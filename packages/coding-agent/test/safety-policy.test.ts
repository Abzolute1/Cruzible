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

	it("blocks bash commands in planning mode", () => {
		const result = evaluateToolSafety("bash", { command: "npm test" }, policy("planning"));

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("planning mode");
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
});
