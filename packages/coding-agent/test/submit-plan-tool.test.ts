import { describe, expect, test } from "vitest";
import {
	createSubmitPlanToolDefinition,
	type SubmittedPlan,
	submitPlanToolDefinition,
} from "../src/core/tools/submit-plan.js";

async function run(params: Record<string, unknown>) {
	return createSubmitPlanToolDefinition().execute(
		"tool-call-id",
		params as never,
		undefined,
		undefined,
		undefined as never,
	);
}

function submittedPlan(result: Awaited<ReturnType<typeof run>>): SubmittedPlan {
	const plan = (result.details as { plan?: SubmittedPlan } | undefined)?.plan;
	expect(plan).toBeDefined();
	return plan as SubmittedPlan;
}

function resultText(result: Awaited<ReturnType<typeof run>>): string {
	const first = result.content[0];
	return first?.type === "text" ? first.text : "";
}

describe("submit_plan tool", () => {
	test("exports a default definition with the expected name", () => {
		expect(submitPlanToolDefinition.name).toBe("submit_plan");
	});

	test("rejects a plan with neither steps nor open questions", async () => {
		const result = await run({ summary: "Nothing actionable yet." });

		expect(result.details).toBeUndefined();
		expect(resultText(result)).toContain(
			"Provide implementation steps, or clarifying questions if foundational choices are open.",
		);
	});

	test("rejects whitespace-only steps and questions as empty", async () => {
		const result = await run({
			summary: "Padded empties.",
			steps: ["   ", ""],
			openQuestions: [{ question: "  " }],
		});

		expect(result.details).toBeUndefined();
		expect(resultText(result)).toContain("Provide implementation steps");
	});

	test("rejects more than 30 steps", async () => {
		const steps = Array.from({ length: 31 }, (_, index) => `Step ${index + 1}`);
		const result = await run({ summary: "Too granular.", steps });

		expect(result.details).toBeUndefined();
		expect(resultText(result)).toContain("31 steps");
		expect(resultText(result)).toContain("30");
	});

	test("rejects more than 10 open questions", async () => {
		const openQuestions = Array.from({ length: 11 }, (_, index) => ({ question: `Question ${index + 1}?` }));
		const result = await run({ summary: "Too many questions.", openQuestions });

		expect(result.details).toBeUndefined();
		expect(resultText(result)).toContain("11 open questions");
	});

	test("rejects a question with more than 8 options", async () => {
		const result = await run({
			summary: "Too many options.",
			openQuestions: [
				{
					question: "Pick a language?",
					options: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
				},
			],
		});

		expect(result.details).toBeUndefined();
		expect(resultText(result)).toContain("more than 8 options");
	});

	test("normalizes strings: trims, drops empties, truncates over 500 chars", async () => {
		const longStep = `x${"y".repeat(600)}z`;
		const result = await run({
			summary: "  Normalize me.  ",
			steps: ["  first step  ", "", longStep],
			openQuestions: [
				{
					question: "  Which database? ",
					options: [" Postgres ", "", "SQLite"],
				},
			],
			assumptions: ["  assumption one ", "   "],
		});

		const plan = submittedPlan(result);
		expect(plan.summary).toBe("Normalize me.");
		expect(plan.steps[0]).toBe("first step");
		expect(plan.steps).toHaveLength(2);
		expect(plan.steps[1]).toHaveLength(500);
		expect(plan.steps[1]).toBe(longStep.slice(0, 500));
		expect(plan.openQuestions).toEqual([{ question: "Which database?", options: ["Postgres", "SQLite"] }]);
		expect(plan.assumptions).toEqual(["assumption one"]);
	});

	test("allows steps and open questions together (draft with open decisions)", async () => {
		const result = await run({
			summary: "Draft plan with one open decision.",
			steps: ["Add the endpoint", "Wire the handler"],
			openQuestions: [{ question: "Which transport?", options: ["REST", "RPC"] }],
		});

		expect(resultText(result)).toBe("Plan submitted: 2 steps, 1 open questions.");
		const plan = submittedPlan(result);
		expect(plan.steps).toHaveLength(2);
		expect(plan.openQuestions).toHaveLength(1);
	});

	test("returns the exact details.plan payload shape with missing arrays as []", async () => {
		const result = await run({
			summary: "Questions only.",
			openQuestions: [{ question: "Target platform?" }],
		});

		expect(resultText(result)).toBe("Plan submitted: 0 steps, 1 open questions.");
		const plan = submittedPlan(result);
		expect(plan).toEqual({
			summary: "Questions only.",
			steps: [],
			openQuestions: [{ question: "Target platform?" }],
			assumptions: [],
			constraints: [],
			risks: [],
			verification: [],
		});
	});
});
