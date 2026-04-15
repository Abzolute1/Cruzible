import { describe, expect, test } from "vitest";
import { createAutonHook } from "../src/core/auton/auton-hook.js";

describe("AutonHook cost budget semantics", () => {
	test("treats cost as estimate-only by default", () => {
		const hook = createAutonHook({
			maxCost: 0.00001,
			maxTokens: 0,
			maxTurns: 0,
		});

		hook.recordUsage(10_000, 10_000);
		const status = hook.getBudgetStatus();

		expect(status.costUsed).toBeGreaterThan(0.00001);
		expect(status.costAuthoritative).toBe(false);
		expect(status.exceeded.cost).toBe(false);
		expect(() => hook.abortIfBudgetExceeded()).not.toThrow();
	});

	test("still enforces token budgets", () => {
		const hook = createAutonHook({
			maxCost: 0.00001,
			maxTokens: 100,
			maxTurns: 0,
		});

		hook.recordUsage(80, 40);
		const status = hook.getBudgetStatus();

		expect(status.exceeded.tokens).toBe(true);
		expect(() => hook.abortIfBudgetExceeded()).toThrow(/Token budget exceeded/);
	});
});
