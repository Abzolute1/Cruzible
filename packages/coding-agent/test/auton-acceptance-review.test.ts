import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	buildAcceptanceReviewUserText,
	collectWorkspaceEvidence,
	looksLikeShellCommand,
	parseAcceptanceReviewResponse,
	rerunVerificationCommand,
	runAcceptanceReview,
} from "../src/core/auton/acceptance-review.js";

const ledger = {
	touchedFiles: ["src/config-parser.mjs"],
	recentMutations: ["preserved explicit falsey values"],
};

const createdDirs: string[] = [];

function createTempDir(prefix = "ag1-acceptance-review-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	createdDirs.push(dir);
	return dir;
}

function writeFile(dir: string, relativePath: string, contents: string, mtimeMs?: number): string {
	const filePath = join(dir, relativePath);
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, contents);
	if (mtimeMs !== undefined) {
		const date = new Date(mtimeMs);
		utimesSync(filePath, date, date);
	}
	return filePath;
}

afterEach(() => {
	while (createdDirs.length > 0) {
		const dir = createdDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("parseAcceptanceReviewResponse", () => {
	test("parses a strict accept verdict", () => {
		expect(parseAcceptanceReviewResponse('{ "verdict": "accept", "reason": "diff implements the goal" }')).toEqual({
			verdict: "accept",
			reason: "diff implements the goal",
		});
	});

	test("parses a strict reject verdict", () => {
		expect(
			parseAcceptanceReviewResponse(
				'{ "verdict": "reject", "reason": "verification does not exercise the change" }',
			),
		).toEqual({
			verdict: "reject",
			reason: "verification does not exercise the change",
		});
	});

	test("tolerates markdown-fenced JSON", () => {
		const response = '```json\n{ "verdict": "accept", "reason": "ok" }\n```';
		expect(parseAcceptanceReviewResponse(response).verdict).toBe("accept");
	});

	test("unparseable response degrades to reject with the raw text as reason", () => {
		const verdict = parseAcceptanceReviewResponse("I think this looks fine, ship it!");
		expect(verdict.verdict).toBe("reject");
		expect(verdict.reason).toContain("not parseable");
		expect(verdict.reason).toContain("ship it");
	});

	test("JSON without a valid verdict degrades to reject", () => {
		const verdict = parseAcceptanceReviewResponse('{ "verdict": "maybe", "reason": "unsure" }');
		expect(verdict.verdict).toBe("reject");
	});

	test("empty response degrades to reject", () => {
		expect(parseAcceptanceReviewResponse("").verdict).toBe("reject");
	});
});

describe("buildAcceptanceReviewUserText", () => {
	test("includes goal, changed files, and verification output", () => {
		const text = buildAcceptanceReviewUserText({
			goal: "fix the parser",
			ledger,
			verificationDetail: "node --test: 12 passed",
		});
		expect(text).toContain("fix the parser");
		expect(text).toContain("src/config-parser.mjs");
		expect(text).toContain("preserved explicit falsey values");
		expect(text).toContain("node --test: 12 passed");
	});
});

describe("runAcceptanceReview", () => {
	const model: never = { id: "verifier-1", provider: "verifier" } as never;

	test("returns the parsed verdict from the reviewer", async () => {
		const verdict = await runAcceptanceReview(
			model,
			{ goal: "fix the parser", ledger, verificationDetail: "tests passed" },
			async () => '{ "verdict": "accept", "reason": "evidence holds" }',
		);
		expect(verdict).toEqual({ verdict: "accept", reason: "evidence holds" });
	});

	test("unparseable reviewer output continues as a reject verdict", async () => {
		const verdict = await runAcceptanceReview(model, { goal: "fix the parser", ledger }, async () => "no idea");
		expect(verdict?.verdict).toBe("reject");
	});

	test("reviewer call failure yields undefined (review unavailable)", async () => {
		const verdict = await runAcceptanceReview(model, { goal: "fix the parser", ledger }, async () => {
			throw new Error("connection refused");
		});
		expect(verdict).toBeUndefined();
	});
});

describe("collectWorkspaceEvidence", () => {
	test("includes files modified at or after the run start and excludes older files", () => {
		const dir = createTempDir();
		// Filesystem mtimes can land a fraction of a millisecond behind
		// Date.now(), so the test window starts slightly in the past.
		const runStart = Date.now() - 5000;
		writeFile(dir, "src/changed.mjs", "export const fixed = true;\n");
		writeFile(dir, "src/old.mjs", "export const old = true;\n", runStart - 60_000);

		const evidence = collectWorkspaceEvidence(dir, runStart);

		expect(evidence.changedFiles.map((file) => file.path)).toEqual(["src/changed.mjs"]);
		expect(evidence.changedFiles[0]?.mtimeMs).toBeGreaterThanOrEqual(runStart);
	});

	test("excludes node_modules, .git, Debug directories and lockfiles", () => {
		const dir = createTempDir();
		const runStart = Date.now() - 5000;
		writeFile(dir, "src/real.mjs", "real\n");
		writeFile(dir, "node_modules/dep/index.js", "dep\n");
		writeFile(dir, ".git/refs/heads/main", "ref\n");
		writeFile(dir, "Debug/run-log.json", "log\n");
		writeFile(dir, "package-lock.json", "{}\n");
		writeFile(dir, "pnpm-lock.yaml", "lock\n");

		const evidence = collectWorkspaceEvidence(dir, runStart);

		expect(evidence.changedFiles.map((file) => file.path)).toEqual(["src/real.mjs"]);
	});

	test("caps the result at 50 paths, newest first", () => {
		const dir = createTempDir();
		const runStart = Date.now();
		for (let i = 0; i < 60; i++) {
			writeFile(dir, `f${String(i).padStart(2, "0")}.txt`, `${i}\n`, runStart + i * 1000);
		}

		const evidence = collectWorkspaceEvidence(dir, runStart);

		expect(evidence.changedFiles).toHaveLength(50);
		expect(evidence.changedFiles[0]?.path).toBe("f59.txt");
		expect(evidence.changedFiles[49]?.path).toBe("f10.txt");
		for (let i = 1; i < evidence.changedFiles.length; i++) {
			expect(evidence.changedFiles[i - 1]!.mtimeMs).toBeGreaterThanOrEqual(evidence.changedFiles[i]!.mtimeMs);
		}
	});

	test("includes git status --porcelain output when the workspace is a git repo", () => {
		const dir = createTempDir();
		const init = spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
		if (init.error || init.status !== 0) {
			// Git unavailable in this environment — the feature degrades silently anyway.
			return;
		}
		writeFile(dir, "untracked.mjs", "new\n");

		const evidence = collectWorkspaceEvidence(dir, Date.now());

		expect(evidence.gitStatus).toBeDefined();
		expect(evidence.gitStatus).toContain("?? untracked.mjs");
	});

	test("omits git status when the workspace is not a git repo", () => {
		const dir = createTempDir();
		writeFile(dir, "src/file.mjs", "x\n");

		const evidence = collectWorkspaceEvidence(dir, Date.now());

		expect(evidence.gitStatus).toBeUndefined();
	});

	test("never throws on an unreadable workspace", () => {
		const evidence = collectWorkspaceEvidence(join(tmpdir(), "ag1-does-not-exist-xyz"), Date.now());
		expect(evidence.changedFiles).toEqual([]);
	});
});

describe("looksLikeShellCommand", () => {
	test("accepts plausible verification commands", () => {
		expect(looksLikeShellCommand("node --test")).toBe(true);
		expect(looksLikeShellCommand("npm test")).toBe(true);
		expect(looksLikeShellCommand("cd packages/coding-agent && npx vitest --run test/x.test.ts")).toBe(true);
		expect(looksLikeShellCommand("./scripts/verify.sh")).toBe(true);
	});

	test("rejects prose and empty details", () => {
		expect(looksLikeShellCommand(undefined)).toBe(false);
		expect(looksLikeShellCommand("")).toBe(false);
		expect(looksLikeShellCommand("   ")).toBe(false);
		expect(looksLikeShellCommand("I ran the tests and they all passed")).toBe(false);
		expect(looksLikeShellCommand("verify: run the parser tests")).toBe(false);
		expect(looksLikeShellCommand("node --test\nrm -rf /")).toBe(false);
		expect(looksLikeShellCommand(`node ${"x".repeat(400)}`)).toBe(false);
	});
});

describe("rerunVerificationCommand", () => {
	test("captures exit code 0 and output for a passing command", () => {
		const dir = createTempDir();
		const result = rerunVerificationCommand("echo all-good", dir);
		expect(result.exitCode).toBe(0);
		expect(result.timedOut).toBe(false);
		expect(result.outputTail).toContain("all-good");
	});

	test("captures a non-zero exit code and the output tail", () => {
		const dir = createTempDir();
		const result = rerunVerificationCommand("echo failing-output; exit 3", dir);
		expect(result.exitCode).toBe(3);
		expect(result.outputTail).toContain("failing-output");
	});

	test("runs inside the given workspace cwd", () => {
		const dir = createTempDir();
		const result = rerunVerificationCommand("pwd", dir);
		expect(result.exitCode).toBe(0);
		expect(result.outputTail).toContain(dir);
	});

	test("reports a timeout without an exit code", () => {
		const dir = createTempDir();
		const result = rerunVerificationCommand("sleep 5", dir, 300);
		expect(result.timedOut).toBe(true);
		expect(result.exitCode).toBeNull();
	}, 10_000);

	test("trims the output tail to roughly 2k characters", () => {
		const dir = createTempDir();
		const result = rerunVerificationCommand(`printf '%0.sx' $(seq 1 5000)`, dir);
		expect(result.exitCode).toBe(0);
		expect(result.outputTail.length).toBeLessThanOrEqual(2001);
		expect(result.outputTail.endsWith("xxx")).toBe(true);
	});
});

describe("buildAcceptanceReviewUserText ground truth", () => {
	test("leads with on-disk evidence and a fresh verification result, ledger demoted to secondary", () => {
		const text = buildAcceptanceReviewUserText({
			goal: "fix the parser",
			ledger,
			verificationDetail: "node --test",
			workspaceEvidence: {
				changedFiles: [{ path: "src/config-parser.mjs", mtimeMs: Date.UTC(2026, 6, 19, 12, 0, 0) }],
				gitStatus: " M src/config-parser.mjs",
			},
			verificationRerun: {
				command: "node --test",
				exitCode: 0,
				timedOut: false,
				outputTail: "# pass 12",
			},
		});
		expect(text).toContain("Ground truth — files modified on disk during this run:");
		expect(text).toContain("src/config-parser.mjs (mtime 2026-07-19T12:00:00.000Z)");
		expect(text).toContain("Ground truth — git status (porcelain):");
		expect(text).toContain(" M src/config-parser.mjs");
		expect(text).toContain("`node --test`: exited 0");
		expect(text).toContain("# pass 12");
		expect(text).toContain("Ledger record (secondary, self-reported by the run)");
		expect(text).toContain("preserved explicit falsey values");
	});

	test("notes explicitly when no files changed on disk", () => {
		const text = buildAcceptanceReviewUserText({
			goal: "fix the parser",
			ledger,
			workspaceEvidence: { changedFiles: [] },
		});
		expect(text).toContain("no workspace files were modified during this run");
	});
});
