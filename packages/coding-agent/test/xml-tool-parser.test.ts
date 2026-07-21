import { describe, expect, test } from "vitest";
import {
	analyzeXmlFallbackTurn,
	buildXmlFallbackRecoveryPrompt,
	parseXmlToolCalls,
	stripXmlToolCallArtifacts,
} from "../src/core/xml-tool-parser.js";

describe("xml tool parser", () => {
	test("parses known XML tool calls with child tags", () => {
		const calls = parseXmlToolCalls("<bash><command>npm test</command></bash><unknown><x>1</x></unknown>", [
			"bash",
			"read",
		]);

		expect(calls).toEqual([
			expect.objectContaining({
				name: "bash",
				arguments: { command: "npm test" },
			}),
		]);
	});

	test("parses wrapped tool_call XML with function and parameter tags", () => {
		const calls = parseXmlToolCalls(
			[
				"<tool_call>",
				"<function-bash>",
				"<parameter-command>ls -lh /home/alex/Downloads/</parameter-command>",
				"</function-bash>",
				"</tool_call>",
			].join(""),
			["bash", "read"],
		);

		expect(calls).toEqual([
			expect.objectContaining({
				name: "bash",
				arguments: { command: "ls -lh /home/alex/Downloads/" },
			}),
		]);
	});

	test("parses wrapped tool_call XML with equals-style function and parameter tags", () => {
		const calls = parseXmlToolCalls(
			[
				"<tool_call>",
				"<function=webFetch>",
				"<parameter=url>https://tech-insider.org/anthropic-claude-code-source-code-leak-npm-2026/</parameter>",
				"</function>",
				"</tool_call>",
			].join(""),
			["bash", "read", "webFetch"],
		);

		expect(calls).toEqual([
			expect.objectContaining({
				name: "webFetch",
				arguments: { url: "https://tech-insider.org/anthropic-claude-code-source-code-leak-npm-2026/" },
			}),
		]);
	});

	test("strips wrapped XML tool-call artifacts from assistant text", () => {
		const stripped = stripXmlToolCallArtifacts(
			[
				"I found the folder. Let me check it.",
				"",
				"<tool_call>",
				"<function-bash>",
				"<parameter-command>ls -lh /home/alex/Downloads/</parameter-command>",
				"</function-bash>",
				"</tool_call>",
			].join("\n"),
		);

		expect(stripped).toBe("I found the folder. Let me check it.");
	});

	test("strips equals-style wrapped XML tool-call artifacts from assistant text", () => {
		const stripped = stripXmlToolCallArtifacts(
			[
				"I found relevant results. Let me fetch the first URL.",
				"",
				"<tool_call>",
				"<function=webFetch>",
				"<parameter=url>https://tech-insider.org/anthropic-claude-code-source-code-leak-npm-2026/</parameter>",
				"</function>",
				"</tool_call>",
			].join("\n"),
		);

		expect(stripped).toBe("I found relevant results. Let me fetch the first URL.");
	});

	test("classifies long truncated XML fallback turns as critical", () => {
		const analysis = analyzeXmlFallbackTurn({
			callCount: 2,
			assistantTextLength: 16_000,
			assistantStopReason: "max_tokens",
			iteration: 1,
		});

		expect(analysis.severity).toBe("critical");
		expect(analysis.shouldInjectRecoveryPrompt).toBe(true);
		expect(analysis.reasons).toEqual(
			expect.arrayContaining(["truncated_turn", "very_long_output", "multiple_xml_calls", "repeated_xml_iteration"]),
		);
		expect(buildXmlFallbackRecoveryPrompt(analysis)).toContain("degraded into a long or truncated XML fallback");
	});

	test("adds direct-answer guidance for local discovery XML recovery", () => {
		const analysis = analyzeXmlFallbackTurn({
			callCount: 2,
			assistantTextLength: 1200,
			assistantStopReason: "stop",
			iteration: 1,
		});

		expect(
			buildXmlFallbackRecoveryPrompt(analysis, {
				toolNames: ["ls", "find"],
			}),
		).toContain("answer directly now and do not call more tools");
	});

	test("classifies simple XML fallback turns as normal", () => {
		const analysis = analyzeXmlFallbackTurn({
			callCount: 1,
			assistantTextLength: 400,
			assistantStopReason: "stop",
			iteration: 0,
		});

		expect(analysis.severity).toBe("normal");
		expect(analysis.shouldInjectRecoveryPrompt).toBe(false);
		expect(buildXmlFallbackRecoveryPrompt(analysis)).toBeUndefined();
	});

	test("adds verification guidance after mutating XML fallback tool calls", () => {
		const analysis = analyzeXmlFallbackTurn({
			callCount: 1,
			assistantTextLength: 400,
			assistantStopReason: "stop",
			iteration: 0,
		});

		expect(buildXmlFallbackRecoveryPrompt(analysis, { toolNames: ["edit"] })).toContain(
			"If the edit/write succeeded, do not repeat or revise it; run the requested verification next.",
		);
	});
});
