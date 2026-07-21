export type StopTaskIntent =
	| "direct_answer"
	| "code_explanation"
	| "small_patch"
	| "debug_fix"
	| "multi_file_change"
	| "verification_only"
	| "research"
	| "frontend_visual"
	| "ambiguous";

export type StopDecisionInput = {
	intent: StopTaskIntent;
	mutationExpected?: boolean;
	verificationPassedAfterMutation?: boolean;
	stopAfterVerifierPass?: boolean;
	finalAnswerDetected?: boolean;
	sufficientEvidence?: boolean;
	sourceCount?: number;
	budgetExhausted?: boolean;
	repeatedFailureCount?: number;
	repeatedFailureLimit?: number;
};

export type StopDecision = {
	shouldStop: boolean;
	finalAnswerOnly: boolean;
	reason?: string;
	label?: string;
	nextAction?: "final_answer" | "continue";
};

export type StopControllerSnapshot = {
	mutationSinceVerifier: boolean;
	verifierPassedAfterMutation: boolean;
	verifierFailedAfterMutation: boolean;
	finalAnswerOnly: boolean;
};

export type StopControllerOptions = {
	stopAfterVerifierPass?: boolean;
};

export type VerificationObservation = {
	matchedVerifier: boolean;
	success: boolean;
};

const VERIFIED_STOP_REASON =
	"Controlled runtime: verifier already passed after the latest mutation. Stop using tools and provide the final summary.";

export function decideStop(input: StopDecisionInput): StopDecision {
	if (input.verificationPassedAfterMutation && input.stopAfterVerifierPass !== false) {
		return {
			shouldStop: true,
			finalAnswerOnly: true,
			reason: VERIFIED_STOP_REASON,
			label: "verified_after_mutation",
			nextAction: "final_answer",
		};
	}

	if (input.intent === "direct_answer" && input.sufficientEvidence) {
		return {
			shouldStop: true,
			finalAnswerOnly: true,
			reason: "Controlled runtime: direct-answer task has sufficient evidence. Provide the final answer.",
			label: "direct_answer_sufficient",
			nextAction: "final_answer",
		};
	}

	if (input.intent === "research" && (input.sourceCount ?? 0) >= 3) {
		return {
			shouldStop: true,
			finalAnswerOnly: true,
			reason:
				"Controlled runtime: research task has enough sourced evidence. Provide the final answer with citations.",
			label: "research_sources_sufficient",
			nextAction: "final_answer",
		};
	}

	if (input.budgetExhausted) {
		return {
			shouldStop: true,
			finalAnswerOnly: true,
			reason: "Controlled runtime: budget is exhausted. Provide the best current result and remaining risk.",
			label: "budget_exhausted",
			nextAction: "final_answer",
		};
	}

	if ((input.repeatedFailureCount ?? 0) >= (input.repeatedFailureLimit ?? 3)) {
		return {
			shouldStop: true,
			finalAnswerOnly: true,
			reason: "Controlled runtime: repeated failure limit reached. Summarize the blocker and smallest next repair.",
			label: "repeated_failure_limit",
			nextAction: "final_answer",
		};
	}

	return {
		shouldStop: false,
		finalAnswerOnly: false,
		nextAction: "continue",
	};
}

export class StopController {
	private readonly options: Required<StopControllerOptions>;
	private mutationSinceVerifier = false;
	private verifierPassedAfterMutation = false;
	private verifierFailedAfterMutation = false;

	constructor(options: StopControllerOptions = {}) {
		this.options = {
			stopAfterVerifierPass: options.stopAfterVerifierPass ?? true,
		};
	}

	noteMutation(): void {
		this.mutationSinceVerifier = true;
		this.verifierPassedAfterMutation = false;
		this.verifierFailedAfterMutation = false;
	}

	noteVerification(observation: VerificationObservation): void {
		if (!observation.matchedVerifier || !this.mutationSinceVerifier) return;
		if (observation.success) {
			this.verifierPassedAfterMutation = true;
			this.verifierFailedAfterMutation = false;
			this.mutationSinceVerifier = false;
			return;
		}
		this.verifierFailedAfterMutation = true;
	}

	evaluateToolUse(): StopDecision {
		return decideStop({
			intent: "debug_fix",
			verificationPassedAfterMutation: this.verifierPassedAfterMutation,
			stopAfterVerifierPass: this.options.stopAfterVerifierPass,
		});
	}

	hasMutationSinceVerifier(): boolean {
		return this.mutationSinceVerifier;
	}

	hasVerifierFailedAfterMutation(): boolean {
		return this.verifierFailedAfterMutation;
	}

	snapshot(): StopControllerSnapshot {
		const finalAnswerOnly = this.verifierPassedAfterMutation && this.options.stopAfterVerifierPass;
		return {
			mutationSinceVerifier: this.mutationSinceVerifier,
			verifierPassedAfterMutation: this.verifierPassedAfterMutation,
			verifierFailedAfterMutation: this.verifierFailedAfterMutation,
			finalAnswerOnly,
		};
	}
}
