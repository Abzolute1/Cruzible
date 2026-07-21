import { describe, expect, it } from "vitest";
import { parseFinalToolCallJson, parseStreamingJson } from "../src/utils/json-parse.js";

describe("parseFinalToolCallJson", () => {
	it("parses complete JSON strictly", () => {
		expect(parseFinalToolCallJson('{"command":"ls -la","timeout":30}')).toEqual({
			arguments: { command: "ls -la", timeout: 30 },
			malformed: false,
		});
	});

	it("returns empty arguments for empty input", () => {
		expect(parseFinalToolCallJson("")).toEqual({ arguments: {}, malformed: false });
		expect(parseFinalToolCallJson(undefined)).toEqual({ arguments: {}, malformed: false });
	});

	it("flags truncated JSON as malformed instead of silently closing open strings", () => {
		const parsed = parseFinalToolCallJson('{"command":"rm -rf /tmp/imp');
		expect(parsed.malformed).toBe(true);
		expect(parsed.arguments).toEqual({});
	});

	it("flags invalid JSON as malformed", () => {
		const parsed = parseFinalToolCallJson("{not json");
		expect(parsed.malformed).toBe(true);
		expect(parsed.arguments).toEqual({});
	});
});

describe("parseStreamingJson", () => {
	it("stays tolerant for intermediate streaming previews", () => {
		// The preview parser intentionally closes the open string.
		expect(parseStreamingJson('{"command":"rm -rf /tmp/imp')).toEqual({ command: "rm -rf /tmp/imp" });
	});
});
