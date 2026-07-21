import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { activateAutonomousWorkspaceMock, restoreWorkspaceMock, runAutonomousSessionMock } = vi.hoisted(() => ({
	activateAutonomousWorkspaceMock: vi.fn(),
	restoreWorkspaceMock: vi.fn(),
	runAutonomousSessionMock: vi.fn(),
}));

vi.mock("../src/core/auton/runner.js", () => ({
	runAutonomousSession: runAutonomousSessionMock,
}));

vi.mock("../src/core/auton/workspace.js", () => ({
	activateAutonomousWorkspace: activateAutonomousWorkspaceMock,
}));

import { runAutonomousMode } from "../src/modes/autonomous-mode.js";

describe("runAutonomousMode", () => {
	beforeEach(() => {
		activateAutonomousWorkspaceMock.mockReset();
		restoreWorkspaceMock.mockReset();
		runAutonomousSessionMock.mockReset();
		activateAutonomousWorkspaceMock.mockResolvedValue({
			sourceCwd: "/tmp/fixture",
			workspaceRoot: "/tmp/ag1-autonomous-fixture",
			activeCwd: "/tmp/fixture-isolated",
			strategy: "copy",
			description: "test workspace",
			restore: restoreWorkspaceMock,
		});
	});

	test("passes accumulated tool and file history into the autonomous runner", async () => {
		const listeners: Array<(event: any) => void> = [];
		const runtimeHost = {
			session: {
				sessionManager: {
					getCwd: () => "/tmp/fixture",
				},
				subscribe(listener: (event: any) => void) {
					listeners.push(listener);
					return () => {
						const index = listeners.indexOf(listener);
						if (index >= 0) listeners.splice(index, 1);
					};
				},
			},
		} as any;

		runAutonomousSessionMock.mockImplementation(async (options: any) => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_start",
					toolCallId: "read-1",
					toolName: "read",
					args: { path: "src/search-url.mjs" },
				});
				listener({
					type: "tool_execution_end",
					toolCallId: "read-1",
					toolName: "read",
					isError: false,
					result: {
						content: [{ type: "text", text: "export function buildSearchUrl() {}" }],
					},
				});
				listener({
					type: "tool_execution_start",
					toolCallId: "edit-1",
					toolName: "edit",
					args: { path: "src/search-url.mjs" },
				});
				listener({
					type: "tool_execution_end",
					toolCallId: "edit-1",
					toolName: "edit",
					isError: false,
					result: {
						content: [{ type: "text", text: "Patched 1 block(s) in src/search-url.mjs." }],
						details: { diff: "..." },
					},
				});
				listener({
					type: "tool_execution_start",
					toolCallId: "bash-1",
					toolName: "bash",
					args: { command: "node --test" },
				});
				listener({
					type: "tool_execution_end",
					toolCallId: "bash-1",
					toolName: "bash",
					isError: false,
					result: {
						content: [
							{
								type: "text",
								text: "missing regression test for explicit zero limit\n\nCommand exited with code 1",
							},
						],
					},
				});
			}

			expect(options.getToolCallHistory()).toEqual([
				expect.objectContaining({
					tool: "read",
					success: true,
					file: "src/search-url.mjs",
					detail: "src/search-url.mjs",
				}),
				expect.objectContaining({
					tool: "edit",
					success: true,
					file: "src/search-url.mjs",
					detail: "src/search-url.mjs",
				}),
				expect.objectContaining({
					tool: "bash",
					success: true,
					detail: "node --test",
					metadata: expect.objectContaining({ outputPreview: "missing regression test for explicit zero limit" }),
				}),
			]);
			expect(options.getFileAccessHistory()).toEqual([
				expect.objectContaining({ tool: "read", success: true, file: "src/search-url.mjs" }),
				expect.objectContaining({ tool: "edit", success: true, file: "src/search-url.mjs" }),
			]);

			return {
				stopReason: "complete",
				budgetStatus: {
					costUsed: 0,
					costAuthoritative: false,
					tokensUsed: 0,
					turnsUsed: 0,
					exceeded: { cost: false, tokens: false, turns: false },
				},
				costSummary: "$0.0000 (estimate) | 0 in / 0 out",
				checkpointState: {} as any,
				ledger: {} as any,
				iterations: 1,
			};
		});

		const exitCode = await runAutonomousMode(runtimeHost, {
			goal: "Fix the bug",
			cwd: "/tmp/fixture",
			autonConfig: {
				maxCost: 0,
				maxTokens: 0,
				maxTurns: 10,
				enableNudges: true,
				enableBehavioralPrompt: true,
				verbose: false,
			},
		});

		expect(exitCode).toBe(0);
		expect(runAutonomousSessionMock).toHaveBeenCalledOnce();
		expect(activateAutonomousWorkspaceMock).toHaveBeenCalledOnce();
		expect(restoreWorkspaceMock).toHaveBeenCalledOnce();
		expect(listeners).toHaveLength(0);
	});

	test("extracts actionable bash failure previews from verbose XML fallback output", async () => {
		const listeners: Array<(event: any) => void> = [];
		const runtimeHost = {
			session: {
				sessionManager: {
					getCwd: () => "/tmp/fixture",
				},
				subscribe(listener: (event: any) => void) {
					listeners.push(listener);
					return () => {
						const index = listeners.indexOf(listener);
						if (index >= 0) listeners.splice(index, 1);
					};
				},
			},
		} as any;

		runAutonomousSessionMock.mockImplementation(async (options: any) => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_start",
					toolCallId: "bash-1",
					toolName: "bash",
					args: { command: "node --test && node scripts/check-regression-test.mjs" },
				});
				listener({
					type: "tool_execution_end",
					toolCallId: "bash-1",
					toolName: "bash",
					isError: true,
					result: {
						content: [
							{
								type: "text",
								text: [
									"Error executing 'bash': TAP version 13",
									"# missing regression test for explicit zero limit",
									"# Subtest: scripts/check-regression-test.mjs",
									"not ok 1 - scripts/check-regression-test.mjs",
									"Command exited with code 1",
								].join("\n"),
							},
						],
					},
				});
			}

			expect(options.getToolCallHistory()).toEqual([
				expect.objectContaining({
					tool: "bash",
					success: false,
					detail: "node --test && node scripts/check-regression-test.mjs",
					metadata: expect.objectContaining({ outputPreview: "missing regression test for explicit zero limit" }),
				}),
			]);

			return {
				stopReason: "complete",
				budgetStatus: {
					costUsed: 0,
					costAuthoritative: false,
					tokensUsed: 0,
					turnsUsed: 0,
					exceeded: { cost: false, tokens: false, turns: false },
				},
				costSummary: "$0.0000 (estimate) | 0 in / 0 out",
				checkpointState: {} as any,
				ledger: {} as any,
				iterations: 1,
			};
		});

		const exitCode = await runAutonomousMode(runtimeHost, {
			goal: "Fix the bug",
			cwd: "/tmp/fixture",
			autonConfig: {
				maxCost: 0,
				maxTokens: 0,
				maxTurns: 10,
				enableNudges: true,
				enableBehavioralPrompt: true,
				verbose: false,
			},
		});

		expect(exitCode).toBe(0);
		expect(runAutonomousSessionMock).toHaveBeenCalledOnce();
		expect(activateAutonomousWorkspaceMock).toHaveBeenCalledOnce();
		expect(restoreWorkspaceMock).toHaveBeenCalledOnce();
	});

	test("activates the isolated workspace before installing policy and running", async () => {
		const sandboxRoot = mkdtempSync(join(tmpdir(), "ag1-autonomous-mode-"));
		const sandboxCwd = join(sandboxRoot, "repo");
		mkdirSync(join(sandboxCwd, "src"), { recursive: true });
		writeFileSync(join(sandboxCwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
		writeFileSync(join(sandboxCwd, "src", "search-url.ts"), "export function buildSearchUrl() {}\n");
		const sourceSafetyPolicy = { mode: "autonomous", cwd: "/repo" };
		const sourceSetToolSafetyPolicy = vi.fn();
		const sandboxSetToolSafetyPolicy = vi.fn();
		const sandboxSetToolPolicy = vi.fn();
		const sandboxSubscribe = vi.fn(() => vi.fn());
		const sourceSession = {
			toolSafetyPolicy: sourceSafetyPolicy,
			sessionManager: {
				getCwd: () => "/repo",
			},
			setToolSafetyPolicy: sourceSetToolSafetyPolicy,
		};
		const sandboxSession = {
			toolSafetyPolicy: undefined,
			sessionManager: {
				getCwd: () => "/tmp/ag1-sandbox/repo",
			},
			setToolSafetyPolicy: sandboxSetToolSafetyPolicy,
			setToolPolicy: sandboxSetToolPolicy,
			subscribe: sandboxSubscribe,
			// Extension-registered tools are user-installed code and must be
			// threaded into the autonomous policy so they are trusted by default.
			extensionRunner: {
				getAllRegisteredTools: () => [{ definition: { name: "subagent" } }],
			},
		};
		const runtimeHost = { session: sourceSession } as any;

		activateAutonomousWorkspaceMock.mockImplementation(async (host: any) => {
			host.session = sandboxSession;
			return {
				sourceCwd: "/repo",
				workspaceRoot: sandboxRoot,
				activeCwd: sandboxCwd,
				strategy: "copy",
				description: "test workspace",
				restore: async () => {
					restoreWorkspaceMock();
					host.session = sourceSession;
				},
			};
		});
		runAutonomousSessionMock.mockResolvedValue({
			stopReason: "complete",
			budgetStatus: {
				costUsed: 0,
				costAuthoritative: false,
				tokensUsed: 0,
				turnsUsed: 0,
				exceeded: { cost: false, tokens: false, turns: false },
			},
			costSummary: "$0.0000 (estimate) | 0 in / 0 out",
			checkpointState: {} as any,
			ledger: {} as any,
			iterations: 1,
		});

		const exitCode = await runAutonomousMode(runtimeHost, {
			goal: "Fix the bug",
			cwd: "/repo",
			agentDir: "/tmp/ag1",
			autonConfig: {
				maxCost: 0,
				maxTokens: 0,
				maxTurns: 10,
				enableNudges: true,
				enableBehavioralPrompt: true,
				verbose: false,
			},
		});

		expect(exitCode).toBe(0);
		expect(activateAutonomousWorkspaceMock).toHaveBeenCalledWith(runtimeHost, { agentDir: "/tmp/ag1" });
		expect(sandboxSetToolSafetyPolicy).toHaveBeenCalledWith({
			mode: "autonomous",
			cwd: sandboxCwd,
			existingTestPaths: expect.any(Set),
			extensionTools: ["subagent"],
		});
		expect(sandboxSetToolPolicy).toHaveBeenCalledWith(expect.objectContaining({ mode: "controlled" }));
		expect(runAutonomousSessionMock).toHaveBeenCalledWith(expect.objectContaining({ runtimeHost }));
		expect(restoreWorkspaceMock).toHaveBeenCalledOnce();
		expect(sourceSetToolSafetyPolicy).toHaveBeenCalledWith(sourceSafetyPolicy);
	});
});
