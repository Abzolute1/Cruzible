import { describe, expect, it } from "vitest";
import { filterHeadlessActiveToolNames } from "../src/core/headless-tool-filter.js";

describe("filterHeadlessActiveToolNames", () => {
	it("removes approval-gated tools from headless active tools", () => {
		expect(
			filterHeadlessActiveToolNames(
				["read", "bash", "edit", "webSearch", "write"],
				["read", "bash", "edit", "write", "grep", "find", "ls", "webSearch", "webFetch"],
			),
		).toEqual(["read", "webSearch"]);
	});

	it("falls back to read-only defaults when only blocked tools were active", () => {
		expect(
			filterHeadlessActiveToolNames(
				["bash", "edit", "write"],
				["read", "bash", "edit", "write", "grep", "find", "ls", "webSearch", "webFetch"],
			),
		).toEqual(["read", "grep", "find", "ls", "webSearch", "webFetch"]);
	});
});
