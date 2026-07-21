import type { BudgetStatus } from "./auton-hook.js";

export type BudgetPressureLevel = "normal" | "elevated" | "high" | "critical";

export type BudgetControlDirective =
	| { kind: "none"; level: BudgetPressureLevel }
	| { kind: "trim"; level: BudgetPressureLevel; detail: string }
	| { kind: "squeeze"; level: BudgetPressureLevel; detail: string };

export interface BudgetControlConfig {
	maxCostUsd?: number;
	maxTokens?: number;
	maxTurns?: number;
}

export interface BudgetControlState {
	consecutiveIntentDriftCount: number;
	consecutiveIntentFailureCount: number;
}

export interface BudgetControlLedger {
	verificationSatisfied: boolean;
	taskJournal: {
		expectedVerification?: string;
		plannedNextStep?: string;
		nextAction?: string;
	};
}

export interface BudgetControlCheckpointCounters {
	budgetTrimPromptCount: number;
	budgetSqueezePromptCount: number;
}

export function getBudgetPressure(
	status: BudgetStatus,
	config: BudgetControlConfig,
): { level: BudgetPressureLevel; ratio: number } {
	const ratios: number[] = [];
	if (status.costAuthoritative && (config.maxCostUsd ?? 0) > 0)
		ratios.push(status.costUsed / (config.maxCostUsd ?? 1));
	if ((config.maxTokens ?? 0) > 0) ratios.push(status.tokensUsed / (config.maxTokens ?? 1));
	if ((config.maxTurns ?? 0) > 0) ratios.push(status.turnsUsed / (config.maxTurns ?? 1));
	const ratio = ratios.length > 0 ? Math.max(...ratios) : 0;

	if ((config.maxTurns ?? 0) > 0) {
		const remainingTurns = (config.maxTurns ?? 0) - status.turnsUsed;
		if (remainingTurns <= 1) return { level: "critical", ratio: Math.max(ratio, 0.95) };
		if (remainingTurns <= 2 && ratio < 0.8) return { level: "high", ratio: Math.max(ratio, 0.8) };
	}

	if (ratio >= 0.92) return { level: "critical", ratio };
	if (ratio >= 0.8) return { level: "high", ratio };
	if (ratio >= 0.6) return { level: "elevated", ratio };
	return { level: "normal", ratio };
}

export function getBudgetControlDirective(
	budgetPressure: { level: BudgetPressureLevel; ratio: number },
	state: BudgetControlState,
	ledger: BudgetControlLedger,
): BudgetControlDirective {
	const detail =
		ledger.taskJournal.expectedVerification ??
		ledger.taskJournal.plannedNextStep ??
		ledger.taskJournal.nextAction ??
		"finish the current slice with concrete verification";
	if (budgetPressure.level === "critical") {
		return { kind: "squeeze", level: budgetPressure.level, detail };
	}
	if (
		budgetPressure.level === "high" ||
		(budgetPressure.level === "elevated" &&
			(state.consecutiveIntentDriftCount > 0 ||
				state.consecutiveIntentFailureCount > 0 ||
				!ledger.verificationSatisfied))
	) {
		return { kind: "trim", level: budgetPressure.level, detail };
	}
	return { kind: "none", level: budgetPressure.level };
}

export function noteBudgetControlDirective<T extends BudgetControlCheckpointCounters>(
	current: T,
	budgetDirective: BudgetControlDirective,
): T {
	if (budgetDirective.kind === "trim") {
		return {
			...current,
			budgetTrimPromptCount: current.budgetTrimPromptCount + 1,
		};
	}
	if (budgetDirective.kind === "squeeze") {
		return {
			...current,
			budgetSqueezePromptCount: current.budgetSqueezePromptCount + 1,
		};
	}
	return current;
}

export function getBudgetAdjustedCompactionTrigger(trigger: number, pressure: BudgetPressureLevel): number {
	if (pressure === "critical") return Math.floor(trigger * 0.65);
	if (pressure === "high") return Math.floor(trigger * 0.8);
	if (pressure === "elevated") return Math.floor(trigger * 0.9);
	return trigger;
}
