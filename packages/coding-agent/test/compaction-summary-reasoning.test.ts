import type { AgentMessage } from "@ag1/agent-core";
import type { AssistantMessage, Model } from "@ag1/ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateSummary } from "../src/core/compaction/index.js";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@ag1/ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ag1/ai")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(reasoning: boolean): Model<"anthropic-messages"> {
	return {
		id: reasoning ? "reasoning-model" : "non-reasoning-model",
		name: reasoning ? "Reasoning Model" : "Non-reasoning Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "## Goal\nTest summary" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

describe("generateSummary reasoning options", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("sets reasoning=high for reasoning-capable models", async () => {
		await generateSummary(messages, createModel(true), 2000, "test-key");

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			reasoning: "high",
			apiKey: "test-key",
		});
	});

	it("does not set reasoning for non-reasoning models", async () => {
		await generateSummary(messages, createModel(false), 2000, "test-key");

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("keeps additional focus in a separate tagged block for cache-stable prompts", async () => {
		await generateSummary(messages, createModel(false), 2000, "test-key", undefined, undefined, "Focus on tests");

		const promptText = completeSimpleMock.mock.calls[0][1].messages[0].content[0].text;
		expect(promptText).toContain("<additional-focus>\nFocus on tests\n</additional-focus>");
		expect(promptText).not.toContain("Additional focus: Focus on tests");
		expect(promptText).toContain("## Files & Evidence");
		expect(promptText).toContain("## Verification");
		expect(promptText).toContain("## Open Questions");
		expect(promptText).toContain("## Resume Checklist");
	});

	it("serializes previous summaries in a dedicated tagged block for update prompts", async () => {
		await generateSummary(
			messages,
			createModel(false),
			2000,
			"test-key",
			undefined,
			undefined,
			"Focus on tests",
			"## Goal\nExisting summary",
		);

		const promptText = completeSimpleMock.mock.calls[0][1].messages[0].content[0].text;
		expect(promptText).toContain("<previous-summary>\n## Goal\nExisting summary\n</previous-summary>");
		expect(promptText).toContain("The messages above are NEW conversation messages");
		expect(promptText).toContain("## Resume Checklist");
	});
});
