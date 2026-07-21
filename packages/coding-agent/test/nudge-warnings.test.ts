import { describe, expect, test } from "vitest";
import { evaluateInteractiveNudges } from "../src/core/nudge-warnings.js";
import { buildToolCallDigest, buildToolResultDigest } from "../src/core/tool-outcome-digests.js";
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
				content: [
					{
						type: "text",
						text: "src/core/tools/research-output.ts\n\n[1 match; next: read src/core/tools/research-output.ts or grep inside it]",
					},
				],
			},
		);

		expect(file).toBe("src/core/tools/research-output.ts");
	});

	test("prefers firstMatchPath metadata for multi-result find output", () => {
		const file = extractTrackedFileFromToolResult(
			"find",
			{ path: "/home/alex/AG1" },
			{
				content: [
					{
						type: "text",
						text: "scripts/harness-benchmark-compare.mjs\nscripts/harness-benchmark-pack.sh\nbenchmarks/",
					},
				],
				details: {
					firstMatchPath: "scripts/harness-benchmark-compare.mjs",
					dominantFileDirectory: "scripts",
				},
			},
		);

		expect(file).toBe("scripts/harness-benchmark-compare.mjs");
	});

	test("does not treat grep no-match output as a tracked file", () => {
		const file = extractTrackedFileFromToolResult(
			"grep",
			{ path: "/home/alex/AG1" },
			{
				content: [
					{
						type: "text",
						text: "(no matches)\n[no matches; literal=true with regex-like pattern; retry with a simpler literal or disable literal]",
					},
				],
			},
		);

		expect(file).toBeUndefined();
	});

	test("does not treat find no-match output as a tracked file", () => {
		const file = extractTrackedFileFromToolResult(
			"find",
			{ path: "/home/alex/AG1" },
			{
				content: [{ type: "text", text: "(no matches)" }],
			},
		);

		expect(file).toBeUndefined();
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

	test("does not warn for consecutive successful edits to the same file with different content", () => {
		const edit = (oldText: string, newText: string) => {
			const args = { path: "theme.ts", edits: [{ oldText, newText }] };
			const result = {
				content: [{ type: "text", text: "Patched 1 block(s) in theme.ts." }],
				details: { diff: `-${oldText}\n+${newText}` },
			};
			return {
				tool: "edit",
				success: true,
				file: "theme.ts",
				callDigest: buildToolCallDigest("edit", args),
				resultDigest: buildToolResultDigest(result, false),
			};
		};
		const warnings = evaluateInteractiveNudges({
			turnIndex: 6,
			toolCallHistory: [edit("a", "b"), edit("c", "d"), edit("e", "f"), edit("g", "h")],
			fileAccessHistory: [edit("a", "b"), edit("c", "d"), edit("e", "f"), edit("g", "h")],
			lastOutputTokens: 120,
		});

		expect(warnings.some((w) => w.type === "error_loop" || w.type === "no_progress" || w.type === "ping_pong")).toBe(
			false,
		);
		expect(warnings.some((w) => w.type === "stuck_file")).toBe(false);
	});

	test("warns when the same edit fails repeatedly with identical arguments", () => {
		const failed = () => {
			const args = { path: "theme.ts", edits: [{ oldText: "missing", newText: "x" }] };
			const result = { content: [{ type: "text", text: "Could not find the exact text in theme.ts." }] };
			return {
				tool: "edit",
				success: false,
				file: "theme.ts",
				callDigest: buildToolCallDigest("edit", args),
				resultDigest: buildToolResultDigest(result, true),
			};
		};
		const warnings = evaluateInteractiveNudges({
			turnIndex: 6,
			toolCallHistory: [failed(), failed(), failed()],
			fileAccessHistory: [],
			lastOutputTokens: 120,
		});

		const warning = warnings.find((w) => w.type === "error_loop");
		expect(warning).toBeDefined();
		expect(warning?.message).toContain("identical arguments");
	});

	test("warns when the same call returns the same result 4 times in a row", () => {
		const grep = () => {
			const args = { pattern: "foo", path: "src" };
			const result = { content: [{ type: "text", text: "src/a.ts:1: foo" }] };
			return {
				tool: "grep",
				success: true,
				callDigest: buildToolCallDigest("grep", args),
				resultDigest: buildToolResultDigest(result, false),
			};
		};
		const warnings = evaluateInteractiveNudges({
			turnIndex: 6,
			toolCallHistory: [grep(), grep(), grep(), grep()],
			fileAccessHistory: [],
			lastOutputTokens: 120,
		});

		expect(warnings.some((w) => w.type === "no_progress")).toBe(true);
	});
});
