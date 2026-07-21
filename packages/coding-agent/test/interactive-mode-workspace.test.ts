import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container } from "@ag1/tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { getAutonomousScopeGuardReason } from "../src/modes/interactive/interactive-autonomous-ui.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function renderAll(container: Container, width = 160): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

describe("InteractiveMode.handleWorkspaceCommand", () => {
	let tempDir: string | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	test("shows a message when no autonomous workspace exists", () => {
		const fakeThis: any = {
			activeAutonomousWorkspace: undefined,
			lastAutonomousWorkspace: undefined,
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			showWarning: vi.fn(),
		};

		(InteractiveMode as any).prototype.handleWorkspaceCommand.call(fakeThis, "/workspace");

		expect(renderAll(fakeThis.chatContainer)).toContain("No autonomous workspace is active or preserved");
	});

	test("refuses autonomous mode from the home directory", async () => {
		const fakeThis: any = {
			sessionManager: {
				getCwd: () => process.env.HOME ?? "/home/alex",
			},
			showWarning: vi.fn(),
		};

		await (InteractiveMode as any).prototype.runAutonomousLoop.call(fakeThis, "fix it", undefined);

		expect(fakeThis.showWarning).toHaveBeenCalledWith(expect.stringContaining("cannot run from your home directory"));
	});

	test("refuses autonomous mode from broad personal directories without project markers", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "interactive-scope-"));
		const desktopDir = join(tempDir, "Desktop");
		mkdirSync(desktopDir, { recursive: true });

		const previousHome = process.env.HOME;
		process.env.HOME = tempDir;
		try {
			const fakeThis: any = {
				sessionManager: {
					getCwd: () => desktopDir,
				},
				showWarning: vi.fn(),
			};

			await (InteractiveMode as any).prototype.runAutonomousLoop.call(fakeThis, "fix it", undefined);

			expect(fakeThis.showWarning).toHaveBeenCalledWith(
				expect.stringContaining("broad personal directories like Desktop"),
			);
		} finally {
			process.env.HOME = previousHome;
		}
	});

	test("allows autonomous mode from nested project-like folders under Desktop", () => {
		tempDir = mkdtempSync(join(tmpdir(), "interactive-scope-"));
		const projectDir = join(tempDir, "Desktop", "Tests", "Snake");
		mkdirSync(projectDir, { recursive: true });

		const previousHome = process.env.HOME;
		process.env.HOME = tempDir;
		try {
			expect(getAutonomousScopeGuardReason(projectDir)).toBeUndefined();
		} finally {
			process.env.HOME = previousHome;
		}
	});

	test("resolves debug artifacts root from the current session cwd", () => {
		const fakeThis: any = {
			activeAutonomousWorkspace: undefined,
			lastAutonomousWorkspace: undefined,
			sessionManager: {
				getCwd: () => "/home/alex/Desktop/Tests/Snake",
			},
		};

		const resolved = (InteractiveMode as any).prototype.resolveProjectRoot.call(fakeThis);
		expect(resolved).toBe("/home/alex/Desktop/Tests/Snake");
	});

	test("prefers autonomous source cwd for debug artifacts", () => {
		const fakeThis: any = {
			activeAutonomousWorkspace: {
				sourceCwd: "/home/alex/projects/snake",
			},
			lastAutonomousWorkspace: {
				sourceCwd: "/tmp/old-workspace",
			},
			sessionManager: {
				getCwd: () => "/tmp/isolation-copy",
			},
		};

		const resolved = (InteractiveMode as any).prototype.resolveProjectRoot.call(fakeThis);
		expect(resolved).toBe("/home/alex/projects/snake");
	});

	test("shows preserved autonomous workspace details", () => {
		const fakeThis: any = {
			activeAutonomousWorkspace: undefined,
			lastAutonomousWorkspace: {
				workspaceRoot: "/tmp/ag1-workspace",
				activeCwd: "/tmp/ag1-workspace/app",
				sourceCwd: "/repo/app",
				strategy: "copy",
				description: "filesystem copy fallback",
			},
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			showWarning: vi.fn(),
		};

		(InteractiveMode as any).prototype.handleWorkspaceCommand.call(fakeThis, "/workspace");

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("Autonomous Workspace");
		expect(output).toContain("/tmp/ag1-workspace");
		expect(output).toContain("copy");
	});

	test("discards the preserved autonomous workspace on command", () => {
		tempDir = mkdtempSync(join(tmpdir(), "interactive-workspace-"));
		const workspaceRoot = join(tempDir, "sandbox");
		mkdirSync(workspaceRoot, { recursive: true });

		const fakeThis: any = {
			activeAutonomousWorkspace: undefined,
			lastAutonomousWorkspace: {
				workspaceRoot,
				activeCwd: workspaceRoot,
				sourceCwd: "/repo",
				strategy: "copy",
				description: "filesystem copy fallback",
			},
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			showWarning: vi.fn(),
		};

		(InteractiveMode as any).prototype.handleWorkspaceCommand.call(fakeThis, "/workspace discard");

		expect(fakeThis.lastAutonomousWorkspace).toBeUndefined();
		expect(renderAll(fakeThis.chatContainer)).toContain("Discarded preserved autonomous workspace");
	});

	test("promotes the preserved autonomous workspace on command", () => {
		tempDir = mkdtempSync(join(tmpdir(), "interactive-workspace-"));
		const workspaceRoot = join(tempDir, "sandbox");
		const sourceRoot = join(tempDir, "source");
		mkdirSync(workspaceRoot, { recursive: true });
		mkdirSync(sourceRoot, { recursive: true });

		const fakeThis: any = {
			activeAutonomousWorkspace: undefined,
			lastAutonomousWorkspace: {
				workspaceRoot,
				activeCwd: workspaceRoot,
				sourceCwd: sourceRoot,
				strategy: "copy",
				description: "filesystem copy fallback",
			},
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			showWarning: vi.fn(),
		};

		(InteractiveMode as any).prototype.handleWorkspaceCommand.call(fakeThis, "/workspace promote");

		expect(renderAll(fakeThis.chatContainer)).toContain("Promoted autonomous workspace");
		expect(renderAll(fakeThis.chatContainer)).toContain(sourceRoot);
	});

	test("shows workspace diff details on command", () => {
		tempDir = mkdtempSync(join(tmpdir(), "interactive-workspace-"));
		const workspaceRoot = join(tempDir, "sandbox");
		const sourceRoot = join(tempDir, "source");
		mkdirSync(workspaceRoot, { recursive: true });
		mkdirSync(sourceRoot, { recursive: true });

		const fakeThis: any = {
			activeAutonomousWorkspace: undefined,
			lastAutonomousWorkspace: {
				workspaceRoot,
				activeCwd: workspaceRoot,
				sourceCwd: sourceRoot,
				strategy: "copy",
				description: "filesystem copy fallback",
			},
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			showWarning: vi.fn(),
		};

		(InteractiveMode as any).prototype.handleWorkspaceCommand.call(fakeThis, "/workspace diff");

		expect(renderAll(fakeThis.chatContainer)).toContain("Autonomous Workspace Diff");
		expect(renderAll(fakeThis.chatContainer)).toContain("Added:");
	});

	test("restores persisted runtime health from session entries", async () => {
		const fakeThis: any = {
			resetExtensionUI: vi.fn(),
			unsubscribe: vi.fn(),
			session: {
				sessionManager: {
					getEntries: () => [
						{
							type: "custom",
							customType: "runtime_health_snapshot",
							data: {
								version: 1,
								savedAt: new Date().toISOString(),
								xmlFallbackCount: 2,
								degradedTurnCount: 1,
								lastXmlFallbackEvent: {
									type: "xml_tool_call",
									toolName: "bash",
									arguments: { command: "npm test" },
									severity: "critical",
									reasons: ["truncated_turn"],
								},
								lastDegradedTurnEvent: {
									type: "degraded_turn",
									severity: "elevated",
									stopReason: "stop",
									outputTokens: 8200,
									textLength: 26000,
									reasons: ["high_output_tokens"],
								},
							},
						},
					],
				},
			},
			applyRuntimeSettings: vi.fn(),
			applySafetyPolicy: vi.fn(),
			bindCurrentSessionExtensions: vi.fn(async () => undefined),
			subscribeToAgent: vi.fn(),
			updateAvailableProviderCount: vi.fn(async () => undefined),
			updateEditorBorderColor: vi.fn(),
			updateTerminalTitle: vi.fn(),
			updateModeDisplay: vi.fn(),
			lastAutonomousRunResult: undefined,
			xmlFallbackCount: 0,
			degradedTurnCount: 0,
			lastXmlFallbackEvent: undefined,
			lastDegradedTurnEvent: undefined,
		};

		await (InteractiveMode as any).prototype.handleRuntimeSessionChange.call(fakeThis);

		expect(fakeThis.xmlFallbackCount).toBe(2);
		expect(fakeThis.degradedTurnCount).toBe(1);
		expect(fakeThis.lastXmlFallbackEvent?.severity).toBe("critical");
		expect(fakeThis.lastDegradedTurnEvent?.severity).toBe("elevated");
		expect(fakeThis.applyRuntimeSettings).toHaveBeenCalled();
		expect(fakeThis.subscribeToAgent).toHaveBeenCalled();
	});

	test("applies a guarded stabilization profile to autonomous config", () => {
		const fakeThis: any = {
			session: {
				model: { provider: "provider", id: "model-a" },
				sessionManager: {
					getEntries: () => [
						{
							type: "custom",
							customType: "runtime_health_snapshot",
							data: {
								version: 1,
								savedAt: new Date().toISOString(),
								modelId: "provider/model-a",
								xmlFallbackCount: 1,
								degradedTurnCount: 1,
								lastDegradedTurnEvent: {
									type: "degraded_turn",
									severity: "critical",
									stopReason: "max_tokens",
									outputTokens: 15000,
									textLength: 52000,
									reasons: ["truncated_turn"],
								},
							},
						},
					],
				},
			},
			autonomousConfig: {
				maxOutputPerTurn: 8000,
				enableBehavioralPrompt: false,
				enableNudges: false,
			},
			getAutonomousStabilizationProfile: (InteractiveMode as any).prototype.getAutonomousStabilizationProfile,
		};

		const resolved = (InteractiveMode as any).prototype.resolveAutonomousRunConfig.call(fakeThis);
		expect(resolved.maxOutputPerTurn).toBe(4000);
		expect(resolved.enableBehavioralPrompt).toBe(true);
		expect(resolved.enableNudges).toBe(true);
	});

	test("adds a stabilization preface to the initial autonomous user message", () => {
		const fakeThis: any = {
			session: {
				sessionManager: {
					getEntries: () => [
						{
							type: "custom",
							customType: "runtime_health_snapshot",
							data: {
								version: 1,
								savedAt: new Date().toISOString(),
								xmlFallbackCount: 1,
								degradedTurnCount: 1,
								lastDegradedTurnEvent: {
									type: "degraded_turn",
									severity: "critical",
									stopReason: "max_tokens",
									outputTokens: 15000,
									textLength: 52000,
									reasons: ["truncated_turn"],
								},
							},
						},
					],
				},
			},
			getAutonomousStabilizationProfile: (InteractiveMode as any).prototype.getAutonomousStabilizationProfile,
		};

		const message = (InteractiveMode as any).prototype.buildAutonomousUserMessage.call(fakeThis, "fix it");
		expect(message).toContain("fix it");
		expect(message).toContain("Autonomous stabilization for this run");
		expect(message).toContain("keep responses terse and tool-driven");
		expect(message).toContain("4,000 output tokens");
	});

	test("adds a stabilization preface to the next interactive user message", () => {
		const fakeThis: any = {
			session: {
				sessionManager: {
					getEntries: () => [
						{
							type: "custom",
							customType: "runtime_health_snapshot",
							data: {
								version: 1,
								savedAt: new Date().toISOString(),
								xmlFallbackCount: 1,
								degradedTurnCount: 1,
								lastDegradedTurnEvent: {
									type: "degraded_turn",
									severity: "critical",
									stopReason: "max_tokens",
									outputTokens: 15000,
									textLength: 52000,
									reasons: ["truncated_turn"],
								},
							},
						},
					],
				},
			},
			getAutonomousStabilizationProfile: (InteractiveMode as any).prototype.getAutonomousStabilizationProfile,
		};

		const message = (InteractiveMode as any).prototype.buildInteractiveUserMessage.call(fakeThis, "fix it");
		expect(message).toContain("fix it");
		expect(message).toContain("Runtime stabilization for this turn");
		expect(message).toContain("do not emit XML fallback");
		expect(message).toContain("4,000 output tokens");
	});

	test("shows the last autonomous run ledger in session info", () => {
		const fakeThis: any = {
			session: {
				model: { provider: "provider", id: "model-a" },
				getSessionStats: () => ({
					sessionFile: "/tmp/session.jsonl",
					sessionId: "session-1",
					userMessages: 1,
					assistantMessages: 2,
					toolCalls: 1,
					toolResults: 1,
					totalMessages: 4,
					tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
					cost: 0.01,
				}),
				sessionManager: {
					getEntries: () => [
						{
							type: "custom",
							customType: "runtime_health_snapshot",
							data: {
								version: 1,
								savedAt: "2026-04-11T20:00:00.000Z",
								modelId: "provider/model-a",
								xmlFallbackCount: 1,
								degradedTurnCount: 0,
								lastXmlFallbackEvent: {
									type: "xml_tool_call",
									toolName: "bash",
									arguments: { command: "npm test" },
									severity: "elevated",
									reasons: ["truncated_turn"],
								},
							},
						},
						{
							type: "custom",
							customType: "runtime_health_snapshot",
							data: {
								version: 1,
								savedAt: "2026-04-11T20:05:00.000Z",
								modelId: "provider/model-a",
								xmlFallbackCount: 2,
								degradedTurnCount: 1,
								lastDegradedTurnEvent: {
									type: "degraded_turn",
									severity: "critical",
									stopReason: "max_tokens",
									outputTokens: 15000,
									textLength: 52000,
									reasons: ["truncated_turn", "very_high_output_tokens"],
								},
							},
						},
					],
				},
			},
			sessionManager: { getSessionName: () => "demo" },
			activeAutonomousWorkspace: undefined,
			lastAutonomousWorkspace: undefined,
			lastAutonomousRunResult: {
				stopReason: "complete",
				budgetStatus: { turnsUsed: 3 },
				costSummary: "$0.0010 | 100 in / 50 out",
				checkpointState: {
					consecutiveNoToolTurns: 0,
					completionPromptCount: 0,
					verificationPromptCount: 0,
					truncatedTurnCount: 0,
					outputCapPromptCount: 0,
					consecutiveIntentDriftCount: 2,
					consecutiveIntentFailureCount: 0,
					replanPromptCount: 1,
					narrowScopePromptCount: 0,
					budgetPressureLevel: "elevated",
					budgetTrimPromptCount: 1,
					budgetSqueezePromptCount: 0,
					lastAssessment: "complete",
					verificationSatisfied: true,
					lastVerificationDetail: "npm test",
				},
				ledger: {
					goal: "fix auth retry path",
					status: "complete",
					turnsObserved: 2,
					visualTarget: {
						surface: "landing page",
						goalSummary: "improve the landing page UI",
						acceptanceCriteria: [
							"render without console or network issues",
							"the landing page layout should reflect the requested visual change",
						],
						viewportProfile: "desktop",
						viewportHint: "desktop viewport (for example 1280x900)",
						interactionMode: "interactive",
						interactionHint: "open the hero modal before capture",
						recommendedTool: "interact_then_screenshot",
						actionRecipe: [
							{ type: "click", targetHint: "the hero modal trigger" },
							{ type: "wait", ms: 300 },
						],
					},
					visualIteration: {
						enabled: true,
						phase: "verified",
						screenshotAttempts: 2,
						lastScreenshotDetail: "http://localhost:3000",
						observationSummary: "verified capture for Landing with no console or network issues",
						outstandingIssues: [],
						recentArtifacts: [],
					},
					visualAssessment: {
						target: "landing page",
						latestJudgment: "pass",
						summary: "verified capture for Landing with no console or network issues",
						blockingIssues: [],
						lastEvaluatedDetail: "http://localhost:3000",
						basis: "screenshot_metadata",
					},
					taskJournal: {
						activeSubtask: "Finalize and report verified completion",
						nextAction: "Stop and present the verified result",
						plannedNextStep:
							"Summarize the verified result, cite the supporting source URLs, and note any residual risks.",
						stepRationale:
							"Verification is satisfied, and the final report should cite the supporting sources clearly before stopping.",
						expectedVerification: "Cite source URLs such as https://react.dev/",
						intentStatus: "on_track",
						lastIntentOutcome: "completion matched the planned summarize step",
						planItems: [
							{ key: "inspect", title: "Inspect relevant files", status: "completed" },
							{ key: "implement", title: "Apply workspace changes", status: "completed" },
							{ key: "verify", title: "Verify latest changes", status: "completed" },
							{ key: "summarize", title: "Summarize verified result", status: "completed" },
						],
						completedCheckpoints: [
							"relevant files inspected",
							"workspace changes applied",
							"verification passed: npm test",
						],
						blockedReasons: [],
					},
					planner: {
						phase: "summarizing",
						lane: "research",
						planRevision: 2,
						executionAttempts: 3,
						handoffSummary:
							"Summarize the verified result, cite the supporting source URLs, and note any residual risks. Why: Verification is satisfied, and the final report should cite the supporting sources clearly before stopping.",
					},
					resume: {
						mode: "resume_summarize",
						resumeInstruction:
							"Summarize the verified result, cite the supporting source URLs, and note any residual risks.",
						resumeReason: "Verification is already satisfied, so the run can summarize and stop.",
						lastStableCheckpoint: "verification passed: npm test",
					},
					research: {
						searchQueries: ["React 19 documentation"],
						fetchedUrls: ["https://react.dev/"],
						sourceUrls: ["https://react.dev/", "https://react.dev/blog"],
						preferredSourceUrls: ["https://react.dev/"],
						recentFindings: ["React Docs — https://react.dev/", "Fetched React — https://react.dev/"],
						evidence: {
							status: "sufficient",
							authoritativeSourceCount: 1,
							fetchedSourceCount: 1,
							citedSourceCount: 2,
							findingCount: 2,
							citationReady: true,
							summaryReady: true,
							gaps: [],
						},
					},
					currentFocus: "Updated retry logic and re-ran tests",
					progressDetail: "updated retry logic",
					lastActionType: "verification",
					lastActionDetail: "npm test",
					touchedFiles: ["src/auth.ts"],
					readFiles: ["src/auth.test.ts"],
					recentMutations: ["updated retry logic"],
					verificationAttempts: 1,
					verificationSatisfied: true,
					lastVerificationDetail: "npm test",
					verificationFailures: [],
					residualRisks: ["browser coverage remains thin"],
				},
			},
			xmlFallbackCount: 2,
			degradedTurnCount: 1,
			lastXmlFallbackEvent: {
				type: "xml_tool_call",
				toolName: "bash",
				arguments: { command: "npm test" },
				iteration: 2,
				callCount: 2,
				assistantStopReason: "max_tokens",
				assistantTextLength: 18000,
				severity: "critical",
				reasons: ["truncated_turn", "multiple_xml_calls"],
				continuationMode: "guided",
			},
			lastDegradedTurnEvent: {
				type: "degraded_turn",
				severity: "elevated",
				stopReason: "stop",
				outputTokens: 8200,
				textLength: 26000,
				reasons: ["high_output_tokens", "long_output_text"],
				recoveryHint:
					"Continue from the last concrete point only, keep the next response short, and avoid repeating prior analysis.",
			},
			debugLogger: {
				getArtifacts: () => ({
					sessionDir: "/tmp/ag1-debug/session-123",
					sessionMd: "/tmp/ag1-debug/session-123/session.md",
					sessionCompactMd: "/tmp/ag1-debug/session-123/session.compact.md",
					timelineJson: "/tmp/ag1-debug/session-123/timeline.json",
				}),
			},
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			formatRuntimeHealthSummary: (InteractiveMode as any).prototype.formatRuntimeHealthSummary,
			formatRuntimeHealthTimelineSummary: (InteractiveMode as any).prototype.formatRuntimeHealthTimelineSummary,
			formatRuntimeHealthIssue: (InteractiveMode as any).prototype.formatRuntimeHealthIssue,
			formatDebugArtifactsSummary: (InteractiveMode as any).prototype.formatDebugArtifactsSummary,
			formatRuntimeRecoverySummary: (InteractiveMode as any).prototype.formatRuntimeRecoverySummary,
			formatAutonomousStabilizationSummary: (InteractiveMode as any).prototype.formatAutonomousStabilizationSummary,
			getAutonomousStabilizationProfile: (InteractiveMode as any).prototype.getAutonomousStabilizationProfile,
			formatAutonomousControlSummary: (InteractiveMode as any).prototype.formatAutonomousControlSummary,
			formatAutonomousResearchSummary: (InteractiveMode as any).prototype.formatAutonomousResearchSummary,
			formatAutonomousVisualSummary: (InteractiveMode as any).prototype.formatAutonomousVisualSummary,
			formatAutonomousRecoverySummary: (InteractiveMode as any).prototype.formatAutonomousRecoverySummary,
			getAutonomousRecoveryActions: (InteractiveMode as any).prototype.getAutonomousRecoveryActions,
			formatVisualActionRecipeSummary: (InteractiveMode as any).prototype.formatVisualActionRecipeSummary,
			getLatestPlanArtifact: vi.fn(() => undefined),
		};

		(InteractiveMode as any).prototype.handleSessionCommand.call(fakeThis);

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("Autonomous Run");
		expect(output).toContain("Runtime Health");
		expect(output).toContain("Runtime Timeline");
		expect(output).toContain("Debug Artifacts");
		expect(output).toContain("Runtime Recovery");
		expect(output).toContain("Autonomous Stabilization");
		expect(output).toContain("Output Cap:");
		expect(output).toContain("/tmp/ag1-debug/session-123");
		expect(output).toContain("timeline.json");
		expect(output).toContain("/compact");
		expect(output).toContain("switch models");
		expect(output).toContain("XML Fallbacks:");
		expect(output).toContain("Degraded Turns:");
		expect(output).toContain("Latest XML Fallback:");
		expect(output).toContain("Latest Degraded Turn:");
		expect(output).toContain("2026-04-11T20:05:00.000Z");
		expect(output).toContain("[provider/model-a]");
		expect(output).toContain("guided");
		expect(output).toContain("Autonomous Control");
		expect(output).toContain("Autonomous Research");
		expect(output).toContain("Autonomous Visual");
		expect(output).toContain("Autonomous Recovery");
		expect(output).toContain("Planner Phase:");
		expect(output).toContain("summarizing");
		expect(output).toContain("Resume Mode:");
		expect(output).toContain("resume_summarize");
		expect(output).toContain("Resume Instruction:");
		expect(output).toContain("Stable Checkpoint:");
		expect(output).toContain("Evidence Ready:");
		expect(output).toContain("yes (visual)");
		expect(output).toContain("Budget Pressure:");
		expect(output).toContain("elevated");
		expect(output).toContain("Verification:");
		expect(output).toContain("satisfied (npm test)");
		expect(output).toContain("Next Allowed Action:");
		expect(output).toContain("Summarize the verified result, cite the supporting source URLs");
		expect(output).toContain("Evidence:");
		expect(output).toContain("sufficient");
		expect(output).toContain("State:");
		expect(output).toContain("Intent Drift Count:");
		expect(output).toContain("Replans Issued:");
		expect(output).toContain("/session");
		expect(output).toContain("Stop Reason:");
		expect(output).toContain("Run ledger:");
		expect(output).toContain("src/auth.ts");
		expect(output).toContain("npm test");
		expect(output).toContain("Preferred Sources:");
		expect(output).toContain("https://react.dev/");
		expect(output).toContain("Cited URLs:");
		expect(output).toContain("Active subtask:");
		expect(output).toContain("Plan:");
		expect(output).toContain("Planned next step:");
		expect(output).toContain("Viewport:");
		expect(output).toContain("desktop viewport");
		expect(output).toContain("Interaction:");
		expect(output).toContain("interactive");
		expect(output).toContain("Tool:");
		expect(output).toContain("interact_then_screenshot");
		expect(output).toContain("Flow:");
		expect(output).toContain("open the hero modal before capture");
		expect(output).toContain("Recipe:");
		expect(output).toContain("click the hero modal trigger -> wait 300ms");
		expect(output).toContain("Assessment:");
		expect(output).toContain("landing page");
	});
});

describe("InteractiveMode.handleResearchCommand", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("shows a message when no research artifacts exist", () => {
		const fakeThis: any = {
			session: { sessionManager: { getEntries: () => [] } },
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			showWarning: vi.fn(),
		};

		(InteractiveMode as any).prototype.handleResearchCommand.call(fakeThis, "/research");

		expect(renderAll(fakeThis.chatContainer)).toContain("No research artifacts saved");
	});

	test("shows recent research artifacts compactly", () => {
		const fakeThis: any = {
			session: {
				sessionManager: {
					getEntries: () => [
						{
							type: "custom",
							customType: "research_artifact",
							data: {
								version: 1,
								savedAt: "2026-04-12T10:00:00.000Z",
								kind: "search",
								query: "latest React docs",
								resultCount: 2,
								compressionMode: "ultra",
								sourceUrls: ["https://react.dev/", "https://react.dev/blog"],
							},
						},
						{
							type: "custom",
							customType: "research_artifact",
							data: {
								version: 1,
								savedAt: "2026-04-12T10:01:00.000Z",
								kind: "fetch",
								url: "https://react.dev/",
								title: "React",
								compressionMode: "ultra",
								cacheHit: true,
								preview: "# React\nBuild user interfaces\nInstall from npm\nMore detail",
							},
						},
					],
				},
			},
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			showWarning: vi.fn(),
		};

		(InteractiveMode as any).prototype.handleResearchCommand.call(fakeThis, "/research");

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("Research Artifacts");
		expect(output).toContain("latest React docs");
		expect(output).toContain("https://react.dev/");
		expect(output).toContain("[cached]");
		expect(output).toContain("Build user interfaces");
		expect(output).not.toContain("More detail");
	});
});
