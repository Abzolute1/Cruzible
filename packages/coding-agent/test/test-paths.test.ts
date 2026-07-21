import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findTestPathShellMutation, isTestPath } from "../src/core/test-paths.js";

let cwd = "";

describe("isTestPath", () => {
	it.each([
		// directory conventions
		"src/__tests__/app.ts",
		"packages/coding-agent/test/safety-policy.test.ts",
		"tests/integration/login.py",
		"test/helpers.ts",
		"spec/models/user.rb",
		"./tests/foo.ts",
		"tests",
		"tests/",
		// basename conventions
		"foo.test.mjs",
		"foo.spec.ts",
		"src/foo.test.mjs",
		"test_paginate.py",
		"paginate_test.go",
		// windows-style separators
		"src\\tests\\foo.ts",
	])("detects test path: %s", (path) => {
		expect(isTestPath(path)).toBe(true);
	});

	it.each([
		"src/app.ts",
		"src/foo.mjs",
		"README.md",
		// near-misses: segments must match exactly, not as substrings
		"testing/utils.ts",
		"src/latest.ts",
		"src/contest.ts",
		"specification/doc.md",
		"my-spec.yaml",
		"src/test.ts",
	])("ignores non-test path: %s", (path) => {
		expect(isTestPath(path)).toBe(false);
	});
});

describe("findTestPathShellMutation", () => {
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "ag1-test-paths-"));
	});

	afterEach(() => {
		if (cwd) {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it.each([
		"rm tests/foo.test.mjs",
		"rm -rf tests/",
		'rm "tests/foo.test.mjs"',
		"mv tests/foo.test.mjs tests/bar.test.mjs",
		"mv src/foo.mjs tests/foo.test.mjs",
		"cp src/foo.mjs tests/foo.test.mjs",
		"cp -r src/a.ts tests/",
		"git checkout -- tests/foo.test.mjs",
		"git restore tests/foo.test.mjs",
		"git restore --staged tests/foo.test.mjs",
		"echo hi && rm tests/foo.test.mjs",
	])("flags mutation: %s", (command) => {
		expect(findTestPathShellMutation(command, cwd)).toBeDefined();
	});

	it("flags absolute test paths inside the workspace", () => {
		const command = `rm ${join(cwd, "tests", "foo.test.mjs")}`;
		expect(findTestPathShellMutation(command, cwd)).toBeDefined();
	});

	it.each([
		// non-test targets
		"rm src/foo.mjs",
		"rm -rf dist/",
		"git checkout main",
		"git restore src/app.ts",
		// reading/copying FROM a test path does not mutate it
		"cat tests/foo.test.mjs",
		"cp tests/foo.test.mjs src/copy.mjs",
		// unrelated commands
		"npm test",
		"npx vitest --run",
	])("ignores non-mutating command: %s", (command) => {
		expect(findTestPathShellMutation(command, cwd)).toBeUndefined();
	});

	it("ignores absolute test paths outside the workspace", () => {
		expect(findTestPathShellMutation("rm /tmp/ag1-unrelated-workspace/tests/foo.test.mjs", cwd)).toBeUndefined();
	});
});

describe("collectExistingTestPaths", () => {
	it("snapshots test files, skips node_modules and non-test files", async () => {
		const { collectExistingTestPaths } = await import("../src/core/test-paths.js");
		const root = mkdtempSync(join(tmpdir(), "ag1-testpaths-snap-"));
		try {
			mkdirSync(join(root, "tests"), { recursive: true });
			mkdirSync(join(root, "src"), { recursive: true });
			mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
			writeFileSync(join(root, "tests", "a.test.mjs"), "x");
			writeFileSync(join(root, "src", "a.mjs"), "x");
			writeFileSync(join(root, "node_modules", "dep", "b.test.mjs"), "x");

			const snapshot = collectExistingTestPaths(root);

			expect([...snapshot]).toHaveLength(1);
			expect([...snapshot][0]).toContain("tests/a.test.mjs");
			expect([...snapshot][0].startsWith("/")).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
