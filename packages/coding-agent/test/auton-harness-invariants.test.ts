import { describe, expect, test } from "vitest";
import {
	applyAutonomousInvariantDirective,
	evaluateAutonomousHarnessInvariants,
} from "../src/core/auton/harness-invariants.js";
import type { AutonomousPlanItem, AutonomousRunLedger } from "../src/core/auton/ledger.js";

function plan(
	overrides: Partial<Record<AutonomousPlanItem["key"], AutonomousPlanItem["status"]>> = {},
): AutonomousPlanItem[] {
	return [
		{ key: "inspect", title: "Inspect relevant files", status: overrides.inspect ?? "pending" },
		{ key: "implement", title: "Apply workspace changes", status: overrides.implement ?? "pending" },
		{ key: "verify", title: "Verify latest changes", status: overrides.verify ?? "pending" },
		{ key: "summarize", title: "Summarize verified result", status: overrides.summarize ?? "pending" },
	];
}

function ledger(overrides: Partial<AutonomousRunLedger> = {}): AutonomousRunLedger {
	const { taskJournal, ...rest } = overrides;
	return {
		goal: "fix it",
		taskMode: "implementation",
		status: "running",
		turnsObserved: 0,
		touchedFiles: [],
		readFiles: [],
		recentMutations: [],
		verificationAttempts: 0,
		verificationSatisfied: false,
		verificationFailures: [],
		residualRisks: [],
		discoveredFiles: [],
		...rest,
		taskJournal: {
			planItems: plan(),
			completedCheckpoints: [],
			blockedReasons: [],
			...taskJournal,
		},
	};
}

describe("autonomous harness invariants", () => {
	test("requires local evidence before implementation edits", () => {
		const decision = evaluateAutonomousHarnessInvariants(
			ledger({
				taskJournal: {
					planItems: plan({ inspect: "completed", implement: "active" }),
					completedCheckpoints: [],
					blockedReasons: [],
				},
			}),
		);

		expect(decision).toMatchObject({
			allow: false,
			invariant: "evidence_before_edit",
			requiredNextAction: "read_evidence",
		});
	});

	test("requires repair after failed verification before rerunning verifier", () => {
		const decision = evaluateAutonomousHarnessInvariants(
			ledger({
				taskJournal: {
					planItems: plan({ inspect: "completed", implement: "completed", verify: "blocked" }),
					completedCheckpoints: [],
					blockedReasons: ["failed verification: npm test"],
				},
				readFiles: ["src/app.ts"],
				touchedFiles: ["src/app.ts"],
				recentMutations: ["src/app.ts"],
				verificationFailures: ["npm test: expected true to equal false"],
				lastActionType: "verification",
			}),
		);

		expect(decision).toMatchObject({
			allow: false,
			invariant: "repair_before_verifier_rerun",
			requiredNextAction: "repair_mutation",
		});
	});

	test("requires verification after mutation before completion", () => {
		const decision = evaluateAutonomousHarnessInvariants(
			ledger({
				taskJournal: {
					planItems: plan({ inspect: "completed", implement: "completed", verify: "active" }),
					completedCheckpoints: [],
					blockedReasons: [],
				},
				readFiles: ["src/app.ts"],
				touchedFiles: ["src/app.ts"],
				recentMutations: ["src/app.ts"],
				lastActionType: "mutation",
			}),
		);

		expect(decision).toMatchObject({
			allow: false,
			invariant: "verify_after_mutation",
			requiredNextAction: "verify",
		});
	});

	test("allows verified summarize state and research ledgers", () => {
		expect(
			evaluateAutonomousHarnessInvariants(
				ledger({
					taskJournal: {
						planItems: plan({
							inspect: "completed",
							implement: "completed",
							verify: "completed",
							summarize: "active",
						}),
						completedCheckpoints: [],
						blockedReasons: [],
					},
					touchedFiles: ["src/app.ts"],
					verificationSatisfied: true,
				}),
			),
		).toEqual({ allow: true });

		expect(evaluateAutonomousHarnessInvariants(ledger({ taskMode: "research" }))).toEqual({ allow: true });
	});

	test("applies invariant message as a non-negotiable prefix", () => {
		const decision = evaluateAutonomousHarnessInvariants(
			ledger({
				taskJournal: {
					planItems: plan({ verify: "active" }),
					completedCheckpoints: [],
					blockedReasons: [],
				},
				touchedFiles: ["src/app.ts"],
				recentMutations: ["src/app.ts"],
				lastActionType: "mutation",
			}),
		);

		const prompt = applyAutonomousInvariantDirective("Continue normally.", decision);
		expect(prompt).toContain("Harness invariant");
		expect(prompt).toContain("Required next action: verify");
		expect(prompt).toContain("Continue normally.");
	});
});
