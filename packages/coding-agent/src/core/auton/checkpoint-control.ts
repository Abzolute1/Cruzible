import type { BudgetPressureLevel } from "./budget-control.js";
import type { VerificationCheckpointState } from "./verification-control.js";

export type TurnAssessmentKind =
	| "continue"
	| "confirm_completion"
	| "confirm_verification"
	| "truncated"
	| "complete"
	| "error";

export type IntentAssessmentOutcome = "on_track" | "drifted" | "failed";

export interface CheckpointControlState {
	consecutiveNoToolTurns: number;
	completionPromptCount: number;
	verificationPromptCount: number;
	truncatedTurnCount: number;
	outputCapPromptCount: number;
	consecutiveIntentDriftCount: number;
	consecutiveIntentFailureCount: number;
	replanPromptCount: number;
	narrowScopePromptCount: number;
	budgetPressureLevel: BudgetPressureLevel;
	budgetTrimPromptCount: number;
	budgetSqueezePromptCount: number;
	lastAssessment: TurnAssessmentKind;
	verificationSatisfied: boolean;
	lastVerificationDetail?: string;
	consecutiveDegradedTurnCount?: number;
	consecutiveCriticalDegradedTurnCount?: number;
	lastDegradedTurnSeverity?: "elevated" | "critical";
	lastDegradedTurnReasons?: string[];
}

export interface DegradedTurnCheckpointEvent {
	severity: "normal" | "elevated" | "critical";
	reasons: string[];
}

export function updateCheckpointState<T extends CheckpointControlState>(
	current: T,
	assessment: TurnAssessmentKind,
	lastTurnHadToolCalls: boolean,
	verificationState: VerificationCheckpointState,
): T {
	return {
		...current,
		consecutiveNoToolTurns: lastTurnHadToolCalls ? 0 : current.consecutiveNoToolTurns + 1,
		completionPromptCount:
			assessment === "confirm_completion" ? current.completionPromptCount + 1 : current.completionPromptCount,
		verificationPromptCount:
			assessment === "confirm_verification" ? current.verificationPromptCount + 1 : current.verificationPromptCount,
		truncatedTurnCount: assessment === "truncated" ? current.truncatedTurnCount + 1 : current.truncatedTurnCount,
		lastAssessment: assessment,
		verificationSatisfied: verificationState.hasVerificationCheckpoint,
		lastVerificationDetail: verificationState.lastVerificationDetail,
	};
}

export function updateDegradedTurnCheckpointState<T extends CheckpointControlState>(
	current: T,
	degradedTurn: DegradedTurnCheckpointEvent | undefined,
): T {
	if (!degradedTurn || degradedTurn.severity === "normal") {
		return {
			...current,
			consecutiveDegradedTurnCount: 0,
			consecutiveCriticalDegradedTurnCount: 0,
			lastDegradedTurnSeverity: undefined,
			lastDegradedTurnReasons: undefined,
		};
	}

	return {
		...current,
		consecutiveDegradedTurnCount: (current.consecutiveDegradedTurnCount ?? 0) + 1,
		consecutiveCriticalDegradedTurnCount:
			degradedTurn.severity === "critical" ? (current.consecutiveCriticalDegradedTurnCount ?? 0) + 1 : 0,
		lastDegradedTurnSeverity: degradedTurn.severity,
		lastDegradedTurnReasons: degradedTurn.reasons,
	};
}

export function updateIntentCheckpointState<T extends CheckpointControlState>(
	current: T,
	outcome: IntentAssessmentOutcome,
): T {
	if (outcome === "on_track") {
		return {
			...current,
			consecutiveIntentDriftCount: 0,
			consecutiveIntentFailureCount: 0,
		};
	}
	if (outcome === "failed") {
		return {
			...current,
			consecutiveIntentFailureCount: current.consecutiveIntentFailureCount + 1,
			consecutiveIntentDriftCount: 0,
		};
	}
	return {
		...current,
		consecutiveIntentDriftCount: current.consecutiveIntentDriftCount + 1,
		consecutiveIntentFailureCount: 0,
	};
}
