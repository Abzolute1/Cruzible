import { describe, expect, it } from "vitest";
import { evaluateToolSafety, type ToolSafetyPolicy } from "../src/core/safety-policy.js";

const cwd = "/workspace/project";

function policy(mode: ToolSafetyPolicy["mode"]): ToolSafetyPolicy {
	return { mode, cwd };
}

describe("tool safety policy", () => {
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

	it("blocks file mutations outside the workspace in autonomous mode", () => {
		const result = evaluateToolSafety(
			"write",
			{ path: "/etc/passwd", content: "x" },
			policy("autonomous"),
		);

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

	it("allows autonomous bash commands that stay within the workspace", () => {
		const result = evaluateToolSafety(
			"bash",
			{ command: "cp /workspace/project/src/app.ts /workspace/project/dist/app.ts" },
			policy("autonomous"),
		);

		expect(result).toEqual({ allow: true });
	});
});
