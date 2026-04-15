import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import {
	buildPlanRevisionPrompt,
	INTERACTIVE_PLAN_ARTIFACT_TYPE,
	type InteractivePlanArtifact,
} from "../src/modes/interactive/interactive-plan-artifacts.js";

function createArtifact(
	overrides: Partial<InteractivePlanArtifact> = {},
): InteractivePlanArtifact {
	return {
		version: 1,
		planId: "plan_123",
		revision: 1,
		status: "draft",
		goal: "Improve planning mode",
		summary: "Make planning mode reviewable.",
		assumptions: ["Session APIs remain stable"],
		constraints: ["Do not execute in planning mode"],
		steps: ["Persist plan artifacts", "Add execute promotion"],
		risks: ["Mode confusion"],
		verification: ["Run focused tests"],
		openQuestions: [],
		rawPlan: "Plan:\n1. Persist plan artifacts\n2. Add execute promotion",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("InteractiveMode.handlePlanCommand", () => {
	test("accept stores accepted status", async () => {
		const artifact = createArtifact();
		const appendCustomEntry = vi.fn();
		const setExecutionMode = vi.fn();
		const fakeThis: any = {
			getPlanArtifactByRevision: vi.fn(() => artifact),
			sessionManager: { appendCustomEntry },
			setExecutionMode,
			updatePendingMessagesDisplay: vi.fn(),
			updateModeDisplay: vi.fn(),
			showPlanArtifactCard: vi.fn(),
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
			acceptPlanArtifact: (InteractiveMode as any).prototype.acceptPlanArtifact,
		};

		await (InteractiveMode as any).prototype.handlePlanCommand.call(fakeThis, {
			kind: "plan",
			action: "accept",
		});

		expect(appendCustomEntry).toHaveBeenCalledWith(
			INTERACTIVE_PLAN_ARTIFACT_TYPE,
			expect.objectContaining({ status: "accepted", planId: artifact.planId, revision: artifact.revision }),
		);
		expect(setExecutionMode).toHaveBeenCalledWith("interactive");
		expect(fakeThis.showPlanArtifactCard).toHaveBeenCalledWith(
			expect.objectContaining({ status: "accepted", revision: artifact.revision }),
		);
		expect(fakeThis.showStatus).toHaveBeenCalledWith(
			`Accepted plan v${artifact.revision}. Interactive mode ready. Use /plan next, /plan execute, or /plan review.`,
		);
	});

	test("accept in planning mode offers a post-approval handoff", async () => {
		const artifact = createArtifact();
		const appendCustomEntry = vi.fn();
		const setExecutionMode = vi.fn();
		const offerAcceptedPlanHandoff = vi.fn(async () => true);
		const fakeThis: any = {
			planningMode: true,
			getPlanArtifactByRevision: vi.fn(() => artifact),
			sessionManager: { appendCustomEntry },
			setExecutionMode,
			offerAcceptedPlanHandoff,
			updatePendingMessagesDisplay: vi.fn(),
			updateModeDisplay: vi.fn(),
			showPlanArtifactCard: vi.fn(),
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
			acceptPlanArtifact: (InteractiveMode as any).prototype.acceptPlanArtifact,
		};

		await (InteractiveMode as any).prototype.handlePlanCommand.call(fakeThis, {
			kind: "plan",
			action: "accept",
		});

		expect(setExecutionMode).toHaveBeenCalledWith("interactive");
		expect(offerAcceptedPlanHandoff).toHaveBeenCalledWith(
			expect.objectContaining({ status: "accepted", revision: artifact.revision }),
		);
		expect(fakeThis.showStatus).not.toHaveBeenCalledWith(
			`Accepted plan v${artifact.revision}. Interactive mode ready. Use /plan next, /plan execute, or /plan review.`,
		);
	});

	test("accepted-plan handoff can execute the next step immediately", async () => {
		const artifact = createArtifact({
			status: "accepted",
			completedStepIndexes: [0],
			steps: ["Persist plans", "Add review cards", "Promote selected steps"],
		});
		const showPlanWorkflowDialog = vi.fn(async () => "execute_next_step");
		const executePlanArtifact = vi.fn(async () => {});
		const fakeThis: any = {
			showPlanWorkflowDialog,
			executePlanArtifact,
		};

		const handled = await (InteractiveMode as any).prototype.offerAcceptedPlanHandoff.call(fakeThis, artifact);

		expect(handled).toBe(true);
		expect(showPlanWorkflowDialog).toHaveBeenCalled();
		expect(executePlanArtifact).toHaveBeenCalledWith(artifact, 1);
	});

	test("accepted-plan handoff can execute the full plan immediately", async () => {
		const artifact = createArtifact({ status: "accepted" });
		const showPlanWorkflowDialog = vi.fn(async () => "execute_full_plan");
		const executePlanArtifact = vi.fn(async () => {});
		const fakeThis: any = {
			showPlanWorkflowDialog,
			executePlanArtifact,
		};

		const handled = await (InteractiveMode as any).prototype.offerAcceptedPlanHandoff.call(fakeThis, artifact);

		expect(handled).toBe(true);
		expect(executePlanArtifact).toHaveBeenCalledWith(artifact);
	});

	test("accepted-plan handoff can leave the user in interactive mode without execution", async () => {
		const artifact = createArtifact({ status: "accepted" });
		const showPlanWorkflowDialog = vi.fn(async () => "stay_in_interactive_mode");
		const executePlanArtifact = vi.fn(async () => {});
		const fakeThis: any = {
			showPlanWorkflowDialog,
			executePlanArtifact,
		};

		const handled = await (InteractiveMode as any).prototype.offerAcceptedPlanHandoff.call(fakeThis, artifact);

		expect(handled).toBe(false);
		expect(executePlanArtifact).not.toHaveBeenCalled();
	});

	test("accept warns when the plan is still clarifying", async () => {
		const artifact = createArtifact({
			status: "clarifying",
			steps: [],
			openQuestions: ["Which language should this use?"],
		});
		const fakeThis: any = {
			getPlanArtifactByRevision: vi.fn(() => artifact),
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};

		await (InteractiveMode as any).prototype.handlePlanCommand.call(fakeThis, {
			kind: "plan",
			action: "accept",
		});

		expect(fakeThis.showWarning).toHaveBeenCalledWith(
			"Answer the clarifying questions first with /plan interview before accepting the plan.",
		);
	});

	test("history renders recent saved plan revisions", async () => {
		const artifacts = [
			createArtifact({ revision: 3, status: "accepted", feedback: "narrow the scope" }),
			createArtifact({ revision: 2, status: "draft" }),
		];
		const fakeThis: any = {
			getPlanArtifacts: () => artifacts,
			chatContainer: { addChild: vi.fn() },
			ui: { requestRender: vi.fn() },
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};

		await (InteractiveMode as any).prototype.handlePlanCommand.call(fakeThis, {
			kind: "plan",
			action: "history",
		});

		expect(fakeThis.showWarning).not.toHaveBeenCalled();
		expect(fakeThis.chatContainer.addChild).toHaveBeenCalledTimes(2);
		expect(fakeThis.ui.requestRender).toHaveBeenCalled();
	});

	test("routes renders planner and executor model routing summary", async () => {
		const fakeThis: any = {
			formatPlanRouteSummaryLines: vi.fn(() => ["Plan Routing", "Planning model: openai/gpt-5.4"]),
			chatContainer: { addChild: vi.fn() },
			ui: { requestRender: vi.fn() },
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};

		await (InteractiveMode as any).prototype.handlePlanCommand.call(fakeThis, {
			kind: "plan",
			action: "routes",
		});

		expect(fakeThis.formatPlanRouteSummaryLines).toHaveBeenCalled();
		expect(fakeThis.chatContainer.addChild).toHaveBeenCalledTimes(2);
		expect(fakeThis.ui.requestRender).toHaveBeenCalled();
	});

	test("planner-model route command stores the resolved model reference", async () => {
		const model = { provider: "openai", id: "gpt-5.4" };
		const fakeThis: any = {
			handlePlanModelRouteCommand: vi.fn(async () => {}),
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};

		await (InteractiveMode as any).prototype.handlePlanCommand.call(fakeThis, {
			kind: "plan",
			action: "planner-model",
			modelRef: "openai/gpt-5.4",
		});

		expect(fakeThis.handlePlanModelRouteCommand).toHaveBeenCalledWith("planning", "openai/gpt-5.4");
		expect(model.provider).toBe("openai");
	});

	test("executor-model route command delegates to execution route handling", async () => {
		const fakeThis: any = {
			handlePlanModelRouteCommand: vi.fn(async () => {}),
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};

		await (InteractiveMode as any).prototype.handlePlanCommand.call(fakeThis, {
			kind: "plan",
			action: "executor-model",
			modelRef: "clear",
		});

		expect(fakeThis.handlePlanModelRouteCommand).toHaveBeenCalledWith("execution", "clear");
	});

	test("show targets a specific saved revision", async () => {
		const artifact = createArtifact({ revision: 2, status: "accepted" });
		const showPlanArtifactCard = vi.fn();
		const fakeThis: any = {
			getPlanArtifactByRevision: vi.fn(() => artifact),
			showPlanArtifactCard,
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};

		await (InteractiveMode as any).prototype.handlePlanCommand.call(fakeThis, {
			kind: "plan",
			action: "show",
			revision: 2,
		});

		expect(fakeThis.getPlanArtifactByRevision).toHaveBeenCalledWith(2);
		expect(fakeThis.showWarning).not.toHaveBeenCalled();
		expect(showPlanArtifactCard).toHaveBeenCalledWith(artifact, { expanded: true });
	});

	test("revise switches to planning mode and reruns planning with feedback", async () => {
		const artifact = createArtifact({ revision: 2, status: "accepted" });
		const setExecutionMode = vi.fn();
		const runPlanningPrompt = vi.fn(async () => {});
		const fakeThis: any = {
			getPlanArtifactByRevision: vi.fn(() => artifact),
			setExecutionMode,
			runPlanningPrompt,
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};

		await (InteractiveMode as any).prototype.handlePlanCommand.call(fakeThis, {
			kind: "plan",
			action: "revise",
			feedback: "Split the plan into smaller verified steps",
		});

		expect(setExecutionMode).toHaveBeenCalledWith("planning");
		expect(runPlanningPrompt).toHaveBeenCalledWith(`Revise plan v${artifact.revision} for: ${artifact.goal}`, {
			goal: artifact.goal,
			previousArtifact: artifact,
			feedback: "Split the plan into smaller verified steps",
			hiddenPromptAddendum: buildPlanRevisionPrompt(artifact, "Split the plan into smaller verified steps"),
		});
	});

	test("execute promotes an accepted plan into interactive execution", async () => {
		const artifact = createArtifact({ status: "accepted" });
		const executePlanArtifact = vi.fn(async () => {});
		const fakeThis: any = {
			getPlanArtifactByRevision: vi.fn(() => artifact),
			executePlanArtifact,
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};

		await (InteractiveMode as any).prototype.handlePlanCommand.call(fakeThis, {
			kind: "plan",
			action: "execute",
		});

		expect(executePlanArtifact).toHaveBeenCalledWith(artifact);
	});

	test("runPlanningPrompt applies the configured planning model route before prompting", async () => {
		const ensurePreferredModeModel = vi.fn(async () => {});
		const prompt = vi.fn(async () => {});
		const persistLatestPlanArtifact = vi.fn(() => undefined);
		const fakeThis: any = {
			getAutonomousStabilizationProfile: vi.fn(() => ({ level: "none", reasons: [] })),
			ensurePreferredModeModel,
			shouldAllowPlanningInspection: vi.fn(() => false),
			applySafetyPolicy: vi.fn(),
			session: { prompt },
			buildPlanningUserMessage: (InteractiveMode as any).prototype.buildPlanningUserMessage,
			persistLatestPlanArtifact,
			updatePendingMessagesDisplay: vi.fn(),
			updateModeDisplay: vi.fn(),
			showStatus: vi.fn(),
		};

		await (InteractiveMode as any).prototype.runPlanningPrompt.call(fakeThis, "Plan the feature");

		expect(ensurePreferredModeModel).toHaveBeenCalledWith("planning");
		expect(fakeThis.shouldAllowPlanningInspection).toHaveBeenCalledWith("Plan the feature", undefined);
		expect(prompt).toHaveBeenCalled();
	});

	test("runPlanningPrompt still prompts the model for generic greenfield requests", async () => {
		const prompt = vi.fn(async () => {});
		const persistLatestPlanArtifact = vi.fn(() => undefined);
		const fakeThis: any = {
			getAutonomousStabilizationProfile: vi.fn(() => ({ level: "none", reasons: [] })),
			ensurePreferredModeModel: vi.fn(async () => {}),
			shouldAllowPlanningInspection: vi.fn(() => false),
			applySafetyPolicy: vi.fn(),
			session: { prompt },
			buildPlanningUserMessage: (InteractiveMode as any).prototype.buildPlanningUserMessage,
			persistLatestPlanArtifact,
			updatePendingMessagesDisplay: vi.fn(),
			updateModeDisplay: vi.fn(),
			showStatus: vi.fn(),
		};

		await (InteractiveMode as any).prototype.runPlanningPrompt.call(fakeThis, "let's plan out a snake game");

		expect(prompt).toHaveBeenCalled();
		expect(persistLatestPlanArtifact).toHaveBeenCalled();
	});

	test("runPlanningPrompt does not short-circuit wrapper phrasing before prompting the model", async () => {
		const prompt = vi.fn(async () => {});
		const persistLatestPlanArtifact = vi.fn(() => undefined);
		const fakeThis: any = {
			getAutonomousStabilizationProfile: vi.fn(() => ({ level: "none", reasons: [] })),
			ensurePreferredModeModel: vi.fn(async () => {}),
			shouldAllowPlanningInspection: vi.fn(() => false),
			applySafetyPolicy: vi.fn(),
			session: { prompt },
			buildPlanningUserMessage: (InteractiveMode as any).prototype.buildPlanningUserMessage,
			persistLatestPlanArtifact,
			updatePendingMessagesDisplay: vi.fn(),
			updateModeDisplay: vi.fn(),
			showStatus: vi.fn(),
		};

		await (InteractiveMode as any).prototype.runPlanningPrompt.call(
			fakeThis,
			"Hey, let's enter planmode for a snake game!",
		);

		expect(prompt).toHaveBeenCalled();
		expect(persistLatestPlanArtifact).toHaveBeenCalled();
	});

	test("runPlanningPrompt forces a hybrid draft-plus-open-questions reply into clarifying interview flow", async () => {
		const prompt = vi.fn(async () => {});
		const appendCustomEntry = vi.fn();
		const showImmediatePlanActionSelector = vi.fn(async () => {});
		const fakeThis: any = {
			getAutonomousStabilizationProfile: vi.fn(() => ({ level: "none", reasons: [] })),
			ensurePreferredModeModel: vi.fn(async () => {}),
			shouldAllowPlanningInspection: vi.fn(() => false),
			applySafetyPolicy: vi.fn(),
			session: {
				prompt,
				getLastAssistantText: () => `Summary

Plan to implement a basic snake game with core mechanics and a clean architecture.

Steps
1. Initialize game window or canvas.
2. Implement snake movement.
3. Add food spawning logic.

Open Questions
- Target language?
- Platform/interface?`,
			},
			sessionManager: { appendCustomEntry },
			buildPlanningUserMessage: (InteractiveMode as any).prototype.buildPlanningUserMessage,
			persistLatestPlanArtifact: (InteractiveMode as any).prototype.persistLatestPlanArtifact,
			showImmediatePlanActionSelector,
			updatePendingMessagesDisplay: vi.fn(),
			updateModeDisplay: vi.fn(),
			showStatus: vi.fn(),
		};

		await (InteractiveMode as any).prototype.runPlanningPrompt.call(fakeThis, "let's plan out a snake game");

		expect(prompt).toHaveBeenCalled();
		expect(appendCustomEntry).toHaveBeenCalledWith(
			INTERACTIVE_PLAN_ARTIFACT_TYPE,
			expect.objectContaining({ status: "clarifying", steps: [], goal: "a snake game" }),
		);
		expect(showImmediatePlanActionSelector).toHaveBeenCalledWith(
			expect.objectContaining({ status: "clarifying", openQuestions: ["Target language?", "Platform/interface?"] }),
		);
	});

	test("runPlanningPrompt falls back to clarifying interview after unusable model output", async () => {
		const prompt = vi.fn(async () => {});
		const appendCustomEntry = vi.fn();
		const showImmediatePlanActionSelector = vi.fn(async () => {});
		const fakeThis: any = {
			getAutonomousStabilizationProfile: vi.fn(() => ({ level: "none", reasons: [] })),
			ensurePreferredModeModel: vi.fn(async () => {}),
			shouldAllowPlanningInspection: vi.fn(() => false),
			applySafetyPolicy: vi.fn(),
			session: {
				prompt,
				getLastAssistantText: () => "Yes, let's do that.",
			},
			sessionManager: { appendCustomEntry },
			buildPlanningUserMessage: (InteractiveMode as any).prototype.buildPlanningUserMessage,
			persistLatestPlanArtifact: (InteractiveMode as any).prototype.persistLatestPlanArtifact,
			showImmediatePlanActionSelector,
			updatePendingMessagesDisplay: vi.fn(),
			updateModeDisplay: vi.fn(),
			showStatus: vi.fn(),
		};

		await (InteractiveMode as any).prototype.runPlanningPrompt.call(fakeThis, "let's plan out a snake game");

		expect(prompt).toHaveBeenCalled();
		expect(appendCustomEntry).toHaveBeenCalledWith(
			INTERACTIVE_PLAN_ARTIFACT_TYPE,
			expect.objectContaining({
				status: "clarifying",
				openQuestions: ["Target language?", "Target interface/platform?", "Feature scope?"],
			}),
		);
		expect(showImmediatePlanActionSelector).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "clarifying",
				openQuestions: ["Target language?", "Target interface/platform?", "Feature scope?"],
			}),
		);
	});

	test("suppresses planning-mode tool rendering for tool-call-only assistant messages", () => {
		const fakeThis: any = {
			planningMode: true,
			shouldSuppressAssistantMessage: vi.fn(() => false),
			hasVisibleAssistantContent: (InteractiveMode as any).prototype.hasVisibleAssistantContent,
		};

		const result = (InteractiveMode as any).prototype.shouldSuppressAssistantToolRendering.call(fakeThis, {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_1",
					name: "webSearch",
					arguments: { query: "snake game" },
				},
			],
		});

		expect(result).toBe(true);
	});

	test("extracts question-mark-delimited interview choices from parenthetical lists", () => {
		const fakeThis: any = {
			splitPlanInterviewChoiceOptions: (InteractiveMode as any).prototype.splitPlanInterviewChoiceOptions,
		};

		const options = (InteractiveMode as any).prototype.getPlanInterviewChoiceOptions.call(
			fakeThis,
			"Target language? (Python with pygame? JavaScript for web? C++/C# for terminal? Rust? Go?)",
		);

		expect(options).toEqual([
			"Python with pygame",
			"JavaScript for web",
			"C++/C# for terminal",
			"Rust",
			"Go",
		]);
	});

	test("prefers normalized artifact option sets for interview selectors", () => {
		const artifact = createArtifact({
			status: "clarifying",
			steps: [],
			openQuestions: ["Target language?"],
			clarificationOptionSets: [["Python", "JavaScript/TypeScript", "Rust"]],
		});
		const fakeThis: any = {
			getPlanInterviewChoiceOptions: vi.fn(() => ["fallback"]),
		};

		const options = (InteractiveMode as any).prototype.getPlanInterviewQuestionChoiceOptions.call(fakeThis, artifact, 0);

		expect(options).toEqual(["Python", "JavaScript/TypeScript", "Rust"]);
		expect(fakeThis.getPlanInterviewChoiceOptions).not.toHaveBeenCalled();
	});

	test("executePlanArtifact applies the configured execution model route before prompting", async () => {
		const artifact = createArtifact({ status: "accepted" });
		const ensurePreferredModeModel = vi.fn(async () => {});
		const prompt = vi.fn(async () => {});
		const persistPlanExecutionReview = vi.fn();
		const fakeThis: any = {
			sessionManager: { appendCustomEntry: vi.fn() },
			setExecutionMode: vi.fn(),
			ensurePreferredModeModel,
			updatePendingMessagesDisplay: vi.fn(),
			updateModeDisplay: vi.fn(),
			showPlanArtifactCard: vi.fn(),
			session: { prompt, getLastAssistantText: vi.fn(() => "done") },
			persistPlanExecutionReview,
			buildInteractiveUserMessage: (value: string) => value,
		};

		await (InteractiveMode as any).prototype.executePlanArtifact.call(fakeThis, artifact);

		expect(ensurePreferredModeModel).toHaveBeenCalledWith("execution");
		expect(prompt).toHaveBeenCalled();
		expect(persistPlanExecutionReview).toHaveBeenCalledWith(expect.objectContaining({ status: "executing" }), 0);
	});

	test("persistPlanExecutionReview warns when the assistant output is not a valid structured execution review", () => {
		const artifact = createArtifact({
			status: "executing",
			executionStepIndex: 0,
			executionStep: "Audit plan transitions",
		});
		const showWarning = vi.fn();
		const fakeThis: any = {
			session: { getLastAssistantText: vi.fn(() => "I changed some code and it seems okay.") },
			sessionManager: { appendCustomEntry: vi.fn() },
			updatePendingMessagesDisplay: vi.fn(),
			updateModeDisplay: vi.fn(),
			showPlanArtifactCard: vi.fn(),
			showStatus: vi.fn(),
			showWarning,
		};

		(InteractiveMode as any).prototype.persistPlanExecutionReview.call(fakeThis, artifact, 0);

		expect(showWarning).toHaveBeenCalledWith(
			"Execution output did not include a valid structured review. Expected headings: Execution Status, Execution Summary, Files Touched, Verification, Remaining, Blockers.",
		);
		expect(fakeThis.sessionManager.appendCustomEntry).not.toHaveBeenCalled();
	});

	test("next executes the next incomplete step from the accepted plan", async () => {
		const artifact = createArtifact({ status: "accepted", completedStepIndexes: [0] });
		const executePlanArtifact = vi.fn(async () => {});
		const fakeThis: any = {
			getPlanArtifactByRevision: vi.fn(() => artifact),
			executePlanArtifact,
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
			executeNextPlanStep: (InteractiveMode as any).prototype.executeNextPlanStep,
		};

		await (InteractiveMode as any).prototype.handlePlanCommand.call(fakeThis, {
			kind: "plan",
			action: "next",
		});

		expect(executePlanArtifact).toHaveBeenCalledWith(artifact, 1);
	});

	test("step executes a selected accepted plan step directly", async () => {
		const artifact = createArtifact({ status: "accepted" });
		const executePlanArtifact = vi.fn(async () => {});
		const fakeThis: any = {
			getPlanArtifactByRevision: vi.fn(() => artifact),
			executePlanArtifact,
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};

		await (InteractiveMode as any).prototype.handlePlanCommand.call(fakeThis, {
			kind: "plan",
			action: "step",
			stepIndex: 1,
		});

		expect(executePlanArtifact).toHaveBeenCalledWith(artifact, 1);
	});

	test("answer routes clarifying feedback back into planning", async () => {
		const artifact = createArtifact({
			revision: 2,
			status: "clarifying",
			steps: [],
			openQuestions: ["Should runtime bootstrap stay in the same file?"],
		});
		const answerClarifyingPlanArtifact = vi.fn(async () => {});
		const fakeThis: any = {
			getPlanArtifactByRevision: vi.fn(() => artifact),
			answerClarifyingPlanArtifact,
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};

		await (InteractiveMode as any).prototype.handlePlanCommand.call(fakeThis, {
			kind: "plan",
			action: "answer",
			feedback: "Keep it in the same file for now.",
		});

		expect(answerClarifyingPlanArtifact).toHaveBeenCalledWith(artifact, "Keep it in the same file for now.");
	});

	test("extracts selector choices from structured interview questions", () => {
		const fakeThis: any = {
			splitPlanInterviewChoiceOptions: (InteractiveMode as any).prototype.splitPlanInterviewChoiceOptions,
		};
		const options = (InteractiveMode as any).prototype.getPlanInterviewChoiceOptions.call(
			fakeThis,
			"Target language/platform: Python (terminal/console), JavaScript (browser), or another language?",
		);

		expect(options).toEqual(["Python (terminal/console)", "JavaScript (browser)", "another language"]);
	});

	test("extracts selector choices from parenthetical interview questions", () => {
		const fakeThis: any = {
			splitPlanInterviewChoiceOptions: (InteractiveMode as any).prototype.splitPlanInterviewChoiceOptions,
		};
		const options = (InteractiveMode as any).prototype.getPlanInterviewChoiceOptions.call(
			fakeThis,
			"What programming language do you want (Python, JavaScript/TypeScript, C++, Java, etc.)?",
		);

		expect(options).toEqual(["Python", "JavaScript/TypeScript", "C++", "Java"]);
	});

	test("interview opens the clarifying interview flow", async () => {
		const artifact = createArtifact({
			revision: 2,
			status: "clarifying",
			steps: [],
			openQuestions: ["Should runtime bootstrap stay in the same file?"],
		});
		const showPlanInterview = vi.fn(async () => {});
		const fakeThis: any = {
			getPlanArtifactByRevision: vi.fn(() => artifact),
			showPlanInterview,
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};

		await (InteractiveMode as any).prototype.handlePlanCommand.call(fakeThis, {
			kind: "plan",
			action: "interview",
		});

		expect(showPlanInterview).toHaveBeenCalledWith(artifact);
	});

	test("done marks a selected plan step complete", async () => {
		const artifact = createArtifact({ status: "accepted" });
		const markPlanStepComplete = vi.fn(async () => {});
		const fakeThis: any = {
			getPlanArtifactByRevision: vi.fn(() => artifact),
			markPlanStepComplete,
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};

		await (InteractiveMode as any).prototype.handlePlanCommand.call(fakeThis, {
			kind: "plan",
			action: "done",
			stepIndex: 1,
		});

		expect(markPlanStepComplete).toHaveBeenCalledWith(artifact, 1);
	});

	test("reopen reopens a completed plan step", async () => {
		const artifact = createArtifact({ status: "accepted", completedStepIndexes: [0, 1] });
		const reopenPlanStep = vi.fn(async () => {});
		const fakeThis: any = {
			getPlanArtifactByRevision: vi.fn(() => artifact),
			reopenPlanStep,
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};

		await (InteractiveMode as any).prototype.handlePlanCommand.call(fakeThis, {
			kind: "plan",
			action: "reopen",
			stepIndex: 0,
		});

		expect(reopenPlanStep).toHaveBeenCalledWith(artifact, 0);
	});

	test("execute warns when a selected revision is not accepted yet", async () => {
		const artifact = createArtifact({ revision: 3, status: "draft" });
		const fakeThis: any = {
			getPlanArtifactByRevision: vi.fn(() => artifact),
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};

		await (InteractiveMode as any).prototype.handlePlanCommand.call(fakeThis, {
			kind: "plan",
			action: "execute",
			revision: 3,
		});

		expect(fakeThis.showWarning).toHaveBeenCalledWith(
			"Accept plan revision 3 first with /plan accept 3 before executing it.",
		);
	});

	test("reject stores rejected status", async () => {
		const artifact = createArtifact({ revision: 2, status: "draft" });
		const appendCustomEntry = vi.fn();
		const fakeThis: any = {
			getPlanArtifactByRevision: vi.fn(() => artifact),
			sessionManager: { appendCustomEntry },
			updatePendingMessagesDisplay: vi.fn(),
			updateModeDisplay: vi.fn(),
			showPlanArtifactCard: vi.fn(),
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
			rejectPlanArtifact: (InteractiveMode as any).prototype.rejectPlanArtifact,
		};

		await (InteractiveMode as any).prototype.handlePlanCommand.call(fakeThis, {
			kind: "plan",
			action: "reject",
			revision: 2,
		});

		expect(appendCustomEntry).toHaveBeenCalledWith(
			INTERACTIVE_PLAN_ARTIFACT_TYPE,
			expect.objectContaining({ status: "rejected", revision: 2 }),
		);
		expect(fakeThis.showPlanArtifactCard).toHaveBeenCalledWith(
			expect.objectContaining({ status: "rejected", revision: 2 }),
		);
	});

	test("persistLatestPlanArtifact does not render a clarifying card before the interview opens", () => {
		const appendCustomEntry = vi.fn();
		const showPlanArtifactCard = vi.fn();
		const fakeThis: any = {
			session: {
				getLastAssistantText: () =>
					"Summary\n\nPlanning a snake game requires a few choices first.\n\nClarifying Questions\n\n1. Target language: Python, TypeScript, or something else?\n2. Platform/interface: terminal, desktop GUI, or web browser?",
			},
			sessionManager: { appendCustomEntry },
			showPlanArtifactCard,
		};

		const artifact = (InteractiveMode as any).prototype.persistLatestPlanArtifact.call(fakeThis, {
			goal: "lets plan out a snake game",
		});

		expect(artifact.status).toBe("clarifying");
		expect(appendCustomEntry).toHaveBeenCalled();
		expect(showPlanArtifactCard).not.toHaveBeenCalled();
	});

	test("persistLatestPlanArtifact synthesizes a clarifying interview when generic planning output has no structure", () => {
		const appendCustomEntry = vi.fn();
		const showPlanArtifactCard = vi.fn();
		const fakeThis: any = {
			session: {
				getLastAssistantText: () => "Yes, let's do that.",
			},
			sessionManager: { appendCustomEntry },
			showPlanArtifactCard,
		};

		const artifact = (InteractiveMode as any).prototype.persistLatestPlanArtifact.call(fakeThis, {
			goal: "let's plan out a snake game",
		});

		expect(artifact.status).toBe("clarifying");
		expect(artifact.openQuestions).toEqual(["Target language?", "Target interface/platform?", "Feature scope?"]);
		expect(appendCustomEntry).toHaveBeenCalled();
		expect(showPlanArtifactCard).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode.showPlanReviewSelector", () => {
	test("offers continue interview and continue planning for partially answered clarifying revisions", () => {
		const artifact = createArtifact({
			revision: 5,
			status: "clarifying",
			steps: [],
			openQuestions: ["Which runtime should this target?", "Should this stay in one file?"],
			clarificationAnswers: ["Node.js", ""],
		});
		const actions = (InteractiveMode as any).prototype.getPlanReviewActions.call({}, artifact);
		expect(actions).toEqual([
			{ id: "show_revision", label: "Show revision", hotkey: "s" },
			{ id: "continue_interview", label: "Continue interview", hotkey: "i" },
			{ id: "continue_planning", label: "Continue planning", hotkey: "p" },
			{ id: "reject_revision", label: "Reject revision", hotkey: "x" },
			{ id: "clear_revision", label: "Clear revision", hotkey: "d" },
		]);
	});

	test("routes accepted revisions into execute via the selector flow", async () => {
		const artifact = createArtifact({ revision: 4, status: "accepted" });
		const showExtensionSelector = vi
			.fn()
			.mockResolvedValueOnce(`v4 • accepted • progress 0/2 • ${artifact.goal} • next: ${artifact.steps[0]}`)
		const showPlanWorkflowDialog = vi.fn().mockResolvedValueOnce("execute_full_plan");
		const handlePlanCommand = vi.fn(async () => {});
		const fakeThis: any = {
			getPlanArtifacts: () => [artifact],
			formatPlanSelectorOption: (InteractiveMode as any).prototype.formatPlanSelectorOption,
			getPlanReviewActions: (InteractiveMode as any).prototype.getPlanReviewActions,
			showExtensionSelector,
			showPlanWorkflowDialog,
			handlePlanCommand,
			showWarning: vi.fn(),
			handlePlanReviewAction: (InteractiveMode as any).prototype.handlePlanReviewAction,
		};

		await (InteractiveMode as any).prototype.showPlanReviewSelector.call(fakeThis);

		expect(handlePlanCommand).toHaveBeenCalledWith({ kind: "plan", action: "execute", revision: 4 });
	});

	test("routes accepted revisions into step execution via the selector flow", async () => {
		const artifact = createArtifact({ revision: 4, status: "accepted" });
		const showExtensionSelector = vi
			.fn()
			.mockResolvedValueOnce(`v4 • accepted • progress 0/2 • ${artifact.goal} • next: ${artifact.steps[0]}`)
			.mockResolvedValueOnce(`2. ${artifact.steps[1]}`);
		const showPlanWorkflowDialog = vi.fn().mockResolvedValueOnce("execute_selected_step");
		const executePlanArtifact = vi.fn(async () => {});
		const fakeThis: any = {
			getPlanArtifacts: () => [artifact],
			formatPlanSelectorOption: (InteractiveMode as any).prototype.formatPlanSelectorOption,
			getPlanReviewActions: (InteractiveMode as any).prototype.getPlanReviewActions,
			getPlanStepSelectorOptions: (InteractiveMode as any).prototype.getPlanStepSelectorOptions,
			showExtensionSelector,
			showPlanWorkflowDialog,
			executePlanArtifact,
			showWarning: vi.fn(),
			handlePlanReviewAction: (InteractiveMode as any).prototype.handlePlanReviewAction,
		};

		await (InteractiveMode as any).prototype.showPlanReviewSelector.call(fakeThis);

		expect(executePlanArtifact).toHaveBeenCalledWith(artifact, 1);
	});

	test("routes accepted revisions into mark-step-complete via the selector flow", async () => {
		const artifact = createArtifact({ revision: 4, status: "accepted" });
		const showExtensionSelector = vi
			.fn()
			.mockResolvedValueOnce(`v4 • accepted • progress 0/2 • ${artifact.goal} • next: ${artifact.steps[0]}`)
			.mockResolvedValueOnce(`1. ${artifact.steps[0]}`);
		const showPlanWorkflowDialog = vi.fn().mockResolvedValueOnce("mark_step_complete");
		const markPlanStepComplete = vi.fn(async () => {});
		const fakeThis: any = {
			getPlanArtifacts: () => [artifact],
			formatPlanSelectorOption: (InteractiveMode as any).prototype.formatPlanSelectorOption,
			getPlanReviewActions: (InteractiveMode as any).prototype.getPlanReviewActions,
			getPlanStepSelectorOptions: (InteractiveMode as any).prototype.getPlanStepSelectorOptions,
			showExtensionSelector,
			showPlanWorkflowDialog,
			markPlanStepComplete,
			showWarning: vi.fn(),
			handlePlanReviewAction: (InteractiveMode as any).prototype.handlePlanReviewAction,
		};

		await (InteractiveMode as any).prototype.showPlanReviewSelector.call(fakeThis);

		expect(markPlanStepComplete).toHaveBeenCalledWith(artifact, 0);
	});

	test("routes revisions into reopen-step via the selector flow", async () => {
		const artifact = createArtifact({
			revision: 6,
			status: "executing",
			completedStepIndexes: [0],
			executionStepIndex: 1,
			executionStep: artifactStep(1),
		});
		const showExtensionSelector = vi
			.fn()
			.mockResolvedValueOnce(`v6 • executing • progress 1/2 • ${artifact.goal} • next: ${artifact.steps[1]}`)
			.mockResolvedValueOnce(`1. ${artifact.steps[0]}`);
		const showPlanWorkflowDialog = vi.fn().mockResolvedValueOnce("reopen_completed_step");
		const reopenPlanStep = vi.fn(async () => {});
		const fakeThis: any = {
			getPlanArtifacts: () => [artifact],
			formatPlanSelectorOption: (InteractiveMode as any).prototype.formatPlanSelectorOption,
			getPlanReviewActions: (InteractiveMode as any).prototype.getPlanReviewActions,
			getPlanStepSelectorOptions: (InteractiveMode as any).prototype.getPlanStepSelectorOptions,
			showExtensionSelector,
			showPlanWorkflowDialog,
			reopenPlanStep,
			showWarning: vi.fn(),
			handlePlanReviewAction: (InteractiveMode as any).prototype.handlePlanReviewAction,
		};

		await (InteractiveMode as any).prototype.showPlanReviewSelector.call(fakeThis);

		expect(reopenPlanStep).toHaveBeenCalledWith(artifact, 0);
	});

	test("routes clarifying revisions into interview flow via the selector", async () => {
		const artifact = createArtifact({
			revision: 5,
			status: "clarifying",
			steps: [],
			openQuestions: ["Should runtime bootstrap stay in the same file?"],
		});
		const showExtensionSelector = vi
			.fn()
			.mockResolvedValueOnce(
				`v5 • clarifying • interview 0/1 • ${artifact.goal} • next: ${artifact.openQuestions[0]}`,
			);
		const showPlanWorkflowDialog = vi.fn().mockResolvedValueOnce("continue_interview");
		const showPlanInterview = vi.fn(async () => {});
		const fakeThis: any = {
			getPlanArtifacts: () => [artifact],
			formatPlanSelectorOption: (InteractiveMode as any).prototype.formatPlanSelectorOption,
			getPlanReviewActions: (InteractiveMode as any).prototype.getPlanReviewActions,
			showExtensionSelector,
			showPlanWorkflowDialog,
			showPlanInterview,
			showWarning: vi.fn(),
			handlePlanReviewAction: (InteractiveMode as any).prototype.handlePlanReviewAction,
		};

		await (InteractiveMode as any).prototype.showPlanReviewSelector.call(fakeThis);

		expect(showPlanInterview).toHaveBeenCalledWith(artifact);
	});
});

function artifactStep(index: number): string {
	return createArtifact().steps[index]!;
}
