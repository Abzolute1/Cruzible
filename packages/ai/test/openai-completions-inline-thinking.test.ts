import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/stream.js";
import type { AssistantMessageEvent, Model } from "../src/types.js";

const mockState = vi.hoisted(() => ({
	chunks: undefined as
		| Array<{
				id?: string;
				choices?: Array<{ delta: Record<string, unknown>; finish_reason: string | null; usage?: unknown }>;
				usage?: {
					prompt_tokens: number;
					completion_tokens: number;
					prompt_tokens_details: { cached_tokens: number; cache_write_tokens?: number };
					completion_tokens_details: { reasoning_tokens: number };
				};
		  }>
		| undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: async () => ({
					async *[Symbol.asyncIterator]() {
						const chunks = mockState.chunks ?? [];
						for (const chunk of chunks) {
							yield chunk;
						}
					},
				}),
			},
		};
	}

	return { default: FakeOpenAI };
});

function createModel(reasoning: boolean): Model<"openai-completions"> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "nvidia",
		baseUrl: "https://example.test/v1",
		reasoning,
		input: ["text"],
		contextWindow: 128000,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

describe("openai-completions inline thinking normalization", () => {
	beforeEach(() => {
		mockState.chunks = undefined;
	});

	it("turns streamed <think> tags into thinking blocks", async () => {
		mockState.chunks = [
			{ id: "resp_1", choices: [{ delta: { content: "A<thi" }, finish_reason: null }] },
			{ id: "resp_1", choices: [{ delta: { content: "nk>sec" }, finish_reason: null }] },
			{ id: "resp_1", choices: [{ delta: { content: "ret</th" }, finish_reason: null }] },
			{
				id: "resp_1",
				choices: [{ delta: { content: "ink>B" }, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 3,
					completion_tokens: 4,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const events: AssistantMessageEvent[] = [];
		const stream = streamSimple(
			createModel(true),
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test", reasoning: "medium" },
		);

		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(events.map((event) => event.type)).toContain("thinking_start");
		expect(events.map((event) => event.type)).toContain("thinking_delta");
		expect(result.content).toEqual([
			{ type: "text", text: "A" },
			{ type: "thinking", thinking: "secret", thinkingSignature: undefined },
			{ type: "text", text: "B" },
		]);

		const textDeltas = events
			.filter(
				(event): event is Extract<AssistantMessageEvent, { type: "text_delta" }> => event.type === "text_delta",
			)
			.map((event) => event.delta)
			.join("");
		const thinkingDeltas = events
			.filter(
				(event): event is Extract<AssistantMessageEvent, { type: "thinking_delta" }> =>
					event.type === "thinking_delta",
			)
			.map((event) => event.delta)
			.join("");

		expect(textDeltas).toBe("AB");
		expect(thinkingDeltas).toBe("secret");
	});

	it("leaves literal <think> text alone for non-reasoning models", async () => {
		mockState.chunks = [
			{
				id: "resp_2",
				choices: [{ delta: { content: "literal <think>tag</think> text" }, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 3,
					completion_tokens: 4,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const stream = streamSimple(
			createModel(false),
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test" },
		);
		const result = await stream.result();

		expect(result.content).toEqual([{ type: "text", text: "literal <think>tag</think> text" }]);
	});
});
