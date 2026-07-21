export type IntentControlDirective =
	| { kind: "none" }
	| { kind: "recover"; detail: string }
	| { kind: "replan"; detail: string }
	| { kind: "narrow_scope"; detail: string }
	| { kind: "stop_blocked"; detail: string };

export interface IntentControlState {
	consecutiveIntentDriftCount: number;
	consecutiveIntentFailureCount: number;
	replanPromptCount: number;
	narrowScopePromptCount: number;
	consecutiveDegradedTurnCount?: number;
	consecutiveCriticalDegradedTurnCount?: number;
	lastDegradedTurnSeverity?: "elevated" | "critical";
	lastDegradedTurnReasons?: string[];
}

export interface IntentControlLedger {
	taskJournal: {
		intentStatus?: "pending" | "on_track" | "drifted" | "failed";
		lastIntentOutcome?: string;
		nextAction?: string;
	};
}

export function formatDegradedTurnDirectiveDetail(state: IntentControlState): string {
	const severity = state.lastDegradedTurnSeverity ?? "elevated";
	const reasons =
		state.lastDegradedTurnReasons && state.lastDegradedTurnReasons.length > 0
			? `: ${state.lastDegradedTurnReasons.join(", ")}`
			: "";
	return `degraded turn ${severity}${reasons}`;
}

export function isDegradedTurnDirectiveDetail(detail: string): boolean {
	return detail.startsWith("degraded turn ");
}

export function getIntentControlDirective(
	state: IntentControlState,
	ledger: IntentControlLedger,
): IntentControlDirective {
	const degradedTurnCount = state.consecutiveDegradedTurnCount ?? 0;
	const criticalDegradedTurnCount = state.consecutiveCriticalDegradedTurnCount ?? 0;
	if (criticalDegradedTurnCount >= 3) {
		return {
			kind: "stop_blocked",
			detail: `Autonomous run stopped after ${criticalDegradedTurnCount} consecutive critically degraded turns: ${formatDegradedTurnDirectiveDetail(state)}`,
		};
	}
	if (criticalDegradedTurnCount >= 2) {
		return {
			kind: "narrow_scope",
			detail: formatDegradedTurnDirectiveDetail(state),
		};
	}
	if (degradedTurnCount >= 2) {
		return {
			kind: "replan",
			detail: formatDegradedTurnDirectiveDetail(state),
		};
	}
	if (degradedTurnCount >= 1) {
		return {
			kind: "recover",
			detail: formatDegradedTurnDirectiveDetail(state),
		};
	}

	const intentStatus = ledger.taskJournal.intentStatus;
	const detail =
		ledger.taskJournal.lastIntentOutcome ?? ledger.taskJournal.nextAction ?? "autonomous run went off track";
	if (intentStatus === "failed") {
		if (state.consecutiveIntentFailureCount >= 3) {
			return {
				kind: "stop_blocked",
				detail: `Autonomous run stopped after ${state.consecutiveIntentFailureCount} consecutive failed steps: ${detail}`,
			};
		}
		if (state.consecutiveIntentFailureCount >= 2) {
			return {
				kind: "narrow_scope",
				detail,
			};
		}
		return {
			kind: "recover",
			detail,
		};
	}
	if (intentStatus === "drifted") {
		if (state.consecutiveIntentDriftCount >= 4) {
			return {
				kind: "stop_blocked",
				detail: `Autonomous run stopped after ${state.consecutiveIntentDriftCount} consecutive drifted steps: ${detail}`,
			};
		}
		if (state.consecutiveIntentDriftCount >= 3) {
			return {
				kind: "narrow_scope",
				detail,
			};
		}
		if (state.consecutiveIntentDriftCount >= 2) {
			return {
				kind: "replan",
				detail,
			};
		}
	}
	return { kind: "none" };
}

export function noteIntentControlDirective<T extends IntentControlState>(
	current: T,
	controlDirective: IntentControlDirective,
): T {
	if (controlDirective.kind === "replan") {
		return {
			...current,
			replanPromptCount: current.replanPromptCount + 1,
		};
	}
	if (controlDirective.kind === "narrow_scope") {
		return {
			...current,
			narrowScopePromptCount: current.narrowScopePromptCount + 1,
		};
	}
	return current;
}
