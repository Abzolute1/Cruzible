import type { AgentTool } from "@ag1/agent-core";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, test } from "vitest";
import { createHarness } from "./test-harness.js";

describe("AgentSession web research budget", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	test("blocks another current-events fetch after coverage is complete", async () => {
		let fetchExecutions = 0;
		const webFetchTool: AgentTool = {
			name: "webFetch",
			label: "Web Fetch",
			description: "Fetch a URL",
			parameters: Type.Object({ url: Type.String() }),
			execute: async (_toolCallId, params) => {
				fetchExecutions++;
				return {
					content: [{ type: "text", text: `fetched ${(params as { url: string }).url}` }],
					details: {
						status: "rich",
						authoritative: true,
						coverage: {
							kind: "current_events",
							present: ["date", "actor", "mechanism", "impact", "response"],
							missing: [],
						},
					},
				};
			},
		};

		const harness = createHarness({
			responses: [
				{
					toolCalls: [{ name: "webFetch", args: { url: "https://news.example.com/incident" } }],
					stopReason: "toolUse",
				},
				{
					toolCalls: [{ name: "webFetch", args: { url: "https://other.example.com/incident" } }],
					stopReason: "toolUse",
				},
				"done",
			],
			tools: [webFetchTool],
			baseToolsOverride: { webFetch: webFetchTool },
		});
		cleanups.push(harness.cleanup);

		await harness.session.prompt("research this incident");

		expect(fetchExecutions).toBe(1);
		const blockedResult = harness.session.messages.find(
			(message) =>
				message.role === "toolResult"
				&& message.isError
				&& message.content.some(
					(part) => part.type === "text" && part.text.includes("current-events coverage is already complete"),
				),
		);
		expect(blockedResult).toBeDefined();
	});

	test("blocks retrying a placeholder host on the same URL path family", async () => {
		let fetchExecutions = 0;
		const webFetchTool: AgentTool = {
			name: "webFetch",
			label: "Web Fetch",
			description: "Fetch a URL",
			parameters: Type.Object({ url: Type.String() }),
			execute: async (_toolCallId, params) => {
				fetchExecutions++;
				return {
					content: [{ type: "text", text: `blocked ${(params as { url: string }).url}` }],
					details: {
						status: "placeholder",
						statusReason: "browser verification interstitial",
					},
				};
			},
		};

		const harness = createHarness({
			responses: [
				{
					toolCalls: [{ name: "webFetch", args: { url: "https://blocked.example.com/news/incident" } }],
					stopReason: "toolUse",
				},
				{
					toolCalls: [{ name: "webFetch", args: { url: "https://blocked.example.com/news/incident/print" } }],
					stopReason: "toolUse",
				},
				"done",
			],
			tools: [webFetchTool],
			baseToolsOverride: { webFetch: webFetchTool },
		});
		cleanups.push(harness.cleanup);

		await harness.session.prompt("fetch the source");

		expect(fetchExecutions).toBe(1);
		const blockedResult = harness.session.messages.find(
			(message) =>
				message.role === "toolResult"
				&& message.isError
				&& message.content.some(
					(part) => part.type === "text" && part.text.includes("already returned placeholder/interstitial"),
				),
		);
		expect(blockedResult).toBeDefined();
	});

	test("allows a materially different path after a placeholder host", async () => {
		let fetchExecutions = 0;
		const webFetchTool: AgentTool = {
			name: "webFetch",
			label: "Web Fetch",
			description: "Fetch a URL",
			parameters: Type.Object({ url: Type.String() }),
			execute: async (_toolCallId, params) => {
				fetchExecutions++;
				return {
					content: [{ type: "text", text: `fetched ${(params as { url: string }).url}` }],
					details: {
						status: fetchExecutions === 1 ? "placeholder" : "rich",
					},
				};
			},
		};

		const harness = createHarness({
			responses: [
				{
					toolCalls: [{ name: "webFetch", args: { url: "https://blocked.example.com/news/incident" } }],
					stopReason: "toolUse",
				},
				{
					toolCalls: [{ name: "webFetch", args: { url: "https://blocked.example.com/security/advisory" } }],
					stopReason: "toolUse",
				},
				"done",
			],
			tools: [webFetchTool],
			baseToolsOverride: { webFetch: webFetchTool },
		});
		cleanups.push(harness.cleanup);

		await harness.session.prompt("fetch the source");

		expect(fetchExecutions).toBe(2);
	});

	test("blocks broad search after a more specific docs search already ran", async () => {
		let searchExecutions = 0;
		const webSearchTool: AgentTool = {
			name: "webSearch",
			label: "Web Search",
			description: "Search web",
			parameters: Type.Object({ query: Type.String() }),
			execute: async () => {
				searchExecutions++;
				return {
					content: [{ type: "text", text: "search results" }],
					details: { resultCount: 2 },
				};
			},
		};

		const harness = createHarness({
			responses: [
				{
					toolCalls: [
						{ name: "webSearch", args: { query: "React useActionState permalink parameter official docs" } },
					],
					stopReason: "toolUse",
				},
				{
					toolCalls: [{ name: "webSearch", args: { query: "React docs" } }],
					stopReason: "toolUse",
				},
				"done",
			],
			tools: [webSearchTool],
			baseToolsOverride: { webSearch: webSearchTool },
		});
		cleanups.push(harness.cleanup);

		await harness.session.prompt("look up React useActionState permalink");

		expect(searchExecutions).toBe(1);
		const blockedResult = harness.session.messages.find(
			(message) =>
				message.role === "toolResult"
				&& message.isError
				&& message.content.some(
					(part) => part.type === "text" && part.text.includes("broader webSearch query would discard specificity"),
				),
		);
		expect(blockedResult).toBeDefined();
	});
});
