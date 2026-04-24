import type { AgentMessage } from "@ag1/agent-core";
import { describe, expect, it } from "vitest";
import { createContextHygieneCopy, createLiveProviderContext, microCompact } from "../src/core/compaction/micro-compact.js";

function createTurnWithToolResult(
	userText: string,
	toolName: string,
	toolResultContent: AgentMessage["content"],
): AgentMessage[] {
	return [
		{
			role: "user",
			content: [{ type: "text", text: userText }],
			timestamp: 1,
		},
		{
			role: "assistant",
			content: [{ type: "toolCall", id: `${toolName}-1`, name: toolName, arguments: {} }],
			api: "responses",
			provider: "faux",
			model: "faux-1",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		} as AgentMessage,
		{
			role: "toolResult",
			toolCallId: `${toolName}-1`,
			content: toolResultContent,
			timestamp: 3,
		} as AgentMessage,
	];
}

describe("createContextHygieneCopy", () => {
	it("compacts old large tool results without mutating the original messages", () => {
		const oldLongText = "A".repeat(900);
		const messages: AgentMessage[] = [
			...createTurnWithToolResult("old", "bash", [{ type: "text", text: oldLongText }]),
			...createTurnWithToolResult("recent", "bash", [{ type: "text", text: "short recent output" }]),
		];

		const result = createContextHygieneCopy(messages, 1);
		const oldResult = result[2] as Extract<AgentMessage, { role: "toolResult" }>;
		const recentResult = result[5] as Extract<AgentMessage, { role: "toolResult" }>;
		const originalOldResult = messages[2] as Extract<AgentMessage, { role: "toolResult" }>;

		expect(result).not.toBe(messages);
		expect(Array.isArray(oldResult.content)).toBe(true);
		expect((oldResult.content as Array<{ type: "text"; text: string }>)[0].text).toContain("[truncated] bash result:");
		expect((recentResult.content as Array<{ type: "text"; text: string }>)[0].text).toBe("short recent output");
		expect((originalOldResult.content as Array<{ type: "text"; text: string }>)[0].text).toBe(oldLongText);
	});

	it("replaces old image tool results with compact text placeholders while preserving text context", () => {
		const messages: AgentMessage[] = [
			...createTurnWithToolResult("old image", "read", [
				{ type: "text", text: "Screenshot of the bug report" },
				{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
			]),
			...createTurnWithToolResult("recent image", "read", [
				{ type: "text", text: "Fresh screenshot" },
				{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
			]),
		];

		const result = createContextHygieneCopy(messages, 1);
		const oldResult = result[2] as Extract<AgentMessage, { role: "toolResult" }>;
		const recentResult = result[5] as Extract<AgentMessage, { role: "toolResult" }>;
		const oldText = (oldResult.content as Array<{ type: "text"; text: string }>)[0].text;

		expect(oldResult.content).toEqual([
			{
				type: "text",
				text: "Screenshot of the bug report\n\n[older image attachment omitted to preserve context]",
			},
		]);
		expect(Array.isArray(recentResult.content)).toBe(true);
		expect((recentResult.content as Array<{ type: string }>).some((block) => block.type === "image")).toBe(true);
		expect(oldText).toContain("Screenshot of the bug report");
		expect(oldText).toContain("older image attachment omitted");
	});

	it("replaces stale user images with a compact placeholder while preserving nearby text", () => {
		const messages: AgentMessage[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "Please inspect this screenshot" },
					{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
				],
				timestamp: 1,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "I will inspect it." }],
				api: "responses",
				provider: "faux",
				model: "faux-1",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			} as AgentMessage,
			{
				role: "user",
				content: [{ type: "text", text: "new prompt" }],
				timestamp: 3,
			},
		];

		const result = createContextHygieneCopy(messages, 1);
		const oldUser = result[0] as Extract<AgentMessage, { role: "user" }>;
		expect(oldUser.content).toEqual([
			{
				type: "text",
				text: "Please inspect this screenshot\n\n[older image attachment omitted to preserve context]",
			},
		]);
	});

	it("replaces stale non-image attachments with a generic placeholder", () => {
		const messages: AgentMessage[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "Please inspect this recording" },
					{ type: "audio", data: "ZmFrZQ==", mimeType: "audio/wav" } as any,
				],
				timestamp: 1,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "I will inspect it." }],
				api: "responses",
				provider: "faux",
				model: "faux-1",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			} as AgentMessage,
			{
				role: "user",
				content: [{ type: "text", text: "recent prompt" }],
				timestamp: 3,
			},
		];

		const result = createContextHygieneCopy(messages, 1);
		const oldUser = result[0] as Extract<AgentMessage, { role: "user" }>;
		expect(oldUser.content).toEqual([
			{
				type: "text",
				text: "Please inspect this recording\n\n[older non-text attachment omitted to preserve context]",
			},
		]);
	});

	it("strips old assistant thinking blocks while preserving visible assistant content", () => {
		const messages: AgentMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "old prompt" }],
				timestamp: 1,
			},
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "very long hidden reasoning" },
					{ type: "text", text: "Visible answer" },
				],
				api: "responses",
				provider: "faux",
				model: "faux-1",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			} as AgentMessage,
			{
				role: "user",
				content: [{ type: "text", text: "recent prompt" }],
				timestamp: 3,
			},
		];

		const result = createContextHygieneCopy(messages, 1);
		const oldAssistant = result[1] as Extract<AgentMessage, { role: "assistant" }>;

		expect(oldAssistant.content).toEqual([{ type: "text", text: "Visible answer" }]);
	});

	it("replaces stale hidden custom runtime messages with compact placeholders", () => {
		const messages: AgentMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "old prompt" }],
				timestamp: 1,
			},
			{
				role: "custom",
				customType: "runtime_continuation_state",
				content: [{ type: "text", text: "x".repeat(400) }],
				display: false,
				timestamp: 2,
			},
			{
				role: "user",
				content: [{ type: "text", text: "recent prompt" }],
				timestamp: 3,
			},
		];

		const result = createContextHygieneCopy(messages, 1);
		const hidden = result[1] as Extract<AgentMessage, { role: "custom" }>;

		expect(hidden.content).toEqual([
			{
				type: "text",
				text: "[older hidden continuation state omitted to preserve context]",
			},
		]);
	});
});

describe("createLiveProviderContext", () => {
	it("appends a hidden continuation-compression hint for bulky trailing tool output", () => {
		const messages: AgentMessage[] = createTurnWithToolResult(
			"inspect the changelog",
			"read",
			[{ type: "text", text: "A".repeat(900) }],
		);

		const result = createLiveProviderContext(messages);
		const last = result[result.length - 1] as Extract<AgentMessage, { role: "custom" }>;

		expect(result).toHaveLength(messages.length + 1);
		expect(last.role).toBe("custom");
		expect(last.customType).toBe("post_tool_continuation_state");
		expect(last.display).toBe(false);
		expect((last.content as Array<{ type: "text"; text: string }>)[0].text).toContain(
			"Summarize the task tool output above and continue with your task.",
		);
		expect((last.content as Array<{ type: "text"; text: string }>)[0].text).toContain("answer now");
	});

	it("does not append continuation compression for small trailing tool output", () => {
		const messages: AgentMessage[] = createTurnWithToolResult(
			"inspect the file",
			"read",
			[{ type: "text", text: "small output" }],
		);

		const result = createLiveProviderContext(messages);
		expect(result).toBe(messages);
	});

	it("does not append continuation compression after a final assistant answer", () => {
		const messages: AgentMessage[] = [
			...createTurnWithToolResult("inspect the file", "read", [{ type: "text", text: "A".repeat(900) }]),
			{
				role: "assistant",
				content: [{ type: "text", text: "Final answer" }],
				api: "responses",
				provider: "faux",
				model: "faux-1",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 4,
			} as AgentMessage,
		];

		const result = createLiveProviderContext(messages);
		expect(result).toBe(messages);
	});
});

describe("microCompact", () => {
	it("compacts stale hidden custom runtime messages in-place", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "old prompt" }], timestamp: 1 },
			{
				role: "custom",
				customType: "runtime_continuation_state",
				content: [{ type: "text", text: "x".repeat(700) }],
				display: false,
				timestamp: 2,
			},
			{ role: "user", content: [{ type: "text", text: "recent prompt" }], timestamp: 3 },
		];

		const compacted = microCompact(messages, 1);
		expect(compacted).toBe(1);
		expect(messages[1]).toMatchObject({
			role: "custom",
			content: [{ type: "text", text: "[older hidden continuation state omitted to preserve context]" }],
		});
	});

	it("strips stale assistant thinking from session-pipeline history during micro compaction", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "old prompt" }], timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hidden chain" },
					{ type: "text", text: "Visible answer" },
				],
				api: "responses",
				provider: "faux",
				model: "faux-1",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			} as AgentMessage,
			{ role: "user", content: [{ type: "text", text: "recent prompt" }], timestamp: 3 },
		];

		const compacted = microCompact(messages, 1);
		expect(compacted).toBe(1);
		expect(messages[1]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Visible answer" }],
		});
	});
});
