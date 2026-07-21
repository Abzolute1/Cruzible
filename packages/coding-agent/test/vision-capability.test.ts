import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	CANARY_PNG_BASE64,
	detectVisionCapability,
	getCachedVision,
	probeCanary,
	probeLmStudio,
	probeOllama,
	readVisionCache,
	VISION_CACHE_NEGATIVE_TTL_MS,
	VISION_CACHE_TTL_MS,
	visionCacheKey,
	writeVisionCache,
} from "../src/core/vision-capability.js";

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

describe("probeLmStudio", () => {
	const baseOptions = { provider: "lmstudio", baseUrl: "http://gpu-box:1234/v1", modelId: "qwen/qwen3.5-35b-a3b" };

	test("vlm model yields yes and strips /v1 from baseUrl", async () => {
		const { fetchFn, calls } = fakeFetch(() => jsonResponse({ data: [{ id: "qwen/qwen3.5-35b-a3b", type: "vlm" }] }));
		const result = await probeLmStudio({ ...baseOptions, fetchFn });
		expect(result).toEqual({ verdict: "yes", source: "lmstudio" });
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("http://gpu-box:1234/api/v0/models");
	});

	test("llm model yields no", async () => {
		const { fetchFn } = fakeFetch(() => jsonResponse({ data: [{ id: "qwen/qwen3.5-35b-a3b", type: "llm" }] }));
		const result = await probeLmStudio({ ...baseOptions, fetchFn });
		expect(result.verdict).toBe("no");
		expect(result.source).toBe("lmstudio");
	});

	test("unreachable API yields unknown with reason", async () => {
		const result = await probeLmStudio({ ...baseOptions, fetchFn: failingFetch("connect ECONNREFUSED") });
		expect(result.verdict).toBe("unknown");
		expect(result.source).toBe("lmstudio");
		expect(result.reason).toContain("ECONNREFUSED");
	});

	test("model absent from list yields unknown", async () => {
		const { fetchFn } = fakeFetch(() => jsonResponse({ data: [{ id: "meta/llama-3.1-8b", type: "llm" }] }));
		const result = await probeLmStudio({ ...baseOptions, fetchFn });
		expect(result.verdict).toBe("unknown");
		expect(result.reason).toContain("not listed");
	});

	test("case-insensitive suffix match without publisher prefix", async () => {
		const { fetchFn } = fakeFetch(() => jsonResponse({ data: [{ id: "Qwen/Qwen3.5-35B-A3B", type: "vlm" }] }));
		const result = await probeLmStudio({ ...baseOptions, modelId: "qwen3.5-35b-a3b", fetchFn });
		expect(result).toEqual({ verdict: "yes", source: "lmstudio" });
	});

	test("publisher-less basename match for aliased registry ids", async () => {
		const { fetchFn } = fakeFetch(() => jsonResponse({ data: [{ id: "qwen/qwen3.6-35b-a3b", type: "vlm" }] }));
		const result = await probeLmStudio({ ...baseOptions, modelId: "registry-alias/qwen3.6-35b-a3b", fetchFn });
		expect(result).toEqual({ verdict: "yes", source: "lmstudio" });
	});

	test("reason lists the server candidates when nothing matches", async () => {
		const { fetchFn } = fakeFetch(() => jsonResponse({ data: [{ id: "meta/llama-3.1-8b", type: "llm" }] }));
		const result = await probeLmStudio({ ...baseOptions, modelId: "lm-studio", fetchFn });
		expect(result.verdict).toBe("unknown");
		expect(result.reason).toContain("not listed");
		expect(result.reason).toContain("meta/llama-3.1-8b");
	});

	test("non-JSON response yields unknown", async () => {
		const { fetchFn } = fakeFetch(() => new Response("<html>nope</html>", { status: 200 }));
		const result = await probeLmStudio({ ...baseOptions, fetchFn });
		expect(result.verdict).toBe("unknown");
	});
});

describe("probeOllama", () => {
	const baseOptions = { provider: "ollama", baseUrl: "http://localhost:11434/v1", modelId: "llava:13b" };

	test("vision capability yields yes, posting model id to /api/show", async () => {
		const { fetchFn, calls } = fakeFetch(() => jsonResponse({ capabilities: ["completion", "vision", "tools"] }));
		const result = await probeOllama({ ...baseOptions, fetchFn });
		expect(result).toEqual({ verdict: "yes", source: "ollama" });
		expect(calls[0].url).toBe("http://localhost:11434/api/show");
		expect(calls[0].init?.method).toBe("POST");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({ model: "llava:13b" });
	});

	test("capabilities without vision yield no", async () => {
		const { fetchFn } = fakeFetch(() => jsonResponse({ capabilities: ["completion", "tools"] }));
		const result = await probeOllama({ ...baseOptions, fetchFn });
		expect(result.verdict).toBe("no");
		expect(result.source).toBe("ollama");
	});

	test("unreachable API yields unknown with reason", async () => {
		const result = await probeOllama({ ...baseOptions, fetchFn: failingFetch("socket hang up") });
		expect(result.verdict).toBe("unknown");
		expect(result.source).toBe("ollama");
		expect(result.reason).toContain("socket hang up");
	});
});

describe("probeCanary", () => {
	const baseOptions = {
		provider: "custom",
		baseUrl: "http://localhost:8080/v1/",
		modelId: "some-model",
		apiKey: "sk-test",
	};

	function chatResponse(text: string): Response {
		return jsonResponse({ choices: [{ message: { role: "assistant", content: text } }] });
	}

	test("assistant naming the canary color yields yes", async () => {
		const { fetchFn, calls } = fakeFetch(() => chatResponse("Teal."));
		const result = await probeCanary({ ...baseOptions, fetchFn });
		expect(result).toEqual({ verdict: "yes", source: "canary" });
		expect(calls[0].url).toBe("http://localhost:8080/v1/chat/completions");
		const headers = calls[0].init?.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer sk-test");
		const body = JSON.parse(String(calls[0].init?.body));
		expect(body.model).toBe("some-model");
		expect(body.messages).toHaveLength(1);
		expect(body.messages[0].content[0]).toEqual({
			type: "text",
			text: "This is a capability probe. The attached image is filled with a single color. Reply with exactly one word: the color.",
		});
		expect(body.messages[0].content[1]).toEqual({
			type: "image_url",
			image_url: { url: `data:image/png;base64,${CANARY_PNG_BASE64}` },
		});
		expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
	});

	test("omits Authorization header without apiKey", async () => {
		const { fetchFn, calls } = fakeFetch(() => chatResponse("teal"));
		const { apiKey: _apiKey, ...noKey } = baseOptions;
		await probeCanary({ ...noKey, fetchFn });
		const headers = calls[0].init?.headers as Record<string, string>;
		expect(headers.authorization).toBeUndefined();
	});

	test("HTTP 400 rejection yields no", async () => {
		const { fetchFn } = fakeFetch(() => jsonResponse({ error: { message: "image input not supported" } }, 400));
		const result = await probeCanary({ ...baseOptions, fetchFn });
		expect(result.verdict).toBe("no");
		expect(result.source).toBe("canary");
		expect(result.reason).toContain("400");
	});

	test("HTTP 404 model-not-found yields unknown, not no", async () => {
		const { fetchFn } = fakeFetch(() => jsonResponse({ error: { message: "model `lm-studio` not found" } }, 404));
		const result = await probeCanary({ ...baseOptions, modelId: "lm-studio", fetchFn });
		expect(result.verdict).toBe("unknown");
		expect(result.source).toBe("canary");
		expect(result.reason).toContain("404");
	});

	test("non-404 error with a model-not-found body yields unknown", async () => {
		const { fetchFn } = fakeFetch(() => jsonResponse({ error: "The requested model does not exist" }, 400));
		const result = await probeCanary({ ...baseOptions, fetchFn });
		expect(result.verdict).toBe("unknown");
		expect(result.source).toBe("canary");
	});

	test("wrong color answer yields unknown", async () => {
		const { fetchFn } = fakeFetch(() => chatResponse("blue"));
		const result = await probeCanary({ ...baseOptions, fetchFn });
		expect(result.verdict).toBe("unknown");
		expect(result.reason).toBeDefined();
	});

	test("timeout error yields unknown with reason", async () => {
		const fetchFn = (async () => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		}) as typeof fetch;
		const result = await probeCanary({ ...baseOptions, fetchFn, canaryTimeoutMs: 5 });
		expect(result.verdict).toBe("unknown");
		expect(result.source).toBe("canary");
		expect(result.reason).toContain("timed out");
	});
});

describe("detectVisionCapability", () => {
	test("routes to LM Studio by provider name", async () => {
		const { fetchFn, calls } = fakeFetch(() => jsonResponse({ data: [{ id: "m", type: "vlm" }] }));
		const result = await detectVisionCapability({
			provider: "LM-Studio",
			baseUrl: "http://whatever:9999/v1",
			modelId: "m",
			fetchFn,
		});
		expect(result).toEqual({ verdict: "yes", source: "lmstudio" });
		expect(calls[0].url).toBe("http://whatever:9999/api/v0/models");
		// Remote endpoint without credentials: introspection-yes is returned unconfirmed.
		expect(calls).toHaveLength(1);
	});

	test("routes to LM Studio by port 1234", async () => {
		const { fetchFn, calls } = fakeFetch(() => jsonResponse({ data: [{ id: "m", type: "llm" }] }));
		const result = await detectVisionCapability({
			provider: "custom-openai",
			baseUrl: "http://192.168.1.20:1234/v1",
			modelId: "m",
			fetchFn,
		});
		expect(result).toEqual({ verdict: "no", source: "lmstudio", reason: expect.any(String) });
		expect(calls[0].url).toBe("http://192.168.1.20:1234/api/v0/models");
	});

	test("routes to Ollama by provider name and confirms the yes with a canary", async () => {
		const { fetchFn, calls } = fakeFetch((url) => {
			if (url.endsWith("/api/show")) return jsonResponse({ capabilities: ["completion", "vision"] });
			return jsonResponse({ choices: [{ message: { content: "teal" } }] });
		});
		const result = await detectVisionCapability({
			provider: "ollama",
			baseUrl: "http://localhost:11434",
			modelId: "llava",
			fetchFn,
		});
		expect(result).toEqual({ verdict: "yes", source: "ollama", reason: "confirmed by canary probe" });
		expect(calls.map((c) => c.url)).toEqual([
			"http://localhost:11434/api/show",
			"http://localhost:11434/chat/completions",
		]);
	});

	test("routes to Ollama by port 11434", async () => {
		const { fetchFn, calls } = fakeFetch(() => jsonResponse({ capabilities: ["completion"] }));
		const result = await detectVisionCapability({
			provider: "custom",
			baseUrl: "http://nas:11434/v1",
			modelId: "m",
			fetchFn,
		});
		expect(result.verdict).toBe("no");
		expect(result.source).toBe("ollama");
		expect(calls[0].url).toBe("http://nas:11434/api/show");
	});

	test("unknown provider on a local endpoint falls back to canary without apiKey", async () => {
		const { fetchFn, calls } = fakeFetch(() => jsonResponse({ choices: [{ message: { content: "teal" } }] }));
		const result = await detectVisionCapability({
			provider: "vllm",
			baseUrl: "http://localhost:8000/v1",
			modelId: "m",
			fetchFn,
		});
		expect(result).toEqual({ verdict: "yes", source: "canary" });
		expect(calls[0].url).toBe("http://localhost:8000/v1/chat/completions");
	});

	test("unknown provider without apiKey on a remote endpoint stays unknown and fetches nothing", async () => {
		const { fetchFn, calls } = fakeFetch(() => jsonResponse({}));
		const result = await detectVisionCapability({
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			modelId: "gpt-x",
			fetchFn,
		});
		expect(result.verdict).toBe("unknown");
		expect(calls).toHaveLength(0);
	});

	test("inconclusive introspection falls through to canary", async () => {
		const { fetchFn, calls } = fakeFetch((url) => {
			if (url.endsWith("/api/v0/models")) return jsonResponse({ data: [] });
			return jsonResponse({ choices: [{ message: { content: "teal" } }] });
		});
		const result = await detectVisionCapability({
			provider: "lmstudio",
			baseUrl: "http://localhost:1234/v1",
			modelId: "ghost",
			fetchFn,
		});
		expect(result).toEqual({ verdict: "yes", source: "canary" });
		expect(calls.map((c) => c.url)).toEqual([
			"http://localhost:1234/api/v0/models",
			"http://localhost:1234/v1/chat/completions",
		]);
	});

	test("confirms an introspection yes with the canary on a local endpoint", async () => {
		const { fetchFn, calls } = fakeFetch((url) => {
			if (url.endsWith("/api/v0/models")) return jsonResponse({ data: [{ id: "m", type: "vlm" }] });
			return jsonResponse({ choices: [{ message: { content: "teal" } }] });
		});
		const result = await detectVisionCapability({
			provider: "lmstudio",
			baseUrl: "http://localhost:1234/v1",
			modelId: "m",
			fetchFn,
		});
		expect(result).toEqual({ verdict: "yes", source: "lmstudio", reason: "confirmed by canary probe" });
		expect(calls.map((c) => c.url)).toEqual([
			"http://localhost:1234/api/v0/models",
			"http://localhost:1234/v1/chat/completions",
		]);
	});

	test("canary rejection overrides an introspection yes", async () => {
		const { fetchFn, calls } = fakeFetch((url) => {
			if (url.endsWith("/api/v0/models")) return jsonResponse({ data: [{ id: "m", type: "vlm" }] });
			return jsonResponse({ error: { message: "image input not supported" } }, 400);
		});
		const result = await detectVisionCapability({
			provider: "lmstudio",
			baseUrl: "http://localhost:1234/v1",
			modelId: "m",
			fetchFn,
		});
		expect(result.verdict).toBe("no");
		expect(result.source).toBe("canary");
		expect(result.reason).toContain("400");
		expect(calls).toHaveLength(2);
	});

	test("inconclusive canary does not downgrade an introspection yes", async () => {
		const { fetchFn, calls } = fakeFetch((url) => {
			if (url.endsWith("/api/v0/models")) return jsonResponse({ data: [{ id: "m", type: "vlm" }] });
			return jsonResponse({ choices: [{ message: { content: "blue" } }] });
		});
		const result = await detectVisionCapability({
			provider: "lmstudio",
			baseUrl: "http://localhost:1234/v1",
			modelId: "m",
			fetchFn,
		});
		expect(result.verdict).toBe("yes");
		expect(result.source).toBe("lmstudio");
		expect(result.reason).toContain("inconclusive");
		expect(calls).toHaveLength(2);
	});

	test("introspection no is trusted without running a canary", async () => {
		const { fetchFn, calls } = fakeFetch(() => jsonResponse({ data: [{ id: "m", type: "llm" }] }));
		const result = await detectVisionCapability({
			provider: "lmstudio",
			baseUrl: "http://localhost:1234/v1",
			modelId: "m",
			fetchFn,
		});
		expect(result.verdict).toBe("no");
		expect(result.source).toBe("lmstudio");
		expect(calls).toHaveLength(1);
	});
});

describe("vision cache", () => {
	let tempDir: string;
	let cachePath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "ag1-vision-cache-"));
		cachePath = join(tempDir, "nested", "vision-cache.json");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("visionCacheKey joins provider, baseUrl and modelId", () => {
		expect(visionCacheKey("ollama", "http://localhost:11434", "llava")).toBe("ollama|http://localhost:11434|llava");
		expect(visionCacheKey("openai", undefined, "gpt-x")).toBe("openai||gpt-x");
	});

	test("write then read round-trips entries, creating parent dirs", async () => {
		const key = visionCacheKey("lmstudio", "http://gpu-box:1234/v1", "qwen/qwen3.5-35b-a3b");
		const cache = { [key]: { verdict: "yes" as const, source: "lmstudio" as const, at: Date.now() } };
		await writeVisionCache(cachePath, cache);
		expect(existsSync(cachePath)).toBe(true);
		expect(await readVisionCache(cachePath)).toEqual(cache);
	});

	test("readVisionCache tolerates missing file", async () => {
		expect(await readVisionCache(join(tempDir, "does-not-exist.json"))).toEqual({});
	});

	test("readVisionCache tolerates corrupt file", async () => {
		const corruptPath = join(tempDir, "corrupt.json");
		writeFileSync(corruptPath, "{ not json !!", "utf8");
		expect(await readVisionCache(corruptPath)).toEqual({});
	});

	test("getCachedVision returns fresh entries and hides stale or non-definitive ones", () => {
		const now = Date.now();
		const cache = {
			fresh: { verdict: "yes" as const, source: "canary" as const, at: now },
			stale: { verdict: "no" as const, at: now - VISION_CACHE_TTL_MS - 1000 },
			unknown: { verdict: "unknown" as never, at: now },
		};
		expect(getCachedVision(cache, "fresh", VISION_CACHE_TTL_MS)?.verdict).toBe("yes");
		expect(getCachedVision(cache, "stale", VISION_CACHE_TTL_MS)).toBeUndefined();
		expect(getCachedVision(cache, "unknown", VISION_CACHE_TTL_MS)).toBeUndefined();
		expect(getCachedVision(cache, "missing", VISION_CACHE_TTL_MS)).toBeUndefined();
	});

	test("getCachedVision honors a custom ttl", () => {
		const cache = { k: { verdict: "yes" as const, at: Date.now() - 500 } };
		expect(getCachedVision(cache, "k", 1000)?.verdict).toBe("yes");
		expect(getCachedVision(cache, "k", 100)).toBeUndefined();
	});

	test("getCachedVision expires negative verdicts after the short negative ttl", () => {
		const now = Date.now();
		const cache = {
			oldNo: { verdict: "no" as const, at: now - VISION_CACHE_NEGATIVE_TTL_MS - 1000 },
			oldYes: { verdict: "yes" as const, at: now - VISION_CACHE_NEGATIVE_TTL_MS - 1000 },
			freshNo: { verdict: "no" as const, at: now - 1000 },
		};
		// Same age: the "yes" is still fresh under the 24h ttl, the "no" is gone.
		expect(getCachedVision(cache, "oldNo", VISION_CACHE_TTL_MS)).toBeUndefined();
		expect(getCachedVision(cache, "oldYes", VISION_CACHE_TTL_MS)?.verdict).toBe("yes");
		expect(getCachedVision(cache, "freshNo", VISION_CACHE_TTL_MS)?.verdict).toBe("no");
		// An explicitly shorter custom ttl still wins over the negative floor.
		const short = { k: { verdict: "no" as const, at: now - 500 } };
		expect(getCachedVision(short, "k", 100)).toBeUndefined();
	});
});
