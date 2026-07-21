import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	CONTEXT_LENGTH_CACHE_TTL_MS,
	contextLengthCacheKey,
	detectContextLength,
	getCachedContextLength,
	probeLmStudioContextLength,
	probeOllamaContextLength,
	readContextLengthCache,
	writeContextLengthCache,
} from "../src/core/model-capability-probe.js";

type FetchCall = { url: string; init?: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** Build a fake fetch that records calls and delegates to `handler`. */
function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	const calls: FetchCall[] = [];
	const fetchFn = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init });
		return handler(url, init);
	}) as typeof fetch;
	return { fetchFn, calls };
}

function failingFetch(message: string): typeof fetch {
	return (async () => {
		throw new Error(message);
	}) as typeof fetch;
}

describe("probeLmStudioContextLength", () => {
	const baseOptions = { provider: "lmstudio", baseUrl: "http://gpu-box:1234/v1", modelId: "qwen/qwen3.5-35b-a3b" };

	test("prefers loaded_context_length over max_context_length, stripping /v1", async () => {
		const { fetchFn, calls } = fakeFetch(() =>
			jsonResponse({
				data: [{ id: "qwen/qwen3.5-35b-a3b", loaded_context_length: 50176, max_context_length: 262144 }],
			}),
		);
		const result = await probeLmStudioContextLength({ ...baseOptions, fetchFn });
		expect(result).toBe(50176);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("http://gpu-box:1234/api/v0/models");
	});

	test("falls back to max_context_length when loaded value is absent", async () => {
		const { fetchFn } = fakeFetch(() =>
			jsonResponse({ data: [{ id: "qwen/qwen3.5-35b-a3b", max_context_length: 131072 }] }),
		);
		const result = await probeLmStudioContextLength({ ...baseOptions, fetchFn });
		expect(result).toBe(131072);
	});

	test("case-insensitive suffix match without publisher prefix", async () => {
		const { fetchFn } = fakeFetch(() =>
			jsonResponse({ data: [{ id: "Qwen/Qwen3.5-35B-A3B", loaded_context_length: 50176 }] }),
		);
		const result = await probeLmStudioContextLength({ ...baseOptions, modelId: "qwen3.5-35b-a3b", fetchFn });
		expect(result).toBe(50176);
	});

	test("publisher-less basename match for aliased registry ids", async () => {
		const { fetchFn } = fakeFetch(() =>
			jsonResponse({ data: [{ id: "qwen/qwen3.6-35b-a3b", loaded_context_length: 40960 }] }),
		);
		const result = await probeLmStudioContextLength({
			...baseOptions,
			modelId: "registry-alias/qwen3.6-35b-a3b",
			fetchFn,
		});
		expect(result).toBe(40960);
	});

	test("unreachable API yields undefined", async () => {
		const result = await probeLmStudioContextLength({
			...baseOptions,
			fetchFn: failingFetch("connect ECONNREFUSED"),
		});
		expect(result).toBeUndefined();
	});

	test("HTTP error yields undefined", async () => {
		const { fetchFn } = fakeFetch(() => jsonResponse({ error: "nope" }, 500));
		const result = await probeLmStudioContextLength({ ...baseOptions, fetchFn });
		expect(result).toBeUndefined();
	});

	test("non-JSON response yields undefined", async () => {
		const { fetchFn } = fakeFetch(() => new Response("<html>nope</html>", { status: 200 }));
		const result = await probeLmStudioContextLength({ ...baseOptions, fetchFn });
		expect(result).toBeUndefined();
	});

	test("model absent from list yields undefined", async () => {
		const { fetchFn } = fakeFetch(() =>
			jsonResponse({ data: [{ id: "meta/llama-3.1-8b", loaded_context_length: 8192 }] }),
		);
		const result = await probeLmStudioContextLength({ ...baseOptions, fetchFn });
		expect(result).toBeUndefined();
	});

	test("implausible values are rejected", async () => {
		const { fetchFn } = fakeFetch(() =>
			jsonResponse({ data: [{ id: "qwen/qwen3.5-35b-a3b", loaded_context_length: 0, max_context_length: -5 }] }),
		);
		const result = await probeLmStudioContextLength({ ...baseOptions, fetchFn });
		expect(result).toBeUndefined();
	});
});

describe("probeOllamaContextLength", () => {
	const baseOptions = { provider: "ollama", baseUrl: "http://localhost:11434/v1", modelId: "qwen3:32b" };

	test("reads architecture-scoped context_length from model_info, posting model id", async () => {
		const { fetchFn, calls } = fakeFetch(() =>
			jsonResponse({ model_info: { "qwen3.context_length": 40960, "qwen3.embedding_length": 2560 } }),
		);
		const result = await probeOllamaContextLength({ ...baseOptions, fetchFn });
		expect(result).toBe(40960);
		expect(calls[0].url).toBe("http://localhost:11434/api/show");
		expect(calls[0].init?.method).toBe("POST");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({ model: "qwen3:32b" });
	});

	test("falls back to top-level context_length then num_ctx", async () => {
		const topLevel = fakeFetch(() => jsonResponse({ context_length: 32768 }));
		expect(await probeOllamaContextLength({ ...baseOptions, fetchFn: topLevel.fetchFn })).toBe(32768);

		const numCtx = fakeFetch(() => jsonResponse({ num_ctx: 16384 }));
		expect(await probeOllamaContextLength({ ...baseOptions, fetchFn: numCtx.fetchFn })).toBe(16384);
	});

	test("unreachable API yields undefined", async () => {
		const result = await probeOllamaContextLength({ ...baseOptions, fetchFn: failingFetch("connect ECONNREFUSED") });
		expect(result).toBeUndefined();
	});

	test("payload without any context length yields undefined", async () => {
		const { fetchFn } = fakeFetch(() => jsonResponse({ model_info: { "qwen3.embedding_length": 2560 } }));
		const result = await probeOllamaContextLength({ ...baseOptions, fetchFn });
		expect(result).toBeUndefined();
	});
});

describe("detectContextLength routing", () => {
	test("routes lmstudio provider names to the LM Studio API", async () => {
		const { fetchFn, calls } = fakeFetch(() => jsonResponse({ data: [{ id: "m", loaded_context_length: 50176 }] }));
		const result = await detectContextLength({
			provider: "lm-studio",
			baseUrl: "http://gpu-box:9999/v1",
			modelId: "m",
			fetchFn,
		});
		expect(result).toBe(50176);
		expect(calls[0].url).toBe("http://gpu-box:9999/api/v0/models");
	});

	test("routes ollama provider names to the Ollama API", async () => {
		const { fetchFn, calls } = fakeFetch(() => jsonResponse({ model_info: { "llama.context_length": 40960 } }));
		const result = await detectContextLength({
			provider: "ollama",
			baseUrl: "http://gpu-box:9999/v1",
			modelId: "m",
			fetchFn,
		});
		expect(result).toBe(40960);
		expect(calls[0].url).toBe("http://gpu-box:9999/api/show");
	});

	test("routes by well-known port when the provider name is generic", async () => {
		const lmStudio = fakeFetch(() => jsonResponse({ data: [{ id: "m", loaded_context_length: 50176 }] }));
		expect(
			await detectContextLength({
				provider: "local",
				baseUrl: "http://localhost:1234/v1",
				modelId: "m",
				fetchFn: lmStudio.fetchFn,
			}),
		).toBe(50176);

		const ollama = fakeFetch(() => jsonResponse({ model_info: { "llama.context_length": 40960 } }));
		expect(
			await detectContextLength({
				provider: "local",
				baseUrl: "http://localhost:11434/v1",
				modelId: "m",
				fetchFn: ollama.fetchFn,
			}),
		).toBe(40960);
	});

	test("unprobeable providers yield undefined without any fetch", async () => {
		const { fetchFn, calls } = fakeFetch(() => jsonResponse({}));
		const result = await detectContextLength({
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			modelId: "gpt-5.2",
			fetchFn,
		});
		expect(result).toBeUndefined();
		expect(calls).toHaveLength(0);
	});
});

describe("context-length cache", () => {
	let tempDir: string;
	let cachePath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "ag1-context-length-cache-"));
		cachePath = join(tempDir, "nested", "context-length-cache.json");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("contextLengthCacheKey joins provider, baseUrl and modelId", () => {
		expect(contextLengthCacheKey("ollama", "http://localhost:11434", "qwen3:32b")).toBe(
			"ollama|http://localhost:11434|qwen3:32b",
		);
		expect(contextLengthCacheKey("lmstudio", undefined, "m")).toBe("lmstudio||m");
	});

	test("write then read round-trips entries, creating parent dirs", async () => {
		const key = contextLengthCacheKey("lmstudio", "http://gpu-box:1234/v1", "qwen/qwen3.5-35b-a3b");
		const cache = { [key]: { contextLength: 50176, at: Date.now() } };
		await writeContextLengthCache(cachePath, cache);
		expect(existsSync(cachePath)).toBe(true);
		expect(await readContextLengthCache(cachePath)).toEqual(cache);
	});

	test("readContextLengthCache tolerates missing file", async () => {
		expect(await readContextLengthCache(join(tempDir, "does-not-exist.json"))).toEqual({});
	});

	test("readContextLengthCache tolerates corrupt file", async () => {
		const corruptPath = join(tempDir, "corrupt.json");
		writeFileSync(corruptPath, "{ not json !!", "utf8");
		expect(await readContextLengthCache(corruptPath)).toEqual({});
	});

	test("getCachedContextLength returns fresh entries and hides stale or implausible ones", () => {
		const now = Date.now();
		const cache = {
			fresh: { contextLength: 50176, at: now },
			stale: { contextLength: 50176, at: now - CONTEXT_LENGTH_CACHE_TTL_MS - 1000 },
			implausible: { contextLength: 0, at: now },
		};
		expect(getCachedContextLength(cache, "fresh", CONTEXT_LENGTH_CACHE_TTL_MS)?.contextLength).toBe(50176);
		expect(getCachedContextLength(cache, "stale", CONTEXT_LENGTH_CACHE_TTL_MS)).toBeUndefined();
		expect(getCachedContextLength(cache, "implausible", CONTEXT_LENGTH_CACHE_TTL_MS)).toBeUndefined();
		expect(getCachedContextLength(cache, "missing", CONTEXT_LENGTH_CACHE_TTL_MS)).toBeUndefined();
	});

	test("getCachedContextLength honors a custom ttl", () => {
		const cache = { k: { contextLength: 50176, at: Date.now() - 500 } };
		expect(getCachedContextLength(cache, "k", 1000)?.contextLength).toBe(50176);
		expect(getCachedContextLength(cache, "k", 100)).toBeUndefined();
	});
});
