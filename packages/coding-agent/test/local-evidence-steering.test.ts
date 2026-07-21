import { describe, expect, it } from "vitest";
import type { ToolOutcome } from "../src/core/auton/nudges/types.js";
import {
	buildLocalEvidenceControl,
	buildLocalEvidencePromptAddendum,
	buildRuntimeContinuationMessage,
} from "../src/core/local-evidence-steering.js";

function outcome(tool: string, overrides: Partial<ToolOutcome> = {}): ToolOutcome {
	return {
		tool,
		success: true,
		...overrides,
	};
}

describe("buildLocalEvidencePromptAddendum", () => {
	it("nudges reuse when discovery tools keep isolating the same file", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			toolCallHistory: [outcome("find", { file: "src/foo.ts" }), outcome("grep", { file: "src/foo.ts" })],
			fileAccessHistory: [outcome("find", { file: "src/foo.ts" }), outcome("grep", { file: "src/foo.ts" })],
		});

		expect(addendum).toContain("already isolated `src/foo.ts`");
		expect(addendum).toContain("Prefer reading that file or answering directly");
	});

	it("nudges direct reading after a decisive grep match", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			toolCallHistory: [
				outcome("grep", {
					file: "src/foo.ts",
					metadata: {
						matchCount: 1,
						uniqueFileCount: 1,
						firstMatchPath: "src/foo.ts",
						firstMatchLine: 14,
					},
				}),
			],
			fileAccessHistory: [
				outcome("grep", {
					file: "src/foo.ts",
					metadata: {
						matchCount: 1,
						uniqueFileCount: 1,
						firstMatchPath: "src/foo.ts",
						firstMatchLine: 14,
					},
				}),
			],
		});

		expect(addendum).toContain("decisive grep match");
		expect(addendum).toContain("before searching again");
		expect(addendum).toContain("Do not run another broad grep");
	});

	it("nudges reuse after repeated reads of the same file", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			toolCallHistory: [
				outcome("read", {
					file: "src/foo.ts",
					metadata: { progress: { completion: "partial", nextOffset: 101 } },
				}),
				outcome("read", {
					file: "src/foo.ts",
					metadata: { progress: { completion: "partial", nextOffset: 201 } },
				}),
			],
			fileAccessHistory: [
				outcome("read", {
					file: "src/foo.ts",
					metadata: { progress: { completion: "partial", nextOffset: 101 } },
				}),
				outcome("read", {
					file: "src/foo.ts",
					metadata: { progress: { completion: "partial", nextOffset: 201 } },
				}),
			],
		});

		expect(addendum).toContain("already read `src/foo.ts`");
		expect(addendum).toContain("continue with `offset=201`");
		expect(addendum).toContain("instead of rereading earlier lines");
	});

	it("does not inject steering when there is no decisive local evidence", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			toolCallHistory: [outcome("websearch", { detail: "react actions docs" })],
			fileAccessHistory: [],
		});

		expect(addendum).toBeUndefined();
	});

	it("nudges reuse when the previous turn already produced bulky web evidence", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			toolCallHistory: [
				outcome("websearch", { detail: "latest claude code leak", estimatedTokens: 850 }),
				outcome("webfetch", { detail: "https://example.com/article", estimatedTokens: 1400 }),
			],
			fileAccessHistory: [],
		});

		expect(addendum).toContain("already gathered substantial web evidence");
		expect(addendum).toContain("restarting broad web search");
	});

	it("nudges reuse when the previous turn already produced bulky local inspection output", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			toolCallHistory: [
				outcome("read", { file: "src/foo.ts", estimatedTokens: 1200 }),
				outcome("grep", { file: "src/foo.ts", estimatedTokens: 900 }),
			],
			fileAccessHistory: [
				outcome("read", { file: "src/foo.ts", estimatedTokens: 1200 }),
				outcome("grep", { file: "src/foo.ts", estimatedTokens: 900 }),
			],
		});

		expect(addendum).toContain("already produced substantial local evidence");
		expect(addendum).toContain("repeating broad read/grep/find/ls/bash inspection");
	});

	it("does not center bulky local evidence on examples or docs", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			toolCallHistory: [
				outcome("read", { file: "packages/coding-agent/examples/rpc-extension-ui.ts", estimatedTokens: 1200 }),
			],
			fileAccessHistory: [
				outcome("read", { file: "packages/coding-agent/examples/rpc-extension-ui.ts", estimatedTokens: 1200 }),
			],
		});

		expect(addendum ?? "").not.toContain("centered on `packages/coding-agent/examples/rpc-extension-ui.ts`");
		expect(addendum).toContain("substantial local inspection output");
	});

	it("nudges answering now when a rich web source was already fetched", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			toolCallHistory: [
				outcome("webfetch", {
					detail: "https://example.com/article",
					estimatedTokens: 600,
					metadata: { status: "rich" },
				}),
			],
			fileAccessHistory: [],
		});

		expect(addendum).toContain("already fetched a rich source");
		expect(addendum).toContain("Answer from that evidence now");
	});

	it("nudges answering now more strongly for authoritative docs fetches", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			toolCallHistory: [
				outcome("webfetch", {
					detail: "https://react.dev/reference/react/useActionState",
					estimatedTokens: 600,
					metadata: { status: "rich", intent: "docs_reference" },
				}),
			],
			fileAccessHistory: [],
		});

		expect(addendum).toContain("already fetched an authoritative docs source");
		expect(addendum).toContain("brief docs summary");
		expect(addendum).toContain("Do not restart broad web search");
	});

	it("uses decisive grep metadata when the raw grep file was a weaker first hit", () => {
		const control = buildLocalEvidenceControl({
			userPrompt:
				"which source file implements the benchmark archive command? give the exact path and one-sentence purpose",
			toolCallHistory: [
				outcome("grep", {
					file: "scripts/profile-coding-agent-node.mjs",
					metadata: {
						matchCount: 3,
						uniqueFileCount: 2,
						firstMatchPath: "scripts/harness-benchmark-archive.mjs",
						firstMatchLine: 12,
					},
				}),
			],
			fileAccessHistory: [
				outcome("grep", {
					file: "scripts/profile-coding-agent-node.mjs",
					metadata: {
						matchCount: 3,
						uniqueFileCount: 2,
						firstMatchPath: "scripts/harness-benchmark-archive.mjs",
						firstMatchLine: 12,
					},
				}),
			],
		});

		expect(control?.message).toContain("scripts/harness-benchmark-archive.mjs");
		expect(control?.message).not.toContain("scripts/profile-coding-agent-node.mjs");
	});

	it("nudges script directory lookups away from repeated no-match find patterns", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			userPrompt:
				"which directory holds the benchmark runner, compare, and archive scripts? list just those filenames",
			toolCallHistory: [
				outcome("find", { detail: "/home/alex/AG1" }),
				outcome("find", { detail: "/home/alex/AG1" }),
				outcome("find", { detail: "/home/alex/AG1" }),
			],
			fileAccessHistory: [],
		});

		expect(addendum).toContain("Recent find attempts did not produce a decisive file");
		expect(addendum).toContain("Stop chaining broader wildcard find patterns");
		expect(addendum).toContain("repo-root `scripts/`");
	});

	it("nudges repo-level command lookups back to repo-root scripts after stale package-local search", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			userPrompt:
				"which source file implements the benchmark archive command? give the exact path and one-sentence purpose",
			toolCallHistory: [
				outcome("find", { detail: "/home/alex/AG1/packages/coding-agent" }),
				outcome("find", { detail: "/home/alex/AG1/packages/coding-agent" }),
			],
			fileAccessHistory: [],
		});

		expect(addendum).toContain("repo-level commands");
		expect(addendum).toContain("repo-root `scripts/`");
		expect(addendum).toContain("under `scripts/`");
	});

	it("nudges answering now when a substantial file read already happened", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			toolCallHistory: [
				outcome("read", {
					file: "src/foo.ts",
					estimatedTokens: 400,
					metadata: { progress: { completion: "complete" } },
				}),
			],
			fileAccessHistory: [
				outcome("read", {
					file: "src/foo.ts",
					estimatedTokens: 400,
					metadata: { progress: { completion: "complete" } },
				}),
			],
		});

		expect(addendum).toContain("completed a full read of `src/foo.ts`");
		expect(addendum).toContain("Prefer answering or acting directly");
	});

	it("does not treat a tail read to EOF as a full-file read", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			toolCallHistory: [
				outcome("read", {
					file: "src/foo.ts",
					estimatedTokens: 300,
					metadata: { progress: { completion: "complete", startLine: 450, endLine: 500, totalLines: 500 } },
				}),
			],
			fileAccessHistory: [
				outcome("read", {
					file: "src/foo.ts",
					estimatedTokens: 300,
					metadata: { progress: { completion: "complete", startLine: 450, endLine: 500, totalLines: 500 } },
				}),
			],
		});

		expect(addendum ?? "").not.toContain("completed a full read of `src/foo.ts`");
		expect(addendum).toContain("through the end of the file starting at line 450");
		expect(addendum).toContain("instead of grepping again");
	});

	it("does not treat README reads as decisive implementation evidence", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			toolCallHistory: [
				outcome("read", {
					file: "packages/coding-agent/README.md",
					estimatedTokens: 400,
					metadata: { progress: { completion: "complete" } },
				}),
			],
			fileAccessHistory: [
				outcome("read", {
					file: "packages/coding-agent/README.md",
					estimatedTokens: 400,
					metadata: { progress: { completion: "complete" } },
				}),
			],
		});

		expect(addendum ?? "").not.toContain("completed a full read of `packages/coding-agent/README.md`");
		expect(addendum).toContain("looks like docs, examples, or another reference artifact");
		expect(addendum).toContain("source-oriented grep/find");
	});

	it("nudges answering now when a single decisive grep match already identifies the path", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			toolCallHistory: [
				outcome("grep", {
					file: "scripts/harness-benchmark-compare.mjs",
					metadata: {
						matchCount: 1,
						uniqueFileCount: 1,
						firstMatchPath: "scripts/harness-benchmark-compare.mjs",
						firstMatchLine: 12,
					},
				}),
			],
			fileAccessHistory: [
				outcome("grep", {
					file: "scripts/harness-benchmark-compare.mjs",
					metadata: {
						matchCount: 1,
						uniqueFileCount: 1,
						firstMatchPath: "scripts/harness-benchmark-compare.mjs",
						firstMatchLine: 12,
					},
				}),
			],
		});

		expect(addendum).toContain("single decisive grep match");
		expect(addendum).toContain("answer now with that location");
	});

	it("nudges answering now after a decisive grep plus one substantial read", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			toolCallHistory: [
				outcome("grep", {
					file: "src/foo.ts",
					metadata: {
						matchCount: 1,
						uniqueFileCount: 1,
						firstMatchPath: "src/foo.ts",
						firstMatchLine: 22,
					},
				}),
				outcome("read", {
					file: "src/foo.ts",
					estimatedTokens: 260,
					metadata: { progress: { completion: "partial", startLine: 18, endLine: 67, nextOffset: 68 } },
				}),
			],
			fileAccessHistory: [
				outcome("grep", {
					file: "src/foo.ts",
					metadata: {
						matchCount: 1,
						uniqueFileCount: 1,
						firstMatchPath: "src/foo.ts",
						firstMatchLine: 22,
					},
				}),
				outcome("read", {
					file: "src/foo.ts",
					estimatedTokens: 260,
					metadata: { progress: { completion: "partial", startLine: 18, endLine: 67, nextOffset: 68 } },
				}),
			],
		});

		expect(addendum).toContain("already isolated `src/foo.ts` and read the defining range");
		expect(addendum).toContain("Answer now from that evidence");
	});

	it("nudges answering now when a single-file find result is already decisive", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			toolCallHistory: [
				outcome("find", {
					file: "scripts/harness-benchmark-archive.mjs",
					metadata: {
						resultCount: 1,
						firstMatchPath: "scripts/harness-benchmark-archive.mjs",
						firstMatchIsDirectory: false,
						dominantFileDirectory: "scripts",
					},
				}),
			],
			fileAccessHistory: [outcome("find", { file: "scripts/harness-benchmark-archive.mjs" })],
		});

		expect(addendum).toContain("already found one decisive file");
		expect(addendum).toContain("Answer now with that path");
	});

	it("does not claim a decisive grep match when grep metadata shows no real match", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			toolCallHistory: [
				outcome("grep", {
					file: "/home/alex/AG1",
					metadata: {
						matchCount: 0,
						uniqueFileCount: 0,
					},
				}),
			],
			fileAccessHistory: [
				outcome("grep", {
					file: "/home/alex/AG1",
					metadata: {
						matchCount: 0,
						uniqueFileCount: 0,
					},
				}),
			],
		});

		expect(addendum ?? "").not.toContain("decisive grep match");
	});

	it("demotes grep hits that only come from tests or notes", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			toolCallHistory: [outcome("grep", { file: "packages/coding-agent/test/prompt-intent-steering.test.ts" })],
			fileAccessHistory: [outcome("grep", { file: "packages/coding-agent/test/prompt-intent-steering.test.ts" })],
		});

		expect(addendum).toContain("looks like a test, scenario, or note");
		expect(addendum).toContain("Do not treat it as the defining implementation");
		expect(addendum).toContain("switch to find on likely filenames");
		expect(addendum).toContain("repo-root script directories");
		expect(addendum).not.toContain("decisive grep match");
		expect(addendum).not.toContain("decisive location");
	});

	it("nudges answering now when find results already cluster under one directory", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			toolCallHistory: [
				outcome("find", {
					file: "scripts",
					metadata: {
						resultCount: 6,
						firstMatchPath: "benchmarks/",
						firstMatchIsDirectory: true,
						dominantFileDirectory: "scripts",
					},
				}),
			],
			fileAccessHistory: [outcome("find", { file: "scripts" })],
		});

		expect(addendum).toContain("relevant matches clustering under `scripts`");
		expect(addendum).toContain("which directory contains");
	});

	it("nudges answering now when repeated discovery files cluster under one directory", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			toolCallHistory: [
				outcome("find", { file: "scripts/harness-benchmark-run.mjs" }),
				outcome("find", { file: "scripts/harness-benchmark-compare.mjs" }),
				outcome("grep", { file: "scripts/harness-benchmark-archive.mjs" }),
			],
			fileAccessHistory: [
				outcome("find", { file: "scripts/harness-benchmark-run.mjs" }),
				outcome("find", { file: "scripts/harness-benchmark-compare.mjs" }),
				outcome("grep", { file: "scripts/harness-benchmark-archive.mjs" }),
			],
		});

		expect(addendum).toContain("clustered the relevant files under `scripts`");
		expect(addendum).toContain("answer now with `scripts`");
		expect(addendum).toContain("instead of running another broad grep or find");
	});

	it("nudges answering now when a directory listing is complete", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			toolCallHistory: [
				outcome("ls", {
					file: "scripts",
					metadata: {
						directoryPath: "scripts",
						entryCount: 4,
						entriesSample: ["a.ts", "b.ts", "c.ts"],
					},
				}),
			],
			fileAccessHistory: [outcome("ls", { file: "scripts" })],
		});

		expect(addendum).toContain("listed `scripts` completely");
		expect(addendum).toContain("Key entries");
	});

	it("adds grouped discovery guidance when local tools already converged on one file", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			toolCallHistory: [
				outcome("find", { file: "src/foo.ts" }),
				outcome("grep", { file: "src/foo.ts" }),
				outcome("read", {
					file: "src/foo.ts",
					metadata: { progress: { completion: "partial", nextOffset: 121 } },
				}),
			],
			fileAccessHistory: [
				outcome("find", { file: "src/foo.ts" }),
				outcome("grep", { file: "src/foo.ts" }),
				outcome("read", {
					file: "src/foo.ts",
					metadata: { progress: { completion: "partial", nextOffset: 121 } },
				}),
			],
		});

		expect(addendum).toContain("Local discovery already converged on `src/foo.ts` via find -> grep -> read");
		expect(addendum).toContain("offset=121");
		expect(addendum).toContain("otherwise answer directly");
	});

	it("warns against another grep when repeated grep hits already point to the same file", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			toolCallHistory: [
				outcome("grep", { file: "src/foo.ts" }),
				outcome("read", {
					file: "src/foo.ts",
					metadata: { progress: { completion: "partial", nextOffset: 220 } },
				}),
				outcome("grep", { file: "src/foo.ts" }),
			],
			fileAccessHistory: [
				outcome("grep", { file: "src/foo.ts" }),
				outcome("read", {
					file: "src/foo.ts",
					metadata: { progress: { completion: "partial", nextOffset: 220 } },
				}),
				outcome("grep", { file: "src/foo.ts" }),
			],
		});

		expect(addendum).toContain("multiple grep hits now point to the same file");
		expect(addendum).toContain("instead of running another grep");
		expect(addendum).toContain("offset=220");
	});

	it("nudges against repeated inspection bash loops", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			toolCallHistory: [
				outcome("bash", {
					detail: "ls -la src",
					estimatedTokens: 200,
				}),
				outcome("bash", {
					detail: "ls -la src",
					estimatedTokens: 220,
				}),
			],
			fileAccessHistory: [],
		});

		expect(addendum).toContain("inspection-style shell step has already been run repeatedly");
		expect(addendum).toContain("move to a targeted read or direct answer");
	});

	it("nudges against repeated mutating bash loops", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			toolCallHistory: [
				outcome("bash", {
					detail: "npm test",
					estimatedTokens: 240,
				}),
				outcome("bash", {
					detail: "npm test",
					estimatedTokens: 260,
				}),
			],
			fileAccessHistory: [],
		});

		expect(addendum).toContain("mutating shell step has already been attempted repeatedly");
		expect(addendum).toContain("Do not rerun it");
	});
});

describe("buildRuntimeContinuationMessage", () => {
	it("creates a compact continuation state for bulky web evidence", () => {
		const message = buildRuntimeContinuationMessage({
			toolCallHistory: [
				outcome("websearch", { detail: "latest claude code leak", estimatedTokens: 900 }),
				outcome("webfetch", { detail: "https://example.com/article", estimatedTokens: 1400 }),
			],
			fileAccessHistory: [],
		});

		expect(message).toContain("<runtime-continuation-state>");
		expect(message).toContain("Bulky web evidence was already gathered");
		expect(message).toContain("https://example.com/article");
	});

	it("creates a compact continuation state for bulky local evidence", () => {
		const message = buildRuntimeContinuationMessage({
			toolCallHistory: [outcome("read", { file: "src/foo.ts", estimatedTokens: 1200 })],
			fileAccessHistory: [outcome("read", { file: "src/foo.ts", estimatedTokens: 1200 })],
		});

		expect(message).toContain("Bulky local inspection output was already gathered");
		expect(message).toContain("src/foo.ts");
	});
});

describe("buildLocalEvidenceControl", () => {
	it("forces answer-now after a decisive single-file find", () => {
		const control = buildLocalEvidenceControl({
			toolCallHistory: [
				outcome("find", {
					file: "scripts/harness-benchmark-archive.mjs",
					metadata: {
						resultCount: 1,
						firstMatchPath: "scripts/harness-benchmark-archive.mjs",
						firstMatchIsDirectory: false,
					},
				}),
			],
			fileAccessHistory: [outcome("find", { file: "scripts/harness-benchmark-archive.mjs" })],
		});

		expect(control?.mode).toBe("answer_now");
		expect(control?.message).toContain("single decisive local file");
	});

	it("prefers directory answer control for directory inventory prompts with clustered matches", () => {
		const control = buildLocalEvidenceControl({
			userPrompt:
				"which directory holds the benchmark runner, compare, and archive scripts? list just those filenames",
			toolCallHistory: [
				outcome("find", { file: "scripts/harness-benchmark-run.mjs" }),
				outcome("find", { file: "scripts/harness-benchmark-compare.mjs" }),
				outcome("find", { file: "scripts/harness-benchmark-archive.mjs" }),
			],
			fileAccessHistory: [
				outcome("find", { file: "scripts/harness-benchmark-run.mjs" }),
				outcome("find", { file: "scripts/harness-benchmark-compare.mjs" }),
				outcome("find", { file: "scripts/harness-benchmark-archive.mjs" }),
			],
		});

		expect(control?.mode).toBe("answer_now");
		expect(control?.message).toContain("clustered the relevant files under `scripts`");
	});

	it("forces a targeted read after a decisive grep hit", () => {
		const control = buildLocalEvidenceControl({
			toolCallHistory: [
				outcome("grep", {
					file: "src/foo.ts",
					metadata: {
						matchCount: 1,
						uniqueFileCount: 1,
						firstMatchPath: "src/foo.ts",
						firstMatchLine: 14,
					},
				}),
			],
			fileAccessHistory: [
				outcome("grep", {
					file: "src/foo.ts",
					metadata: {
						matchCount: 1,
						uniqueFileCount: 1,
						firstMatchPath: "src/foo.ts",
						firstMatchLine: 14,
					},
				}),
			],
		});

		expect(control?.mode).toBe("read_then_answer");
		expect(control?.message).toContain("Do exactly one targeted read");
	});

	it("keeps comparative prompts inside the same file after a decisive read", () => {
		const control = buildLocalEvidenceControl({
			userPrompt:
				"find where createLiveProviderContext is defined and explain how it differs from createContextHygieneCopy; do not browse the web",
			toolCallHistory: [
				outcome("grep", {
					file: "src/foo.ts",
					metadata: {
						matchCount: 1,
						uniqueFileCount: 1,
						firstMatchPath: "src/foo.ts",
						firstMatchLine: 120,
					},
				}),
				outcome("read", {
					file: "src/foo.ts",
					estimatedTokens: 250,
					metadata: { progress: { completion: "partial", startLine: 120, endLine: 170, nextOffset: 171 } },
				}),
			],
			fileAccessHistory: [
				outcome("grep", {
					file: "src/foo.ts",
					metadata: {
						matchCount: 1,
						uniqueFileCount: 1,
						firstMatchPath: "src/foo.ts",
						firstMatchLine: 120,
					},
				}),
				outcome("read", {
					file: "src/foo.ts",
					estimatedTokens: 250,
					metadata: { progress: { completion: "partial", startLine: 120, endLine: 170, nextOffset: 171 } },
				}),
			],
		});

		expect(control?.mode).toBe("read_then_answer");
		expect(control?.message).toContain("Stay inside `src/foo.ts`");
		expect(control?.message).toContain("Do not run another grep or find");
	});

	it("keeps explain-style prompts in the same file after a partial decisive read", () => {
		const control = buildLocalEvidenceControl({
			userPrompt: "find where buildSystemPrompt is defined and explain it; do not browse the web",
			toolCallHistory: [
				outcome("grep", {
					file: "src/foo.ts",
					metadata: {
						matchCount: 1,
						uniqueFileCount: 1,
						firstMatchPath: "src/foo.ts",
						firstMatchLine: 55,
					},
				}),
				outcome("read", {
					file: "src/foo.ts",
					estimatedTokens: 250,
					metadata: { progress: { completion: "partial", startLine: 55, endLine: 114, nextOffset: 115 } },
				}),
			],
			fileAccessHistory: [
				outcome("grep", {
					file: "src/foo.ts",
					metadata: {
						matchCount: 1,
						uniqueFileCount: 1,
						firstMatchPath: "src/foo.ts",
						firstMatchLine: 55,
					},
				}),
				outcome("read", {
					file: "src/foo.ts",
					estimatedTokens: 250,
					metadata: { progress: { completion: "partial", startLine: 55, endLine: 114, nextOffset: 115 } },
				}),
			],
		});

		expect(control?.mode).toBe("read_then_answer");
		expect(control?.message).toContain("defining file `src/foo.ts` is already known");
		expect(control?.message).toContain("offset=115");
		expect(control?.message).toContain("Do not run another grep, find, or ls step");
	});

	it("forces answer-now when the same discovery step repeats on one file", () => {
		const control = buildLocalEvidenceControl({
			userPrompt: "which file defines the benchmark archive command?",
			toolCallHistory: [
				outcome("find", { file: "scripts/harness-benchmark-archive.mjs", detail: "scripts/*archive*" }),
				outcome("find", { file: "scripts/harness-benchmark-archive.mjs", detail: "scripts/*archive*" }),
			],
			fileAccessHistory: [
				outcome("find", { file: "scripts/harness-benchmark-archive.mjs" }),
				outcome("find", { file: "scripts/harness-benchmark-archive.mjs" }),
			],
		});

		expect(control?.mode).toBe("answer_now");
		expect(control?.message).toContain("same local discovery step has already repeated");
		expect(control?.message).toContain("Answer now");
	});

	it("forces one continuation read after repeated reads of the same file on behavior prompts", () => {
		const control = buildLocalEvidenceControl({
			userPrompt: "find where normalizeCurrentEventsQuery is defined and briefly explain why it exists",
			toolCallHistory: [
				outcome("read", {
					file: "src/foo.ts",
					metadata: { progress: { completion: "partial", startLine: 180, endLine: 240, nextOffset: 241 } },
				}),
				outcome("read", {
					file: "src/foo.ts",
					metadata: { progress: { completion: "partial", startLine: 241, endLine: 300, nextOffset: 301 } },
				}),
			],
			fileAccessHistory: [outcome("read", { file: "src/foo.ts" }), outcome("read", { file: "src/foo.ts" })],
		});

		expect(control?.mode).toBe("read_then_answer");
		expect(control?.message).toContain("Recent reads have already stayed inside `src/foo.ts`");
		expect(control?.message).toContain("offset=301");
	});

	it("forces answer-now after a rich authoritative docs fetch for a brief prompt", () => {
		const control = buildLocalEvidenceControl({
			userPrompt:
				"look up the official React docs for useActionState and explain the permalink parameter in one sentence",
			toolCallHistory: [
				outcome("webfetch", {
					detail: "https://react.dev/reference/react/useActionState",
					metadata: { status: "rich", intent: "docs_reference", authoritative: true },
				}),
			],
			fileAccessHistory: [],
		});

		expect(control?.mode).toBe("answer_now");
		expect(control?.message).toContain("rich authoritative web source is already in hand");
		expect(control?.message).toContain("Do not run another webSearch or webFetch");
	});

	it("forces answer-now when an authoritative docs search snippet already answers the prompt", () => {
		const control = buildLocalEvidenceControl({
			userPrompt:
				"look up the official React docs for useActionState and explain the permalink parameter in one sentence",
			toolCallHistory: [
				outcome("websearch", {
					detail: "React useActionState permalink parameter explanation",
					metadata: {
						intent: "docs_reference",
						results: [
							{
								url: "https://react.dev/reference/react/useActionState",
								authoritative: true,
								snippet:
									"When using the permalink option, ensure the same form component is rendered on the destination page so React knows how to pass the state through. Once the page becomes interactive, this parameter has no effect.",
							},
						],
					},
				}),
			],
			fileAccessHistory: [],
		});

		expect(control?.mode).toBe("answer_now");
		expect(control?.message).toContain("search snippet already contains the requested fact");
	});

	it("forces answer-now from an authoritative docs search snippet even without brief-summary wording when the named token is present", () => {
		const control = buildLocalEvidenceControl({
			userPrompt: "look up the official React docs for useActionState and explain the permalink parameter",
			toolCallHistory: [
				outcome("websearch", {
					detail: "React useActionState permalink parameter official docs",
					metadata: {
						intent: "docs_reference",
						results: [
							{
								url: "https://react.dev/reference/react/useActionState",
								authoritative: true,
								snippet:
									"Reference useActionState(reducerAction, initialState, permalink?) Call useActionState at the top level of your component.",
							},
						],
					},
				}),
			],
			fileAccessHistory: [],
		});

		expect(control?.mode).toBe("answer_now");
		expect(control?.message).toContain("authoritative docs search snippet already contains the requested fact");
	});

	it("treats an authoritative docs signature snippet as sufficient when it includes the named parameter token", () => {
		const control = buildLocalEvidenceControl({
			userPrompt:
				"look up the official React docs for useActionState and explain the permalink parameter in one sentence",
			toolCallHistory: [
				outcome("websearch", {
					detail: "React useActionState permalink parameter official docs",
					metadata: {
						intent: "docs_reference",
						results: [
							{
								url: "https://react.dev/reference/react/useActionState",
								authoritative: true,
								snippet:
									"Reference useActionState(reducerAction, initialState, permalink?) Call useActionState at the top level of your component.",
							},
						],
					},
				}),
			],
			fileAccessHistory: [],
		});

		expect(control?.mode).toBe("answer_now");
		expect(control?.message).toContain("search snippet already contains the requested fact");
	});

	it("forces answer-now after a strongest-source authoritative current-events fetch", () => {
		const control = buildLocalEvidenceControl({
			userPrompt: "research the latest Claude Code leak and summarize it from the strongest source you can find",
			toolCallHistory: [
				outcome("webfetch", {
					detail: "https://www.infoq.com/news/2026/04/claude-code-source-leak/",
					metadata: { status: "rich", intent: "current_events", authoritative: true },
				}),
			],
			fileAccessHistory: [],
		});

		expect(control?.mode).toBe("answer_now");
		expect(control?.message).toContain("strongest-source fetch is already in hand");
		expect(control?.message).toContain("Do not run another webSearch or webFetch first");
	});

	it("does not collapse expansion follow-ups into answer-now after a rich authoritative current-events fetch", () => {
		const control = buildLocalEvidenceControl({
			userPrompt: "broaden this and give me the whole picture about the latest Claude Code leak",
			toolCallHistory: [
				outcome("webfetch", {
					detail: "https://www.infoq.com/news/2026/04/claude-code-source-leak/",
					metadata: { status: "rich", intent: "current_events", authoritative: true },
				}),
			],
			fileAccessHistory: [],
		});

		expect(control?.mode).toBe("read_then_answer");
		expect(control?.message).toContain("Expand from that evidence");
		expect(control?.message).toContain("At most one targeted corroborating webSearch or webFetch is allowed");
	});

	it("fetches the strongest source before expanding when the current-events search snippet is sufficient but the user asked for more depth", () => {
		const control = buildLocalEvidenceControl({
			userPrompt: "give me the whole picture and more detail about the latest Claude Code leak",
			toolCallHistory: [
				outcome("websearch", {
					detail: "latest Claude Code leak",
					metadata: {
						intent: "current_events",
						results: [
							{
								url: "https://www.infoq.com/news/2026/04/claude-code-source-leak/",
								authoritative: true,
								snippet:
									"Anthropic accidentally published Claude Code source maps to npm, exposing TypeScript source files before removing them the same day.",
							},
						],
					},
				}),
			],
			fileAccessHistory: [],
		});

		expect(control?.mode).toBe("read_then_answer");
		expect(control?.message).toContain("Fetch the top authoritative URL now");
		expect(control?.message).toContain("user asked for more depth");
	});

	it("does not answer from a large repo-root listing for directory prompts", () => {
		const control = buildLocalEvidenceControl({
			userPrompt:
				"which directory holds the benchmark runner, compare, and archive scripts? list just those filenames",
			toolCallHistory: [
				outcome("ls", {
					file: "/home/alex/AG1",
					metadata: {
						directoryPath: "/home/alex/AG1",
						entryCount: 50,
						entriesSample: ["scripts/", "packages/"],
					},
				}),
			],
			fileAccessHistory: [
				outcome("ls", {
					file: "/home/alex/AG1",
					metadata: {
						directoryPath: "/home/alex/AG1",
						entryCount: 50,
						entriesSample: ["scripts/", "packages/"],
					},
				}),
			],
		});

		expect(control).toBeUndefined();
	});

	it("does not force a read from repeated directory listings", () => {
		const control = buildLocalEvidenceControl({
			userPrompt:
				"which source file implements the benchmark archive command? give the exact path and one-sentence purpose",
			toolCallHistory: [
				outcome("ls", {
					file: "packages/coding-agent",
					detail: "packages/coding-agent",
					metadata: {
						directoryPath: "packages/coding-agent",
						entryCount: 14,
						entriesSample: ["scripts/", "src/"],
					},
				}),
				outcome("ls", {
					file: "packages/coding-agent",
					detail: "packages/coding-agent",
					metadata: {
						directoryPath: "packages/coding-agent",
						entryCount: 14,
						entriesSample: ["scripts/", "src/"],
					},
				}),
			],
			fileAccessHistory: [
				outcome("ls", {
					file: "packages/coding-agent",
					metadata: {
						directoryPath: "packages/coding-agent",
						entryCount: 14,
						entriesSample: ["scripts/", "src/"],
					},
				}),
				outcome("ls", {
					file: "packages/coding-agent",
					metadata: {
						directoryPath: "packages/coding-agent",
						entryCount: 14,
						entriesSample: ["scripts/", "src/"],
					},
				}),
			],
		});

		expect(control).toBeUndefined();
	});

	it("nudges command lookups toward a listed scripts child directory", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			userPrompt:
				"which source file implements the benchmark archive command? give the exact path and one-sentence purpose",
			toolCallHistory: [
				outcome("ls", {
					file: "packages/coding-agent",
					metadata: {
						directoryPath: "packages/coding-agent",
						entryCount: 14,
						entriesSample: ["scripts/", "src/"],
					},
				}),
			],
			fileAccessHistory: [
				outcome("ls", {
					file: "packages/coding-agent",
					metadata: {
						directoryPath: "packages/coding-agent",
						entryCount: 14,
						entriesSample: ["scripts/", "src/"],
					},
				}),
			],
		});

		expect(addendum).toContain("shows a `scripts/` child directory");
		expect(addendum).toContain("inspect that exact `scripts/` child next");
	});

	it("nudges small benchmark workspaces away from shell hunting after the top-level listing", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			userPrompt: [
				"You are in a self-contained benchmark workspace.",
				"Fix the report rendering bug so the CLI output uses line breaks between summary items.",
				"Run the verification command before your final answer.",
				"Stay inside this workspace.",
				"The intended verification command is: `node --test`",
			].join("\n"),
			toolCallHistory: [
				outcome("ls", {
					file: ".",
					metadata: {
						directoryPath: ".",
						entryCount: 6,
						entriesSample: ["cli/", "generated/", "reference/", "src/", "tests/"],
					},
				}),
			],
			fileAccessHistory: [
				outcome("ls", {
					file: ".",
					metadata: {
						directoryPath: ".",
						entryCount: 6,
						entriesSample: ["cli/", "generated/", "reference/", "src/", "tests/"],
					},
				}),
			],
		});

		expect(addendum).toContain("small self-contained workspace is already scoped by the top-level listing");
		expect(addendum).toContain("Stop shell-style file hunting");
		expect(addendum).toContain(
			"Read the likely implementation, importing caller, failing test, or named reference file next",
		);
	});

	it("nudges misleading-sibling tasks to confirm the caller or test before editing", () => {
		const addendum = buildLocalEvidencePromptAddendum({
			userPrompt: [
				"You are in a self-contained benchmark workspace.",
				"Fix the report rendering bug so the CLI output uses line breaks between summary items.",
				"Be careful: there is a misleading similarly named formatter file in the workspace.",
				"Run the verification command before your final answer.",
				"Stay inside this workspace.",
				"The intended verification command is: `node --test`",
			].join("\n"),
			toolCallHistory: [outcome("read", { file: "cli/formatter.mjs" })],
			fileAccessHistory: [outcome("read", { file: "cli/formatter.mjs" })],
		});

		expect(addendum).toContain("misleading similarly named file");
		expect(addendum).toContain("confirm the real caller/import path or failing test expectation");
		expect(addendum).toContain("Do not copy semantics");
	});
});
