import { beforeEach, describe, expect, test, vi } from "vitest";

const { runAutonomousSessionMock } = vi.hoisted(() => ({
	runAutonomousSessionMock: vi.fn(),
}));

vi.mock("../src/core/auton/runner.js", () => ({
	runAutonomousSession: runAutonomousSessionMock,
}));

import { runAutonomousMode } from "../src/modes/autonomous-mode.js";

describe("runAutonomousMode", () => {
	beforeEach(() => {
		runAutonomousSessionMock.mockReset();
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
						content: [{ type: "text", text: "missing regression test for explicit zero limit\n\nCommand exited with code 1" }],
					},
				});
			}

			expect(options.getToolCallHistory()).toEqual([
				expect.objectContaining({ tool: "read", success: true, file: "src/search-url.mjs", detail: "src/search-url.mjs" }),
				expect.objectContaining({ tool: "edit", success: true, file: "src/search-url.mjs", detail: "src/search-url.mjs" }),
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
				budgetStatus: { costUsed: 0, costAuthoritative: false, tokensUsed: 0, turnsUsed: 0, exceeded: { cost: false, tokens: false, turns: false } },
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
				budgetStatus: { costUsed: 0, costAuthoritative: false, tokensUsed: 0, turnsUsed: 0, exceeded: { cost: false, tokens: false, turns: false } },
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
	});
});
