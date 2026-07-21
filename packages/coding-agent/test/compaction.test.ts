import type { AgentMessage } from "@ag1/agent-core";
import type { AssistantMessage, Usage } from "@ag1/ai";
import { getModel } from "@ag1/ai";
import { readFileSync } from "fs";
import { join } from "path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type CompactionSettings,
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokenAttribution,
	estimateContextTokens,
	extractWorkingMemory,
	findCutPoint,
	formatWorkingMemoryForSummary,
	formatWorkingMemoryPrimaryState,
	getLastAssistantUsage,
	prepareCompaction,
	shouldCompact,
	type WorkingMemoryLedger,
} from "../src/core/compaction/index.js";
import {
	buildSessionContext,
	type CompactionEntry,
	type ModelChangeEntry,
	migrateSessionEntries,
	parseSessionEntries,
	type SessionEntry,
	type SessionMessageEntry,
	type ThinkingLevelChangeEntry,
} from "../src/core/session-manager.js";

// ============================================================================
// Test fixtures
// ============================================================================

function loadLargeSessionEntries(): SessionEntry[] {
	const sessionPath = join(__dirname, "fixtures/large-session.jsonl");
	const content = readFileSync(sessionPath, "utf-8");
	const entries = parseSessionEntries(content);
	migrateSessionEntries(entries); // Add id/parentId for v1 fixtures
	return entries.filter((e): e is SessionEntry => e.type !== "session");
}

function createMockUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createAssistantMessage(text: string, usage?: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: usage || createMockUsage(100, 50),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

function createAssistantToolCall(name: string, args: Record<string, unknown>, id = `${name}-call`): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		usage: createMockUsage(100, 50),
		stopReason: "toolUse",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

function createToolResult(toolCallId: string, text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	} as AgentMessage;
}

let entryCounter = 0;
let lastId: string | null = null;

function resetEntryCounter() {
	entryCounter = 0;
	lastId = null;
}

// Reset counter before each test to get predictable IDs
beforeEach(() => {
	resetEntryCounter();
});

function createMessageEntry(message: AgentMessage): SessionMessageEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: SessionMessageEntry = {
		type: "message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		message,
	};
	lastId = id;
	return entry;
}

function createCompactionEntry(summary: string, firstKeptEntryId: string, details?: unknown): CompactionEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: CompactionEntry = {
		type: "compaction",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 10000,
		details,
	};
	lastId = id;
	return entry;
}

function createModelChangeEntry(provider: string, modelId: string): ModelChangeEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: ModelChangeEntry = {
		type: "model_change",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		provider,
		modelId,
	};
	lastId = id;
	return entry;
}

function createThinkingLevelEntry(thinkingLevel: string): ThinkingLevelChangeEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: ThinkingLevelChangeEntry = {
		type: "thinking_level_change",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		thinkingLevel,
	};
	lastId = id;
	return entry;
}

function extractText(messages: AgentMessage[]): string {
	return messages
		.map((message) => {
			switch (message.role) {
				case "user":
					return typeof message.content === "string"
						? message.content
						: message.content
								.filter((block): block is { type: "text"; text: string } => block.type === "text")
								.map((block) => block.text)
								.join(" ");
				case "assistant":
					return message.content
						.filter((block): block is { type: "text"; text: string } => block.type === "text")
						.map((block) => block.text)
						.join(" ");
				case "branchSummary":
				case "compactionSummary":
					return message.summary;
				case "custom":
				case "toolResult":
					return typeof message.content === "string"
						? message.content
						: message.content
								.filter((block): block is { type: "text"; text: string } => block.type === "text")
								.map((block) => block.text)
								.join(" ");
				case "bashExecution":
					return `${message.command}\n${message.output}`;
				default:
					return "";
			}
		})
		.join("\n");
}

// ============================================================================
// Unit tests
// ============================================================================

describe("Token calculation", () => {
	it("should calculate total context tokens from usage", () => {
		const usage = createMockUsage(1000, 500, 200, 100);
		expect(calculateContextTokens(usage)).toBe(1800);
	});

	it("should handle zero values", () => {
		const usage = createMockUsage(0, 0, 0, 0);
		expect(calculateContextTokens(usage)).toBe(0);
	});

	it("estimates live context after hygiene removes old thinking and hidden runtime messages", () => {
		const bulkyThinking = "x".repeat(4000);
		const hiddenControl = "y".repeat(1000);
		const messages: AgentMessage[] = [
			{ role: "user", content: "old prompt", timestamp: Date.now() - 5_000 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: bulkyThinking },
					{ type: "text", text: "Visible answer" },
				],
				usage: createMockUsage(100, 50),
				stopReason: "stop",
				timestamp: Date.now() - 4_000,
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
			},
			{
				role: "custom",
				customType: "runtime_continuation_state",
				content: hiddenControl,
				display: false,
				timestamp: Date.now() - 3_000,
			},
			{ role: "user", content: "recent prompt", timestamp: Date.now() - 2_000 },
			createAssistantMessage("recent answer", createMockUsage(200, 100)),
		];

		const estimate = estimateContextTokens(messages);
		expect(estimate.tokens).toBeLessThan(1600);
	});

	it("attributes estimated context tokens by source", () => {
		const attribution = estimateContextTokenAttribution({
			systemPrompt: "system instructions",
			tools: [
				{
					name: "read",
					label: "Read",
					description: "Read a file",
					parameters: { type: "object", properties: { path: { type: "string" } } },
					execute: async () => ({ content: [], details: {} }),
				},
			],
			messages: [
				createUserMessage("Fix the bug"),
				createAssistantMessage("I will inspect it"),
				createToolResult("read-1", "file output"),
				{ role: "compactionSummary", summary: "Previous summary", tokensBefore: 100, timestamp: Date.now() },
			],
			totalTokens: 1000,
		});

		expect(attribution.systemPrompt).toBeGreaterThan(0);
		expect(attribution.toolSchemas).toBeGreaterThan(0);
		expect(attribution.retainedTranscript).toBeGreaterThan(0);
		expect(attribution.toolOutputs).toBeGreaterThan(0);
		expect(attribution.summaries).toBeGreaterThan(0);
		expect(attribution.estimatedTotal).toBeGreaterThan(0);
		expect(attribution.overhead).toBe(1000 - attribution.estimatedTotal);
	});
});

describe("getLastAssistantUsage", () => {
	it("should find the last non-aborted assistant message usage", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Hello")),
			createMessageEntry(createAssistantMessage("Hi", createMockUsage(100, 50))),
			createMessageEntry(createUserMessage("How are you?")),
			createMessageEntry(createAssistantMessage("Good", createMockUsage(200, 100))),
		];

		const usage = getLastAssistantUsage(entries);
		expect(usage).not.toBeNull();
		expect(usage!.input).toBe(200);
	});

	it("should skip aborted messages", () => {
		const abortedMsg: AssistantMessage = {
			...createAssistantMessage("Aborted", createMockUsage(300, 150)),
			stopReason: "aborted",
		};

		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Hello")),
			createMessageEntry(createAssistantMessage("Hi", createMockUsage(100, 50))),
			createMessageEntry(createUserMessage("How are you?")),
			createMessageEntry(abortedMsg),
		];

		const usage = getLastAssistantUsage(entries);
		expect(usage).not.toBeNull();
		expect(usage!.input).toBe(100);
	});

	it("should return undefined if no assistant messages", () => {
		const entries: SessionEntry[] = [createMessageEntry(createUserMessage("Hello"))];
		expect(getLastAssistantUsage(entries)).toBeUndefined();
	});
});

describe("shouldCompact", () => {
	it("should return true when context exceeds threshold", () => {
		const settings: CompactionSettings = {
			enabled: true,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
		};

		expect(shouldCompact(95000, 100000, settings)).toBe(true);
		expect(shouldCompact(89000, 100000, settings)).toBe(false);
	});

	it("should return false when disabled", () => {
		const settings: CompactionSettings = {
			enabled: false,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
		};

		expect(shouldCompact(95000, 100000, settings)).toBe(false);
	});
});

describe("findCutPoint", () => {
	it("should find cut point based on actual token differences", () => {
		// Create entries with cumulative token counts
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 10; i++) {
			entries.push(createMessageEntry(createUserMessage(`User ${i}`)));
			entries.push(
				createMessageEntry(createAssistantMessage(`Assistant ${i}`, createMockUsage(0, 100, (i + 1) * 1000, 0))),
			);
		}

		// 20 entries, last assistant has 10000 tokens
		// keepRecentTokens = 2500: keep entries where diff < 2500
		const result = findCutPoint(entries, 0, entries.length, 2500);

		// Should cut at a valid cut point (user or assistant message)
		expect(entries[result.firstKeptEntryIndex].type).toBe("message");
		const role = (entries[result.firstKeptEntryIndex] as SessionMessageEntry).message.role;
		expect(role === "user" || role === "assistant").toBe(true);
	});

	it("should return startIndex if no valid cut points in range", () => {
		const entries: SessionEntry[] = [createMessageEntry(createAssistantMessage("a"))];
		const result = findCutPoint(entries, 0, entries.length, 1000);
		expect(result.firstKeptEntryIndex).toBe(0);
	});

	it("should keep everything if all messages fit within budget", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createMessageEntry(createAssistantMessage("a", createMockUsage(0, 50, 500, 0))),
			createMessageEntry(createUserMessage("2")),
			createMessageEntry(createAssistantMessage("b", createMockUsage(0, 50, 1000, 0))),
		];

		const result = findCutPoint(entries, 0, entries.length, 50000);
		expect(result.firstKeptEntryIndex).toBe(0);
	});

	it("should indicate split turn when cutting at assistant message", () => {
		// Create a scenario where we cut at an assistant message mid-turn
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(createAssistantMessage("A1", createMockUsage(0, 100, 1000, 0))),
			createMessageEntry(createUserMessage("Turn 2")), // index 2
			createMessageEntry(createAssistantMessage("A2-1", createMockUsage(0, 100, 5000, 0))), // index 3
			createMessageEntry(createAssistantMessage("A2-2", createMockUsage(0, 100, 8000, 0))), // index 4
			createMessageEntry(createAssistantMessage("A2-3", createMockUsage(0, 100, 10000, 0))), // index 5
		];

		// With keepRecentTokens = 3000, should cut somewhere in Turn 2
		const result = findCutPoint(entries, 0, entries.length, 3000);

		// If cut at assistant message (not user), should indicate split turn
		const cutEntry = entries[result.firstKeptEntryIndex] as SessionMessageEntry;
		if (cutEntry.message.role === "assistant") {
			expect(result.isSplitTurn).toBe(true);
			expect(result.turnStartIndex).toBe(2); // Turn 2 starts at index 2
		}
	});
});

describe("buildSessionContext", () => {
	it("should load all messages when no compaction", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createMessageEntry(createAssistantMessage("a")),
			createMessageEntry(createUserMessage("2")),
			createMessageEntry(createAssistantMessage("b")),
		];

		const loaded = buildSessionContext(entries);
		expect(loaded.messages.length).toBe(4);
		expect(loaded.thinkingLevel).toBe("off");
		expect(loaded.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
	});

	it("should handle single compaction", () => {
		// IDs: u1=test-id-0, a1=test-id-1, u2=test-id-2, a2=test-id-3, compaction=test-id-4, u3=test-id-5, a3=test-id-6
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const u2 = createMessageEntry(createUserMessage("2"));
		const a2 = createMessageEntry(createAssistantMessage("b"));
		const compaction = createCompactionEntry("Summary of 1,a,2,b", u2.id); // keep from u2 onwards
		const u3 = createMessageEntry(createUserMessage("3"));
		const a3 = createMessageEntry(createAssistantMessage("c"));

		const entries: SessionEntry[] = [u1, a1, u2, a2, compaction, u3, a3];

		const loaded = buildSessionContext(entries);
		// summary + kept (u2, a2) + after (u3, a3) = 5
		expect(loaded.messages.length).toBe(5);
		expect(loaded.messages[0].role).toBe("compactionSummary");
		expect((loaded.messages[0] as any).summary).toContain("Summary of 1,a,2,b");
	});

	it("should handle multiple compactions (only latest matters)", () => {
		// First batch
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const compact1 = createCompactionEntry("First summary", u1.id);
		// Second batch
		const u2 = createMessageEntry(createUserMessage("2"));
		const b = createMessageEntry(createAssistantMessage("b"));
		const u3 = createMessageEntry(createUserMessage("3"));
		const c = createMessageEntry(createAssistantMessage("c"));
		const compact2 = createCompactionEntry("Second summary", u3.id); // keep from u3 onwards
		// After second compaction
		const u4 = createMessageEntry(createUserMessage("4"));
		const d = createMessageEntry(createAssistantMessage("d"));

		const entries: SessionEntry[] = [u1, a1, compact1, u2, b, u3, c, compact2, u4, d];

		const loaded = buildSessionContext(entries);
		// summary + kept from u3 (u3, c) + after (u4, d) = 5
		expect(loaded.messages.length).toBe(5);
		expect((loaded.messages[0] as any).summary).toContain("Second summary");
	});

	it("should keep all messages when firstKeptEntryId is first entry", () => {
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const compact1 = createCompactionEntry("First summary", u1.id); // keep from first entry
		const u2 = createMessageEntry(createUserMessage("2"));
		const b = createMessageEntry(createAssistantMessage("b"));

		const entries: SessionEntry[] = [u1, a1, compact1, u2, b];

		const loaded = buildSessionContext(entries);
		// summary + all messages (u1, a1, u2, b) = 5
		expect(loaded.messages.length).toBe(5);
	});

	it("should track model and thinking level changes", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createModelChangeEntry("openai", "gpt-4"),
			createMessageEntry(createAssistantMessage("a")),
			createThinkingLevelEntry("high"),
		];

		const loaded = buildSessionContext(entries);
		// model_change is later overwritten by assistant message's model info
		expect(loaded.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		expect(loaded.thinkingLevel).toBe("high");
	});
});

describe("prepareCompaction with previous compaction", () => {
	it("should preserve kept messages across repeated compactions when they still fit", () => {
		const u1 = createMessageEntry(createUserMessage("user msg 1 (summarized by compaction1)"));
		const a1 = createMessageEntry(createAssistantMessage("assistant msg 1"));
		const u2 = createMessageEntry(createUserMessage("user msg 2 - kept by compaction1"));
		const a2 = createMessageEntry(createAssistantMessage("assistant msg 2"));
		const u3 = createMessageEntry(createUserMessage("user msg 3 - kept by compaction1"));
		const a3 = createMessageEntry(createAssistantMessage("assistant msg 3", createMockUsage(5000, 1000)));
		const compaction1 = createCompactionEntry("First summary", u2.id);
		const u4 = createMessageEntry(createUserMessage("user msg 4 (new after compaction1)"));
		const a4 = createMessageEntry(createAssistantMessage("assistant msg 4", createMockUsage(8000, 2000)));

		const pathEntries = [u1, a1, u2, a2, u3, a3, compaction1, u4, a4];
		const contextBefore = buildSessionContext(pathEntries);
		const preparation = prepareCompaction(pathEntries, DEFAULT_COMPACTION_SETTINGS);

		expect(preparation).toBeDefined();
		expect(preparation!.firstKeptEntryId).toBe(u2.id);
		expect(preparation!.previousSummary).toBe("First summary");
		expect(extractText(preparation!.messagesToSummarize)).not.toContain("First summary");
		expect(preparation!.tokensBefore).toBe(estimateContextTokens(contextBefore.messages).tokens);

		const compaction2: CompactionEntry = {
			type: "compaction",
			id: "compaction2-id",
			parentId: a4.id,
			timestamp: new Date().toISOString(),
			summary: "Second summary",
			firstKeptEntryId: preparation!.firstKeptEntryId,
			tokensBefore: preparation!.tokensBefore,
		};
		const contextAfter = buildSessionContext([...pathEntries, compaction2]);
		const contextAfterText = extractText(contextAfter.messages);

		expect(contextAfterText).toContain("user msg 2 - kept by compaction1");
		expect(contextAfterText).toContain("user msg 3 - kept by compaction1");
	});

	it("should re-summarize previously kept messages when the recent window moves past them", () => {
		const u1 = createMessageEntry(createUserMessage("user msg 1 (summarized by compaction1)".repeat(4)));
		const a1 = createMessageEntry(createAssistantMessage("assistant msg 1".repeat(4)));
		const u2 = createMessageEntry(createUserMessage("user msg 2 - kept by compaction1 ".repeat(12)));
		const a2 = createMessageEntry(createAssistantMessage("assistant msg 2 ".repeat(12)));
		const u3 = createMessageEntry(createUserMessage("user msg 3 - kept by compaction1 ".repeat(12)));
		const a3 = createMessageEntry(createAssistantMessage("assistant msg 3 ".repeat(12), createMockUsage(5000, 1000)));
		const compaction1 = createCompactionEntry("First summary", u2.id);
		const u4 = createMessageEntry(createUserMessage("user msg 4 (new after compaction1) ".repeat(12)));
		const a4 = createMessageEntry(createAssistantMessage("assistant msg 4 ".repeat(12), createMockUsage(8000, 2000)));

		const settings: CompactionSettings = {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 100,
		};
		const preparation = prepareCompaction([u1, a1, u2, a2, u3, a3, compaction1, u4, a4], settings);

		expect(preparation).toBeDefined();
		const summarizedText = extractText(preparation!.messagesToSummarize);
		expect(summarizedText).toContain("user msg 2 - kept by compaction1");
		expect(summarizedText).toContain("user msg 3 - kept by compaction1");
		expect(summarizedText).not.toContain("First summary");
		expect(preparation!.previousSummary).toBe("First summary");
	});
});

describe("working memory ledger", () => {
	it("extracts goals, constraints, files, failed attempts, and verification state", () => {
		const memory = extractWorkingMemory({
			messages: [
				createUserMessage("Fix the parser. Do not touch generated files. Verify with npm test."),
				createAssistantToolCall("read", { path: "src/parser.ts" }, "read-1"),
				createAssistantToolCall("edit", { path: "src/parser.ts", old: "bad", new: "good" }, "edit-1"),
				createAssistantToolCall("bash", { command: "npm test" }, "bash-1"),
				createToolResult("bash-1", "Error: expected true to equal false\nexit code 1"),
				createAssistantMessage("Next step: update the parser guard and rerun verification."),
			],
		});

		expect(memory.goals).toContain("Fix the parser. Do not touch generated files. Verify with npm test.");
		expect(memory.constraints).toEqual(["Do not touch generated files.", "Verify with npm test."]);
		expect(memory.readFiles).toContain("src/parser.ts");
		expect(memory.modifiedFiles).toContain("src/parser.ts");
		expect(memory.commandsRun).toContain("npm test");
		expect(memory.failedAttempts[0]).toContain("npm test: Error: expected true to equal false");
		expect(memory.verification).toEqual([
			expect.objectContaining({
				command: "npm test",
				status: "failed",
			}),
		]);
		expect(memory.nextSteps).toContain("Next step: update the parser guard and rerun verification.");
	});

	it("carries previous working memory through repeated compactions", () => {
		const previousMemory: WorkingMemoryLedger = {
			goals: ["Fix auth retry behavior"],
			constraints: ["Only edit src/auth.ts"],
			readFiles: ["tests/auth.test.ts"],
			modifiedFiles: [],
			commandsRun: ["npm test"],
			failedAttempts: ["npm test: retry assertion failed"],
			verification: [{ command: "npm test", status: "failed", detail: "retry assertion failed" }],
			nextSteps: ["Patch src/auth.ts"],
			openQuestions: [],
		};
		const u1 = createMessageEntry(createUserMessage("old"));
		const a1 = createMessageEntry(createAssistantMessage("old answer"));
		const compact1 = createCompactionEntry("First summary", u1.id, {
			readFiles: ["tests/auth.test.ts"],
			modifiedFiles: [],
			workingMemory: previousMemory,
		});
		const u2 = createMessageEntry(createUserMessage("Continue. Verify with npm test."));
		const a2 = createMessageEntry(createAssistantToolCall("edit", { path: "src/auth.ts" }, "edit-2"));
		const u3 = createMessageEntry(createUserMessage("recent prompt"));
		const a3 = createMessageEntry(createAssistantMessage("recent answer", createMockUsage(8000, 2000)));

		const preparation = prepareCompaction([u1, a1, compact1, u2, a2, u3, a3], {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
		});

		expect(preparation).toBeDefined();
		expect(preparation!.workingMemory.goals).toContain("Fix auth retry behavior");
		expect(preparation!.workingMemory.constraints).toContain("Only edit src/auth.ts");
		expect(preparation!.workingMemory.modifiedFiles).toContain("src/auth.ts");
		expect(preparation!.workingMemory.failedAttempts).toContain("npm test: retry assertion failed");
	});

	it("formats working memory as an inspectable summary artifact", () => {
		const text = formatWorkingMemoryForSummary({
			goals: ["Fix auth retry behavior"],
			constraints: ["Only edit src/auth.ts"],
			readFiles: ["tests/auth.test.ts"],
			modifiedFiles: ["src/auth.ts"],
			commandsRun: ["npm test"],
			failedAttempts: ["npm test: retry assertion failed"],
			verification: [{ command: "npm test", status: "failed", detail: "retry assertion failed" }],
			nextSteps: ["Patch src/auth.ts"],
			openQuestions: ["Is retry count off by one?"],
		});

		expect(text).toContain("<working-memory>");
		expect(text).toContain("constraints:");
		expect(text).toContain("- Only edit src/auth.ts");
		expect(text).toContain("verification:");
		expect(text).toContain("- failed: npm test");
		expect(text).toContain("</working-memory>");
	});

	it("formats working memory as primary compacted state", () => {
		const text = formatWorkingMemoryPrimaryState({
			goals: ["Fix auth retry behavior"],
			constraints: ["Only edit src/auth.ts"],
			readFiles: ["tests/auth.test.ts"],
			modifiedFiles: ["src/auth.ts"],
			commandsRun: ["npm test"],
			failedAttempts: [],
			verification: [{ command: "npm test", status: "passed" }],
			nextSteps: ["Report the result"],
			openQuestions: [],
		});

		expect(text).toMatch(/^## Deterministic Working Memory/);
		expect(text).toContain("<working-memory>");
		expect(text).toContain("goals:");
		expect(text).toContain("Treat this ledger as the primary compacted state");
	});
});

// ============================================================================
// Integration tests with real session data
// ============================================================================

describe("Large session fixture", () => {
	it("should parse the large session", () => {
		const entries = loadLargeSessionEntries();
		expect(entries.length).toBeGreaterThan(100);

		const messageCount = entries.filter((e) => e.type === "message").length;
		expect(messageCount).toBeGreaterThan(100);
	});

	it("should find cut point in large session", () => {
		const entries = loadLargeSessionEntries();
		const result = findCutPoint(entries, 0, entries.length, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);

		// Cut point should be at a message entry (user or assistant)
		expect(entries[result.firstKeptEntryIndex].type).toBe("message");
		const role = (entries[result.firstKeptEntryIndex] as SessionMessageEntry).message.role;
		expect(role === "user" || role === "assistant").toBe(true);
	});

	it("should load session correctly", () => {
		const entries = loadLargeSessionEntries();
		const loaded = buildSessionContext(entries);

		expect(loaded.messages.length).toBeGreaterThan(100);
		expect(loaded.model).not.toBeNull();
	});
});

// ============================================================================
// LLM integration tests (skipped without API key)
// ============================================================================

describe.skipIf(!process.env.ANTHROPIC_OAUTH_TOKEN)("LLM summarization", () => {
	it("should generate a compaction result for the large session", async () => {
		const entries = loadLargeSessionEntries();
		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
		expect(preparation).toBeDefined();

		const compactionResult = await compact(preparation!, model, process.env.ANTHROPIC_OAUTH_TOKEN!);

		expect(compactionResult.summary.length).toBeGreaterThan(100);
		expect(compactionResult.firstKeptEntryId).toBeTruthy();
		expect(compactionResult.tokensBefore).toBeGreaterThan(0);

		console.log("Summary length:", compactionResult.summary.length);
		console.log("First kept entry ID:", compactionResult.firstKeptEntryId);
		console.log("Tokens before:", compactionResult.tokensBefore);
		console.log("\n--- SUMMARY ---\n");
		console.log(compactionResult.summary);
	}, 60000);

	it("should produce valid session after compaction", async () => {
		const entries = loadLargeSessionEntries();
		const loaded = buildSessionContext(entries);
		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
		expect(preparation).toBeDefined();

		const compactionResult = await compact(preparation!, model, process.env.ANTHROPIC_OAUTH_TOKEN!);

		// Simulate appending compaction to entries by creating a proper entry
		const lastEntry = entries[entries.length - 1];
		const parentId = lastEntry.id;
		const compactionEntry: CompactionEntry = {
			type: "compaction",
			id: "compaction-test-id",
			parentId,
			timestamp: new Date().toISOString(),
			...compactionResult,
		};
		const newEntries = [...entries, compactionEntry];
		const reloaded = buildSessionContext(newEntries);

		// Should have summary + kept messages
		expect(reloaded.messages.length).toBeLessThan(loaded.messages.length);
		expect(reloaded.messages[0].role).toBe("compactionSummary");
		expect((reloaded.messages[0] as any).summary).toContain(compactionResult.summary);

		console.log("Original messages:", loaded.messages.length);
		console.log("After compaction:", reloaded.messages.length);
	}, 60000);
});
