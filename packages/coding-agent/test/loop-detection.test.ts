import { describe, expect, test } from "vitest";
import { detectErrorLoop, detectNoProgressLoop, detectPingPong } from "../src/core/auton/nudges/loop-detection.js";
import type { ToolOutcome } from "../src/core/auton/nudges/types.js";
import { buildToolCallDigest, buildToolResultDigest } from "../src/core/tool-outcome-digests.js";

function editOutcome(path: string, oldText: string, newText: string, diff: string): ToolOutcome {
	const args = { path, edits: [{ oldText, newText }] };
	const result = {
		content: [{ type: "text", text: `Patched 1 block(s) in ${path}.` }],
		details: { diff },
	};
	return {
		tool: "edit",
		success: true,
		file: path,
		callDigest: buildToolCallDigest("edit", args),
		resultDigest: buildToolResultDigest(result, false),
	};
}

function failedEdit(path: string, oldText: string): ToolOutcome {
	const args = { path, edits: [{ oldText, newText: "x" }] };
	const result = { content: [{ type: "text", text: `Could not find the exact text in ${path}.` }] };
	return {
		tool: "edit",
		success: false,
		file: path,
		callDigest: buildToolCallDigest("edit", args),
		resultDigest: buildToolResultDigest(result, true),
	};
}

describe("buildToolCallDigest", () => {
	test("differentiates edits to the same file by content", () => {
		const a = buildToolCallDigest("edit", { path: "a.ts", edits: [{ oldText: "foo", newText: "bar" }] });
		const b = buildToolCallDigest("edit", { path: "a.ts", edits: [{ oldText: "baz", newText: "qux" }] });
		const aAgain = buildToolCallDigest("edit", { path: "a.ts", edits: [{ oldText: "foo", newText: "bar" }] });
		expect(a).not.toBe(b);
		expect(a).toBe(aAgain);
	});

	test("differentiates bash commands and normalizes whitespace", () => {
		const a = buildToolCallDigest("bash", { command: "npm   test" });
		const b = buildToolCallDigest("bash", { command: "npm test" });
		const c = buildToolCallDigest("bash", { command: "npm run build" });
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});

	test("differentiates read ranges", () => {
		const a = buildToolCallDigest("read", { path: "a.ts", offset: 1, limit: 100 });
		const b = buildToolCallDigest("read", { path: "a.ts", offset: 101, limit: 100 });
		expect(a).not.toBe(b);
	});

	test("falls back to stable args identity for unknown tools", () => {
		const a = buildToolCallDigest("custom", { b: 1, a: "x" });
		const b = buildToolCallDigest("custom", { a: "x", b: 1 });
		expect(a).toBe(b);
	});
});

describe("buildToolResultDigest", () => {
	test("uses the diff for edit results, not the generic success text", () => {
		const r1 = buildToolResultDigest(
			{ content: [{ type: "text", text: "Patched 1 block(s) in a.ts." }], details: { diff: "+foo" } },
			false,
		);
		const r2 = buildToolResultDigest(
			{ content: [{ type: "text", text: "Patched 1 block(s) in a.ts." }], details: { diff: "+bar" } },
			false,
		);
		expect(r1).not.toBe(r2);
	});

	test("distinguishes errors from successes with identical text", () => {
		const result = { content: [{ type: "text", text: "same text" }] };
		expect(buildToolResultDigest(result, true)).not.toBe(buildToolResultDigest(result, false));
	});
});

describe("detectErrorLoop", () => {
	test("fires on 3 consecutive identical failures", () => {
		const history = [failedEdit("a.ts", "missing1"), failedEdit("a.ts", "missing1"), failedEdit("a.ts", "missing1")];
		expect(detectErrorLoop(history)?.tool).toBe("edit");
	});

	test("does not fire when failures have different arguments", () => {
		const history = [failedEdit("a.ts", "m1"), failedEdit("a.ts", "m2"), failedEdit("a.ts", "m3")];
		expect(detectErrorLoop(history)).toBeNull();
	});

	test("does not fire when a success breaks the streak", () => {
		const history = [failedEdit("a.ts", "m1"), failedEdit("a.ts", "m1"), editOutcome("a.ts", "m1", "x", "+x")];
		expect(detectErrorLoop(history)).toBeNull();
	});
});

describe("detectNoProgressLoop", () => {
	test("does not fire on consecutive successful edits to the same file (regression)", () => {
		const history = [
			editOutcome("theme.ts", "aaa", "bbb", "-aaa\n+bbb"),
			editOutcome("theme.ts", "ccc", "ddd", "-ccc\n+ddd"),
			editOutcome("theme.ts", "eee", "fff", "-eee\n+fff"),
			editOutcome("theme.ts", "ggg", "hhh", "-ggg\n+hhh"),
		];
		expect(detectNoProgressLoop(history)).toBeNull();
	});

	test("fires on 4 identical calls with identical results", () => {
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
		expect(detectNoProgressLoop([grep(), grep(), grep(), grep()])?.tool).toBe("grep");
	});

	test("does not fire on only 3 identical pairs", () => {
		const grep = () => ({
			tool: "grep",
			success: true,
			callDigest: buildToolCallDigest("grep", { pattern: "foo", path: "src" }),
			resultDigest: buildToolResultDigest({ content: [{ type: "text", text: "src/a.ts:1: foo" }] }, false),
		});
		expect(detectNoProgressLoop([grep(), grep(), grep()])).toBeNull();
	});

	test("does not fire when results change between identical calls", () => {
		const bash = (out: string) => ({
			tool: "bash",
			success: true,
			callDigest: buildToolCallDigest("bash", { command: "npm test" }),
			resultDigest: buildToolResultDigest({ content: [{ type: "text", text: out }] }, false),
		});
		const history = [bash("1 passing"), bash("2 passing"), bash("3 passing"), bash("4 passing")];
		expect(detectNoProgressLoop(history)).toBeNull();
	});
});

describe("detectPingPong", () => {
	test("fires on A→B→A→B→A→B alternation", () => {
		const a = () => ({
			tool: "read",
			success: true,
			callDigest: buildToolCallDigest("read", { path: "a.ts" }),
		});
		const b = () => ({
			tool: "read",
			success: true,
			callDigest: buildToolCallDigest("read", { path: "b.ts" }),
		});
		expect(detectPingPong([a(), b(), a(), b(), a(), b()])).not.toBeNull();
	});

	test("does not fire when the pattern breaks", () => {
		const a = () => ({
			tool: "read",
			success: true,
			callDigest: buildToolCallDigest("read", { path: "a.ts" }),
		});
		const b = () => ({
			tool: "read",
			success: true,
			callDigest: buildToolCallDigest("read", { path: "b.ts" }),
		});
		expect(detectPingPong([a(), b(), a(), b(), a(), a()])).toBeNull();
	});
});
