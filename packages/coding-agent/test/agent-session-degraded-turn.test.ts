import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, test } from "vitest";
import { createHarness } from "./test-harness.js";

describe("AgentSession degraded turn events", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	test("emits degraded_turn for critical truncated turns", async () => {
		const harness = createHarness({
			responses: [
				{
					text: "x".repeat(50_000),
					stopReason: "max_tokens",
					usage: { output: 15_000 },
				},
			],
		});
		cleanups.push(harness.cleanup);

		await harness.session.prompt("trigger degraded turn");

		const degraded = harness.eventsOfType("degraded_turn");
		expect(degraded).toHaveLength(1);
		expect(degraded[0]).toEqual(
			expect.objectContaining({
				severity: "critical",
				stopReason: "max_tokens",
				outputTokens: 15_000,
			}),
		);
		expect(degraded[0]?.reasons).toEqual(
			expect.arrayContaining(["truncated_turn", "very_high_output_tokens", "very_long_output_text"]),
		);
	});

	test("guides recovery for critical XML fallback turns and restores the system prompt", async () => {
		let toolExecuted = false;
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				toolExecuted = true;
				return { content: [{ type: "text", text: "echoed" }], details: {} };
			},
		};

		const harness = createHarness({
			systemPrompt: "BASE_PROMPT",
			responses: [
				{
					text: `<echo><text>hi</text></echo>\n${"x".repeat(50_000)}`,
					stopReason: "length",
					usage: { output: 15_000 },
				},
				"done after xml recovery",
			],
			tools: [echoTool],
			baseToolsOverride: { echo: echoTool },
		});
		cleanups.push(harness.cleanup);
		const previousSystemPrompt = harness.session.systemPrompt;

		await harness.session.prompt("trigger xml fallback");

		expect(toolExecuted).toBe(true);
		expect(harness.faux.callCount).toBe(2);
		const xmlEvents = harness.eventsOfType("xml_tool_call");
		expect(xmlEvents).toHaveLength(1);
		expect(xmlEvents[0]).toEqual(
			expect.objectContaining({
				severity: "critical",
				continuationMode: "guided",
			}),
		);
		expect(xmlEvents[0]?.reasons).toEqual(expect.arrayContaining(["truncated_turn", "very_long_output"]));
		expect(harness.session.systemPrompt).toBe(previousSystemPrompt);
	});

	test("executes XML fallback calls even after an earlier structured tool call in the same prompt", async () => {
		let searchExecuted = false;
		let fetchExecuted = false;

		const webSearchTool: AgentTool = {
			name: "webSearch",
			label: "Web Search",
			description: "Search the web",
			parameters: Type.Object({ query: Type.String() }),
			execute: async () => {
				searchExecuted = true;
				return { content: [{ type: "text", text: "search results" }], details: { resultCount: 4 } };
			},
		};

		const webFetchTool: AgentTool = {
			name: "webFetch",
			label: "Web Fetch",
			description: "Fetch a URL",
			parameters: Type.Object({ url: Type.String() }),
			execute: async (_toolCallId, params) => {
				fetchExecuted = true;
				return {
					content: [{ type: "text", text: `fetched ${(params as { url: string }).url}` }],
					details: { title: "Fetched page" },
				};
			},
		};

		const harness = createHarness({
			responses: [
				{
					toolCalls: [{ name: "webSearch", args: { query: "claude code leak 2026" } }],
					stopReason: "toolUse",
				},
				{
					text: [
						"I found relevant sources. Let me fetch the first one.",
						"",
						"<tool_call>",
						"<function=webFetch>",
						"<parameter=url>https://example.com/claude-code-leak</parameter>",
						"</function>",
						"</tool_call>",
					].join("\n"),
				},
				"done after structured tool and xml fallback",
			],
			tools: [webSearchTool, webFetchTool],
			baseToolsOverride: { webSearch: webSearchTool, webFetch: webFetchTool },
		});
		cleanups.push(harness.cleanup);

		await harness.session.prompt("research the latest claude code leak");

		expect(searchExecuted).toBe(true);
		expect(fetchExecuted).toBe(true);
		expect(harness.faux.callCount).toBe(3);
		const xmlEvents = harness.eventsOfType("xml_tool_call");
		expect(xmlEvents).toHaveLength(1);
		expect(xmlEvents[0]).toEqual(
			expect.objectContaining({
				toolName: "webFetch",
				arguments: { url: "https://example.com/claude-code-leak" },
			}),
		);
	});
});
