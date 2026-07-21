import type { AutonomousPlanItem, AutonomousRunLedger } from "./ledger.js";

export type AutonomousInvariantRequiredAction =
	| "read_evidence"
	| "repair_mutation"
	| "verify"
	| "summarize"
	| "stop_blocked";

export type AutonomousHarnessInvariantDecision =
	| { allow: true }
	| {
			allow: false;
			invariant:
				| "evidence_before_edit"
				| "repair_before_verifier_rerun"
				| "verify_after_mutation"
				| "ledger_backed_completion";
			reason: string;
			requiredNextAction: AutonomousInvariantRequiredAction;
			message: string;
	  };

export interface AutonomousHarnessInvariantOptions {
	visualVerificationRelevant?: boolean;
	researchRelevant?: boolean;
}

export function evaluateAutonomousHarnessInvariants(
	ledger: AutonomousRunLedger,
	options: AutonomousHarnessInvariantOptions = {},
): AutonomousHarnessInvariantDecision {
	if (ledger.taskMode === "research" || options.researchRelevant) return { allow: true };

	const inspectStatus = getPlanStatus(ledger, "inspect");
	const implementStatus = getPlanStatus(ledger, "implement");
	const verifyStatus = getPlanStatus(ledger, "verify");
	const summarizeStatus = getPlanStatus(ledger, "summarize");
	const hasMutationEvidence = ledger.touchedFiles.length > 0 || ledger.recentMutations.length > 0;
	const hasReadEvidence = ledger.readFiles.length > 0;
	const latestMutation = ledger.recentMutations.at(-1) ?? ledger.touchedFiles.at(-1);
	const latestVerificationFailure = ledger.verificationFailures.at(-1);
	const verificationLabel = options.visualVerificationRelevant ? "visual verification" : "verification";

	if (
		ledger.taskMode === "implementation" &&
		(implementStatus === "active" || inspectStatus === "completed") &&
		!hasReadEvidence &&
		!hasMutationEvidence
	) {
		return {
			allow: false,
			invariant: "evidence_before_edit",
			requiredNextAction: "read_evidence",
			reason: "implementation work has no ledger-backed file evidence yet",
			message:
				"Harness invariant: do not edit before ledger-backed evidence exists. Read the most relevant local file first, then make the smallest supported change.",
		};
	}

	if (verifyStatus === "blocked" && latestVerificationFailure && !ledger.verificationSatisfied) {
		return {
			allow: false,
			invariant: "repair_before_verifier_rerun",
			requiredNextAction: "repair_mutation",
			reason: `verification is blocked by an unresolved failure: ${latestVerificationFailure}`,
			message: `Harness invariant: do not rerun the same verifier until a repair mutation addresses the failure. Repair the smallest relevant file first. Latest failure: ${latestVerificationFailure}`,
		};
	}

	if (
		hasMutationEvidence &&
		!ledger.verificationSatisfied &&
		(verifyStatus === "active" || ledger.lastActionType === "mutation")
	) {
		return {
			allow: false,
			invariant: "verify_after_mutation",
			requiredNextAction: "verify",
			reason: `latest mutation is not yet verified${latestMutation ? `: ${latestMutation}` : ""}`,
			message: `Harness invariant: no final answer after mutation until ${verificationLabel} is ledger-backed. Run ${verificationLabel} now for the latest change${latestMutation ? ` (${latestMutation})` : ""}.`,
		};
	}

	if (summarizeStatus === "active" && !ledger.verificationSatisfied && hasMutationEvidence) {
		return {
			allow: false,
			invariant: "ledger_backed_completion",
			requiredNextAction: "verify",
			reason: "summarize is active but completion lacks ledger-backed verification",
			message:
				"Harness invariant: done state requires a ledger-backed reason. Do not summarize completion until verification is satisfied; run verification or report the blocker.",
		};
	}

	return { allow: true };
}

export function applyAutonomousInvariantDirective(
	prompt: string,
	decision: AutonomousHarnessInvariantDecision,
): string {
	if (decision.allow) return prompt;
	return `${decision.message}\n\nRequired next action: ${decision.requiredNextAction}.\n\n${prompt}`;
}

function getPlanStatus(
	ledger: AutonomousRunLedger,
	key: AutonomousPlanItem["key"],
): AutonomousPlanItem["status"] | undefined {
	return ledger.taskJournal.planItems.find((item) => item.key === key)?.status;
}
