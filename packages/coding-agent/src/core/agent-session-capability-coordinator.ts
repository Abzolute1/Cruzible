import { join } from "node:path";
import type { Model } from "@ag1/ai";
import { getAgentDir } from "../config.js";
import {
	CONTEXT_LENGTH_CACHE_TTL_MS,
	type ContextLengthCacheEntry,
	contextLengthCacheKey,
	detectContextLength,
	getCachedContextLength,
	readContextLengthCache,
	writeContextLengthCache,
} from "./model-capability-probe.js";
import type { ModelRegistry } from "./model-registry.js";
import { modelSupportsVision } from "./tools/visual/vision.js";
import {
	detectVisionCapability,
	getCachedVision,
	readVisionCache,
	VISION_CACHE_TTL_MS,
	type VisionCacheEntry,
	visionCacheKey,
	writeVisionCache,
} from "./vision-capability.js";

export interface AgentSessionCapabilityCoordinatorOptions {
	/** Active model (also the in-memory model a probed context length is applied to). */
	getModel: () => Model<any> | undefined;
	/** "auto" (default): visual tools gated on probed vision capability; anything else skips probing. */
	getVisualToolsMode: () => "auto" | "on" | "off";
	getApiKeyAndHeaders: ModelRegistry["getApiKeyAndHeaders"];
	/** Rebuild the tool registry so a fresh verdict surfaces (or keeps hiding) visual tools. */
	refreshToolRegistry: () => void;
}

export class AgentSessionCapabilityCoordinator {
	/** Probed vision verdicts (layered over registry metadata), persisted to disk. */
	private _visionVerdicts = new Map<string, VisionCacheEntry>();
	private _visionCacheLoaded = false;
	private _visionProbesInFlight = new Map<string, Promise<void>>();
	/** Provider-reported context lengths (layered over registry metadata), persisted to disk. */
	private _contextLengths = new Map<string, ContextLengthCacheEntry>();
	private _contextLengthCacheLoaded = false;
	private _contextLengthProbesInFlight = new Set<string>();

	constructor(private readonly options: AgentSessionCapabilityCoordinatorOptions) {}

	getVisionVerdict(model: Model<any>): "yes" | "no" | undefined {
		const key = visionCacheKey(model.provider, model.baseUrl ?? "", model.id);
		return getCachedVision(this._visionVerdicts, key, VISION_CACHE_TTL_MS)?.verdict;
	}

	private _visionCachePath(): string {
		return join(getAgentDir(), "vision-cache.json");
	}

	private async _ensureVisionCacheLoaded(): Promise<void> {
		if (this._visionCacheLoaded) return;
		this._visionCacheLoaded = true;
		const cache = await readVisionCache(this._visionCachePath());
		for (const [key, entry] of Object.entries(cache)) {
			this._visionVerdicts.set(key, entry);
		}
	}

	private async _persistVisionCache(): Promise<void> {
		try {
			await writeVisionCache(this._visionCachePath(), Object.fromEntries(this._visionVerdicts));
		} catch {
			// Best effort — a lost cache only means re-probing.
		}
	}

	/**
	 * Probe the provider for the model's vision capability (LM Studio model
	 * type, Ollama capabilities, canary-image fallback). Returns the probe
	 * promise so callers can either fire-and-forget (model switch: tools appear
	 * mid-session on a "yes") or await it before the first generation —
	 * see ensureVisionCapabilityResolved.
	 */
	resolveVisionCapability(model: Model<any>): Promise<void> {
		if (this.options.getVisualToolsMode() !== "auto") return Promise.resolve();
		if (modelSupportsVision(model)) return Promise.resolve(); // declared metadata already enables the tools
		if (this.getVisionVerdict(model) !== undefined) return Promise.resolve();
		const key = visionCacheKey(model.provider, model.baseUrl ?? "", model.id);
		const inFlight = this._visionProbesInFlight.get(key);
		if (inFlight) return inFlight;
		const probe = (async () => {
			try {
				await this._ensureVisionCacheLoaded();
				const cached = getCachedVision(this._visionVerdicts, key, VISION_CACHE_TTL_MS);
				if (cached) {
					if (cached.verdict === "yes") this.options.refreshToolRegistry();
					return;
				}
				const auth = await this.options.getApiKeyAndHeaders(model);
				const result = await detectVisionCapability({
					provider: model.provider,
					baseUrl: model.baseUrl,
					apiKey: auth.ok ? auth.apiKey : undefined,
					modelId: model.id,
				});
				if (result.verdict === "unknown") return;
				this._visionVerdicts.set(key, { verdict: result.verdict, source: result.source, at: Date.now() });
				await this._persistVisionCache();
				this.options.refreshToolRegistry();
			} catch {
				// Detection is best-effort; never break model selection.
			}
		})().finally(() => {
			this._visionProbesInFlight.delete(key);
		});
		this._visionProbesInFlight.set(key, probe);
		return probe;
	}

	async ensureVisionCapabilityResolved(): Promise<void> {
		const model = this.options.getModel();
		if (!model) return;
		if (this.options.getVisualToolsMode() !== "auto") return;
		if (modelSupportsVision(model)) return;
		if (this.getVisionVerdict(model) !== undefined) return;
		await this.resolveVisionCapability(model);
	}

	private _contextLengthCachePath(): string {
		return join(getAgentDir(), "context-length-cache.json");
	}

	private async _ensureContextLengthCacheLoaded(): Promise<void> {
		if (this._contextLengthCacheLoaded) return;
		this._contextLengthCacheLoaded = true;
		const cache = await readContextLengthCache(this._contextLengthCachePath());
		for (const [key, entry] of Object.entries(cache)) {
			this._contextLengths.set(key, entry);
		}
	}

	private async _persistContextLengthCache(): Promise<void> {
		try {
			await writeContextLengthCache(this._contextLengthCachePath(), Object.fromEntries(this._contextLengths));
		} catch {
			// Best effort — a lost cache only means re-probing.
		}
	}

	/**
	 * Probe the provider for the model's real context length (LM Studio loaded
	 * context, Ollama model_info). Registry `contextWindow` values are static
	 * declarations and can under- or over-state reality; capability
	 * classification and context-usage accounting read `model.contextWindow`,
	 * so when a provider-reported value arrives the in-memory model is updated
	 * and the value is persisted. Runs async after model selection; a fresh
	 * cache hit short-circuits probing. Best-effort: never throws, never blocks.
	 */
	async resolveContextLength(model: Model<any>): Promise<void> {
		const key = contextLengthCacheKey(model.provider, model.baseUrl ?? "", model.id);
		if (this._contextLengthProbesInFlight.has(key)) return;
		this._contextLengthProbesInFlight.add(key);
		try {
			await this._ensureContextLengthCacheLoaded();
			const cached = getCachedContextLength(
				Object.fromEntries(this._contextLengths),
				key,
				CONTEXT_LENGTH_CACHE_TTL_MS,
			);
			if (cached) {
				this._applyProbedContextLength(model, cached.contextLength);
				return;
			}
			const detected = await detectContextLength({
				provider: model.provider,
				baseUrl: model.baseUrl,
				modelId: model.id,
			});
			if (detected === undefined) return;
			this._contextLengths.set(key, { contextLength: detected, at: Date.now() });
			await this._persistContextLengthCache();
			this._applyProbedContextLength(model, detected);
		} catch {
			// Detection is best-effort; never break model selection.
		} finally {
			this._contextLengthProbesInFlight.delete(key);
		}
	}

	/** Update the in-memory model's contextWindow if the probed value differs. */
	private _applyProbedContextLength(model: Model<any>, contextLength: number): void {
		const current = this.options.getModel();
		if (!current || current.id !== model.id || current.provider !== model.provider) return;
		if (current.contextWindow === contextLength) return;
		current.contextWindow = contextLength;
	}
}
