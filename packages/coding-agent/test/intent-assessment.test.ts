import { describe, expect, test } from "vitest";
import { extractLocalVerificationCommand } from "../src/core/auton/intent-assessment.js";

describe("extractLocalVerificationCommand", () => {
	test("extracts a backticked 'intended verification command' (adversarial pack phrasing)", () => {
		expect(
			extractLocalVerificationCommand("Some task.\nThe intended verification command is: `node src/export.mjs`\n"),
		).toBe("node src/export.mjs");
	});

	test("extracts AND strips backticks from 'the verification command is' (v4 phrasing)", () => {
		// The v4 shell_script_fix failure mode: backticks were kept, so no bash
		// detail ever equaled the extracted command and the run drift-stopped.
		expect(
			extractLocalVerificationCommand(
				"Fix build.sh.\nThe verification command is: `bash build.sh && grep -q OK dist/output.txt`\n",
			),
		).toBe("bash build.sh && grep -q OK dist/output.txt");
	});

	test("extracts an unquoted command", () => {
		expect(extractLocalVerificationCommand("Run it.\nThe intended verification command is: node --test\n")).toBe(
			"node --test",
		);
	});

	test("returns undefined when no command is declared", () => {
		expect(extractLocalVerificationCommand("just do the thing")).toBeUndefined();
	});
});
