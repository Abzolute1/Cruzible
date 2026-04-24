import { describe, expect, test } from "vitest";
import {
	buildFallbackInteractivePlanArtifact,
	buildPlanClarificationPrompt,
	buildPlanExecutionPrompt,
	buildPlanStepExecutionPrompt,
	buildPlanRevisionPrompt,
	extractInteractivePlanArtifact,
	formatInteractivePlanArtifact,
	formatInteractivePlanHistory,
	getAnsweredClarificationCount,
	getCompletedStepCount,
	getClarificationAnswers,
	getLatestInteractivePlanStepExecutionRecord,
	getNextInteractivePlanStep,
	getNextInteractivePlanStepIndex,
	getInteractivePlanArtifacts,
	getLatestInteractivePlanArtifact,
	type InteractivePlanArtifact,
	INTERACTIVE_PLAN_ARTIFACT_TYPE,
	markInteractivePlanStepComplete,
	parseInteractivePlanStepExecutionReview,
	recordInteractivePlanStepExecutionReview,
	reopenInteractivePlanStep,
	setInteractivePlanClarificationAnswer,
	shouldStartWithFallbackPlanningInterview,
	updateInteractivePlanArtifactStatus,
} from "../src/modes/interactive/interactive-plan-artifacts.js";

describe("interactive-plan-artifacts", () => {
	test("extracts a structured plan artifact from planning output", () => {
		const artifact = extractInteractivePlanArtifact({
			goal: "Refactor runtime bootstrap",
			assistantText: `Summary:
Split runtime bootstrap responsibilities into smaller coordinators.

Assumptions:
- Session APIs remain stable

Constraints:
- Do not change external behavior

Steps:
1. Extract runtime prep into its own helper
2. Add focused tests for bootstrap replacement
3. Rewire InteractiveMode to delegate

Risks:
- Startup regressions

Verification:
- Run focused startup tests
- Run typecheck`,
		});

		expect(artifact).toBeTruthy();
		expect(artifact?.goal).toBe("Refactor runtime bootstrap");
		expect(artifact?.steps).toHaveLength(3);
		expect(artifact?.assumptions).toEqual(["Session APIs remain stable"]);
		expect(artifact?.verification).toContain("Run focused startup tests");
	});

	test("extracts plans that use markdown headings and Step N labels", () => {
		const artifact = extractInteractivePlanArtifact({
			goal: "Plan out a snake game",
			assistantText: `### Summary

Implement a classic snake game with keyboard movement, food spawning, growth, and collision handling.

### Assumptions
- Use Python with pygame
- Start with a small fixed grid

### Constraints
- Prevent 180 degree reversals
- Food must not spawn on the snake

### Steps
Step 1: Setup imports, constants, and initial game state
Step 2: Implement input handling and movement updates
Step 3: Add food spawning and snake growth
Step 4: Add collision detection and game-over handling
Step 5: Render the board, snake, food, and score

### Risks
- Input timing could cause conflicting turns

### Verification
- Manual play test
- Confirm food never spawns on the snake`,
		});

		expect(artifact).toBeTruthy();
		expect(artifact?.status).toBe("draft");
		expect(artifact?.steps).toEqual([
			"Setup imports, constants, and initial game state",
			"Implement input handling and movement updates",
			"Add food spawning and snake growth",
			"Add collision detection and game-over handling",
			"Render the board, snake, food, and score",
		]);
	});

	test("returns undefined for clarifying questions without a concrete plan", () => {
		const artifact = extractInteractivePlanArtifact({
			goal: "Refactor runtime bootstrap",
			assistantText: `Before I propose a plan, I need two answers:

Questions:
- Do you want to preserve all CLI behavior?
			- Should runtime bootstrap stay in the same file?`,
		});

		expect(artifact).toBeTruthy();
		expect(artifact?.status).toBe("clarifying");
		expect(artifact?.openQuestions).toHaveLength(2);
	});

	test("treats numbered clarifying questions as clarification, not plan steps", () => {
		const artifact = extractInteractivePlanArtifact({
			goal: "lets plan out a snake game",
			assistantText: `Summary

Planning a snake game requires a few choices first.

Clarifying Questions

1. Target language: Python, TypeScript, or something else?
2. Platform/interface: terminal, desktop GUI, or web browser?
3. Key features needed: basic movement only, or food, animation, persistence too?`,
		});

		expect(artifact).toBeTruthy();
		expect(artifact?.status).toBe("clarifying");
		expect(artifact?.steps).toEqual([]);
		expect(artifact?.openQuestions).toEqual([
			"Target language?",
			"Platform/interface?",
			"Key features needed?",
		]);
		expect(artifact?.clarificationOptionSets?.[0]).toEqual(["Python", "TypeScript", "something else"]);
		expect(artifact?.clarificationOptionSets?.[1]).toEqual(["terminal", "desktop GUI", "web browser"]);
		expect(artifact?.clarificationOptionSets?.[2]).toEqual(["basic movement only", "food", "animation", "persistence too"]);
	});

	test("reclassifies question-like steps into clarifying interview state", () => {
		const artifact = extractInteractivePlanArtifact({
			goal: "let's plan a snake game",
			assistantText: `I'd be happy to help you plan a snake game! However, I need a few clarifications to provide the most relevant plan:

Steps:
1. Target language: Python? JavaScript? Another language?
2. Interface type:
3. Platform: Desktop, web browser, mobile?
4. Features scope: Basic game only (move snake, eat food, handle death on self-touch), or include features like:`,
		});

		expect(artifact).toBeTruthy();
		expect(artifact?.status).toBe("clarifying");
		expect(artifact?.steps).toEqual([]);
		expect(artifact?.openQuestions).toEqual([
			"Target language?",
			"Interface type?",
			"Platform?",
			"Features scope?",
		]);
		expect(artifact?.clarificationOptionSets?.[0]).toEqual(["Python", "JavaScript", "Another language"]);
		expect(artifact?.clarificationOptionSets?.[2]).toEqual(["Desktop", "web browser", "mobile"]);
	});

	test("reclassifies interrogative step lists into clarifying interview state", () => {
		const artifact = extractInteractivePlanArtifact({
			goal: "lets plan out a snake game",
			assistantText: `I'd like to help you plan a snake game! But I need some clarification on your preferences:

Steps:
1. What programming language? (Python, JavaScript, C++, Java, etc.)
2. What platform/interface?
3. Any specific requirements? (game loop style, animation speed, data structures you prefer to use)`,
		});

		expect(artifact).toBeTruthy();
		expect(artifact?.status).toBe("clarifying");
		expect(artifact?.steps).toEqual([]);
		expect(artifact?.openQuestions).toEqual([
			"What programming language?",
			"What platform/interface?",
			"Any specific requirements?",
		]);
		expect(artifact?.clarificationOptionSets?.[0]).toEqual(["Python", "JavaScript", "C++", "Java"]);
	});

	test("falls back to scope selector options when parsed scope choices are incomplete", () => {
		const artifact = extractInteractivePlanArtifact({
			goal: "let's plan a snake game",
			assistantText: `I'd be happy to help you plan a snake game! However, I need a few clarifications to provide the most relevant plan:

Steps:
1. Features scope: Basic game only (move snake, eat food, handle death on self-touch), or include features like:`,
		});

		expect(artifact).toBeTruthy();
		expect(artifact?.status).toBe("clarifying");
		expect(artifact?.openQuestions).toEqual(["Features scope?"]);
		expect(artifact?.clarificationOptionSets?.[0]).toEqual([
			"Basic gameplay only",
			"Score + restart",
			"Polished visuals",
			"Extended mechanics",
		]);
	});

	test("forces clarification when a greenfield draft still contains foundational open questions", () => {
		const artifact = extractInteractivePlanArtifact({
			goal: "let's plan out a snake game",
			assistantText: `Summary

Plan to implement a basic snake game with core mechanics and a clean architecture.

Steps
1. Initialize game window or canvas.
2. Implement snake movement (keyboard input handling).
3. Add food spawning logic (random grid position).
4. Create collision detection (walls, self, food).

Open Questions
- Target language?
- Platform?
- Required libraries/frameworks?`,
		});

		expect(artifact).toBeTruthy();
		expect(artifact?.status).toBe("clarifying");
		expect(artifact?.steps).toEqual([]);
		expect(artifact?.openQuestions).toEqual(["Target language?", "Platform?", "Required libraries/frameworks?"]);
	});

	test("forces clarification for wrapper phrasing when a generic draft still contains foundational open questions", () => {
		const artifact = extractInteractivePlanArtifact({
			goal: "Hey, let's enter planmode for a snake game!",
			assistantText: `Summary

Plan to implement a basic snake game with core mechanics and a clean architecture.

Steps
1. Initialize game window or canvas.
2. Implement snake movement.
3. Add food spawning logic.

Open Questions
- Target language?
- Platform/interface?`,
		});

		expect(artifact).toBeTruthy();
		expect(artifact?.status).toBe("clarifying");
		expect(artifact?.goal).toBe("snake game");
		expect(artifact?.steps).toEqual([]);
		expect(artifact?.openQuestions).toEqual(["Target language?", "Platform/interface?"]);
	});

	test("builds a fallback clarifying artifact for generic greenfield planning goals", () => {
		const artifact = buildFallbackInteractivePlanArtifact({
			goal: "let's plan out a snake game",
			rawPlan: "Sure, let's do that.",
		});

		expect(artifact).toBeTruthy();
		expect(artifact?.status).toBe("clarifying");
		expect(artifact?.openQuestions).toEqual(["Target language?", "Target interface/platform?", "Feature scope?"]);
		expect(artifact?.clarificationOptionSets?.[0]).toEqual(["Python", "JavaScript/TypeScript", "C++", "Rust", "Other"]);
	});

	test("does not start the fallback interview when foundational choices are already present", () => {
		expect(shouldStartWithFallbackPlanningInterview("plan a snake game in TypeScript for the browser")).toBe(false);
		expect(shouldStartWithFallbackPlanningInterview("plan the current runtime bootstrap refactor")).toBe(false);
	});

	test("starts the fallback interview for wrapper phrases like enter planmode for a generic game", () => {
		expect(shouldStartWithFallbackPlanningInterview("Hey, let's enter planmode for a snake game!")).toBe(true);
		expect(shouldStartWithFallbackPlanningInterview("Start planning mode for a browser snake game in TypeScript")).toBe(
			false,
		);
	});

	test("normalizes wrapper phrasing down to the actual planning goal", () => {
		const artifact = buildFallbackInteractivePlanArtifact({
			goal: "Hey, let's enter planmode for a snake game!",
			rawPlan: "",
		});

		expect(artifact?.goal).toBe("snake game");
	});

	test("drops low-quality filler options for open-ended clarifying questions", () => {
		const artifact = extractInteractivePlanArtifact({
			goal: "lets plan out a snake game",
			assistantText: `Summary

I need a bit more detail first.

Clarifying Questions

1. Any specific requirements? (For example, game loop style, animation speed, or data structures you prefer to use)`,
		});

		expect(artifact).toBeTruthy();
		expect(artifact?.status).toBe("clarifying");
		expect(artifact?.openQuestions).toEqual(["Any specific requirements?"]);
		expect(artifact?.clarificationOptionSets?.[0]).toEqual([]);
	});

	test("uses yes or no selector options for binary clarification questions with example paths", () => {
		const artifact = extractInteractivePlanArtifact({
			goal: "Create a tiny smoke-test file at /tmp/ag1-planmode-smoke.txt containing exactly hello and then verify it.",
			assistantText: `Summary

Clarifying Questions

1. Would you like me to create this file inside the session workspace instead? (e.g. /home/alex/AG1/tmp/ag1-planmode-smoke.txt)`,
		});

		expect(artifact).toBeTruthy();
		expect(artifact?.status).toBe("clarifying");
		expect(artifact?.openQuestions).toEqual([
			"Would you like me to create this file inside the session workspace instead?",
		]);
		expect(artifact?.clarificationOptionSets?.[0]).toEqual(["Yes", "No"]);
	});

	test("extracts bracketed clarifying choices with nested parentheses cleanly", () => {
		const artifact = extractInteractivePlanArtifact({
			goal: "lets plan out a snake game",
			assistantText: `Summary

I need a bit more detail first.

Clarifying Questions

1. Platform/interface [Terminal-based game, Web browser with canvas, Desktop GUI (Tkinter/PyQt)]?`,
		});

		expect(artifact).toBeTruthy();
		expect(artifact?.status).toBe("clarifying");
		expect(artifact?.openQuestions).toEqual(["Platform/interface?"]);
		expect(artifact?.clarificationOptionSets?.[0]).toEqual([
			"Terminal-based game",
			"Web browser with canvas",
			"Desktop GUI (Tkinter/PyQt)",
		]);
	});

	test("fills fallback platform options when the model asks the question without choices", () => {
		const artifact = extractInteractivePlanArtifact({
			goal: "lets plan out a snake game",
			assistantText: `Summary

I need a bit more detail first.

Clarifying Questions

1. What platform/interface do you want for the snake game?`,
		});

		expect(artifact).toBeTruthy();
		expect(artifact?.status).toBe("clarifying");
		expect(artifact?.openQuestions).toEqual(["What platform/interface do you want for the snake game?"]);
		expect(artifact?.clarificationOptionSets?.[0]).toEqual(["Terminal", "Desktop GUI", "Web browser", "Mobile"]);
	});

	test("falls back to sane game interview questions when clarification output is option fragments", () => {
		const artifact = extractInteractivePlanArtifact({
			goal: "let's plan a snake game",
			assistantText: `Summary

I need clarification before I can propose a plan.

Clarifying Questions

- Terminal-based game
- Web browser
- Mobile`,
		});

		expect(artifact).toBeTruthy();
		expect(artifact?.status).toBe("clarifying");
		expect(artifact?.openQuestions).toEqual([
			"Target language?",
			"Target interface/platform?",
			"Feature scope?",
		]);
		expect(artifact?.clarificationOptionSets?.[1]).toEqual(["Terminal", "Desktop GUI", "Web browser", "Mobile"]);
	});

	test("revisions reuse plan id and increment revision", () => {
		const first = extractInteractivePlanArtifact({
			goal: "Refactor runtime bootstrap",
			assistantText: `Plan:
1. Extract helper
2. Add tests`,
		})!;

		const revised = extractInteractivePlanArtifact({
			goal: first.goal,
			assistantText: `Plan:
1. Extract helper
2. Add tests
3. Add migration shim`,
			previous: first,
			feedback: "include migration work",
		})!;

		expect(revised.planId).toBe(first.planId);
		expect(revised.revision).toBe(first.revision + 1);
		expect(revised.feedback).toBe("include migration work");
	});

	test("finds the latest saved artifact from session entries", () => {
		const entries = [
			{
				type: "custom",
				id: "1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00Z",
				customType: INTERACTIVE_PLAN_ARTIFACT_TYPE,
				data: {
					version: 1,
					planId: "plan_a",
					revision: 1,
					status: "draft",
					goal: "A",
					steps: ["one"],
					assumptions: [],
					constraints: [],
					risks: [],
					verification: [],
					openQuestions: [],
					rawPlan: "Plan:\n1. one",
					createdAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
				},
			},
			{
				type: "custom",
				id: "2",
				parentId: "1",
				timestamp: "2026-01-01T00:01:00Z",
				customType: INTERACTIVE_PLAN_ARTIFACT_TYPE,
				data: {
					version: 1,
					planId: "plan_a",
					revision: 1,
					status: "accepted",
					goal: "A",
					steps: ["one"],
					assumptions: [],
					constraints: [],
					risks: [],
					verification: [],
					openQuestions: [],
					rawPlan: "Plan:\n1. one",
					createdAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:01:00Z",
				},
			},
		] as any;

		const latest = getLatestInteractivePlanArtifact(entries);
		expect(latest?.status).toBe("accepted");
		expect(getInteractivePlanArtifacts(entries)).toHaveLength(1);
	});

	test("formats and builds review prompts", () => {
		const artifact: InteractivePlanArtifact = {
			version: 1,
			planId: "plan_x",
			revision: 2,
			status: "accepted",
			goal: "Improve planning mode",
			summary: "Make planning mode explicit.",
			assumptions: ["Session APIs remain stable"],
			constraints: ["Do not execute in planning mode"],
			steps: ["Persist plan artifacts", "Add execute promotion"],
			risks: ["Mode confusion"],
			verification: ["Run focused tests"],
			openQuestions: [],
			rawPlan: "Plan:\n1. Persist plan artifacts\n2. Add execute promotion",
			completedStepIndexes: [0],
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:01:00Z",
		};

		expect(formatInteractivePlanArtifact(artifact)).toContain("Plan 2 · accepted");
		expect(formatInteractivePlanArtifact(artifact)).toContain("Progress: 1/2 steps complete");
		expect(formatInteractivePlanArtifact(artifact)).toContain("[done] Persist plan artifacts");
		expect(formatInteractivePlanArtifact(artifact)).toContain("[next] Add execute promotion");
		expect(buildPlanRevisionPrompt(artifact, "Add risk handling")).toContain("User feedback:");
		expect(buildPlanExecutionPrompt(updateInteractivePlanArtifactStatus(artifact, "executing"))).toContain(
			"Next incomplete step: 2. Add execute promotion",
		);
		expect(buildPlanExecutionPrompt(updateInteractivePlanArtifactStatus(artifact, "executing"))).toContain(
			"Execution Status, Execution Summary, Files Touched, Verification, Remaining, Blockers",
		);
		expect(buildPlanStepExecutionPrompt(updateInteractivePlanArtifactStatus(artifact, "executing"), 1)).toContain(
			"Execute only step 2",
		);
		const clarifyingArtifact = {
			...artifact,
			status: "clarifying" as const,
			steps: [],
			openQuestions: ["Should runtime bootstrap stay in the same file?"],
		};
		expect(buildPlanClarificationPrompt(clarifyingArtifact, "Keep runtime bootstrap in the same file for now")).toContain(
			"User clarification:",
		);
		expect(formatInteractivePlanHistory([artifact])).toContain("Plan History");
		expect(formatInteractivePlanHistory([artifact])).toContain("v2 · accepted");
		expect(formatInteractivePlanHistory([artifact])).toContain("Progress: 1/2 complete");
		expect(getCompletedStepCount(artifact)).toBe(1);
		expect(getNextInteractivePlanStepIndex(artifact)).toBe(1);
		expect(getNextInteractivePlanStep(artifact)).toBe("Add execute promotion");
	});

	test("tracks clarification answers and includes them in prompts", () => {
		const clarifying = createArtifactForStatusTest({
			status: "clarifying",
			steps: [],
			openQuestions: ["Which language should this use?", "Should it be terminal or web based?"],
		});
		const answered = setInteractivePlanClarificationAnswer(clarifying, 0, "Use TypeScript.");
		expect(getClarificationAnswers(answered)).toEqual(["Use TypeScript.", ""]);
		expect(getAnsweredClarificationCount(answered)).toBe(1);
		expect(formatInteractivePlanArtifact(answered)).toContain("Clarification Answers");
		expect(buildPlanClarificationPrompt(answered, "Q1 answered, Q2 still open")).toContain("Saved interview answers:");
		expect(buildPlanClarificationPrompt(answered, "Q1 answered, Q2 still open")).toContain("A1: Use TypeScript.");
	});

	test("parses and records structured execution review output", () => {
		const artifact = createArtifactForStatusTest({
			status: "executing",
			executionStepIndex: 1,
			executionStep: "Add execute promotion",
		});
		const assistantText = `Implemented the selected execution slice.

## Execution Status
reviewed

## Execution Summary
Added the execution promotion path and kept the plan artifact update logic intact.

## Files Touched
- src/modes/interactive/interactive-mode.ts
- test/interactive-plan-commands.test.ts

## Verification
- Ran focused plan command tests
- Rechecked the accepted-plan promotion path

## Remaining
- Wire the new summary into the compact card

## Blockers
- None`;

		const review = parseInteractivePlanStepExecutionReview(assistantText, 1, "Add execute promotion");
		expect(review?.status).toBe("reviewed");
		expect(review?.filesTouched).toEqual([
			"src/modes/interactive/interactive-mode.ts",
			"test/interactive-plan-commands.test.ts",
		]);
		expect(review?.verification).toContain("Ran focused plan command tests");

		const recorded = recordInteractivePlanStepExecutionReview(artifact, 1, assistantText);
		expect(getLatestInteractivePlanStepExecutionRecord(recorded, 1)?.summary).toContain(
			"Added the execution promotion path",
		);
		expect(formatInteractivePlanArtifact(recorded)).toContain("Recent Execution Review");
	});

	test("rejects execution reviews that omit required headings", () => {
		const artifact = createArtifactForStatusTest({
			status: "executing",
			executionStepIndex: 1,
			executionStep: "Add execute promotion",
		});
		const assistantText = `Implemented the selected execution slice.

## Execution Status
reviewed

## Execution Summary
Added the execution promotion path and kept the plan artifact update logic intact.

## Files Touched
- src/modes/interactive/interactive-mode.ts`;

		expect(parseInteractivePlanStepExecutionReview(assistantText, 1, "Add execute promotion")).toBeUndefined();
		expect(recordInteractivePlanStepExecutionReview(artifact, 1, assistantText)).toBe(artifact);
	});

	test("marks and reopens plan steps", () => {
		const artifact = createArtifactForStatusTest({
			status: "executing",
			completedStepIndexes: [0],
			executionStepIndex: 1,
			executionStep: "Add execute promotion",
			stepExecutionRecords: [
				{
					stepIndex: 1,
					step: "Add execute promotion",
					status: "reviewed",
					summary: "Promotion path implemented and waiting for acceptance.",
					filesTouched: ["src/modes/interactive/interactive-mode.ts"],
					verification: ["Ran focused plan tests"],
					remaining: [],
					blockers: [],
					recordedAt: "2026-01-01T00:00:00Z",
				},
			],
		});

		const completed = markInteractivePlanStepComplete(artifact, 1);
		expect(completed.status).toBe("accepted");
		expect(completed.completedStepIndexes).toEqual([0, 1]);
		expect(completed.executionStepIndex).toBeUndefined();
		expect(getLatestInteractivePlanStepExecutionRecord(completed, 1)?.status).toBe("completed");
		expect(getNextInteractivePlanStepIndex(completed)).toBeUndefined();

		const reopened = reopenInteractivePlanStep(completed, 0);
		expect(reopened.completedStepIndexes).toEqual([1]);
		expect(getLatestInteractivePlanStepExecutionRecord(reopened, 0)?.status).toBe("reopened");
		expect(getNextInteractivePlanStepIndex(reopened)).toBe(0);
	});
});

function createArtifactForStatusTest(
	overrides: Partial<InteractivePlanArtifact> = {},
): InteractivePlanArtifact {
	return {
		version: 1,
		planId: "plan_status",
		revision: 1,
		status: "accepted",
		goal: "Improve planning mode",
		summary: "Make planning mode reviewable.",
		assumptions: [],
		constraints: [],
		steps: ["Persist plan artifacts", "Add execute promotion"],
		risks: [],
		verification: [],
		openQuestions: [],
		rawPlan: "Plan:\n1. Persist plan artifacts\n2. Add execute promotion",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}
