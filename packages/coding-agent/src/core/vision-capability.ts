/**
 * Layered vision-capability detection for models whose registry metadata
 * does not declare image input support (typical for local/custom providers
 * like LM Studio and Ollama).
 *
 * Layers, cheapest first:
 * 1. LM Studio introspection (`GET {origin}/api/v0/models`, `type === "vlm"`).
 * 2. Ollama introspection (`POST {origin}/api/show`, `capabilities` includes "vision").
 * 3. Canary chat completion with a tiny solid-color image attached — used as a
 *    fallback when introspection is unavailable/inconclusive, and to confirm an
 *    introspection "yes" against the live endpoint (a definitive canary "no"
 *    overrides stale server metadata).
 *
 * Introspection metadata can contradict runtime reality (a server may report
 * `type: "vlm"` and then 400 on actual image input), so an introspection "yes"
 * is confirmed with the canary probe; runtime truth wins. An introspection
 * "no" is trusted as-is (no canary spent). A canary HTTP 404 / "model not
 * found" means the probe targeted a wrong (e.g. aliased) model id, so it
 * yields "unknown", never "no".
 *
 * Everything network-bound goes through an injectable `fetchFn` so tests
 * never hit the network. Only definitive yes/no verdicts are cached on disk;
 * "no" verdicts expire far sooner (see VISION_CACHE_NEGATIVE_TTL_MS).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type VisionVerdict = "yes" | "no" | "unknown";

export type VisionSource = "lmstudio" | "ollama" | "canary";

export interface VisionProbeResult {
	verdict: VisionVerdict;
	source?: VisionSource;
	reason?: string;
}

export interface VisionDetectOptions {
	provider: string;
	baseUrl?: string;
	apiKey?: string;
	modelId: string;
	fetchFn?: typeof fetch;
	canaryTimeoutMs?: number;
}

export interface VisionCacheEntry {
	verdict: "yes" | "no";
	source?: VisionSource;
	at: number;
}

export const VISION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Negative verdicts expire much faster than positive ones. A "no" usually
 * reflects a transient runtime state (vision adapter not loaded yet, server
 * restarted without mmproj) rather than a stable model property, and a stale
 * "no" silently disables a capability the runtime actually has. Re-probing
 * costs one tiny canary request, so the asymmetry is cheap insurance.
 */
export const VISION_CACHE_NEGATIVE_TTL_MS = 15 * 60 * 1000;

/**
 * 8x8 solid teal (#008080) PNG, generated with a tiny zlib script (no external
 * deps). Teal is deliberately uncommon as a one-word color answer.
 */
export const CANARY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEElEQVR4nGNgaGjAjoaWBADiMEABWMSWggAAAABJRU5ErkJggg==";

const CANARY_PROMPT =
	"This is a capability probe. The attached image is filled with a single color. Reply with exactly one word: the color.";

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

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

function isLocalBaseUrl(baseUrl: string): boolean {
	try {
		const host = new URL(baseUrl).hostname.toLowerCase();
		return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
	} catch {
		return /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(baseUrl);
	}
}

type LmStudioModelEntry = { id?: unknown; type?: unknown };

/** Publisher-less basename segment of a model id ("qwen/foo-7b" → "foo-7b"). */
function basenameOf(id: string): string {
	const idx = id.lastIndexOf("/");
	return idx === -1 ? id : id.slice(idx + 1);
}

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

export async function probeLmStudio(options: VisionDetectOptions): Promise<VisionProbeResult> {
	const fetchFn = options.fetchFn ?? fetch;
	if (!options.baseUrl) {
		return { verdict: "unknown", source: "lmstudio", reason: "no baseUrl configured" };
	}
	const origin = baseUrlToOrigin(options.baseUrl);
	let res: Response;
	try {
		res = await fetchFn(`${origin}/api/v0/models`);
	} catch (err) {
		return { verdict: "unknown", source: "lmstudio", reason: `LM Studio API unreachable: ${errMessage(err)}` };
	}
	if (!res.ok) {
		return { verdict: "unknown", source: "lmstudio", reason: `LM Studio API returned HTTP ${res.status}` };
	}
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		return { verdict: "unknown", source: "lmstudio", reason: "LM Studio API returned non-JSON response" };
	}
	const data = (body as { data?: unknown })?.data;
	if (!Array.isArray(data)) {
		return { verdict: "unknown", source: "lmstudio", reason: "unexpected LM Studio models payload" };
	}
	const entries = data as LmStudioModelEntry[];
	const model = findLmStudioModel(entries, options.modelId);
	if (!model) {
		const candidates = entries.map((m) => (typeof m?.id === "string" ? m.id : "")).filter(Boolean);
		return {
			verdict: "unknown",
			source: "lmstudio",
			reason: `model "${options.modelId}" not listed by LM Studio (no exact, suffix, or basename match among: ${candidates.join(", ") || "none"})`,
		};
	}
	if (model.type === "vlm") {
		return { verdict: "yes", source: "lmstudio" };
	}
	return { verdict: "no", source: "lmstudio", reason: `LM Studio reports model type "${String(model.type)}"` };
}

export async function probeOllama(options: VisionDetectOptions): Promise<VisionProbeResult> {
	const fetchFn = options.fetchFn ?? fetch;
	if (!options.baseUrl) {
		return { verdict: "unknown", source: "ollama", reason: "no baseUrl configured" };
	}
	const origin = baseUrlToOrigin(options.baseUrl);
	let res: Response;
	try {
		res = await fetchFn(`${origin}/api/show`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: options.modelId }),
		});
	} catch (err) {
		return { verdict: "unknown", source: "ollama", reason: `Ollama API unreachable: ${errMessage(err)}` };
	}
	if (!res.ok) {
		return { verdict: "unknown", source: "ollama", reason: `Ollama API returned HTTP ${res.status}` };
	}
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		return { verdict: "unknown", source: "ollama", reason: "Ollama API returned non-JSON response" };
	}
	const capabilities = (body as { capabilities?: unknown })?.capabilities;
	if (!Array.isArray(capabilities)) {
		return { verdict: "unknown", source: "ollama", reason: "Ollama response missing capabilities list" };
	}
	if (capabilities.includes("vision")) {
		return { verdict: "yes", source: "ollama" };
	}
	return { verdict: "no", source: "ollama", reason: 'Ollama capabilities do not include "vision"' };
}

function extractAssistantText(payload: unknown): string {
	const choices = (payload as { choices?: unknown })?.choices;
	if (!Array.isArray(choices) || choices.length === 0) return "";
	const content = (choices[0] as { message?: { content?: unknown } })?.message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (typeof (part as { text?: unknown })?.text === "string" ? (part as { text: string }).text : ""))
			.join(" ");
	}
	return "";
}

export async function probeCanary(options: VisionDetectOptions): Promise<VisionProbeResult> {
	const fetchFn = options.fetchFn ?? fetch;
	if (!options.baseUrl) {
		return { verdict: "unknown", source: "canary", reason: "no baseUrl configured" };
	}
	// A text-only endpoint typically errors on image content blocks, so an HTTP
	// error is a solid "no". Matching an uncommon canary color guards against
	// lucky one-word guesses from models that ignore the image.
	const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (options.apiKey) {
		headers.authorization = `Bearer ${options.apiKey}`;
	}
	const body = {
		model: options.modelId,
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: CANARY_PROMPT },
					{ type: "image_url", image_url: { url: `data:image/png;base64,${CANARY_PNG_BASE64}` } },
				],
			},
		],
		// Reasoning models spend tokens on reasoning_content before content; a
		// tiny budget (e.g. 16) gets fully eaten by reasoning, leaving the answer
		// empty and the probe inconclusive. 512 leaves room to think and answer.
		max_tokens: 512,
	};
	let res: Response;
	try {
		res = await fetchFn(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(options.canaryTimeoutMs ?? 30000),
		});
	} catch (err) {
		return { verdict: "unknown", source: "canary", reason: `canary request failed: ${errMessage(err)}` };
	}
	let rawBody = "";
	try {
		rawBody = await res.text();
	} catch {
		// Body unreadable; status-only verdicts below still work.
	}
	if (!res.ok) {
		// A 404 (or a "model not found" body at any status) means the probe
		// targeted a model id the server doesn't have — e.g. a registry alias —
		// which says nothing about the real model's vision capability.
		if (res.status === 404 || /model.*not.*found|does not exist/i.test(rawBody)) {
			return {
				verdict: "unknown",
				source: "canary",
				reason: `canary probe inconclusive: server reports the model id "${options.modelId}" as not found (HTTP ${res.status})`,
			};
		}
		return { verdict: "no", source: "canary", reason: `endpoint rejected image input with HTTP ${res.status}` };
	}
	let payload: unknown;
	try {
		payload = JSON.parse(rawBody);
	} catch {
		return { verdict: "unknown", source: "canary", reason: "canary response was not JSON" };
	}
	const text = extractAssistantText(payload);
	if (!text) {
		return { verdict: "unknown", source: "canary", reason: "canary response missing assistant text" };
	}
	if (/teal/i.test(text)) {
		return { verdict: "yes", source: "canary" };
	}
	return { verdict: "unknown", source: "canary", reason: "canary answer did not identify the canary color" };
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

export async function detectVisionCapability(options: VisionDetectOptions): Promise<VisionProbeResult> {
	const kind = inferIntrospectionKind(options.provider, options.baseUrl);
	let introspection: VisionProbeResult | undefined;
	if (kind === "lmstudio") {
		introspection = await probeLmStudio(options);
	} else if (kind === "ollama") {
		introspection = await probeOllama(options);
	}
	// The canary needs credentials, or a local endpoint that needs no auth.
	const canRunCanary = Boolean(options.apiKey || (options.baseUrl && isLocalBaseUrl(options.baseUrl)));
	if (introspection) {
		// A provider-declared "no" is trusted as-is.
		if (introspection.verdict === "no") {
			return introspection;
		}
		if (introspection.verdict === "yes") {
			// Confirm a declared "yes" with the live canary: server metadata can
			// claim vision while the OpenAI-compatible endpoint actually rejects
			// image content blocks. A definitive canary "no" overrides the
			// declaration; an inconclusive canary does not downgrade it.
			if (!canRunCanary) {
				return introspection;
			}
			const canary = await probeCanary(options);
			if (canary.verdict === "no") {
				return canary;
			}
			if (canary.verdict === "yes") {
				return { verdict: "yes", source: introspection.source, reason: "confirmed by canary probe" };
			}
			return {
				verdict: "yes",
				source: introspection.source,
				reason: `canary confirmation inconclusive: ${canary.reason ?? "no details"}`,
			};
		}
	}
	// Introspection unavailable or inconclusive: run the live canary when we
	// hold credentials, or when the endpoint is local and needs no auth.
	if (canRunCanary) {
		return probeCanary(options);
	}
	return (
		introspection ?? {
			verdict: "unknown",
			reason: "no introspection available and no credentials or local endpoint for canary probe",
		}
	);
}

export function visionCacheKey(provider: string, baseUrl: string | undefined, modelId: string): string {
	return `${provider}|${baseUrl ?? ""}|${modelId}`;
}

export async function readVisionCache(filePath: string): Promise<Record<string, VisionCacheEntry>> {
	try {
		const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		return parsed as Record<string, VisionCacheEntry>;
	} catch {
		// Missing or corrupt cache file: start empty.
		return {};
	}
}

export async function writeVisionCache(filePath: string, cache: Record<string, VisionCacheEntry>): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	// Atomic-ish write: serialize to a sibling temp file, then rename over the target.
	const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmpPath, JSON.stringify(cache, null, 2));
	await rename(tmpPath, filePath);
}

export function getCachedVision(
	cache: Record<string, VisionCacheEntry> | ReadonlyMap<string, VisionCacheEntry>,
	key: string,
	ttlMs: number = VISION_CACHE_TTL_MS,
): VisionCacheEntry | undefined {
	const entry = cache instanceof Map ? cache.get(key) : (cache as Record<string, VisionCacheEntry>)[key];
	if (!entry) return undefined;
	// Only definitive verdicts are ever cached; anything else is treated as absent.
	if (entry.verdict !== "yes" && entry.verdict !== "no") return undefined;
	const effectiveTtlMs = entry.verdict === "no" ? Math.min(ttlMs, VISION_CACHE_NEGATIVE_TTL_MS) : ttlMs;
	if (typeof entry.at !== "number" || Date.now() - entry.at > effectiveTtlMs) return undefined;
	return entry;
}
