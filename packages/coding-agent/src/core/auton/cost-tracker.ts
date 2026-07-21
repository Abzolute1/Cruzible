// Auton — Cost Tracker
// Calculates real-time USD cost based on token usage and model pricing.

import type { Model } from "@ag1/ai";

export interface PricingModel {
	inputPerM: number; // Cost per 1M input tokens
	outputPerM: number; // Cost per 1M output tokens
	cacheReadPerM?: number; // Cost per 1M cache-read tokens
	cacheWritePerM?: number; // Cost per 1M cache-write tokens
	/** True only when pricing is accurate enough to act as a hard-stop budget. */
	authoritative?: boolean;
}

export interface CostSummary {
	totalCost: number;
	authoritative: boolean;
}

// Default pricing for Qwen models (DashScope intl)
// qwen3.6-plus: $0.50/M input, $3.00/M output
export const QWEN_PRICING: PricingModel = {
	inputPerM: 0.5,
	outputPerM: 3.0,
	cacheReadPerM: 0,
	cacheWritePerM: 0,
	authoritative: false,
};

// Pricing for other common models (placeholders)
export const OPENAI_PRICING: PricingModel = {
	inputPerM: 2.5,
	outputPerM: 10.0,
	cacheReadPerM: 1.25,
	cacheWritePerM: 0,
	authoritative: false,
}; // gpt-4o approx
export const ANTHROPIC_PRICING: PricingModel = {
	inputPerM: 3.0,
	outputPerM: 15.0,
	cacheReadPerM: 0.3,
	cacheWritePerM: 3.75,
	authoritative: false,
}; // Sonnet approx

// Free-tier pricing (NVIDIA, local models) — non-zero token tracking but zero cost
export const FREE_PRICING: PricingModel = { inputPerM: 0, outputPerM: 0, authoritative: false };

/**
 * Known pricing entries indexed by model provider or ID prefix.
 * Used by CostTracker to select the right pricing model per-turn.
 */
export const MODEL_PRICING_MAP: Record<string, PricingModel> = {
	nvidia: FREE_PRICING,
	"nvidia-nim": FREE_PRICING,
	local: FREE_PRICING,
	dashscope: QWEN_PRICING,
	openai: OPENAI_PRICING,
	anthropic: ANTHROPIC_PRICING,
};

export class CostTracker {
	private _totalInputTokens = 0;
	private _totalOutputTokens = 0;
	private _totalCacheReadTokens = 0;
	private _totalCacheWriteTokens = 0;
	private _pricing: PricingModel;
	private _pricingMap: Record<string, PricingModel>;
	private _modelId: string;
	private _authoritative: boolean;
	private _declaredPricing: PricingModel | undefined;

	constructor(
		pricing: PricingModel = QWEN_PRICING,
		modelId?: string,
		pricingMap?: Record<string, PricingModel>,
		authoritative: boolean = false,
	) {
		this._pricing = pricing;
		this._modelId = modelId ?? "";
		this._pricingMap = pricingMap ?? MODEL_PRICING_MAP;
		this._authoritative = authoritative;
	}

	/**
	 * Apply a model's own declared cost metadata (from the provider registry).
	 * Declared per-model rates are the prices the provider actually bills at,
	 * and the usage they multiply comes from API responses — accurate enough
	 * to hard-stop a budget, so they resolve as authoritative. All-zero rates
	 * (local/free models) resolve as a non-authoritative zero estimate.
	 */
	setDeclaredModelCost(cost: Model<any>["cost"] | undefined): void {
		if (!cost) return;
		const hasRate = cost.input > 0 || cost.output > 0;
		this._declaredPricing = {
			inputPerM: cost.input,
			outputPerM: cost.output,
			cacheReadPerM: cost.cacheRead,
			cacheWritePerM: cost.cacheWrite,
			authoritative: hasRate,
		};
	}

	/** Total input (prompt) tokens consumed. */
	get totalInputTokens(): number {
		return this._totalInputTokens;
	}
	/** Total output (completion) tokens consumed. */
	get totalOutputTokens(): number {
		return this._totalOutputTokens;
	}
	get totalCacheReadTokens(): number {
		return this._totalCacheReadTokens;
	}
	get totalCacheWriteTokens(): number {
		return this._totalCacheWriteTokens;
	}

	get isAuthoritative(): boolean {
		return this._authoritative || this._resolvePricing().authoritative === true;
	}

	/**
	 * Resolve the pricing model: the model's own declared cost first, then the
	 * pricing map by model ID prefix, then the constructor fallback.
	 */
	private _resolvePricing(): PricingModel {
		if (this._declaredPricing) {
			return this._declaredPricing;
		}
		const id = this._modelId.toLowerCase();

		// Exact match (e.g., "nvidia/nemotron-3-super-120b-a12b")
		for (const [key, pricing] of Object.entries(this._pricingMap)) {
			if (id === key || id.startsWith(`${key}/`)) {
				return pricing;
			}
		}

		// Fallback to constructor pricing
		return this._pricing;
	}

	/**
	 * Record token usage from a turn.
	 */
	recordUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): void {
		this._totalInputTokens += input;
		this._totalOutputTokens += output;
		this._totalCacheReadTokens += cacheRead;
		this._totalCacheWriteTokens += cacheWrite;
	}

	/**
	 * Get current total cost in USD.
	 */
	getTotalCost(): number {
		const pricing = this._resolvePricing();
		const inputCost = (this._totalInputTokens / 1_000_000) * pricing.inputPerM;
		const outputCost = (this._totalOutputTokens / 1_000_000) * pricing.outputPerM;
		const cacheReadCost = (this._totalCacheReadTokens / 1_000_000) * (pricing.cacheReadPerM ?? 0);
		const cacheWriteCost = (this._totalCacheWriteTokens / 1_000_000) * (pricing.cacheWritePerM ?? 0);
		return inputCost + outputCost + cacheReadCost + cacheWriteCost;
	}

	getCostSummary(): CostSummary {
		return {
			totalCost: this.getTotalCost(),
			authoritative: this.isAuthoritative,
		};
	}

	/**
	 * Get summary string for display.
	 */
	getSummary(): string {
		const suffix = this.isAuthoritative ? "" : " (estimate)";
		const parts = [
			`${this._totalInputTokens.toLocaleString()} in`,
			`${this._totalOutputTokens.toLocaleString()} out`,
		];
		if (this._totalCacheReadTokens > 0) parts.push(`${this._totalCacheReadTokens.toLocaleString()} cache-read`);
		if (this._totalCacheWriteTokens > 0) parts.push(`${this._totalCacheWriteTokens.toLocaleString()} cache-write`);
		return `$${this.getTotalCost().toFixed(4)}${suffix} | ${parts.join(" / ")}`;
	}
}
