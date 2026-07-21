import { describe, expect, test } from "vitest";
import { buildEvidencePlan, formatEvidencePlanStep, nextEvidencePlanStep } from "../src/core/evidence-planner.js";
import type { TaskPolicy } from "../src/core/task-policy.js";

const debugPolicy: TaskPolicy = {
	mode: "strict_benchmark",
	intent: "debug_fix",
	mutationExpected: true,
	webRelevant: false,
	allowedPaths: ["src/config-parser.mjs", "src/defaults.mjs", "tests/config-parser.test.mjs"],
	expectedChangedPaths: ["src/config-parser.mjs"],
	likelyTests: ["tests/config-parser.test.mjs"],
	verification: "node --test",
	maxReadsBeforePatch: 4,
	maxSearchesBeforePatch: 1,
	maxPatchAttempts: 2,
	stopAfterVerifierPass: true,
};

describe("evidence-planner", () => {
	test("orders mutation tasks as test evidence, target evidence, edit, verify, final", () => {
		const plan = buildEvidencePlan(debugPolicy);

		expect(plan.map(formatEvidencePlanStep)).toEqual([
			"read tests/config-parser.test.mjs",
			"read src/config-parser.mjs",
			"read src/defaults.mjs",
			"edit src/config-parser.mjs",
			"bash node --test",
			"final_answer",
		]);
		expect(plan.find((step) => step.path === "src/defaults.mjs")).toMatchObject({ required: false });
	});

	test("returns the next required evidence step before optional support reads", () => {
		const plan = buildEvidencePlan(debugPolicy);

		expect(formatEvidencePlanStep(nextEvidencePlanStep(plan) ?? plan[0])).toBe("read tests/config-parser.test.mjs");
		expect(
			formatEvidencePlanStep(nextEvidencePlanStep(plan, { readPaths: ["tests/config-parser.test.mjs"] }) ?? plan[0]),
		).toBe("read src/config-parser.mjs");
		expect(
			formatEvidencePlanStep(
				nextEvidencePlanStep(plan, {
					readPaths: ["tests/config-parser.test.mjs", "src/config-parser.mjs"],
				}) ?? plan[0],
			),
		).toBe("edit src/config-parser.mjs");
	});

	test("moves to verifier after expected mutation and final answer after verifier pass", () => {
		const plan = buildEvidencePlan(debugPolicy);

		expect(
			formatEvidencePlanStep(
				nextEvidencePlanStep(plan, {
					readPaths: ["tests/config-parser.test.mjs", "src/config-parser.mjs"],
					mutatedPaths: ["src/config-parser.mjs"],
					mutationSinceVerifier: true,
				}) ?? plan[0],
			),
		).toBe("bash node --test");
		expect(formatEvidencePlanStep(nextEvidencePlanStep(plan, { verifierPassedAfterMutation: true }) ?? plan[0])).toBe(
			"final_answer",
		);
	});

	test("verification-only tasks go straight to verifier", () => {
		const plan = buildEvidencePlan({
			...debugPolicy,
			intent: "verification_only",
			mutationExpected: false,
			expectedChangedPaths: [],
		});

		expect(plan.map(formatEvidencePlanStep)).toEqual(["bash node --test", "final_answer"]);
	});
});
