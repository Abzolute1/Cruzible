import { describe, expect, test } from "vitest";
import { AutonHook } from "../src/core/auton/auton-hook.js";

describe("AutonHook cost budget semantics", () => {
	test("treats provider-level placeholder pricing as estimate-only", () => {
		const hook = new AutonHook({
			maxCost: 0.00001,
			modelId: "openai/gpt-5.4",
		});

		hook.recordUsage(2000, 2000);
		const status = hook.getBudgetStatus();

		expect(status.costUsed).toBeGreaterThan(0);
		expect(status.costAuthoritative).toBe(false);
		expect(status.exceeded.cost).toBe(false);
		expect(hook.getCostSummary()).toContain("estimate");
	});

	test("enforces maxCost when explicit authoritative pricing is provided", () => {
		const hook = new AutonHook({
			maxCost: 0.00001,
			modelId: "custom/model",
			pricing: {
				inputPerM: 10,
				outputPerM: 10,
				cacheReadPerM: 10,
				cacheWritePerM: 10,
				authoritative: true,
			},
		});

		hook.recordUsage(1000, 1000);
		const status = hook.getBudgetStatus();

		expect(status.costAuthoritative).toBe(true);
		expect(status.exceeded.cost).toBe(true);
		expect(() => hook.abortIfBudgetExceeded()).toThrow(/Cost budget exceeded/);
	});

	test("tracks cache tokens in budget and summary", () => {
		const hook = new AutonHook({
			maxTokens: 100,
			modelId: "custom/model",
			pricing: {
				inputPerM: 0,
				outputPerM: 0,
				cacheReadPerM: 0.5,
				cacheWritePerM: 1,
				authoritative: true,
			},
		});

		hook.recordUsage(10, 20, 30, 40);
		const status = hook.getBudgetStatus();

		expect(status.tokensUsed).toBe(100);
		expect(status.exceeded.tokens).toBe(true);
		expect(status.costUsed).toBeGreaterThan(0);
		expect(hook.getCostSummary()).toContain("30 cache-read");
		expect(hook.getCostSummary()).toContain("40 cache-write");
	});

	function bindSessionWithCost(
		hook: AutonHook,
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number },
	) {
		hook.bindSession({
			subscribe: () => () => {},
			model: { cost } as never,
		});
	}

	test("declared model cost makes --max-cost authoritative and enforcing", () => {
		const hook = new AutonHook({ maxCost: 0.00001, modelId: "claude-sonnet-4-5" });
		bindSessionWithCost(hook, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });

		hook.recordUsage(2000, 2000);
		const status = hook.getBudgetStatus();

		expect(status.costAuthoritative).toBe(true);
		expect(status.exceeded.cost).toBe(true);
		expect(() => hook.abortIfBudgetExceeded()).toThrow(/Cost budget exceeded/);
		expect(hook.getCostSummary()).not.toContain("estimate");
	});

	test("all-zero declared cost (local/free model) stays a non-authoritative zero estimate", () => {
		const hook = new AutonHook({ maxCost: 0.00001, modelId: "lm-studio" });
		bindSessionWithCost(hook, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

		hook.recordUsage(5000, 5000);
		const status = hook.getBudgetStatus();

		expect(status.costUsed).toBe(0);
		expect(status.costAuthoritative).toBe(false);
		expect(status.exceeded.cost).toBe(false);
		expect(hook.getCostSummary()).toContain("estimate");
	});
});
