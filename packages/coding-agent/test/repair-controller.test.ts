import { describe, expect, test } from "vitest";
import { RepairController } from "../src/core/repair-controller.js";

const assertionFailure = `
not ok 1 - saves normalized scope
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal
actual: []
expected: [ 'admin' ]
stack: tests/session-store.test.mjs:14:10
`;

describe("repair-controller", () => {
	test("blocks verifier reruns until a repair mutation happens", () => {
		const controller = new RepairController({
			relevantPaths: ["src/key-normalizer.mjs", "tests/session-store.test.mjs"],
			expectedChangedPaths: ["src/key-normalizer.mjs"],
		});

		controller.noteVerificationFailure(assertionFailure);

		expect(controller.evaluateVerifierRun()).toMatchObject({
			allow: false,
			nextAction: "edit src/key-normalizer.mjs",
		});
		expect(controller.getGuidance()).toContain("repair assertion verifier failure");

		controller.noteMutation();
		expect(controller.evaluateVerifierRun()).toEqual({ allow: true });
	});

	test("stops after the same verifier failure repeats across repair attempts", () => {
		const controller = new RepairController({
			expectedChangedPaths: ["src/key-normalizer.mjs"],
			repeatedFailureLimit: 2,
		});

		controller.noteVerificationFailure(assertionFailure);
		controller.noteMutation();
		controller.noteVerificationFailure(assertionFailure.replace(":14:10", ":21:10"));

		expect(controller.snapshot()).toMatchObject({
			failed: true,
			sameFailureCount: 2,
			shouldStop: true,
		});
		expect(controller.evaluateVerifierRun()).toMatchObject({
			allow: false,
			nextAction: "final_answer",
		});
	});

	test("resets after successful verification", () => {
		const controller = new RepairController({ expectedChangedPaths: ["src/key-normalizer.mjs"] });

		controller.noteVerificationFailure(assertionFailure);
		controller.noteVerificationSuccess();

		expect(controller.snapshot()).toMatchObject({
			failed: false,
			sameFailureCount: 0,
			shouldStop: false,
		});
		expect(controller.evaluateVerifierRun()).toEqual({ allow: true });
	});
});
