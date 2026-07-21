import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateToolSafety, type ToolSafetyPolicy } from "../src/core/safety-policy.js";

let cwd = "";

function policy(mode: ToolSafetyPolicy["mode"]): ToolSafetyPolicy {
	return { mode, cwd };
}

describe("tool safety policy", () => {
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "ag1-safety-policy-"));
		mkdirSync(join(cwd, "src"), { recursive: true });
		mkdirSync(join(cwd, "dist"), { recursive: true });
		writeFileSync(join(cwd, "src", "app.ts"), "export const app = true;\n");
	});

	afterEach(() => {
		if (cwd) {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("requires approval for bash commands in interactive mode", () => {
		const result = evaluateToolSafety("bash", { command: "npm test" }, policy("interactive"));

		expect(result.allow).toBe(true);
		expect(result.approvalRequest?.toolName).toBe("bash");
		expect(result.approvalRequest?.risk).toBe("high");
	});

	it("blocks bash commands in headless mode", () => {
		const result = evaluateToolSafety("bash", { command: "npm test" }, policy("headless"));

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("headless mode");
		expect(result.reason).toContain("Use read, grep, find, ls, webSearch, or webFetch instead.");
	});

	it("blocks mutating bash commands in planning mode", () => {
		const result = evaluateToolSafety("bash", { command: "npm test" }, policy("planning"));

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("read-only shell commands");
	});

	it("allows read-only bash commands in planning mode", () => {
		for (const command of [
			"git status",
			"git log --oneline -10",
			"git diff HEAD~1 -- src/",
			"cat package.json",
			"cat package.json | jq .name",
			"grep -rn foo src/ | head -20",
			"wc -l src/*.ts",
			"ls -la 2>/dev/null",
			"npm ls",
			"find src -name '*.ts'",
		]) {
			const result = evaluateToolSafety("bash", { command }, policy("planning"));
			expect(result.allow, `expected allow: ${command}`).toBe(true);
		}
	});

	it("blocks sneaky bash mutations in planning mode", () => {
		for (const command of [
			"cat foo && rm bar",
			"cat $(rm -rf ~)",
			"echo hi > file.txt",
			"ls | tee out.txt",
			"git reset --hard",
			"npm install",
			"npx vitest",
			"curl https://example.com",
			"printenv",
			"node script.js",
		]) {
			const result = evaluateToolSafety("bash", { command }, policy("planning"));
			expect(result.allow, `expected block: ${command}`).toBe(false);
		}
	});

	it("blocks read-only exploration tools in planning mode when inspection is disabled for the turn", () => {
		const result = evaluateToolSafety(
			"read",
			{ path: "src/app.ts" },
			{
				...policy("planning"),
				planningReadOnlyTools: "block",
			},
		);

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("blocked for this planning turn");
	});

	it("blocks web research tools in planning mode when inspection is disabled for the turn", () => {
		const result = evaluateToolSafety(
			"webSearch",
			{ query: "snake game tutorial" },
			{
				...policy("planning"),
				planningReadOnlyTools: "block",
			},
		);

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("blocked for this planning turn");
	});

	it("requires approval for workspace file writes in interactive mode", () => {
		const result = evaluateToolSafety("write", { path: "src/app.ts", content: "x" }, policy("interactive"));

		expect(result.allow).toBe(true);
		expect(result.approvalRequest?.toolName).toBe("write");
		expect(result.approvalRequest?.risk).toBe("high");
	});

	it("allows workspace file edits in autonomous mode", () => {
		const result = evaluateToolSafety("edit", { path: "src/app.ts", edits: [] }, policy("autonomous"));

		expect(result).toEqual({ allow: true });
	});

	it("blocks workspace file edits in planning mode", () => {
		const result = evaluateToolSafety("edit", { path: "src/app.ts", edits: [] }, policy("planning"));

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("planning mode");
	});

	it("blocks file mutations outside the workspace in autonomous mode", () => {
		const result = evaluateToolSafety("write", { path: "/etc/passwd", content: "x" }, policy("autonomous"));

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("outside the session workspace");
	});

	it("blocks destructive rm -rf root commands in all modes", () => {
		const result = evaluateToolSafety("bash", { command: "rm -rf /" }, policy("autonomous"));

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("filesystem root");
	});

	it("blocks privileged shell commands outright", () => {
		const result = evaluateToolSafety("bash", { command: "sudo apt-get update" }, policy("interactive"));

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("Privileged");
	});

	it("blocks autonomous bash commands that target absolute paths outside the workspace", () => {
		const result = evaluateToolSafety("bash", { command: "cp src/app.ts /tmp/app.ts" }, policy("autonomous"));

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("outside the session workspace");
	});

	it("blocks autonomous bash commands that escape the workspace via relative paths", () => {
		const result = evaluateToolSafety("bash", { command: "cat ../secrets.txt" }, policy("autonomous"));

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("outside the session workspace");
	});

	it("blocks autonomous bash commands that reference home-directory aliases", () => {
		const bracedHome = "$" + "{HOME}";
		for (const command of ["cat ~/secrets.txt", "cat $HOME/secrets.txt", `cat ${bracedHome}/secrets.txt`]) {
			const result = evaluateToolSafety("bash", { command }, policy("autonomous"));

			expect(result.allow).toBe(false);
			expect(result.reason).toContain("outside the session workspace");
		}
	});

	it("blocks quoted absolute paths inside autonomous shell snippets", () => {
		const result = evaluateToolSafety(
			"bash",
			{ command: "python -c 'open(\"/etc/passwd\").read()'" },
			policy("autonomous"),
		);

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("outside the session workspace");
	});

	it("allows autonomous bash commands that stay within the workspace", () => {
		const result = evaluateToolSafety(
			"bash",
			{ command: `cp ${join(cwd, "src", "app.ts")} ${join(cwd, "dist", "app.ts")}` },
			policy("autonomous"),
		);

		expect(result).toEqual({ allow: true });
	});

	it("blocks unmanaged custom tools in headless mode", () => {
		const result = evaluateToolSafety("deploy", { target: "prod" }, policy("headless"));

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("not covered by the headless safety policy");
	});

	it("blocks unmanaged custom tools in autonomous mode", () => {
		const result = evaluateToolSafety("deploy", { target: "prod" }, policy("autonomous"));

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("not covered by the autonomous safety policy");
	});

	it("allows extension-registered tools in autonomous mode by default", () => {
		const result = evaluateToolSafety(
			"subagent",
			{ task: "review src/app.ts" },
			{
				...policy("autonomous"),
				extensionTools: ["subagent"],
			},
		);

		expect(result).toEqual({ allow: true });
	});

	it("blocks extension-registered tools in autonomous mode when AG1_AUTONOMOUS_UNTRUSTED_EXTENSIONS=1", () => {
		const previous = process.env.AG1_AUTONOMOUS_UNTRUSTED_EXTENSIONS;
		process.env.AG1_AUTONOMOUS_UNTRUSTED_EXTENSIONS = "1";
		try {
			const result = evaluateToolSafety(
				"subagent",
				{ task: "review src/app.ts" },
				{
					...policy("autonomous"),
					extensionTools: ["subagent"],
				},
			);

			expect(result.allow).toBe(false);
			expect(result.reason).toContain("not covered by the autonomous safety policy");
		} finally {
			if (previous === undefined) {
				delete process.env.AG1_AUTONOMOUS_UNTRUSTED_EXTENSIONS;
			} else {
				process.env.AG1_AUTONOMOUS_UNTRUSTED_EXTENSIONS = previous;
			}
		}
	});

	it("still blocks unknown tool names in autonomous mode when other extension tools are registered", () => {
		const result = evaluateToolSafety(
			"deploy",
			{ target: "prod" },
			{
				...policy("autonomous"),
				extensionTools: ["subagent"],
			},
		);

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("not covered by the autonomous safety policy");
	});

	it("keeps extension-registered tools blocked in headless and planning modes", () => {
		for (const mode of ["headless", "planning"] as const) {
			const result = evaluateToolSafety(
				"subagent",
				{ task: "review src/app.ts" },
				{
					...policy(mode),
					extensionTools: ["subagent"],
				},
			);

			expect(result.allow, `expected block in ${mode} mode`).toBe(false);
		}
	});

	it("keeps extension-registered tools approval-gated in interactive mode", () => {
		const result = evaluateToolSafety(
			"subagent",
			{ task: "review src/app.ts" },
			{
				...policy("interactive"),
				extensionTools: ["subagent"],
			},
		);

		expect(result.allow).toBe(true);
		expect(result.approvalRequest?.toolName).toBe("subagent");
		expect(result.approvalRequest?.summary).toContain("Approve custom tool");
	});

	it("allows explicitly trusted custom tools in non-interactive modes", () => {
		const result = evaluateToolSafety(
			"safe_probe",
			{ path: "src/app.ts" },
			{
				...policy("headless"),
				trustedTools: ["safe_probe"],
			},
		);

		expect(result).toEqual({ allow: true });
	});

	it("requires approval for unmanaged custom tools in interactive mode", () => {
		const result = evaluateToolSafety("deploy", { target: "prod" }, policy("interactive"));

		expect(result.allow).toBe(true);
		expect(result.approvalRequest?.toolName).toBe("deploy");
		expect(result.approvalRequest?.summary).toContain("Approve custom tool");
	});

	it("allows autonomous support tools in autonomous mode", () => {
		expect(evaluateToolSafety("verify", { command: "npm test" }, policy("autonomous"))).toEqual({ allow: true });
		expect(evaluateToolSafety("screenshot_url", { url: "http://localhost:3000" }, policy("autonomous"))).toEqual({
			allow: true,
		});
	});

	it("blocks file mutations that traverse a symlink outside the workspace", () => {
		const outsideDir = mkdtempSync(join(tmpdir(), "ag1-safety-policy-outside-"));
		symlinkSync(outsideDir, join(cwd, "linked-outside"));

		const result = evaluateToolSafety(
			"write",
			{ path: "linked-outside/secret.txt", content: "x" },
			policy("autonomous"),
		);

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("outside the session workspace");
	});

	it("blocks autonomous bash commands that read outside the workspace via input redirect", () => {
		const result = evaluateToolSafety("bash", { command: "cat </etc/passwd" }, policy("autonomous"));

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("outside the session workspace");
	});

	it("blocks autonomous bash commands that write outside the workspace via output redirect", () => {
		const result = evaluateToolSafety("bash", { command: "cp src/app.ts >/etc/y" }, policy("autonomous"));

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("outside the session workspace");
	});

	it("allows autonomous bash commands that redirect to /dev/null", () => {
		const result = evaluateToolSafety("bash", { command: "npm test 2>/dev/null" }, policy("autonomous"));

		expect(result).toEqual({ allow: true });
	});

	it("blocks autonomous bash commands that cd to an absolute path outside the workspace", () => {
		const result = evaluateToolSafety("bash", { command: "cd /etc && cat passwd" }, policy("autonomous"));

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("outside the session workspace");
	});

	it("blocks autonomous bash commands with a bare cd (moves to $HOME)", () => {
		const result = evaluateToolSafety("bash", { command: "cd && cat secrets.txt" }, policy("autonomous"));

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("outside the session workspace");
	});

	it("allows autonomous bash commands that cd within the workspace", () => {
		const result = evaluateToolSafety("bash", { command: "cd src && cat app.ts" }, policy("autonomous"));

		expect(result).toEqual({ allow: true });
	});

	it("marks truncated approval commands as fully executing", () => {
		const longCommand = `echo ${"a".repeat(700)}`;
		const result = evaluateToolSafety("bash", { command: longCommand }, policy("interactive"));

		expect(result.allow).toBe(true);
		expect(result.approvalRequest?.details).toContain("[truncated — full command will execute]");
	});

	it("does not mark short approval commands as truncated", () => {
		const result = evaluateToolSafety("bash", { command: "npm test" }, policy("interactive"));

		expect(result.approvalRequest?.details).not.toContain("[truncated — full command will execute]");
	});

	it("requires approval to edit an existing test file in interactive mode", () => {
		writeFileSync(join(cwd, "src", "foo.test.mjs"), "test\n");

		const result = evaluateToolSafety("edit", { path: "src/foo.test.mjs", edits: [] }, policy("interactive"));

		expect(result.allow).toBe(true);
		expect(result.approvalRequest?.toolName).toBe("edit");
		expect(result.approvalRequest?.risk).toBe("high");
		expect(result.approvalRequest?.summary).toContain("Modify existing test file src/foo.test.mjs?");
		expect(result.approvalRequest?.summary).toContain("verification anchor");
	});

	it("blocks edits to an existing test file in autonomous mode", () => {
		writeFileSync(join(cwd, "src", "foo.test.mjs"), "test\n");

		const result = evaluateToolSafety("write", { path: "src/foo.test.mjs", content: "x" }, policy("autonomous"));

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("Test integrity guard");
		expect(result.reason).toContain("Fix the code, not the tests.");
	});

	it("allows creating new test files in interactive and autonomous modes", () => {
		const interactive = evaluateToolSafety(
			"write",
			{ path: "src/new.test.mjs", content: "x" },
			policy("interactive"),
		);
		expect(interactive.allow).toBe(true);
		expect(interactive.approvalRequest?.summary).toBe("Approve write in the workspace?");

		const autonomous = evaluateToolSafety("write", { path: "src/new.test.mjs", content: "x" }, policy("autonomous"));
		expect(autonomous).toEqual({ allow: true });
	});

	it("blocks autonomous bash commands that delete test paths", () => {
		const result = evaluateToolSafety("bash", { command: "rm tests/foo.test.mjs" }, policy("autonomous"));

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("Test integrity guard");
	});

	it("blocks autonomous bash commands that restore test paths via git", () => {
		const result = evaluateToolSafety(
			"bash",
			{ command: "git checkout -- tests/foo.test.mjs" },
			policy("autonomous"),
		);

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("Test integrity guard");
	});

	it("allows autonomous bash commands that delete non-test paths", () => {
		const result = evaluateToolSafety("bash", { command: "rm src/foo.mjs" }, policy("autonomous"));

		expect(result).toEqual({ allow: true });
	});

	it("keeps test-file edits blocked in planning and headless modes", () => {
		writeFileSync(join(cwd, "src", "foo.test.mjs"), "test\n");

		for (const mode of ["planning", "headless"] as const) {
			const result = evaluateToolSafety("edit", { path: "src/foo.test.mjs", edits: [] }, policy(mode));

			expect(result.allow, `expected block in ${mode} mode`).toBe(false);
			expect(result.reason, `expected ${mode} reason`).toContain(`${mode} mode`);
		}
	});

	it("keeps interactive bash test-path deletions approval-gated, not hard-blocked", () => {
		const result = evaluateToolSafety("bash", { command: "rm tests/foo.test.mjs" }, policy("interactive"));

		expect(result.allow).toBe(true);
		expect(result.approvalRequest?.toolName).toBe("bash");
	});
});

describe("test integrity guard with existingTestPaths snapshot", () => {
	let snapshotCwd = "";

	beforeEach(() => {
		snapshotCwd = mkdtempSync(join(tmpdir(), "ag1-safety-snapshot-"));
		mkdirSync(join(snapshotCwd, "tests"), { recursive: true });
		writeFileSync(join(snapshotCwd, "tests", "existing.test.mjs"), "test('old', () => {});\n");
	});

	afterEach(() => {
		if (snapshotCwd) {
			rmSync(snapshotCwd, { recursive: true, force: true });
		}
	});

	it("blocks autonomous edits of test files present at policy install", async () => {
		const { collectExistingTestPaths } = await import("../src/core/test-paths.js");
		const p: ToolSafetyPolicy = {
			mode: "autonomous",
			cwd: snapshotCwd,
			existingTestPaths: collectExistingTestPaths(snapshotCwd),
		};

		const result = evaluateToolSafety("edit", { path: "tests/existing.test.mjs", edits: [] }, p);

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("Test integrity guard");
	});

	it("lets autonomous mode repair test files the agent created during the run", async () => {
		const { collectExistingTestPaths } = await import("../src/core/test-paths.js");
		const p: ToolSafetyPolicy = {
			mode: "autonomous",
			cwd: snapshotCwd,
			existingTestPaths: collectExistingTestPaths(snapshotCwd),
		};
		// The agent creates the test file AFTER the policy snapshot, then needs
		// to fix it (the vacuous_pass_trap failure mode).
		writeFileSync(join(snapshotCwd, "tests", "agent-created.test.mjs"), "// broken draft\n");

		const result = evaluateToolSafety("edit", { path: "tests/agent-created.test.mjs", edits: [] }, p);

		expect(result.allow).toBe(true);
	});

	it("without a snapshot, protects every existing test file (legacy conservative)", () => {
		const result = evaluateToolSafety(
			"edit",
			{ path: "tests/existing.test.mjs", edits: [] },
			{ mode: "autonomous", cwd: snapshotCwd },
		);

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("Test integrity guard");
	});

	it("interactive mode gives the generic (not test-anchor) approval for agent-created test files", async () => {
		const { collectExistingTestPaths } = await import("../src/core/test-paths.js");
		const p: ToolSafetyPolicy = {
			mode: "interactive",
			cwd: snapshotCwd,
			existingTestPaths: collectExistingTestPaths(snapshotCwd),
		};
		// Created after the snapshot — the agent's own draft, not a protected anchor.
		writeFileSync(join(snapshotCwd, "tests", "agent-created.test.mjs"), "// draft\n");

		const result = evaluateToolSafety("edit", { path: "tests/agent-created.test.mjs", edits: [] }, p);

		expect(result.allow).toBe(true);
		expect(result.approvalRequest).toBeDefined();
		expect(result.approvalRequest?.summary).not.toContain("verification anchor");
	});

	it("shell: rm of a snapshot test file is blocked, rm of an agent-created one is allowed", async () => {
		const { collectExistingTestPaths } = await import("../src/core/test-paths.js");
		const p: ToolSafetyPolicy = {
			mode: "autonomous",
			cwd: snapshotCwd,
			existingTestPaths: collectExistingTestPaths(snapshotCwd),
		};
		writeFileSync(join(snapshotCwd, "tests", "agent-created.test.mjs"), "// draft\n");

		expect(evaluateToolSafety("bash", { command: "rm tests/existing.test.mjs" }, p).allow).toBe(false);
		expect(evaluateToolSafety("bash", { command: "rm tests/agent-created.test.mjs" }, p).allow).toBe(true);
	});
});
