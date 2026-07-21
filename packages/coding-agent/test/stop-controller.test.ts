import { describe, expect, test } from "vitest";
import { decideStop, StopController } from "../src/core/stop-controller.js";

describe("stop-controller", () => {
	test("enforces final-answer-only after verifier passes following mutation", () => {
		const controller = new StopController({ stopAfterVerifierPass: true });

		controller.noteMutation();
		controller.noteVerification({ matchedVerifier: true, success: true });

		expect(controller.snapshot()).toMatchObject({
			mutationSinceVerifier: false,
			verifierPassedAfterMutation: true,
			finalAnswerOnly: true,
		});
		expect(controller.evaluateToolUse()).toMatchObject({
			shouldStop: true,
			finalAnswerOnly: true,
			label: "verified_after_mutation",
			nextAction: "final_answer",
		});
	});

	test("does not stop on verifier pass unless it followed a mutation", () => {
		const controller = new StopController();

		controller.noteVerification({ matchedVerifier: true, success: true });

		expect(controller.snapshot()).toMatchObject({
			mutationSinceVerifier: false,
			verifierPassedAfterMutation: false,
			finalAnswerOnly: false,
		});
		expect(controller.evaluateToolUse()).toMatchObject({
			shouldStop: false,
			nextAction: "continue",
		});
	});

	test("keeps repair mode open after verifier failure", () => {
		const controller = new StopController();

		controller.noteMutation();
		controller.noteVerification({ matchedVerifier: true, success: false });

		expect(controller.snapshot()).toMatchObject({
			mutationSinceVerifier: true,
			verifierPassedAfterMutation: false,
			verifierFailedAfterMutation: true,
			finalAnswerOnly: false,
		});
		expect(controller.evaluateToolUse()).toMatchObject({
			shouldStop: false,
		});
	});

	test("stops direct answer and research tasks when evidence is sufficient", () => {
		expect(decideStop({ intent: "direct_answer", sufficientEvidence: true })).toMatchObject({
			shouldStop: true,
			label: "direct_answer_sufficient",
		});
		expect(decideStop({ intent: "research", sourceCount: 3 })).toMatchObject({
			shouldStop: true,
			label: "research_sources_sufficient",
		});
	});

	test("stops on budget exhaustion and repeated failure limits", () => {
		expect(decideStop({ intent: "debug_fix", budgetExhausted: true })).toMatchObject({
			shouldStop: true,
			label: "budget_exhausted",
		});
		expect(decideStop({ intent: "debug_fix", repeatedFailureCount: 3, repeatedFailureLimit: 3 })).toMatchObject({
			shouldStop: true,
			label: "repeated_failure_limit",
		});
	});
});
