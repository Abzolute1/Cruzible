import { describe, expect, test } from "vitest";
import { evaluateInteractiveNudges } from "../src/core/nudge-warnings.js";
import { extractTrackedFileFromToolResult } from "../src/core/tool-outcome-file.js";

describe("tool outcome file extraction", () => {
	test("extracts matched file from grep result content", () => {
		const file = extractTrackedFileFromToolResult(
			"grep",
			{ path: "." },
			{
				content: [
					{
						type: "text",
						text: "src/core/tools/websearch.ts:195: function rankResearchResults(query: string): void\n\n[1 match in src/core/tools/websearch.ts:195; next: read src/core/tools/websearch.ts offset=190]",
					},
				],
			},
		);

		expect(file).toBe("src/core/tools/websearch.ts");
	});

	test("extracts single file result from find output", () => {
		const file = extractTrackedFileFromToolResult(
			"find",
			{ path: "." },
			{
				content: [{ type: "text", text: "src/core/tools/research-output.ts\n\n[1 match; next: read src/core/tools/research-output.ts or grep inside it]" }],
			},
		);

		expect(file).toBe("src/core/tools/research-output.ts");
	});
});

describe("evaluateInteractiveNudges", () => {
	test("warns to reuse evidence when the same file is repeatedly rediscovered", () => {
		const warnings = evaluateInteractiveNudges({
			turnIndex: 6,
			toolCallHistory: [],
			fileAccessHistory: [
				{ tool: "find", success: true, file: "src/core/tools/websearch.ts" },
				{ tool: "grep", success: true, file: "src/core/tools/websearch.ts" },
				{ tool: "find", success: true, file: "src/core/tools/websearch.ts" },
				{ tool: "grep", success: true, file: "src/core/tools/websearch.ts" },
			],
			lastOutputTokens: 120,
		});

		expect(warnings.some((warning) => warning.type === "stuck_file")).toBe(true);
		expect(warnings.find((warning) => warning.type === "stuck_file")?.message).toContain(
			"Reuse the evidence you already have instead of searching again.",
		);
	});
});
