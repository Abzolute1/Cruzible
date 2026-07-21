import { describe, expect, it } from "vitest";
import { createAutonomousRunLedger } from "../src/core/auton/ledger.js";
import { promoteEvidenceBackedCompletion } from "../src/core/auton/ledger-events.js";
import type { ToolOutcome } from "../src/core/auton/nudges/types.js";

// A summary that *claims* a fix and verification without any verification tool
// having run. Pre-fix, this text alone could promote confirm_verification →
// complete even when the run had mutated the workspace.
const SWEET_TALK =
	"Fixed the falsey-value bug in `src/config-parser.mjs` and verified the fix: the test suite passes now. No further work needed.";

const EDIT_OUTCOME: ToolOutcome = {
	tool: "edit",
	success: true,
	file: "src/config-parser.mjs",
	detail: "apply falsey-value fix",
};

const READ_OUTCOME: ToolOutcome = {
	tool: "read",
	success: true,
	file: "src/config-parser.mjs",
	detail: "inspect parser",
};

function makeOptions(toolHistory: ToolOutcome[]) {
	return {
		currentLedger: createAutonomousRunLedger("fix the config parser bug"),
		lastAssistantText: SWEET_TALK,
		toolHistory,
		fileAccessHistory: [] as ToolOutcome[],
		verificationSatisfied: false,
		researchRelevant: false,
		userMessage: "fix the config parser bug",
	};
}

describe("promoteEvidenceBackedCompletion — verification gate", () => {
	it("does not let a mutating run complete on text-claimed verification", () => {
		const result = promoteEvidenceBackedCompletion("confirm_verification", makeOptions([EDIT_OUTCOME]));
		expect(result).toBe("confirm_verification");
	});

	it("does not promote a continuing mutating run to complete on text-claimed verification", () => {
		const result = promoteEvidenceBackedCompletion("continue", makeOptions([EDIT_OUTCOME]));
		expect(result).toBe("continue");
	});

	it("still allows a non-mutating run to complete from a verified-summary answer", () => {
		const result = promoteEvidenceBackedCompletion("confirm_verification", makeOptions([READ_OUTCOME]));
		expect(result).toBe("complete");
	});
});
