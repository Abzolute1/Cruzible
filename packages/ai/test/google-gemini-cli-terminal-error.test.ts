import { afterEach, describe, expect, it, vi } from "vitest";
import { streamGoogleGeminiCli } from "../src/providers/google-gemini-cli.js";
import type { Context, Model } from "../src/types.js";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

const model: Model<"google-gemini-cli"> = {
	id: "gemini-2.5-flash",
	name: "Gemini 2.5 Flash",
	api: "google-gemini-cli",
	provider: "google-gemini-cli",
	baseUrl: "https://cloudcode-pa.googleapis.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

const context: Context = {
	messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
};

const options = { apiKey: JSON.stringify({ token: "token", projectId: "project" }) };

describe("google-gemini-cli terminal errors", () => {
	it("does not retry non-retryable API errors", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: { message: "API key not valid" } }), {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		);
		global.fetch = fetchMock as typeof fetch;

		const result = await streamGoogleGeminiCli(model, context, options).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("API key not valid");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("surfaces excessive server-requested retry delays immediately", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
					status: 429,
					headers: { "content-type": "application/json", "Retry-After": "120" },
				}),
		);
		global.fetch = fetchMock as typeof fetch;

		const result = await streamGoogleGeminiCli(model, context, options).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("retry delay");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
