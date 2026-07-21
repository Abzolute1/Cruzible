import { describe, expect, test } from "vitest";
import {
	createAutonomousRunLedger,
	isLaunderedVerificationCommand,
	updateAutonomousRunLedger,
} from "../src/core/auton/ledger.js";
import type { ToolOutcome } from "../src/core/auton/nudges/types.js";
import { getVerificationCheckpointState } from "../src/core/auton/verification-control.js";

function ledgerAfter(toolHistory: ToolOutcome[]) {
	return updateAutonomousRunLedger({
		current: createAutonomousRunLedger("fix the retry logic and verify it"),
		lastAssistantText: "Ran the verification step.",
		toolHistory,
		fileAccessHistory: [],
		verificationSatisfied: false,
		lastVerificationDetail: undefined,
	});
}

function bashOutcome(command: string, success = true): ToolOutcome {
	return { tool: "bash", success, detail: command };
}

function verifyTaskOutcome(command: string, exitCode = 0): ToolOutcome {
	return {
		tool: "task",
		success: true,
		detail: "verify changes",
		metadata: {
			type: "verify",
			state: "completed",
			evidence: [{ kind: "bash", command, exitCode }],
		},
	};
}

describe("isLaunderedVerificationCommand", () => {
	test.each([
		"cd packages/coding-agent && npx vitest run 2>&1 || true",
		"npm test ||true",
		"npm test || :",
		"npm test; true",
		"npm test || echo ok",
		"npm test || exit 0",
		"npm test; :",
	])("flags laundered command: %s", (command) => {
		expect(isLaunderedVerificationCommand(command)).toBe(true);
	});

	test.each([
		"cd packages/coding-agent && npx vitest --run test/auton-ledger.test.ts",
		"npm test",
		"pnpm run typecheck",
		"npx tsc --noEmit",
	])("trusts honest command: %s", (command) => {
		expect(isLaunderedVerificationCommand(command)).toBe(false);
	});
});

describe("laundering guard in verification outcomes", () => {
	test.each([
		"cd packages/coding-agent && npx vitest run 2>&1 || true",
		"npm test ||true",
		"npm test || :",
		"npm test; true",
		"npm test || echo ok",
	])("laundered bash command does not count as verification: %s", (command) => {
		const next = ledgerAfter([bashOutcome(command)]);
		expect(next.verificationAttempts).toBe(0);
		expect(next.verificationFailures).toEqual([]);
	});

	test("real test commands still count as verification", () => {
		const next = ledgerAfter([bashOutcome("cd packages/coding-agent && npx vitest --run test/auton-ledger.test.ts")]);
		expect(next.verificationAttempts).toBe(1);
		expect(next.verificationFailures).toEqual([]);
	});

	test("laundered task-evidence bash entry does not count as verification", () => {
		const next = ledgerAfter([verifyTaskOutcome("npm test || true")]);
		expect(next.verificationAttempts).toBe(0);
	});

	test("honest task-evidence bash entry still counts as verification", () => {
		const next = ledgerAfter([verifyTaskOutcome("npm test")]);
		expect(next.verificationAttempts).toBe(1);
		expect(next.verificationFailures).toEqual([]);
	});
});

describe("verify_ui verdict semantics", () => {
	test("verify_ui PASS counts as passed verification", () => {
		const next = ledgerAfter([
			{
				tool: "verify_ui",
				success: true,
				detail: "the submit button is visible and enabled",
				metadata: { verdict: "PASS", outputPreview: "PASS · the submit button is visible and enabled" },
			},
		]);
		expect(next.verificationAttempts).toBe(1);
		expect(next.verificationFailures).toEqual([]);
		expect(next.currentFocus).toContain("Running verification");
	});

	test("verify_ui FAIL verdict does not count as passed verification", () => {
		const next = ledgerAfter([
			{
				tool: "verify_ui",
				success: true,
				detail: "the submit button is visible and enabled",
				metadata: { verdict: "FAIL", outputPreview: "FAIL · the submit button is disabled" },
			},
		]);
		expect(next.verificationAttempts).toBe(1);
		expect(next.verificationFailures).toHaveLength(1);
		expect(next.verificationFailures[0]).toContain("failed verification");
		expect(next.currentFocus).toContain("Address verification failure");
	});

	test("verify_ui FAIL from leading result text does not count as passed verification", () => {
		const next = ledgerAfter([
			{
				tool: "verify_ui",
				success: true,
				detail: "FAIL · the page shows an error banner",
			},
		]);
		expect(next.verificationAttempts).toBe(1);
		expect(next.verificationFailures).toHaveLength(1);
		expect(next.currentFocus).toContain("Address verification failure");
	});
});

describe("verification-control checkpoint honesty", () => {
	const mutation = { tool: "edit", success: true, file: "src/a.ts", detail: "src/a.ts" };

	test("laundered verification command does not satisfy the checkpoint", () => {
		const laundered = getVerificationCheckpointState([mutation, bashOutcome("npx vitest run 2>&1 || true")]);
		expect(laundered.hasVerificationCheckpoint).toBe(false);

		const real = getVerificationCheckpointState([mutation, bashOutcome("npx vitest run")]);
		expect(real.hasVerificationCheckpoint).toBe(true);
	});

	test("verify_ui PASS satisfies the checkpoint, FAIL blocks it with detail", () => {
		const pass = getVerificationCheckpointState([
			mutation,
			{ tool: "verify_ui", success: true, detail: "grid renders", metadata: { verdict: "PASS" } },
		]);
		expect(pass.hasVerificationCheckpoint).toBe(true);

		const fail = getVerificationCheckpointState(
			[mutation, { tool: "verify_ui", success: true, detail: "grid renders", metadata: { verdict: "FAIL" } }],
			true,
		);
		expect(fail.hasVerificationCheckpoint).toBe(false);
		expect(fail.visualFailureDetail).toBeTruthy();
	});
});
