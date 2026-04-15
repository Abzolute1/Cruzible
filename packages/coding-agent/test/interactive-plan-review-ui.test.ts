import { describe, expect, test } from "vitest";
import {
	buildInteractiveExpandedPlanCardLines,
	buildInteractivePlanCardLines,
	buildInteractivePlanInterviewLines,
	buildInteractivePlanReviewLines,
	summarizeInteractivePlanForModeLine,
} from "../src/modes/interactive/interactive-plan-review-ui.js";
import type { InteractivePlanArtifact } from "../src/modes/interactive/interactive-plan-artifacts.js";

function createArtifact(overrides: Partial<InteractivePlanArtifact> = {}): InteractivePlanArtifact {
	return {
		version: 1,
		planId: "plan_card",
		revision: 3,
		status: "accepted",
		goal: "Make plan mode reviewable",
		summary: "Improve review UI.",
		assumptions: [],
		constraints: [],
		steps: ["Persist plans", "Add review cards", "Promote selected steps"],
		risks: [],
		verification: [],
		openQuestions: [],
		rawPlan: "Plan:\n1. Persist plans\n2. Add review cards\n3. Promote selected steps",
		completedStepIndexes: [0],
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("interactive-plan-review-ui", () => {
	test("builds compact plan card lines with progress and actions", () => {
		const lines = buildInteractivePlanCardLines(
			createArtifact({
				stepExecutionRecords: [
					{
						stepIndex: 1,
						step: "Add review cards",
						status: "reviewed",
						summary: "Review card flow was implemented and verified.",
						filesTouched: ["src/modes/interactive/components/plan-review-card.ts"],
						verification: ["Ran focused review-ui tests"],
						remaining: [],
						blockers: [],
						recordedAt: "2026-01-01T00:00:00Z",
					},
				],
			}),
		);
		expect(lines).toContain("Plan v3 · accepted");
		expect(lines).toContain("Progress: 1/3 complete");
		expect(lines).toContain("Next: Add review cards");
		expect(lines).toContain("Latest Review: step 2 • reviewed");
		expect(lines).toContain("Actions: review, execute next, execute step, mark done");
	});

	test("shows clarifying and executing states distinctly", () => {
		const clarifyingArtifact = createArtifact({
			status: "clarifying",
			steps: [],
			completedStepIndexes: [],
			openQuestions: ["Should revision review be inline or selector-driven?"],
		});
		const clarifyingLines = buildInteractivePlanCardLines(clarifyingArtifact);
		expect(clarifyingLines).toContain("Current question: Should revision review be inline or selector-driven?");
		expect(clarifyingLines).toContain("Interview: 0/1 answered");
		expect(clarifyingLines).toContain("Actions: interview, continue planning, clear");
		expect(buildInteractivePlanReviewLines(clarifyingArtifact)).toContain("Plan Review: v3 • clarifying • interview 0/1");
		expect(buildInteractivePlanReviewLines(clarifyingArtifact)).toContain("Interview: 0/1 answered");
		expect(buildInteractivePlanReviewLines(clarifyingArtifact)).toContain(
			"Current question: Should revision review be inline or selector-driven?",
		);
		expect(summarizeInteractivePlanForModeLine(clarifyingArtifact, true)).toEqual([
			"plan v3",
			"interview 0/1",
			"awaiting clarification",
		]);

		const executingLines = buildInteractivePlanCardLines(
			createArtifact({
				status: "executing",
				executionStepIndex: 1,
				executionStep: "Add review cards",
			}),
		);
		expect(executingLines).toContain("Executing: Add review cards");
		expect(executingLines).toContain("Actions: review, mark done, reopen step, revise");
	});

	test("builds expanded plan card lines with structured sections", () => {
		const lines = buildInteractiveExpandedPlanCardLines(
			createArtifact({
				stepExecutionRecords: [
					{
						stepIndex: 1,
						step: "Add review cards",
						status: "blocked",
						summary: "Card rendering works, but selector actions still need follow-up.",
						filesTouched: ["src/modes/interactive/interactive-plan-review-ui.ts"],
						verification: ["Ran focused review-ui tests"],
						remaining: ["Wire selector-triggered review updates"],
						blockers: ["Need a cleaner selector-to-card action bridge"],
						recordedAt: "2026-01-01T00:00:00Z",
					},
				],
			}),
		);
		expect(lines).toContain("Summary");
		expect(lines).toContain("Improve review UI.");
		expect(lines).toContain("- 1. [done] Persist plans");
		expect(lines).toContain("- 2. [next] Add review cards");
		expect(lines).toContain("Latest Step Review");
		expect(lines).toContain("- Step 2 · blocked");
		expect(lines).toContain("- blocked: Need a cleaner selector-to-card action bridge");
		expect(lines).toContain("Execution Actions");
		expect(lines).toContain("Execute the next step or promote a selected step into execution.");
		expect(lines).toContain("Hotkeys: Alt+R review, Alt+N execute next step");
	});

	test("shows selector choice previews for unanswered interview questions", () => {
		const lines = buildInteractivePlanInterviewLines(
			createArtifact({
				status: "clarifying",
				steps: [],
				completedStepIndexes: [],
				openQuestions: ["Target language?", "Target interface/platform?"],
				clarificationOptionSets: [
					["Python", "JavaScript/TypeScript", "Rust", "C++", "Other"],
					["Terminal", "Desktop GUI", "Web browser"],
				],
				clarificationAnswers: ["", "Web browser"],
			}),
		);

		expect(lines).toContain("[open] Q1. Target language?");
		expect(lines).toContain("  Choices: Python • JavaScript/TypeScript • Rust • C++ • …");
		expect(lines).toContain("[answered] Q2. Target interface/platform?");
		expect(lines).toContain("  A2. Web browser");
	});
});
