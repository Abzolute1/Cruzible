import type { Model } from "@mariozechner/pi-ai";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.js";
import { ScopedModelsSelectorComponent } from "../src/modes/interactive/components/scoped-models-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function renderComponentText(component: { render: (width: number) => string[] }, width = 160): string {
	return stripAnsi(component.render(width).join("\n"));
}

function createModel(overrides: Partial<Model<any>> & Pick<Model<any>, "id" | "provider" | "name">): Model<any> {
	return {
		id: overrides.id,
		provider: overrides.provider,
		name: overrides.name,
		api: {} as never,
		contextWindow: 128_000,
		maxTokens: 8192,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: {},
		...overrides,
	};
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("model selector pricing", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("shows compact and detailed pricing in the main model picker", async () => {
		const pricedModel = createModel({
			id: "nvidia/nemotron-3-super-120b-a12b",
			provider: "nvidia",
			name: "Nemotron 3 Super (120B)",
			cost: { input: 0.2, output: 0.8, cacheRead: 0, cacheWrite: 0 },
		});

		const selector = new ModelSelectorComponent(
			{ requestRender: vi.fn() } as any,
			pricedModel,
			{ setDefaultModelAndProvider: vi.fn() } as any,
			{
				refresh: vi.fn(),
				getError: () => undefined,
				getAvailable: () => [pricedModel],
				find: () => pricedModel,
			} as any,
			[],
			vi.fn(),
			vi.fn(),
		);

		await flushMicrotasks();

		const output = renderComponentText(selector);
		expect(output).toContain("$0.20/$0.80");
		expect(output).toContain("Pricing: $0.20 in / $0.80 out per 1M");
	});

	test("shows pricing in the scoped model picker", () => {
		const pricedModel = createModel({
			id: "nvidia/llama-3.1-nemotron-ultra-253b-v1",
			provider: "nvidia",
			name: "Llama 3.1 Nemotron Ultra (253B)",
			cost: { input: 0.6, output: 1.8, cacheRead: 0, cacheWrite: 0 },
		});

		const selector = new ScopedModelsSelectorComponent(
			{
				allModels: [pricedModel],
				enabledModelIds: new Set<string>(),
				hasEnabledModelsFilter: false,
			},
			{
				onModelToggle: vi.fn(),
				onPersist: vi.fn(),
				onEnableAll: vi.fn(),
				onClearAll: vi.fn(),
				onToggleProvider: vi.fn(),
				onCancel: vi.fn(),
			},
		);

		const output = renderComponentText(selector);
		expect(output).toContain("$0.60/$1.80");
		expect(output).toContain("Pricing: $0.60 in / $1.80 out per 1M");
	});
});
