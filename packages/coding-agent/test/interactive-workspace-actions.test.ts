import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { executeInteractiveWorkspaceCommand } from "../src/modes/interactive/interactive-workspace-actions.js";

describe("interactive-workspace-actions", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	test("shows a summary when no workspace exists", () => {
		const result = executeInteractiveWorkspaceCommand({
			text: "/workspace",
			activeWorkspace: undefined,
			lastWorkspace: undefined,
		});

		expect(result.output).toContain("No autonomous workspace is active or preserved");
		expect(result.dim).toBe(true);
	});

	test("refuses discard while a workspace is active", () => {
		const result = executeInteractiveWorkspaceCommand({
			text: "/workspace discard",
			activeWorkspace: {
				workspaceRoot: "/tmp/active",
				activeCwd: "/tmp/active",
				sourceCwd: "/repo",
				strategy: "copy",
				description: "copy",
				restore: async () => undefined,
			},
			lastWorkspace: undefined,
		});

		expect(result.warning).toContain("Cannot discard the autonomous workspace while it is active");
	});

	test("discards a preserved workspace", () => {
		tempDir = mkdtempSync(join(tmpdir(), "interactive-workspace-actions-"));
		const workspaceRoot = join(tempDir, "sandbox");
		mkdirSync(workspaceRoot, { recursive: true });

		const result = executeInteractiveWorkspaceCommand({
			text: "/workspace discard",
			activeWorkspace: undefined,
			lastWorkspace: {
				workspaceRoot,
				activeCwd: workspaceRoot,
				sourceCwd: "/repo",
				strategy: "copy",
				description: "copy",
			},
		});

		expect(result.output).toContain("Discarded preserved autonomous workspace");
		expect(result.nextLastWorkspace).toBeUndefined();
	});
});
