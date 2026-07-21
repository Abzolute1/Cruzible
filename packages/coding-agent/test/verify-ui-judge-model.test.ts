import type { Model } from "@ag1/ai";
import { describe, expect, test, vi } from "vitest";

vi.mock("../src/core/tools/visual/engine.js", () => ({
	runScreenshot: vi.fn(async () => ({
		image: { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		url: "http://localhost:5173",
		title: "Fixture page",
		consoleErrors: [],
		failedRequests: [],
		loadTimeMs: 5,
	})),
}));

import {
	AgentSessionToolRegistryCoordinator,
	type AgentSessionToolRegistryCoordinatorOptions,
} from "../src/core/agent-session-tool-registry-coordinator.js";
import type { ToolDefinition } from "../src/core/extensions/index.js";

function visionModel(provider: string, id: string): Model<any> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		// Unroutable endpoint: the judge call fails fast and verify_ui reports which model was used.
		baseUrl: "http://127.0.0.1:1/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function createCoordinatorHarness(options: { getVerifierModel?: () => Model<any> | undefined }): {
	verifyUiDefinition: ToolDefinition;
} {
	const activeModel = visionModel("active-provider", "active-1");
	const definitions = new Map<string, ToolDefinition>();
	const coordinatorOptions: AgentSessionToolRegistryCoordinatorOptions = {
		getModel: () => activeModel,
		...(options.getVerifierModel ? { getVerifierModel: options.getVerifierModel } : {}),
		getVisualToolsMode: () => "on",
		getExtensionRunner: () => undefined,
		getBaseToolDefinitions: () => new Map(),
		getCustomTools: () => [],
		getCurrentToolRegistryNames: () => [],
		getCurrentActiveToolNames: () => [],
		normalizePromptSnippet: (text) => text,
		normalizePromptGuidelines: (guidelines) => guidelines ?? [],
		setState: ({ toolDefinitions }) => {
			for (const [name, entry] of toolDefinitions) {
				definitions.set(name, entry.definition);
			}
		},
		applyActiveToolNames: () => {},
	};
	new AgentSessionToolRegistryCoordinator(coordinatorOptions).refresh({ activeToolNames: [] });
	const verifyUiDefinition = definitions.get("verify_ui");
	if (!verifyUiDefinition) throw new Error("verify_ui definition was not registered");
	return { verifyUiDefinition };
}

async function judgeModelUsedBy(definition: ToolDefinition): Promise<string | undefined> {
	const result = await definition.execute(
		"tool-call-1",
		{ url: "http://localhost:5173", claim: "the submit button is visible" },
		undefined,
		undefined,
		{} as never,
	);
	return (result.details as { judgeModel?: string } | undefined)?.judgeModel;
}

describe("verify_ui judge model routing", () => {
	test("uses the verifier model as judge when a verifier route resolves", async () => {
		const verifier = visionModel("verifier-provider", "verifier-1");
		const { verifyUiDefinition } = createCoordinatorHarness({ getVerifierModel: () => verifier });

		expect(await judgeModelUsedBy(verifyUiDefinition)).toBe("verifier-provider/verifier-1");
	});

	test("falls back to the active model when the verifier route resolves to nothing", async () => {
		const { verifyUiDefinition } = createCoordinatorHarness({ getVerifierModel: () => undefined });

		expect(await judgeModelUsedBy(verifyUiDefinition)).toBe("active-provider/active-1");
	});

	test("falls back to the active model when no verifier option is provided", async () => {
		const { verifyUiDefinition } = createCoordinatorHarness({});

		expect(await judgeModelUsedBy(verifyUiDefinition)).toBe("active-provider/active-1");
	});
});
