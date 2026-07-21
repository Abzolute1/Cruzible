import { classifyVerificationFailure, type VerificationFailureClassification } from "./verification-controller.js";

export type RepairControllerOptions = {
	relevantPaths?: string[];
	expectedChangedPaths?: string[];
	repeatedFailureLimit?: number;
};

export type RepairSnapshot = {
	failed: boolean;
	mutationSinceFailure: boolean;
	sameFailureCount: number;
	repeatedFailureLimit: number;
	lastFailure?: VerificationFailureClassification;
	shouldStop: boolean;
};

export type RepairVerifierDecision = { allow: true } | { allow: false; reason: string; nextAction: string };

export class RepairController {
	private readonly relevantPaths: string[];
	private readonly expectedChangedPaths: string[];
	private readonly repeatedFailureLimit: number;
	private lastFailure: VerificationFailureClassification | undefined;
	private sameFailureCount = 0;
	private mutationSinceFailure = false;

	constructor(options: RepairControllerOptions = {}) {
		this.relevantPaths = options.relevantPaths ?? [];
		this.expectedChangedPaths = options.expectedChangedPaths ?? [];
		this.repeatedFailureLimit = options.repeatedFailureLimit ?? 2;
	}

	noteMutation(): void {
		if (this.lastFailure) this.mutationSinceFailure = true;
	}

	noteVerificationSuccess(): void {
		this.lastFailure = undefined;
		this.sameFailureCount = 0;
		this.mutationSinceFailure = false;
	}

	noteVerificationFailure(output: string): VerificationFailureClassification {
		const failure = classifyVerificationFailure(output, { relevantPaths: this.relevantPaths });
		if (this.lastFailure?.signature === failure.signature) this.sameFailureCount++;
		else this.sameFailureCount = 1;
		this.lastFailure = failure;
		this.mutationSinceFailure = false;
		return failure;
	}

	evaluateVerifierRun(): RepairVerifierDecision {
		if (!this.lastFailure) return { allow: true };
		if (this.sameFailureCount >= this.repeatedFailureLimit && !this.mutationSinceFailure) {
			return {
				allow: false,
				reason: `Controlled runtime: same verifier failure repeated ${this.sameFailureCount} times (${this.lastFailure.kind}). Stop the loop and summarize the blocker: ${this.lastFailure.summary}`,
				nextAction: "final_answer",
			};
		}
		if (!this.mutationSinceFailure) {
			return {
				allow: false,
				reason: `Controlled runtime: verifier already failed with the current code (${this.lastFailure.kind}). Repair before rerunning verifier: ${this.lastFailure.summary}`,
				nextAction: this.nextRepairAction(),
			};
		}
		return { allow: true };
	}

	nextRepairAction(): string {
		const target = this.expectedChangedPaths[0] ?? this.relevantPaths.find((path) => !isLikelyTest(path));
		return target ? `edit ${target}` : "final_answer";
	}

	getGuidance(): string | undefined {
		if (!this.lastFailure) return undefined;
		if (this.sameFailureCount >= this.repeatedFailureLimit && !this.mutationSinceFailure) {
			return `final_answer; repeated ${this.lastFailure.kind} verifier failure: ${this.lastFailure.summary}`;
		}
		if (!this.mutationSinceFailure) {
			return `${this.nextRepairAction()}; repair ${this.lastFailure.kind} verifier failure: ${this.lastFailure.summary}`;
		}
		return undefined;
	}

	snapshot(): RepairSnapshot {
		return {
			failed: Boolean(this.lastFailure),
			mutationSinceFailure: this.mutationSinceFailure,
			sameFailureCount: this.sameFailureCount,
			repeatedFailureLimit: this.repeatedFailureLimit,
			lastFailure: this.lastFailure,
			shouldStop: Boolean(
				this.lastFailure && this.sameFailureCount >= this.repeatedFailureLimit && !this.mutationSinceFailure,
			),
		};
	}
}

function isLikelyTest(path: string): boolean {
	return /(^|\/)(test|tests|__tests__)\/|[._-](test|spec)\.[cm]?[jt]sx?$/i.test(path);
}
