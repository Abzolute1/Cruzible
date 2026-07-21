/**
 * Provider-reported context-length probing.
 *
 * Registry `contextWindow` values are static declarations and can be wrong
 * (e.g. a registry entry says 32000 while LM Studio actually loaded the model
 * with 50176). Capability classification must rest on measured facts, so for
 * providers that can introspect themselves we ask the server:
 *
 * - LM Studio: `GET {origin}/api/v0/models` — entries carry
 *   `loaded_context_length` (the live loaded value, preferred) and
 *   `max_context_length` (theoretical max).
 * - Ollama: `POST {origin}/api/show` — `model_info` carries architecture-
 *   scoped keys ending in `.context_length`; some versions expose top-level
 *   `context_length` / `num_ctx`.
 *
 * Everything network-bound goes through an injectable `fetchFn` so tests
 * never hit the network. Probing is best-effort: any failure yields
 * `undefined` and the caller keeps the registry value. Probed values are
 * cached on disk (next to the vision cache) for 7 days.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ContextLengthProbeOptions {
	provider: string;
	baseUrl?: string;
	modelId: string;
	fetchFn?: typeof fetch;
}

export interface ContextLengthCacheEntry {
	contextLength: number;
	at: number;
}

export const CONTEXT_LENGTH_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Smallest plausible real context window; anything below is metadata noise. */
const MIN_PLAUSIBLE_CONTEXT_TOKENS = 1024;

/** Strip a trailing `/v1` (and any trailing slashes) so `{origin}` style APIs can be addressed. */
function baseUrlToOrigin(baseUrl: string): string {
	let origin = baseUrl.trim().replace(/\/+$/, "");
	if (origin.toLowerCase().endsWith("/v1")) {
		origin = origin.slice(0, -3);
	}
	return origin.replace(/\/+$/, "");
}

function portOf(baseUrl: string | undefined): string {
	if (!baseUrl) return "";
	try {
		return new URL(baseUrl).port;
	} catch {
		return "";
	}
}

/** Publisher-less basename segment of a model id ("qwen/foo-7b" → "foo-7b"). */
function basenameOf(id: string): string {
	const idx = id.lastIndexOf("/");
	return idx === -1 ? id : id.slice(idx + 1);
}

function plausibleContextLength(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < MIN_PLAUSIBLE_CONTEXT_TOKENS) {
		return undefined;
	}
	return Math.round(value);
}

type LmStudioModelEntry = { id?: unknown; loaded_context_length?: unknown; max_context_length?: unknown };

/**
 * Exact id match first, then case-insensitive suffix match (id with or without
 * publisher prefix), then a publisher-less basename match as a last resort —
 * registry model ids can be aliases or carry a different publisher segment
 * than the server's id.
 */
function findLmStudioModel(models: LmStudioModelEntry[], modelId: string): LmStudioModelEntry | undefined {
	const needle = modelId.toLowerCase();
	const needleBase = basenameOf(needle);
	let suffixMatch: LmStudioModelEntry | undefined;
	let basenameMatch: LmStudioModelEntry | undefined;
	for (const entry of models) {
		if (typeof entry?.id !== "string") continue;
		const id = entry.id.toLowerCase();
		if (id === needle) return entry;
		if (!suffixMatch && (id.endsWith(`/${needle}`) || needle.endsWith(`/${id}`))) {
			suffixMatch = entry;
		}
		if (!basenameMatch && needleBase !== "" && basenameOf(id) === needleBase) {
			basenameMatch = entry;
		}
	}
	return suffixMatch ?? basenameMatch;
}

/**
 * Ask LM Studio for the model's context length. Prefers the live
 * `loaded_context_length` over the theoretical `max_context_length`.
 */
export async function probeLmStudioContextLength(options: ContextLengthProbeOptions): Promise<number | undefined> {
	const fetchFn = options.fetchFn ?? fetch;
	if (!options.baseUrl) return undefined;
	const origin = baseUrlToOrigin(options.baseUrl);
	let res: Response;
	try {
		res = await fetchFn(`${origin}/api/v0/models`);
	} catch {
		return undefined;
	}
	if (!res.ok) return undefined;
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		return undefined;
	}
	const data = (body as { data?: unknown })?.data;
	if (!Array.isArray(data)) return undefined;
	const model = findLmStudioModel(data as LmStudioModelEntry[], options.modelId);
	if (!model) return undefined;
	return plausibleContextLength(model.loaded_context_length) ?? plausibleContextLength(model.max_context_length);
}

/**
 * Ask Ollama for the model's context length. Reads the first architecture-
 * scoped `*.context_length` entry in `model_info`, falling back to top-level
 * `context_length` / `num_ctx` when present.
 */
export async function probeOllamaContextLength(options: ContextLengthProbeOptions): Promise<number | undefined> {
	const fetchFn = options.fetchFn ?? fetch;
	if (!options.baseUrl) return undefined;
	const origin = baseUrlToOrigin(options.baseUrl);
	let res: Response;
	try {
		res = await fetchFn(`${origin}/api/show`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: options.modelId }),
		});
	} catch {
		return undefined;
	}
	if (!res.ok) return undefined;
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		return undefined;
	}
	const record = body as Record<string, unknown>;
	const modelInfo = record?.model_info;
	if (modelInfo && typeof modelInfo === "object" && !Array.isArray(modelInfo)) {
		for (const [key, value] of Object.entries(modelInfo as Record<string, unknown>)) {
			if (!key.endsWith(".context_length")) continue;
			const contextLength = plausibleContextLength(value);
			if (contextLength !== undefined) return contextLength;
		}
	}
	return plausibleContextLength(record?.context_length) ?? plausibleContextLength(record?.num_ctx);
}

type IntrospectionKind = "lmstudio" | "ollama" | undefined;

function inferIntrospectionKind(provider: string, baseUrl: string | undefined): IntrospectionKind {
	const p = provider.toLowerCase();
	if (p.includes("lmstudio") || p.includes("lm-studio")) return "lmstudio";
	if (p.includes("ollama")) return "ollama";
	const port = portOf(baseUrl);
	if (port === "1234") return "lmstudio";
	if (port === "11434") return "ollama";
	return undefined;
}

/**
 * Detect the provider-reported context length, if the provider supports
 * introspection (LM Studio / Ollama, by name or well-known port). Returns
 * `undefined` for unprobeable providers or any failure — callers treat that
 * as "keep the registry value".
 */
export async function detectContextLength(options: ContextLengthProbeOptions): Promise<number | undefined> {
	const kind = inferIntrospectionKind(options.provider, options.baseUrl);
	if (kind === "lmstudio") return probeLmStudioContextLength(options);
	if (kind === "ollama") return probeOllamaContextLength(options);
	return undefined;
}

export function contextLengthCacheKey(provider: string, baseUrl: string | undefined, modelId: string): string {
	return `${provider}|${baseUrl ?? ""}|${modelId}`;
}

export async function readContextLengthCache(filePath: string): Promise<Record<string, ContextLengthCacheEntry>> {
	try {
		const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		return parsed as Record<string, ContextLengthCacheEntry>;
	} catch {
		// Missing or corrupt cache file: start empty.
		return {};
	}
}

export async function writeContextLengthCache(
	filePath: string,
	cache: Record<string, ContextLengthCacheEntry>,
): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	// Atomic-ish write: serialize to a sibling temp file, then rename over the target.
	const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmpPath, JSON.stringify(cache, null, 2));
	await rename(tmpPath, filePath);
}

export function getCachedContextLength(
	cache: Record<string, ContextLengthCacheEntry>,
	key: string,
	ttlMs: number = CONTEXT_LENGTH_CACHE_TTL_MS,
): ContextLengthCacheEntry | undefined {
	const entry = cache[key];
	if (!entry) return undefined;
	if (plausibleContextLength(entry.contextLength) === undefined) return undefined;
	if (typeof entry.at !== "number" || Date.now() - entry.at > ttlMs) return undefined;
	return entry;
}
