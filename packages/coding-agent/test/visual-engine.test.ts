import { afterEach, describe, expect, test, vi } from "vitest";

const { getBrowserMock } = vi.hoisted(() => ({
	getBrowserMock: vi.fn(),
}));

vi.mock("../src/core/tools/visual/browser.js", () => ({
	getBrowser: getBrowserMock,
}));

import { runScreenshot } from "../src/core/tools/visual/engine.js";

describe("visual screenshot engine", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	test("aborts a screenshot run before browser startup", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(runScreenshot("http://localhost:3000", [], {}, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
			message: "Screenshot aborted",
		});
		expect(getBrowserMock).not.toHaveBeenCalled();
	});

	test("aborts during a wait action and still closes the context", async () => {
		const controller = new AbortController();
		const page = {
			on: vi.fn(),
			goto: vi.fn().mockResolvedValue(undefined),
			locator: vi.fn(),
			title: vi.fn().mockResolvedValue("Demo"),
			url: vi.fn().mockReturnValue("http://localhost:3000"),
			screenshot: vi.fn().mockResolvedValue(Buffer.from("png")),
			viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 900 }),
			setViewportSize: vi.fn().mockResolvedValue(undefined),
		};
		const ctx = {
			newPage: vi.fn().mockResolvedValue(page),
			close: vi.fn().mockResolvedValue(undefined),
		};
		getBrowserMock.mockResolvedValue({
			browser: {
				newContext: vi.fn().mockResolvedValue(ctx),
			},
		});

		const promise = runScreenshot("http://localhost:3000", [{ type: "wait", ms: 5_000 }], {}, controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 0));
		controller.abort();

		await expect(promise).rejects.toMatchObject({
			name: "AbortError",
			message: "Screenshot aborted",
		});
		expect(ctx.close).toHaveBeenCalled();
	});
});
