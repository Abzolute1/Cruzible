import { Container } from "@mariozechner/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function renderLastLine(container: Container, width = 120): string {
	const last = container.children[container.children.length - 1];
	if (!last) return "";
	return last.render(width).join("\n");
}

function renderAll(container: Container, width = 120): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

describe("InteractiveMode.showStatus", () => {
	beforeAll(() => {
		// showStatus uses the global theme instance
		initTheme("dark");
	});

	test("coalesces immediately-sequential status messages", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_ONE");

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// second status updates the previous line instead of appending
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
		expect(renderLastLine(fakeThis.chatContainer)).not.toContain("STATUS_ONE");
	});

	test("appends a new status line if something else was added in between", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);

		// Something else gets added to the chat in between status updates
		fakeThis.chatContainer.addChild({ render: () => ["OTHER"], invalidate: () => {} });
		expect(fakeThis.chatContainer.children).toHaveLength(3);

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// adds spacer + text
		expect(fakeThis.chatContainer.children).toHaveLength(5);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
	});
});

describe("InteractiveMode.handleAutonomousCheckpoint", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("updates the live loader message and announces meaningful control changes", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			loadingAnimation: { setMessage: vi.fn() },
			pendingWorkingMessage: undefined,
			lastAutonomousLiveStatus: undefined,
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
			showStatus: (InteractiveMode as any).prototype.showStatus,
			formatAutonomousCheckpointStatus: (InteractiveMode as any).prototype.formatAutonomousCheckpointStatus,
			getAutonomousControlStateFromSnapshot:
				(InteractiveMode as any).prototype.getAutonomousControlStateFromSnapshot,
			formatVisualActionRecipeSummary: (InteractiveMode as any).prototype.formatVisualActionRecipeSummary,
		};

		(InteractiveMode as any).prototype.handleAutonomousCheckpoint.call(fakeThis, {
			phase: "pre_turn",
			iterations: 2,
			stopReason: "unknown",
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
				budgetPressureLevel: "normal",
				budgetTrimPromptCount: 0,
				budgetSqueezePromptCount: 0,
				lastAssessment: "continue",
				verificationSatisfied: false,
				lastVerificationDetail: undefined,
			},
			ledger: {
				goal: "fix it",
				status: "running",
				turnsObserved: 2,
				visualTarget: {
					surface: "checkout page",
					goalSummary: "fix the mobile checkout layout",
					acceptanceCriteria: [
						"render without console or network issues",
						"look correct at the intended mobile viewport and breakpoint",
					],
					viewportProfile: "mobile",
					viewportHint: "mobile viewport (for example 390x844)",
					interactionMode: "interactive",
					interactionHint: "open the cart drawer before capture",
					recommendedTool: "interact_then_screenshot",
					actionRecipe: [
						{ type: "click", targetHint: "the cart drawer toggle" },
						{ type: "wait", ms: 500 },
					],
				},
				visualIteration: {
					enabled: true,
					phase: "recapture",
					screenshotAttempts: 1,
					lastScreenshotDetail: "http://localhost:3000/checkout",
					observationSummary: "latest capture for checkout page with issues: console errors: layout overflow",
					outstandingIssues: ["console errors: layout overflow"],
					recentArtifacts: [],
				},
				visualAssessment: {
					target: "checkout page",
					latestJudgment: "fail",
					summary: "latest visual verification for checkout page found blocking issues: console errors: layout overflow",
					blockingIssues: ["console errors: layout overflow"],
					lastEvaluatedDetail: "http://localhost:3000/checkout",
					basis: "screenshot_metadata",
				},
				taskJournal: {
					activeSubtask: "Replan the next slice",
					nextAction: "Replan into 1-2 concrete steps",
					plannedNextStep: "Replan into 1-2 concrete steps, pick the first step, and execute it immediately.",
					stepRationale: "Repeated drift indicates the current plan is not holding, so the run needs a tighter short-horizon plan.",
					expectedVerification: "npm test",
					intentStatus: "pending",
					lastIntentOutcome: undefined,
					planItems: [],
					completedCheckpoints: [],
					blockedReasons: [],
				},
				currentFocus: "replanning",
				progressDetail: "replanning",
				lastActionType: "other",
				lastActionDetail: "replanning",
				touchedFiles: [],
				readFiles: [],
				recentMutations: [],
				verificationAttempts: 0,
				verificationSatisfied: false,
				lastVerificationDetail: undefined,
				verificationFailures: [],
				residualRisks: [],
			},
		});

		expect(fakeThis.loadingAnimation.setMessage).toHaveBeenCalledWith(
			expect.stringContaining("Autonomous: visual blocker"),
		);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("Autonomous: visual blocker");
		expect(renderLastLine(fakeThis.chatContainer)).toContain("layout overflow");
	});

	test("shows recovery actions when autonomy hard-stops", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			loadingAnimation: { setMessage: vi.fn() },
			pendingWorkingMessage: undefined,
			lastAutonomousLiveStatus: undefined,
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
			activeAutonomousWorkspace: {
				workspaceRoot: "/tmp/ag1-workspace",
				activeCwd: "/tmp/ag1-workspace/app",
				sourceCwd: "/repo/app",
				strategy: "copy",
				description: "filesystem copy fallback",
			},
			lastAutonomousWorkspace: undefined,
			showStatus: (InteractiveMode as any).prototype.showStatus,
			formatAutonomousCheckpointStatus: (InteractiveMode as any).prototype.formatAutonomousCheckpointStatus,
			getAutonomousControlStateFromSnapshot:
				(InteractiveMode as any).prototype.getAutonomousControlStateFromSnapshot,
			getAutonomousRecoveryActions: (InteractiveMode as any).prototype.getAutonomousRecoveryActions,
			formatVisualActionRecipeSummary: (InteractiveMode as any).prototype.formatVisualActionRecipeSummary,
		};

		(InteractiveMode as any).prototype.handleAutonomousCheckpoint.call(fakeThis, {
			phase: "final",
			iterations: 3,
			stopReason: "error",
			costSummary: "$0.0007 | 30 in / 60 out",
			budgetStatus: { turnsUsed: 3 },
			checkpointState: {
				consecutiveNoToolTurns: 0,
				completionPromptCount: 0,
				verificationPromptCount: 0,
				truncatedTurnCount: 0,
				outputCapPromptCount: 0,
				consecutiveIntentDriftCount: 0,
				consecutiveIntentFailureCount: 3,
				replanPromptCount: 0,
				narrowScopePromptCount: 1,
				budgetPressureLevel: "high",
				budgetTrimPromptCount: 1,
				budgetSqueezePromptCount: 0,
				lastAssessment: "continue",
				verificationSatisfied: false,
				lastVerificationDetail: "npm test",
			},
			ledger: {
				goal: "fix it",
				status: "error",
				turnsObserved: 3,
				taskJournal: {
					activeSubtask: "Recover from the blocker",
					nextAction: "Resolve blocker: failed verification: npm test",
					plannedNextStep: "Define the smallest verifiable slice, execute only that slice, and verify it immediately.",
					stepRationale: "Repeated drift or failure indicates the current scope is too broad, so the run must shrink to a smaller verified target.",
					expectedVerification: "npm test",
					intentStatus: "failed",
					lastIntentOutcome: "verification failed: npm test",
					planItems: [],
					completedCheckpoints: [],
					blockedReasons: ["Autonomous run stopped after 3 consecutive failed steps: verification failed: npm test"],
				},
				currentFocus: "recovering blocker",
				progressDetail: "npm test",
				lastActionType: "verification",
				lastActionDetail: "npm test",
				touchedFiles: ["src/app.ts"],
				readFiles: [],
				recentMutations: ["updated retry path"],
				verificationAttempts: 3,
				verificationSatisfied: false,
				lastVerificationDetail: "npm test",
				verificationFailures: ["failed verification: npm test"],
				residualRisks: [],
			},
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("Recovery:");
		expect(output).toContain("/workspace diff");
		expect(output).toContain("/session");
	});

	test("includes the recorded interaction flow in visual recapture status", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			loadingAnimation: { setMessage: vi.fn() },
			pendingWorkingMessage: undefined,
			lastAutonomousLiveStatus: undefined,
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
			showStatus: (InteractiveMode as any).prototype.showStatus,
			formatAutonomousCheckpointStatus: (InteractiveMode as any).prototype.formatAutonomousCheckpointStatus,
			getAutonomousControlStateFromSnapshot:
				(InteractiveMode as any).prototype.getAutonomousControlStateFromSnapshot,
			formatVisualActionRecipeSummary: (InteractiveMode as any).prototype.formatVisualActionRecipeSummary,
		};

		(InteractiveMode as any).prototype.handleAutonomousCheckpoint.call(fakeThis, {
			phase: "post_turn",
			iterations: 3,
			stopReason: "unknown",
			checkpointState: {
				consecutiveNoToolTurns: 0,
				completionPromptCount: 0,
				verificationPromptCount: 1,
				truncatedTurnCount: 0,
				outputCapPromptCount: 0,
				consecutiveIntentDriftCount: 0,
				consecutiveIntentFailureCount: 0,
				replanPromptCount: 0,
				narrowScopePromptCount: 0,
				budgetPressureLevel: "normal",
				budgetTrimPromptCount: 0,
				budgetSqueezePromptCount: 0,
				lastAssessment: "continue",
				verificationSatisfied: false,
				lastVerificationDetail: undefined,
			},
			ledger: {
				goal: "fix checkout drawer",
				status: "running",
				turnsObserved: 3,
				visualTarget: {
					surface: "checkout page",
					goalSummary: "fix the mobile checkout drawer",
					acceptanceCriteria: ["look correct at the intended mobile viewport and breakpoint"],
					viewportProfile: "mobile",
					viewportHint: "mobile viewport (for example 390x844)",
					interactionMode: "interactive",
					interactionHint: "open the cart drawer before capture",
					recommendedTool: "interact_then_screenshot",
					actionRecipe: [
						{ type: "click", targetHint: "the cart drawer toggle" },
						{ type: "wait", ms: 500 },
					],
				},
				visualIteration: {
					enabled: true,
					phase: "recapture",
					screenshotAttempts: 1,
					lastScreenshotDetail: "http://localhost:3000/checkout",
					observationSummary: "baseline capture complete",
					outstandingIssues: [],
					recentArtifacts: [],
				},
				visualAssessment: {
					target: "checkout page",
					latestJudgment: "pending",
					summary: "waiting for a fresh recapture",
					blockingIssues: [],
					lastEvaluatedDetail: "http://localhost:3000/checkout",
					basis: "screenshot_metadata",
				},
				taskJournal: {
					activeSubtask: "Recapture the updated checkout UI",
					nextAction: "Use interact_then_screenshot after opening the drawer",
					plannedNextStep: "Recapture the updated UI and assess the rendered result.",
					stepRationale: "The latest mutation invalidated the previous visual checkpoint.",
					expectedVerification: "Use interact_then_screenshot on the updated checkout drawer",
					intentStatus: "pending",
					lastIntentOutcome: undefined,
					planItems: [],
					completedCheckpoints: [],
					blockedReasons: [],
				},
				currentFocus: "visual verification",
				progressDetail: "waiting for a fresh visual capture",
				lastActionType: "mutation",
				lastActionDetail: "updated drawer layout",
				touchedFiles: ["src/checkout.tsx"],
				readFiles: [],
				recentMutations: ["updated drawer layout"],
				verificationAttempts: 1,
				verificationSatisfied: false,
				lastVerificationDetail: undefined,
				verificationFailures: [],
				residualRisks: [],
			},
		});

		expect(fakeThis.loadingAnimation.setMessage).toHaveBeenCalledWith(
			expect.stringContaining("Autonomous: visual recapture"),
		);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("recapturing checkout page");
		expect(renderLastLine(fakeThis.chatContainer)).toContain("open the cart drawer before capture");
	});

	test("surfaces degraded-turn stabilization during autonomy", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			loadingAnimation: { setMessage: vi.fn() },
			pendingWorkingMessage: undefined,
			lastAutonomousLiveStatus: undefined,
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
			showStatus: (InteractiveMode as any).prototype.showStatus,
			formatAutonomousCheckpointStatus: (InteractiveMode as any).prototype.formatAutonomousCheckpointStatus,
			getAutonomousControlStateFromSnapshot:
				(InteractiveMode as any).prototype.getAutonomousControlStateFromSnapshot,
			formatVisualActionRecipeSummary: (InteractiveMode as any).prototype.formatVisualActionRecipeSummary,
		};

		(InteractiveMode as any).prototype.handleAutonomousCheckpoint.call(fakeThis, {
			phase: "post_turn",
			iterations: 2,
			stopReason: "unknown",
			checkpointState: {
				consecutiveNoToolTurns: 0,
				completionPromptCount: 0,
				verificationPromptCount: 0,
				truncatedTurnCount: 1,
				outputCapPromptCount: 1,
				consecutiveIntentDriftCount: 0,
				consecutiveIntentFailureCount: 0,
				replanPromptCount: 0,
				narrowScopePromptCount: 0,
				budgetPressureLevel: "normal",
				budgetTrimPromptCount: 0,
				budgetSqueezePromptCount: 0,
				lastAssessment: "truncated",
				verificationSatisfied: false,
				lastVerificationDetail: undefined,
				consecutiveDegradedTurnCount: 1,
				consecutiveCriticalDegradedTurnCount: 1,
				lastDegradedTurnSeverity: "critical",
				lastDegradedTurnReasons: ["truncated_turn", "very_high_output_tokens"],
			},
			ledger: {
				goal: "fix it",
				status: "running",
				turnsObserved: 2,
				taskJournal: {
					activeSubtask: "Stabilize the next step",
					nextAction: "Resume from the last concrete point",
					plannedNextStep: "Resume from the last concrete point, make only the next smallest step, and keep the response terse.",
					stepRationale: "The previous turn degraded, so the loop should stabilize before taking on more scope.",
					expectedVerification: "npm test",
					intentStatus: "pending",
					lastIntentOutcome: undefined,
					planItems: [],
					completedCheckpoints: [],
					blockedReasons: [],
				},
				currentFocus: "stabilizing",
				progressDetail: "stabilizing",
				lastActionType: "other",
				lastActionDetail: "stabilizing",
				touchedFiles: [],
				readFiles: [],
				recentMutations: [],
				verificationAttempts: 0,
				verificationSatisfied: false,
				lastVerificationDetail: undefined,
				verificationFailures: [],
				residualRisks: [],
			},
		});

		expect(fakeThis.loadingAnimation.setMessage).toHaveBeenCalledWith(
			expect.stringContaining("Autonomous: stabilizing degraded turn"),
		);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("stabilizing degraded turn");
		expect(renderLastLine(fakeThis.chatContainer)).toContain("truncated_turn");
	});

	test("shows live research status when autonomy is gathering sources", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			loadingAnimation: { setMessage: vi.fn() },
			pendingWorkingMessage: undefined,
			lastAutonomousLiveStatus: undefined,
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
			showStatus: (InteractiveMode as any).prototype.showStatus,
			formatAutonomousCheckpointStatus: (InteractiveMode as any).prototype.formatAutonomousCheckpointStatus,
			getAutonomousControlStateFromSnapshot:
				(InteractiveMode as any).prototype.getAutonomousControlStateFromSnapshot,
			formatVisualActionRecipeSummary: (InteractiveMode as any).prototype.formatVisualActionRecipeSummary,
		};

		(InteractiveMode as any).prototype.handleAutonomousCheckpoint.call(fakeThis, {
			phase: "pre_turn",
			iterations: 1,
			stopReason: "unknown",
			checkpointState: {
				consecutiveNoToolTurns: 0,
				completionPromptCount: 0,
				verificationPromptCount: 0,
				truncatedTurnCount: 0,
				outputCapPromptCount: 0,
				consecutiveIntentDriftCount: 0,
				consecutiveIntentFailureCount: 0,
				replanPromptCount: 0,
				narrowScopePromptCount: 0,
				budgetPressureLevel: "normal",
				budgetTrimPromptCount: 0,
				budgetSqueezePromptCount: 0,
				lastAssessment: "continue",
				verificationSatisfied: false,
				lastVerificationDetail: undefined,
			},
			ledger: {
				goal: "research the latest React 19 docs",
				status: "running",
				turnsObserved: 1,
				research: {
					searchQueries: [],
					fetchedUrls: [],
					sourceUrls: [],
					preferredSourceUrls: [],
					recentFindings: [],
				},
				taskJournal: {
					activeSubtask: "Gather current sources",
					nextAction: "Search current docs",
					plannedNextStep: "Use webSearch to find the most relevant current or authoritative sources, then webFetch the best result before proceeding.",
					stepRationale: "The task depends on external information.",
					expectedVerification: "Carry forward authoritative source URLs from webSearch and webFetch",
					intentStatus: "pending",
					lastIntentOutcome: undefined,
					planItems: [],
					completedCheckpoints: [],
					blockedReasons: [],
				},
				currentFocus: "researching current docs",
				progressDetail: undefined,
				lastActionType: "other",
				lastActionDetail: undefined,
				touchedFiles: [],
				readFiles: [],
				recentMutations: [],
				verificationAttempts: 0,
				verificationSatisfied: false,
				lastVerificationDetail: undefined,
				verificationFailures: [],
				residualRisks: [],
			},
		});

		expect(fakeThis.loadingAnimation.setMessage).toHaveBeenCalledWith(
			expect.stringContaining("Autonomous: researching sources"),
		);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("Autonomous: researching sources");
		expect(renderLastLine(fakeThis.chatContainer)).toContain("webSearch");
	});

	test("shows evidence synthesis when research is sufficient", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			loadingAnimation: { setMessage: vi.fn() },
			pendingWorkingMessage: undefined,
			lastAutonomousLiveStatus: undefined,
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
			showStatus: (InteractiveMode as any).prototype.showStatus,
			formatAutonomousCheckpointStatus: (InteractiveMode as any).prototype.formatAutonomousCheckpointStatus,
			getAutonomousControlStateFromSnapshot:
				(InteractiveMode as any).prototype.getAutonomousControlStateFromSnapshot,
			formatVisualActionRecipeSummary: (InteractiveMode as any).prototype.formatVisualActionRecipeSummary,
		};

		(InteractiveMode as any).prototype.handleAutonomousCheckpoint.call(fakeThis, {
			phase: "pre_turn",
			iterations: 2,
			stopReason: "unknown",
			checkpointState: {
				consecutiveNoToolTurns: 0,
				completionPromptCount: 0,
				verificationPromptCount: 0,
				truncatedTurnCount: 0,
				outputCapPromptCount: 0,
				consecutiveIntentDriftCount: 0,
				consecutiveIntentFailureCount: 0,
				replanPromptCount: 0,
				narrowScopePromptCount: 0,
				budgetPressureLevel: "normal",
				budgetTrimPromptCount: 0,
				budgetSqueezePromptCount: 0,
				lastAssessment: "continue",
				verificationSatisfied: false,
				lastVerificationDetail: undefined,
			},
			ledger: {
				goal: "research the latest React 19 docs",
				status: "running",
				turnsObserved: 2,
				planner: {
					phase: "summarizing",
					lane: "research",
					planRevision: 1,
					executionAttempts: 1,
					handoffSummary: "Research evidence is sufficient. Stop browsing and synthesize the answer from the saved sources.",
				},
				research: {
					searchQueries: ["React 19 documentation"],
					fetchedUrls: ["https://react.dev/"],
					sourceUrls: ["https://react.dev/"],
					preferredSourceUrls: ["https://react.dev/"],
					recentFindings: ["React Docs — https://react.dev/"],
					evidence: {
						status: "sufficient",
						authoritativeSourceCount: 1,
						fetchedSourceCount: 1,
						citedSourceCount: 1,
						findingCount: 1,
						citationReady: true,
						summaryReady: true,
						gaps: [],
					},
				},
				taskJournal: {
					activeSubtask: "Finalize and report verified completion",
					nextAction: "Stop and present the verified result",
					plannedNextStep: "Summarize the source-backed answer from the saved research artifacts, cite the supporting URLs, and stop unless a concrete evidence gap remains.",
					stepRationale: "The run already has enough authoritative evidence, so further browsing would waste budget instead of improving the answer.",
					expectedVerification: "Cite supporting source URLs such as https://react.dev/",
					intentStatus: "pending",
					lastIntentOutcome: undefined,
					planItems: [],
					completedCheckpoints: [],
					blockedReasons: [],
				},
				currentFocus: "synthesizing source-backed answer",
				progressDetail: undefined,
				lastActionType: "other",
				lastActionDetail: undefined,
				touchedFiles: [],
				readFiles: [],
				recentMutations: [],
				verificationAttempts: 0,
				verificationSatisfied: false,
				lastVerificationDetail: undefined,
				verificationFailures: [],
				residualRisks: [],
			},
		});

		expect(fakeThis.loadingAnimation.setMessage).toHaveBeenCalledWith(
			expect.stringContaining("Autonomous: synthesizing evidence"),
		);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("Autonomous: synthesizing evidence");
		expect(renderLastLine(fakeThis.chatContainer)).toContain("Summarize the source-backed answer");
	});

	test("shows verification resume state when saved control state says verification should resume", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			loadingAnimation: { setMessage: vi.fn() },
			pendingWorkingMessage: undefined,
			lastAutonomousLiveStatus: undefined,
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
			showStatus: (InteractiveMode as any).prototype.showStatus,
			formatAutonomousCheckpointStatus: (InteractiveMode as any).prototype.formatAutonomousCheckpointStatus,
			getAutonomousControlStateFromSnapshot:
				(InteractiveMode as any).prototype.getAutonomousControlStateFromSnapshot,
			formatVisualActionRecipeSummary: (InteractiveMode as any).prototype.formatVisualActionRecipeSummary,
		};

		(InteractiveMode as any).prototype.handleAutonomousCheckpoint.call(fakeThis, {
			phase: "pre_turn",
			iterations: 3,
			stopReason: "unknown",
			checkpointState: {
				consecutiveNoToolTurns: 0,
				completionPromptCount: 0,
				verificationPromptCount: 0,
				truncatedTurnCount: 0,
				outputCapPromptCount: 0,
				consecutiveIntentDriftCount: 0,
				consecutiveIntentFailureCount: 0,
				replanPromptCount: 0,
				narrowScopePromptCount: 0,
				budgetPressureLevel: "normal",
				budgetTrimPromptCount: 0,
				budgetSqueezePromptCount: 0,
				lastAssessment: "continue",
				verificationSatisfied: false,
				lastVerificationDetail: undefined,
			},
			ledger: {
				goal: "fix auth retry path",
				status: "running",
				turnsObserved: 3,
				resume: {
					mode: "resume_verify",
					resumeInstruction: "Run verification on the latest changes",
					resumeReason: "The run already finished implementation and should verify before more changes.",
					lastStableCheckpoint: "workspace changes applied",
				},
				taskJournal: {
					activeSubtask: "Validate the recent change",
					nextAction: "Run verification on the latest changes",
					plannedNextStep: "Run verification on the latest changes.",
					stepRationale: "The implementation phase is done enough to justify verification before more changes.",
					expectedVerification: "npm test",
					intentStatus: "pending",
					lastIntentOutcome: undefined,
					planItems: [],
					completedCheckpoints: [],
					blockedReasons: [],
				},
				currentFocus: "verifying latest auth retry changes",
				progressDetail: undefined,
				lastActionType: "other",
				lastActionDetail: undefined,
				touchedFiles: ["src/auth.ts"],
				readFiles: ["src/auth.test.ts"],
				recentMutations: ["updated retry logic"],
				verificationAttempts: 0,
				verificationSatisfied: false,
				lastVerificationDetail: undefined,
				verificationFailures: [],
				residualRisks: [],
			},
		});

		expect(fakeThis.loadingAnimation.setMessage).toHaveBeenCalledWith(
			expect.stringContaining("Autonomous: resuming verification"),
		);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("Autonomous: resuming verification");
	});

	test("shows verified slice readiness when the run is already backed by concrete verification", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			loadingAnimation: { setMessage: vi.fn() },
			pendingWorkingMessage: undefined,
			lastAutonomousLiveStatus: undefined,
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
			showStatus: (InteractiveMode as any).prototype.showStatus,
			formatAutonomousCheckpointStatus: (InteractiveMode as any).prototype.formatAutonomousCheckpointStatus,
			getAutonomousControlStateFromSnapshot:
				(InteractiveMode as any).prototype.getAutonomousControlStateFromSnapshot,
			formatVisualActionRecipeSummary: (InteractiveMode as any).prototype.formatVisualActionRecipeSummary,
		};

		(InteractiveMode as any).prototype.handleAutonomousCheckpoint.call(fakeThis, {
			phase: "pre_turn",
			iterations: 4,
			stopReason: "unknown",
			checkpointState: {
				consecutiveNoToolTurns: 0,
				completionPromptCount: 0,
				verificationPromptCount: 0,
				truncatedTurnCount: 0,
				outputCapPromptCount: 0,
				consecutiveIntentDriftCount: 0,
				consecutiveIntentFailureCount: 0,
				replanPromptCount: 0,
				narrowScopePromptCount: 0,
				budgetPressureLevel: "normal",
				budgetTrimPromptCount: 0,
				budgetSqueezePromptCount: 0,
				lastAssessment: "continue",
				verificationSatisfied: true,
				lastVerificationDetail: "npm test",
			},
			ledger: {
				goal: "fix auth retry path",
				status: "running",
				turnsObserved: 4,
				planner: {
					phase: "summarizing",
					lane: "implementation",
					planRevision: 2,
					executionAttempts: 2,
					handoffSummary: "Summarize the verified result and stop.",
				},
				taskJournal: {
					activeSubtask: "Finalize and report verified completion",
					nextAction: "Stop and present the verified result",
					plannedNextStep: "Summarize the verified result, note any residual risks, and stop.",
					stepRationale: "The latest implementation slice is already backed by concrete verification, so more turns would only add cost.",
					expectedVerification: "npm test",
					intentStatus: "pending",
					lastIntentOutcome: undefined,
					planItems: [],
					completedCheckpoints: [],
					blockedReasons: [],
				},
				currentFocus: "summarizing verified auth change",
				progressDetail: "npm test",
				lastActionType: "verification",
				lastActionDetail: "npm test",
				touchedFiles: ["src/auth.ts"],
				readFiles: ["src/auth.test.ts"],
				recentMutations: ["updated retry logic"],
				verificationAttempts: 1,
				verificationSatisfied: true,
				lastVerificationDetail: "npm test",
				verificationFailures: [],
				residualRisks: [],
			},
		});

		expect(fakeThis.loadingAnimation.setMessage).toHaveBeenCalledWith(
			expect.stringContaining("Autonomous: verified slice ready"),
		);
		expect(fakeThis.lastAutonomousLiveStatus).toContain("Summarize the verified result");
	});
});

describe("InteractiveMode persistent mode strip", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("describes interactive mode near the editor", () => {
		const fakeThis: any = {
			autonomousMode: false,
			planningMode: false,
			getAutonomousStabilizationProfile: () => ({ level: "none", reasons: [] }),
		};

		const line = (InteractiveMode as any).prototype.getPersistentModeLine.call(fakeThis);
		expect(line).toBe("");
	});

	test("includes autonomous stabilization when active", () => {
		const fakeThis: any = {
			autonomousMode: true,
			planningMode: false,
			lastAutonomousLiveStatus: undefined,
			getAutonomousStabilizationProfile: () => ({
				level: "guarded",
				reasons: ["recent degraded turns"],
			}),
			summarizeAutonomousLiveStatus: (InteractiveMode as any).prototype.summarizeAutonomousLiveStatus,
		};

		const line = (InteractiveMode as any).prototype.getPersistentModeLine.call(fakeThis);
		expect(line).toContain("Autonomous Mode Running");
	});

	test("includes the live autonomous control state in the mode strip", () => {
		const fakeThis: any = {
			autonomousMode: true,
			planningMode: false,
			lastAutonomousLiveStatus: "Autonomous: researching sources | turn 2 | https://react.dev/",
			getAutonomousStabilizationProfile: () => ({
				level: "none",
				reasons: [],
			}),
			summarizeAutonomousLiveStatus: (InteractiveMode as any).prototype.summarizeAutonomousLiveStatus,
		};

		const line = (InteractiveMode as any).prototype.getPersistentModeLine.call(fakeThis);
		expect(line).toContain("Autonomous Mode Running");
	});

	test("shows preserved sandbox state in interactive mode strip", () => {
		const fakeThis: any = {
			autonomousMode: false,
			planningMode: false,
			lastAutonomousWorkspace: {
				workspaceRoot: "/tmp/ag1-workspace",
			},
			getAutonomousStabilizationProfile: () => ({ level: "none", reasons: [] }),
		};

		const line = (InteractiveMode as any).prototype.getPersistentModeLine.call(fakeThis);
		expect(line).toBe("");
	});

	test("shows autonomy unavailable in the mode strip for broad unsafe roots", () => {
		const previousHome = process.env.HOME;
		process.env.HOME = "/home/alex";
		try {
			const fakeThis: any = {
				autonomousMode: false,
				planningMode: false,
				sessionManager: { getCwd: () => "/home/alex" },
				lastAutonomousWorkspace: undefined,
				getAutonomousStabilizationProfile: () => ({ level: "none", reasons: [] }),
			};

			const line = (InteractiveMode as any).prototype.getPersistentModeLine.call(fakeThis);
			expect(line).toBe("");
		} finally {
			process.env.HOME = previousHome;
		}
	});

	test("refuses to arm autonomous mode from an unsafe broad root", () => {
		const previousHome = process.env.HOME;
		process.env.HOME = "/home/alex";
		try {
			const fakeThis: any = {
				autonomousMode: false,
				planningMode: true,
				getExecutionMode: () => "planning",
				sessionManager: { getCwd: () => "/home/alex" },
				showWarning: vi.fn(),
				updateModeDisplay: vi.fn(),
				setExecutionMode: vi.fn(),
				showStatus: vi.fn(),
			};

			(InteractiveMode as any).prototype.cycleMode.call(fakeThis);

			expect(fakeThis.autonomousMode).toBe(false);
			expect(fakeThis.showWarning).toHaveBeenCalledWith(
				expect.stringContaining("cannot run from your home directory"),
			);
			expect(fakeThis.showStatus).not.toHaveBeenCalled();
		} finally {
			process.env.HOME = previousHome;
		}
	});

	test("describes planning mode near the editor", () => {
		const fakeThis: any = {
			autonomousMode: false,
			planningMode: true,
			getLatestPlanArtifact: () => ({
				version: 1,
				planId: "plan_1",
				revision: 2,
				status: "draft",
				goal: "Improve plan mode",
				steps: ["Persist plan artifacts", "Add execution promotion"],
				assumptions: [],
				constraints: [],
				risks: [],
				verification: [],
				openQuestions: [],
				rawPlan: "Plan:\n1. Persist plan artifacts\n2. Add execution promotion",
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
			}),
			getAutonomousStabilizationProfile: () => ({ level: "none", reasons: [] }),
		};

		const line = (InteractiveMode as any).prototype.getPersistentModeLine.call(fakeThis);
		expect(line).toBe("");
	});

	test("shows awaiting clarification in planning mode strip", () => {
		const fakeThis: any = {
			autonomousMode: false,
			planningMode: true,
			getLatestPlanArtifact: () => ({
				version: 1,
				planId: "plan_1",
				revision: 3,
				status: "clarifying",
				goal: "Improve plan mode",
				steps: [],
				assumptions: [],
				constraints: [],
				risks: [],
				verification: [],
				openQuestions: ["Do you want to preserve current CLI behavior?"],
				rawPlan: "Questions:\n- Do you want to preserve current CLI behavior?",
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
			}),
			getAutonomousStabilizationProfile: () => ({ level: "none", reasons: [] }),
		};

		const line = (InteractiveMode as any).prototype.getPersistentModeLine.call(fakeThis);
		expect(line).toBe("");
	});

	test("cycles interactive directly to autonomous", () => {
		const fakeThis: any = {
			autonomousMode: false,
			planningMode: false,
			getExecutionMode: () => "interactive",
			sessionManager: { getCwd: () => "/tmp/project" },
			setExecutionMode: vi.fn(),
			showStatus: vi.fn(),
		};

		(InteractiveMode as any).prototype.cycleMode.call(fakeThis);

		expect(fakeThis.setExecutionMode).toHaveBeenCalledWith("autonomous");
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Execution: Autonomous");
	});

	test("cycles planning directly to autonomous without an intermediate planning toggle", () => {
		const fakeThis: any = {
			autonomousMode: false,
			planningMode: true,
			getExecutionMode: () => "planning",
			sessionManager: { getCwd: () => "/tmp/project" },
			setExecutionMode: vi.fn(),
			showStatus: vi.fn(),
		};

		(InteractiveMode as any).prototype.cycleMode.call(fakeThis);

		expect(fakeThis.setExecutionMode).toHaveBeenCalledWith("autonomous");
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Execution: Autonomous");
	});

	test("shows the saved plan review block in the pending area", () => {
		const fakeThis: any = {
			pendingMessagesContainer: new Container(),
			getAllQueuedMessages: () => ({ steering: [], followUp: [] }),
			getLatestPlanArtifact: () => ({
				version: 1,
				planId: "plan_1",
				revision: 1,
				status: "accepted",
				goal: "Refactor runtime bootstrap",
				steps: ["Extract bootstrap coordinator", "Add focused tests"],
				completedStepIndexes: [0],
				assumptions: [],
				constraints: [],
				risks: [],
				verification: [],
				openQuestions: [],
				rawPlan: "Plan:\n1. Extract bootstrap coordinator\n2. Add focused tests",
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
			}),
		};

		(InteractiveMode as any).prototype.updatePendingMessagesDisplay.call(fakeThis);

		const output = renderAll(fakeThis.pendingMessagesContainer);
		expect(output).toContain("Plan Review: v1");
		expect(output).toContain("accepted");
		expect(output).toContain("Refactor runtime bootstrap");
		expect(output).toContain("Progress: 1/2 complete");
		expect(output).toContain("Next: Add focused tests");
		expect(output).toContain("execute next");
	});

	test("shows clarifying questions in the pending review block", () => {
		const fakeThis: any = {
			pendingMessagesContainer: new Container(),
			getAllQueuedMessages: () => ({ steering: [], followUp: [] }),
			getLatestPlanArtifact: () => ({
				version: 1,
				planId: "plan_1",
				revision: 2,
				status: "clarifying",
				goal: "Refactor runtime bootstrap",
				steps: [],
				assumptions: [],
				constraints: [],
				risks: [],
				verification: [],
				openQuestions: ["Should runtime bootstrap stay in the same file?"],
				rawPlan: "Questions:\n- Should runtime bootstrap stay in the same file?",
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
			}),
		};

		(InteractiveMode as any).prototype.updatePendingMessagesDisplay.call(fakeThis);

		const output = renderAll(fakeThis.pendingMessagesContainer);
		expect(output).toContain("Plan Review: v2");
		expect(output).toContain("clarifying");
		expect(output).toContain("Should runtime bootstrap stay in the same file?");
		expect(output).toContain("Interview: 0/1 answered");
		expect(output).toContain("Actions: interview");
	});

	test("shows preserved autonomous workspace context in the pending area", () => {
		const fakeThis: any = {
			pendingMessagesContainer: new Container(),
			getAllQueuedMessages: () => ({ steering: [], followUp: [] }),
			getLatestPlanArtifact: () => undefined,
			activeAutonomousWorkspace: undefined,
			lastAutonomousWorkspace: {
				strategy: "copy",
				workspaceRoot: "/tmp/ag1-sandbox",
				activeCwd: "/tmp/ag1-sandbox/project",
				sourceCwd: "/home/alex/AG1",
			},
		};

		(InteractiveMode as any).prototype.updatePendingMessagesDisplay.call(fakeThis);

		const output = renderAll(fakeThis.pendingMessagesContainer);
		expect(output).toContain("Autonomous Sandbox Preserved");
		expect(output).toContain("State:");
		expect(output).toContain("preserved");
		expect(output).toContain("/tmp/ag1-sandbox");
		expect(output).toContain("/home/alex/AG1");
	});
});

describe("InteractiveMode autonomous resume detection", () => {
	test("picks up the last interrupted autonomous snapshot for continuation prompts", () => {
		const snapshot = {
			version: 1,
			savedAt: "2026-04-12T12:00:00.000Z",
			phase: "post_turn",
			iterations: 2,
			stopReason: "unknown",
			costSummary: "$0.0004 | 20 in / 40 out",
			budgetStatus: { turnsUsed: 2 },
			checkpointState: {},
			ledger: {
				goal: "research the latest React 19 docs",
				taskJournal: { plannedNextStep: "Summarize the source-backed answer.", blockedReasons: [] },
			},
		};
		const fakeThis: any = {
			session: {
				sessionManager: {
					getEntries: () => [
						{
							type: "custom",
							customType: "autonomous_run_snapshot",
							data: snapshot,
						},
					],
				},
			},
			isAutonomousResumeRequest: (InteractiveMode as any).prototype.isAutonomousResumeRequest,
		};

		const result = (InteractiveMode as any).prototype.getAutonomousResumeSnapshot.call(fakeThis, "continue");
		expect(result?.savedAt).toBe("2026-04-12T12:00:00.000Z");
	});

	test("does not resume stale autonomous state for an unrelated new prompt", () => {
		const snapshot = {
			version: 1,
			savedAt: "2026-04-12T12:00:00.000Z",
			phase: "post_turn",
			iterations: 2,
			stopReason: "unknown",
			costSummary: "$0.0004 | 20 in / 40 out",
			budgetStatus: { turnsUsed: 2 },
			checkpointState: {},
			ledger: {
				goal: "research the latest React 19 docs",
				taskJournal: { plannedNextStep: "Summarize the source-backed answer.", blockedReasons: [] },
			},
		};
		const fakeThis: any = {
			session: {
				sessionManager: {
					getEntries: () => [
						{
							type: "custom",
							customType: "autonomous_run_snapshot",
							data: snapshot,
						},
					],
				},
			},
			isAutonomousResumeRequest: (InteractiveMode as any).prototype.isAutonomousResumeRequest,
		};

		const result = (InteractiveMode as any).prototype.getAutonomousResumeSnapshot.call(
			fakeThis,
			"build me a Rust CLI from scratch",
		);
		expect(result).toBeUndefined();
	});
});

describe("InteractiveMode.handleEvent xml fallback", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("surfaces critical XML fallback recovery warnings live", async () => {
		const fakeThis: any = {
			isInitialized: true,
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			footer: { invalidate: vi.fn(), setWarning: vi.fn() },
			xmlFallbackCount: 0,
			lastXmlFallbackEvent: undefined,
			persistRuntimeHealthSnapshot: vi.fn(),
			showWarning: (InteractiveMode as any).prototype.showWarning,
			showStatus: (InteractiveMode as any).prototype.showStatus,
			formatXmlFallbackWarning: (InteractiveMode as any).prototype.formatXmlFallbackWarning,
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		await (InteractiveMode as any).prototype.handleEvent.call(fakeThis, {
			type: "xml_tool_call",
			toolName: "bash",
			arguments: { command: "npm test" },
			iteration: 2,
			callCount: 3,
			assistantStopReason: "max_tokens",
			assistantTextLength: 18000,
			severity: "critical",
			reasons: ["truncated_turn", "very_long_output", "multiple_xml_calls"],
			continuationMode: "guided",
		});

		expect(fakeThis.footer.setWarning).toHaveBeenCalledWith(expect.stringContaining("XML fallback critical"));
		expect(fakeThis.xmlFallbackCount).toBe(1);
		expect(fakeThis.lastXmlFallbackEvent?.severity).toBe("critical");
		expect(fakeThis.persistRuntimeHealthSnapshot).toHaveBeenCalledTimes(1);
		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("Warning:");
		expect(output).toContain("XML fallback critical");
		expect(output).toContain("guided recovery enabled");
		expect(output).toContain("max_tokens");
	});

	test("surfaces critical degraded-turn warnings live", async () => {
		const fakeThis: any = {
			isInitialized: true,
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			footer: { invalidate: vi.fn(), setWarning: vi.fn() },
			degradedTurnCount: 0,
			lastDegradedTurnEvent: undefined,
			persistRuntimeHealthSnapshot: vi.fn(),
			showWarning: (InteractiveMode as any).prototype.showWarning,
			showStatus: (InteractiveMode as any).prototype.showStatus,
			formatDegradedTurnWarning: (InteractiveMode as any).prototype.formatDegradedTurnWarning,
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		await (InteractiveMode as any).prototype.handleEvent.call(fakeThis, {
			type: "degraded_turn",
			severity: "critical",
			stopReason: "max_tokens",
			outputTokens: 15000,
			textLength: 52000,
			reasons: ["truncated_turn", "very_high_output_tokens", "very_long_output_text"],
			recoveryHint: "Continue from the last concrete point only, keep the next response short, and avoid repeating prior analysis.",
		});

		expect(fakeThis.footer.setWarning).toHaveBeenCalledWith(expect.stringContaining("Turn degraded critical"));
		expect(fakeThis.degradedTurnCount).toBe(1);
		expect(fakeThis.lastDegradedTurnEvent?.severity).toBe("critical");
		expect(fakeThis.persistRuntimeHealthSnapshot).toHaveBeenCalledTimes(1);
		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("Warning:");
		expect(output).toContain("Turn degraded critical");
		expect(output).toContain("max_tokens");
		expect(output).toContain("15000");
	});

	test("surfaces provider authentication failures in the footer without degraded-turn handling", async () => {
		const assistantMessage: any = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			provider: "openai",
			model: "gpt-5.4",
			stopReason: "error",
			errorMessage: "401 Your authentication token is not from a valid issuer.",
		};

		const fakeThis: any = {
			isInitialized: true,
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			footer: { invalidate: vi.fn(), setWarning: vi.fn() },
			pendingTools: new Map(),
			pendingToolArgs: new Map(),
			settingsManager: { getShowImages: vi.fn(() => true) },
			streamingComponent: { updateContent: vi.fn() },
			streamingMessage: undefined,
			lastNudgeOutputTokens: 0,
			formatRequestFailureWarning: (InteractiveMode as any).prototype.formatRequestFailureWarning,
		};

		await (InteractiveMode as any).prototype.handleEvent.call(fakeThis, {
			type: "message_end",
			message: assistantMessage,
		});

		expect(fakeThis.footer.setWarning).toHaveBeenCalledWith(
			expect.stringContaining("Authentication failed for openai"),
		);
		expect(fakeThis.footer.setWarning).toHaveBeenCalledWith(expect.stringContaining("Run '/login openai'"));
		expect(fakeThis.footer.setWarning).toHaveBeenCalledWith(expect.stringContaining("Ctrl+L"));
	});
});

describe("InteractiveMode.createExtensionUIContext setTheme", () => {
	test("persists theme changes to settings manager", () => {
		initTheme("dark");

		let currentTheme = "dark";
		const settingsManager = {
			getTheme: vi.fn(() => currentTheme),
			setTheme: vi.fn((theme: string) => {
				currentTheme = theme;
			}),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("light");

		expect(result.success).toBe(true);
		expect(settingsManager.setTheme).toHaveBeenCalledWith("light");
		expect(currentTheme).toBe("light");
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("does not persist invalid theme names", () => {
		initTheme("dark");

		const settingsManager = {
			getTheme: vi.fn(() => "dark"),
			setTheme: vi.fn(),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("__missing_theme__");

		expect(result.success).toBe(false);
		expect(settingsManager.setTheme).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode.showLoadedResources", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	function createShowLoadedResourcesThis(options: {
		quietStartup: boolean;
		verbose?: boolean;
		skills?: Array<{ filePath: string }>;
		skillDiagnostics?: Array<{ type: "warning" | "error" | "collision"; message: string }>;
	}) {
		const fakeThis: any = {
			options: { verbose: options.verbose ?? false },
			chatContainer: new Container(),
			settingsManager: {
				getQuietStartup: () => options.quietStartup,
			},
			session: {
				promptTemplates: [],
				extensionRunner: undefined,
				resourceLoader: {
					getPathMetadata: () => new Map(),
					getAgentsFiles: () => ({ agentsFiles: [] }),
					getSkills: () => ({
						skills: options.skills ?? [],
						diagnostics: options.skillDiagnostics ?? [],
					}),
					getPrompts: () => ({ prompts: [], diagnostics: [] }),
					getExtensions: () => ({ extensions: [], errors: [], runtime: {} }),
					getThemes: () => ({ themes: [], diagnostics: [] }),
				},
			},
			formatDisplayPath: (p: string) => p,
			buildScopeGroups: () => [],
			formatScopeGroups: () => "resource-list",
			getShortPath: (p: string) => p,
			formatDiagnostics: () => "diagnostics",
			getBuiltInCommandConflictDiagnostics: () => [],
		};

		return fakeThis;
	}

	test("does not show verbose listing on quiet startup during reload", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			extensions: [{ path: "/tmp/ext/index.ts" }],
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		expect(fakeThis.chatContainer.children).toHaveLength(0);
	});

	test("still shows diagnostics on quiet startup when requested", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md" }],
			skillDiagnostics: [{ type: "warning", message: "duplicate skill name" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Skill conflicts]");
		expect(output).not.toContain("[Skills]");
	});
});
