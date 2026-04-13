import { describe, expect, test } from "vitest";
import {
	analyzeXmlFallbackTurn,
	buildXmlFallbackRecoveryPrompt,
	parseXmlToolCalls,
} from "../src/core/xml-tool-parser.js";

describe("xml tool parser", () => {
	test("parses known XML tool calls with child tags", () => {
		const calls = parseXmlToolCalls(
			"<bash><command>npm test</command></bash><unknown><x>1</x></unknown>",
			["bash", "read"],
		);

		expect(calls).toEqual([
			expect.objectContaining({
				name: "bash",
				arguments: { command: "npm test" },
			}),
		]);
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
});
