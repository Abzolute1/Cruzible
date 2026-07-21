/**
 * Model capability classification.
 *
 * Classification is computed from measured or provider-reported endpoint
 * properties only — never from model-name heuristics (no parameter-count
 * regexes, no curated frontier-model lists). Inputs:
 *
 * - `contextWindow`: registry-declared, possibly refined by the context-length
 *   probe (`model-capability-probe.ts`) which asks the serving provider
 *   (LM Studio / Ollama) for the real loaded context length.
 * - `input`: declared input modalities (image support).
 * - `reasoning`: declared reasoning/budget support.
 * - Provider locality: the provider name or a loopback baseUrl. Locality is a
 *   transport fact, not model identity — it only drives provider-behavior
 *   preferences (XML tool-call fallback, stricter edit schema tolerance),
 *   never capability tiers derived from the model's name or size.
 */

import type { Api, Model } from "@ag1/ai";

export type ModelCapabilityLevel = "high" | "medium" | "low";

export type RecommendedCompactionPolicy = "large" | "standard" | "small" | "local_small";

export interface ModelCapabilityProfile {
	toolCallReliability: ModelCapabilityLevel;
	prefersXmlFallback: boolean;
	maxUsefulToolResultTokens: number;
	maxPlanHorizonSteps: number;
	needsStrictEditSchema: boolean;
	needsShortVerifierOutput: boolean;
	supportsImages: boolean;
	supportsReasoningBudget: boolean;
	recommendedCompactionPolicy: RecommendedCompactionPolicy;
}

export type ModelCapabilityProfileInput = Pick<
	Model<Api>,
	"id" | "provider" | "api" | "baseUrl" | "input" | "reasoning" | "contextWindow"
>;

const LOCAL_PROVIDER_RE = /(lmstudio|lm-studio|ollama|local|vllm|llama\.cpp|kobold|text-generation-webui)/i;

/** Below this the context is genuinely cramped: tool schemas and results compete with the task itself. */
const CRAMPED_CONTEXT_TOKENS = 16384;
/** Below this, tool results and plan horizons stay conservative. */
const MEDIUM_CONTEXT_TOKENS = 65536;
/** Below this, local endpoints get the aggressive local_small hygiene policy. */
const LARGE_CONTEXT_TOKENS = 128000;
/** At or above this, the large-context hygiene policy applies. */
const XL_CONTEXT_TOKENS = 200000;
/** Assumed window when the registry declares no usable value. */
const DEFAULT_CONTEXT_TOKENS = 128000;

function isLocalBaseUrl(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		const host = url.hostname.toLowerCase();
		return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
	} catch {
		return /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(baseUrl);
	}
}

/** Locality is a transport fact: provider name or a loopback/LAN-local baseUrl. */
function isLocalEndpoint(model: ModelCapabilityProfileInput): boolean {
	const provider = String(model.provider).toLowerCase();
	const baseUrl = typeof model.baseUrl === "string" ? model.baseUrl : "";
	return LOCAL_PROVIDER_RE.test(provider) || isLocalBaseUrl(baseUrl);
}

function resolveCompactionPolicy(contextWindow: number, localish: boolean): RecommendedCompactionPolicy {
	if (contextWindow < CRAMPED_CONTEXT_TOKENS) return "local_small";
	if (contextWindow < LARGE_CONTEXT_TOKENS) return localish ? "local_small" : "small";
	if (contextWindow < XL_CONTEXT_TOKENS) return localish ? "small" : "standard";
	return "large";
}

export function inferModelCapabilityProfile(model: ModelCapabilityProfileInput): ModelCapabilityProfile {
	const input = Array.isArray(model.input) ? model.input : ["text"];
	const contextWindow =
		Number.isFinite(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : DEFAULT_CONTEXT_TOKENS;
	const supportsImages = input.includes("image");
	const supportsReasoningBudget = Boolean(model.reasoning);
	const localish = isLocalEndpoint(model);
	const cramped = contextWindow < CRAMPED_CONTEXT_TOKENS;
	const medium = contextWindow < MEDIUM_CONTEXT_TOKENS;

	return {
		toolCallReliability: cramped ? "low" : "medium",
		prefersXmlFallback: localish,
		maxUsefulToolResultTokens: cramped ? 1200 : medium ? 1800 : 2400,
		maxPlanHorizonSteps: cramped ? 2 : medium ? 3 : 4,
		// Local endpoints (OpenAI-compatible shims over gguf/MLX runtimes) need
		// stricter schemas and shorter verifier output regardless of model size —
		// that is provider behavior, not a model-size judgment.
		needsStrictEditSchema: cramped || localish,
		needsShortVerifierOutput: cramped || localish,
		supportsImages,
		supportsReasoningBudget,
		recommendedCompactionPolicy: resolveCompactionPolicy(contextWindow, localish),
	};
}
