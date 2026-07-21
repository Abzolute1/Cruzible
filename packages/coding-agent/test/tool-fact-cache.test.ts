import { describe, expect, it } from "vitest";
import { buildToolFactCachePromptAddendum, ToolFactCache } from "../src/core/tool-fact-cache.js";

describe("ToolFactCache", () => {
	it("deduplicates reusable tool facts and formats a compact prompt addendum", () => {
		const cache = new ToolFactCache({ maxFacts: 4, ttlMs: 1000 });

		cache.record(
			{
				tool: "read",
				success: true,
				file: "src/app.ts",
				detail: "src/app.ts (offset=1, limit=120)",
				estimatedTokens: 1200,
			},
			100,
		);
		cache.record(
			{
				tool: "read",
				success: true,
				file: "src/app.ts",
				detail: "src/app.ts (offset=1, limit=120)",
				estimatedTokens: 1200,
			},
			200,
		);

		const facts = cache.getReusableFacts(200);
		expect(facts).toHaveLength(1);
		expect(facts[0]).toMatchObject({ tool: "read", file: "src/app.ts", hits: 2 });

		const addendum = buildToolFactCachePromptAddendum(cache, { now: 200 });
		expect(addendum).toContain("Reusable facts from prior tool calls");
		expect(addendum).toContain("read: src/app.ts");
		expect(addendum).toContain("~1.2k tokens");
	});

	it("invalidates cached file facts after mutations and expires stale facts", () => {
		const cache = new ToolFactCache({ maxFacts: 4, ttlMs: 100 });

		cache.record({ tool: "read", success: true, file: "src/app.ts", estimatedTokens: 10 }, 100);
		expect(cache.getReusableFacts(150)).toHaveLength(1);

		cache.record({ tool: "edit", success: true, file: "src/app.ts" }, 160);
		expect(cache.getReusableFacts(160)).toHaveLength(0);

		cache.record({ tool: "grep", success: true, detail: "parseConfig", estimatedTokens: 10 }, 200);
		expect(cache.getReusableFacts(250)).toHaveLength(1);
		expect(cache.getReusableFacts(400)).toHaveLength(0);
	});
});
