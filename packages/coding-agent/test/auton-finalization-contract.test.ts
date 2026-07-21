import { describe, expect, test } from "vitest";
import {
	appendFinalizationContractInstruction,
	parseFinalizationContract,
} from "../src/core/auton/finalization-contract.js";
import { assessTurnOutcome } from "../src/core/auton/turn-state.js";

const verified = {
	hasVerificationCheckpoint: true,
	lastVerificationDetail: "npm test",
	visualBlockingIssues: [],
};

const unverified = {
	hasVerificationCheckpoint: false,
	visualBlockingIssues: [],
};

describe("autonomous finalization contract", () => {
	test("appends the structured completion instruction once", () => {
		const prompt = appendFinalizationContractInstruction("Do the work.");

		expect(prompt).toContain("AG1_FINAL_STATUS: complete");
		expect(appendFinalizationContractInstruction(prompt)).toBe(prompt);
	});

	test("parses final status only from the recent response tail", () => {
		expect(parseFinalizationContract("Done\nAG1_FINAL_STATUS: complete")).toBe("complete");
		expect(parseFinalizationContract("Still working\nAG1_FINAL_STATUS: continue")).toBe("continue");
		expect(
			parseFinalizationContract(`AG1_FINAL_STATUS: complete\n${Array(10).fill("later").join("\n")}`),
		).toBeUndefined();
	});

	test("accepts structured completion when verification evidence exists", () => {
		const assessment = assessTurnOutcome({
			lastTurnHadToolCalls: false,
			lastTurnFinishReason: "stop",
			lastAssistantText: "Implemented the change.\nAG1_FINAL_STATUS: complete",
			verificationState: verified,
		});

		expect(assessment.kind).toBe("complete");
	});

	test("structured completion still requires verification evidence", () => {
		const assessment = assessTurnOutcome({
			lastTurnHadToolCalls: false,
			lastTurnFinishReason: "stop",
			lastAssistantText: "Implemented the change.\nAG1_FINAL_STATUS: complete",
			verificationState: unverified,
		});

		expect(assessment.kind).toBe("confirm_verification");
	});

	test("structured continue overrides legacy completion wording", () => {
		const assessment = assessTurnOutcome({
			lastTurnHadToolCalls: false,
			lastTurnFinishReason: "stop",
			lastAssistantText:
				"Task complete. I verified the implementation and no further changes are needed.\nAG1_FINAL_STATUS: continue",
			verificationState: verified,
		});

		expect(assessment.kind).toBe("continue");
	});
});
