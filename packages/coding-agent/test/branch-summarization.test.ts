import type { AssistantMessage, Model } from "@ag1/ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateBranchSummary } from "../src/core/compaction/branch-summarization.js";
import type { SessionEntry } from "../src/core/session-manager.js";

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

function createModel(): Model<"anthropic-messages"> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "## Goal\nBranch summary" }],
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

describe("generateBranchSummary", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("uses context hygiene so old assistant thinking is not sent into branch summarization prompts", async () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: {
					role: "user",
					content: "Summarize the branch",
					timestamp: Date.now(),
				},
			},
			{
				type: "message",
				id: "2",
				parentId: "1",
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "private reasoning should be omitted" },
						{ type: "text", text: "Visible answer" },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test-model",
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
				},
			},
		];

		await generateBranchSummary(entries, {
			model: createModel(),
			apiKey: "test-key",
			signal: new AbortController().signal,
		});

		const promptText = completeSimpleMock.mock.calls[0][1].messages[0].content[0].text;
		expect(promptText).toContain("## Files & Evidence");
		expect(promptText).toContain("## Verification");
		expect(promptText).toContain("## Open Questions");
		expect(promptText).toContain("Visible answer");
		expect(promptText).not.toContain("Assistant thinking");
		expect(promptText).not.toContain("private reasoning should be omitted");
	});
});
