import type { Model } from "@ag1/ai";
import { describe, expect, it } from "vitest";
import { selectCheapModelForTask } from "../src/core/model-routing.js";

function model(partial: Partial<Model<any>> & Pick<Model<any>, "id" | "provider">): Model<any> {
	return {
		id: partial.id,
		name: partial.name ?? partial.id,
		api: partial.api ?? "anthropic-messages",
		provider: partial.provider,
		baseUrl: partial.baseUrl ?? "https://example.com",
		reasoning: partial.reasoning ?? false,
		input: partial.input ?? ["text"],
		cost: partial.cost ?? { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: partial.contextWindow ?? 128_000,
		maxTokens: partial.maxTokens ?? 8_192,
	};
}

describe("model-routing", () => {
	it("selects an eligible cheaper model for summarization", () => {
		const current = model({
			id: "expensive",
			provider: "anthropic",
			cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
		});
		const cheap = model({
			id: "mini",
			provider: "openai",
			cost: { input: 0.15, output: 0.6, cacheRead: 0.02, cacheWrite: 0.15 },
		});

		const route = selectCheapModelForTask({
			task: "summarization",
			currentModel: current,
			candidates: [cheap],
			minContextWindow: 64_000,
		});

		expect(route.model).toBe(cheap);
		expect(route.reason).toBe("cheaper_available");
	});

	it("keeps current model when cheaper candidates cannot fit the task", () => {
		const current = model({ id: "current", provider: "anthropic", contextWindow: 200_000 });
		const tooSmall = model({
			id: "tiny",
			provider: "openai",
			contextWindow: 8_000,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.01, cacheWrite: 0.01 },
		});

		const route = selectCheapModelForTask({
			task: "summarization",
			currentModel: current,
			candidates: [tooSmall],
			minContextWindow: 64_000,
		});

		expect(route.model).toBe(current);
		expect(route.reason).toBe("current_is_cheapest");
	});

	it("prefers local models for cheap direct lookups when eligible", () => {
		const current = model({ id: "cloud", provider: "anthropic" });
		const local = model({
			id: "lm-studio",
			provider: "local",
			baseUrl: "http://127.0.0.1:1234/v1",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});

		const route = selectCheapModelForTask({
			task: "direct_lookup",
			currentModel: current,
			candidates: [local],
		});

		expect(route.model).toBe(local);
		expect(route.reason).toBe("cheaper_available");
	});
});
