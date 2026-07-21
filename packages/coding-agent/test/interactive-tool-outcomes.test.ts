import { describe, expect, it } from "vitest";
import {
	estimateInteractiveToolResultTokens,
	extractInteractiveToolDetail,
	extractInteractiveToolMetadata,
} from "../src/modes/interactive/interactive-tool-outcomes.js";

describe("interactive tool outcome helpers", () => {
	it("extracts concise details for common tool calls", () => {
		expect(extractInteractiveToolDetail("bash", { command: "npm test" })).toBe("npm test");
		expect(extractInteractiveToolDetail("websearch", { query: "AG1 docs" })).toBe("AG1 docs");
		expect(extractInteractiveToolDetail("webfetch", { url: "https://example.com" })).toBe("https://example.com");
		expect(extractInteractiveToolDetail("read", { path: "src/app.ts", offset: 10, limit: 20 })).toBe(
			"src/app.ts (offset=10, limit=20)",
		);
	});

	it("extracts metadata and estimates text result tokens", () => {
		const result = {
			content: [{ type: "text", text: "abcd efgh" }],
			details: { path: "src/app.ts" },
		};

		expect(extractInteractiveToolMetadata(result)).toEqual({ path: "src/app.ts" });
		expect(estimateInteractiveToolResultTokens(result)).toBe(3);
	});
});
