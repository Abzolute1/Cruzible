import { describe, expect, it } from "vitest";
import {
	cacheHitRatio,
	capturePrefixShape,
	comparePrefixShape,
	estimateTokens,
	type ToolSchemaLike,
} from "../src/core/prefix-shape.js";

const SYSTEM_PROMPT = "You are a coding agent. Workspace: src/ package.json";

const readSchema: ToolSchemaLike = {
	name: "read",
	description: "Read a file",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string" },
			offset: { type: "number" },
		},
		required: ["path"],
	},
};

const bashSchema: ToolSchemaLike = {
	name: "bash",
	description: "Run a shell command",
	parameters: {
		type: "object",
		properties: {
			command: { type: "string" },
			timeout: { type: "number" },
		},
		required: ["command"],
	},
};

describe("capturePrefixShape", () => {
	it("is deterministic: same inputs produce the same hashes", () => {
		const a = capturePrefixShape(SYSTEM_PROMPT, [readSchema, bashSchema], 0);
		const b = capturePrefixShape(SYSTEM_PROMPT, [readSchema, bashSchema], 0);
		expect(a).toEqual(b);
		expect(a.prefixHash).toMatch(/^[0-9a-f]{16}$/);
	});

	it("changes hashes when the system prompt changes", () => {
		const a = capturePrefixShape(SYSTEM_PROMPT, [readSchema], 0);
		const b = capturePrefixShape(`${SYSTEM_PROMPT}\nExtra line.`, [readSchema], 0);
		expect(a.systemHash).not.toBe(b.systemHash);
		expect(a.prefixHash).not.toBe(b.prefixHash);
	});

	it("normalizes tool schema order: shuffled schemas hash identically", () => {
		const a = capturePrefixShape(SYSTEM_PROMPT, [readSchema, bashSchema], 0);
		const b = capturePrefixShape(SYSTEM_PROMPT, [bashSchema, readSchema], 0);
		expect(a.toolsHash).toBe(b.toolsHash);
		expect(a.prefixHash).toBe(b.prefixHash);
		expect(a.toolSchemaTokens).toBe(b.toolSchemaTokens);
	});

	it("normalizes parameter key order inside a schema", () => {
		const reordered: ToolSchemaLike = {
			name: "read",
			description: "Read a file",
			parameters: {
				required: ["path"],
				properties: {
					offset: { type: "number" },
					path: { type: "string" },
				},
				type: "object",
			},
		};
		const a = capturePrefixShape(SYSTEM_PROMPT, [readSchema], 0);
		const b = capturePrefixShape(SYSTEM_PROMPT, [reordered], 0);
		expect(a.toolsHash).toBe(b.toolsHash);
	});

	it("estimates tool schema tokens at ~4 chars per token", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("12345678")).toBe(2);
	});
});

describe("comparePrefixShape", () => {
	it("reports no reasons on the first turn (no previous shape)", () => {
		const cur = capturePrefixShape(SYSTEM_PROMPT, [readSchema], 0);
		const comparison = comparePrefixShape(undefined, cur);
		expect(comparison.prefixChanged).toBe(false);
		expect(comparison.reasons).toEqual([]);
		expect(comparison.prefixHash).toBe(cur.prefixHash);
	});

	it("reports no reasons when the prefix is unchanged", () => {
		const prev = capturePrefixShape(SYSTEM_PROMPT, [readSchema, bashSchema], 0);
		const cur = capturePrefixShape(SYSTEM_PROMPT, [bashSchema, readSchema], 0);
		expect(comparePrefixShape(prev, cur).reasons).toEqual([]);
	});

	it("categorizes a system prompt change as 'system'", () => {
		const prev = capturePrefixShape(SYSTEM_PROMPT, [readSchema], 0);
		const cur = capturePrefixShape("Different system prompt.", [readSchema], 0);
		expect(comparePrefixShape(prev, cur).reasons).toEqual(["system"]);
	});

	it("categorizes a tool schema change as 'tools'", () => {
		const prev = capturePrefixShape(SYSTEM_PROMPT, [readSchema], 0);
		const cur = capturePrefixShape(SYSTEM_PROMPT, [readSchema, bashSchema], 0);
		expect(comparePrefixShape(prev, cur).reasons).toEqual(["tools"]);
	});

	it("categorizes a history rewrite version bump as 'history_rewrite'", () => {
		const prev = capturePrefixShape(SYSTEM_PROMPT, [readSchema], 0);
		const cur = capturePrefixShape(SYSTEM_PROMPT, [readSchema], 1);
		expect(comparePrefixShape(prev, cur).reasons).toEqual(["history_rewrite"]);
	});

	it("passes usage through and derives the cache-hit ratio", () => {
		const prev = capturePrefixShape(SYSTEM_PROMPT, [readSchema], 0);
		const cur = capturePrefixShape(SYSTEM_PROMPT, [readSchema], 0);
		const comparison = comparePrefixShape(prev, cur, { cacheReadTokens: 800, inputTokens: 200 });
		expect(comparison.cacheReadTokens).toBe(800);
		expect(comparison.inputTokens).toBe(200);
		expect(comparison.cacheHitRatio).toBeCloseTo(0.8);
	});
});

describe("cacheHitRatio", () => {
	it("is undefined without usage or with zero tokens", () => {
		expect(cacheHitRatio(undefined)).toBeUndefined();
		expect(cacheHitRatio({ cacheReadTokens: 0, inputTokens: 0 })).toBeUndefined();
	});

	it("computes cacheRead / (cacheRead + input)", () => {
		expect(cacheHitRatio({ cacheReadTokens: 300, inputTokens: 100 })).toBeCloseTo(0.75);
	});
});
