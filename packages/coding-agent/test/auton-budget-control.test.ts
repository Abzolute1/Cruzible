import { describe, expect, test } from "vitest";
import type { BudgetStatus } from "../src/core/auton/auton-hook.js";
import {
	getBudgetAdjustedCompactionTrigger,
	getBudgetControlDirective,
	getBudgetPressure,
	noteBudgetControlDirective,
} from "../src/core/auton/budget-control.js";

function budgetStatus(partial: Partial<BudgetStatus>): BudgetStatus {
	return {
		costUsed: 0,
		costAuthoritative: false,
		tokensUsed: 0,
		turnsUsed: 0,
		exceeded: {
			cost: false,
			tokens: false,
			turns: false,
		},
		...partial,
	};
}

describe("autonomous budget control", () => {
	test("classifies pressure by the highest configured budget ratio", () => {
		expect(getBudgetPressure(budgetStatus({ tokensUsed: 50 }), { maxTokens: 100 }).level).toBe("normal");
		expect(getBudgetPressure(budgetStatus({ tokensUsed: 65 }), { maxTokens: 100 }).level).toBe("elevated");
		expect(getBudgetPressure(budgetStatus({ tokensUsed: 80 }), { maxTokens: 100 }).level).toBe("high");
		expect(getBudgetPressure(budgetStatus({ tokensUsed: 92 }), { maxTokens: 100 }).level).toBe("critical");
	});

	test("treats low remaining turn count as pressure even when token ratio is low", () => {
		expect(getBudgetPressure(budgetStatus({ turnsUsed: 8 }), { maxTurns: 10 })).toMatchObject({
			level: "high",
			ratio: 0.8,
		});
		expect(getBudgetPressure(budgetStatus({ turnsUsed: 9 }), { maxTurns: 10 })).toMatchObject({
			level: "critical",
			ratio: 0.95,
		});
	});

	test("selects trim and squeeze directives from budget pressure and run state", () => {
		const ledger = {
			verificationSatisfied: false,
			taskJournal: { expectedVerification: "npm test" },
		};

		expect(
			getBudgetControlDirective(
				{ level: "elevated", ratio: 0.65 },
				{ consecutiveIntentDriftCount: 0, consecutiveIntentFailureCount: 0 },
				ledger,
			),
		).toEqual({ kind: "trim", level: "elevated", detail: "npm test" });
		expect(
			getBudgetControlDirective(
				{ level: "critical", ratio: 0.95 },
				{ consecutiveIntentDriftCount: 0, consecutiveIntentFailureCount: 0 },
				ledger,
			),
		).toEqual({ kind: "squeeze", level: "critical", detail: "npm test" });
	});

	test("updates checkpoint counters only for active budget directives", () => {
		const base = { budgetTrimPromptCount: 0, budgetSqueezePromptCount: 0 };

		expect(noteBudgetControlDirective(base, { kind: "none", level: "normal" })).toBe(base);
		expect(noteBudgetControlDirective(base, { kind: "trim", level: "high", detail: "verify" })).toEqual({
			budgetTrimPromptCount: 1,
			budgetSqueezePromptCount: 0,
		});
		expect(noteBudgetControlDirective(base, { kind: "squeeze", level: "critical", detail: "verify" })).toEqual({
			budgetTrimPromptCount: 0,
			budgetSqueezePromptCount: 1,
		});
	});

	test("lowers compaction trigger under budget pressure", () => {
		expect(getBudgetAdjustedCompactionTrigger(10_000, "normal")).toBe(10_000);
		expect(getBudgetAdjustedCompactionTrigger(10_000, "elevated")).toBe(9_000);
		expect(getBudgetAdjustedCompactionTrigger(10_000, "high")).toBe(8_000);
		expect(getBudgetAdjustedCompactionTrigger(10_000, "critical")).toBe(6_500);
	});
});
