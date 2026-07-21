import { afterEach, describe, expect, test, vi } from "vitest";

const { runScreenshotMock } = vi.hoisted(() => ({
	runScreenshotMock: vi.fn(),
}));

vi.mock("../src/core/tools/visual/engine.js", () => ({
	runScreenshot: runScreenshotMock,
}));

import {
	createInteractThenScreenshotToolDefinition,
	createScreenshotUrlToolDefinition,
} from "../src/core/tools/visual/tools.js";

describe("visual tool hardening", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	test("passes the abort signal through screenshot_url", async () => {
		const tool = createScreenshotUrlToolDefinition();
		const controller = new AbortController();
		runScreenshotMock.mockResolvedValue({
			image: { type: "image", data: "abc", mimeType: "image/png" },
			url: "http://localhost:3000",
			title: "Demo",
			consoleErrors: [],
			failedRequests: [],
			loadTimeMs: 50,
		});

		await tool.execute("tool-1", { url: "http://localhost:3000" }, controller.signal, undefined, {} as any);

		expect(runScreenshotMock).toHaveBeenCalledWith("http://localhost:3000", [], {}, controller.signal);
	});

	test("rejects malformed interaction actions instead of silently defaulting them", async () => {
		const tool = createInteractThenScreenshotToolDefinition();

		const result = await tool.execute(
			"tool-2",
			{
				url: "http://localhost:3000/login",
				actions: [{ type: "click", selector: "   " }],
			} as any,
			undefined,
			undefined,
			{} as any,
		);

		expect(runScreenshotMock).not.toHaveBeenCalled();
		const first = result.content[0];
		expect(first?.type === "text" && first.text.includes("Action 1 (click) is missing a non-empty selector.")).toBe(
			true,
		);
		expect((result.details as Record<string, unknown>).error).toBe(
			"Action 1 (click) is missing a non-empty selector.",
		);
	});
});
