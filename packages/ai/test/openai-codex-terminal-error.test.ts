import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import type { Context, Model } from "../src/types.js";

const originalFetch = global.fetch;
const originalAgentDir = process.env.AG1_CODING_AGENT_DIR;

afterEach(() => {
	global.fetch = originalFetch;
	if (originalAgentDir === undefined) {
		delete process.env.AG1_CODING_AGENT_DIR;
	} else {
		process.env.AG1_CODING_AGENT_DIR = originalAgentDir;
	}
	vi.restoreAllMocks();
});

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.1-codex",
	name: "GPT-5.1 Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const context: Context = {
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
};

describe("openai-codex terminal errors", () => {
	it("does not retry non-retryable API errors", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "ag1-codex-terminal-"));
		process.env.AG1_CODING_AGENT_DIR = tempDir;

		let responsesCalls = 0;
		global.fetch = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				responsesCalls += 1;
				return new Response(JSON.stringify({ error: { code: "invalid_api_key", message: "Invalid token" } }), {
					status: 401,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		const result = await streamOpenAICodexResponses(model, context, { apiKey: mockToken() }).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Invalid token");
		expect(responsesCalls).toBe(1);
	});
});
