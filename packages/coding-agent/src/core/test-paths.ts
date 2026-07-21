import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isContainedPath } from "./tools/path-utils.js";

/**
 * Test-path detection for the test integrity guard.
 *
 * Tests are the harness's verification anchor: if the model can rewrite the
 * tests it is graded against, exit-code-based verification becomes meaningless.
 * These heuristics cover the common test-file conventions across ecosystems
 * (JS/TS, Python, Go, Ruby) and are deliberately conservative — a false
 * positive costs an approval prompt (interactive) or a block (autonomous),
 * while a false negative silently weakens verification.
 */

const TEST_DIR_SEGMENT = /(?:^|\/)(?:__tests__|tests?|spec)(?=\/|$)/;
const TEST_BASENAME_PATTERNS = [
	// foo.test.mjs, foo.spec.ts
	/\.(?:test|spec)\.[^./]+$/,
	// test_paginate.py
	/^test_.+\.[^./]+$/,
	// paginate_test.go
	/.+_test\.[^./]+$/,
];

/** Detect common test-file path conventions (directory segments and basenames). */
export function isTestPath(path: string): boolean {
	const normalized = path.replace(/\\/g, "/");
	if (TEST_DIR_SEGMENT.test(normalized)) {
		return true;
	}
	const basename = normalized.split("/").at(-1) ?? "";
	return TEST_BASENAME_PATTERNS.some((pattern) => pattern.test(basename));
}

const SNAPSHOT_SKIP_DIRS = new Set(["node_modules", ".git"]);

/**
 * Snapshot the test paths present under a root, normalized like
 * resolveToCwd's output (absolute, forward slashes). The test integrity guard
 * protects exactly this set: files created AFTER the snapshot are the agent's
 * own work product and must stay mutable — otherwise the guard blocks the
 * model from fixing tests it wrote itself earlier in the same run (seen in
 * the adversarial pack: a model wrote a broken test file, then the guard
 * refused its repair for 14 turns and the run died).
 */
export function collectExistingTestPaths(root: string): Set<string> {
	const snapshot = new Set<string>();
	const walk = (dir: string): void => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			if (SNAPSHOT_SKIP_DIRS.has(name)) continue;
			const absolute = join(dir, name);
			let stats;
			try {
				stats = lstatSync(absolute);
			} catch {
				continue;
			}
			if (stats.isDirectory()) {
				walk(absolute);
				continue;
			}
			if (stats.isFile() && isTestPath(absolute)) {
				snapshot.add(resolve(absolute).replace(/\\/g, "/"));
			}
		}
	};
	walk(root);
	return snapshot;
}

function normalizeShellToken(token: string): string {
	return token.replace(/^[("'`]+/, "").replace(/[)"'`,:]+$/, "");
}

function shellOperands(tokens: string[]): string[] {
	return tokens.map(normalizeShellToken).filter((token) => token.length > 0 && !token.startsWith("-"));
}

function isWorkspaceTestOperand(operand: string, cwd: string): boolean {
	if (!isTestPath(operand)) {
		return false;
	}
	// Relative operands resolve against the shell cwd (the workspace). Absolute
	// operands only count when they stay inside the workspace — paths outside it
	// are the out-of-workspace guard's job.
	return !operand.startsWith("/") || isContainedPath(operand, cwd);
}

/**
 * Best-effort detection of shell commands that delete, move, or overwrite test
 * paths (rm / mv / cp / git checkout / git restore). Same heuristic status as
 * the other shell guards in safety-policy.ts: quoting tricks, `$VAR`/`$(...)`
 * expansion, and output redirects can evade it, and the real containment
 * boundary is AG1_BASH_SANDBOX_COMMAND.
 */
export function findTestPathShellMutation(command: string, cwd: string): string | undefined {
	for (const segment of command.split(/[;&|\n]+/)) {
		const tokens = segment
			.trim()
			.split(/\s+/)
			.filter((token) => token.length > 0);
		if (tokens.length === 0) {
			continue;
		}
		const [cmd, ...rest] = tokens;

		if (cmd === "rm" || cmd === "mv") {
			const hit = shellOperands(rest).find((operand) => isWorkspaceTestOperand(operand, cwd));
			if (hit) {
				return hit;
			}
			continue;
		}

		if (cmd === "cp") {
			// cp only mutates its destination; copying FROM a test file is harmless.
			const destination = shellOperands(rest).at(-1);
			if (destination && isWorkspaceTestOperand(destination, cwd)) {
				return destination;
			}
			continue;
		}

		if (cmd === "git" && (rest[0] === "checkout" || rest[0] === "restore")) {
			const hit = shellOperands(rest.slice(1)).find((operand) => isWorkspaceTestOperand(operand, cwd));
			if (hit) {
				return hit;
			}
		}
	}
	return undefined;
}
