// Auton — Cost Tracker
// Calculates real-time USD cost based on token usage and model pricing.

export interface PricingModel {
	inputPerM: number; // Cost per 1M input tokens
	outputPerM: number; // Cost per 1M output tokens
}

// Default pricing for Qwen models (DashScope intl)
// qwen3.6-plus: $0.50/M input, $3.00/M output
export const QWEN_PRICING: PricingModel = {
	inputPerM: 0.5,
	outputPerM: 3.0,
};

// Pricing for other common models (placeholders)
export const OPENAI_PRICING: PricingModel = { inputPerM: 2.5, outputPerM: 10.0 }; // gpt-4o approx
export const ANTHROPIC_PRICING: PricingModel = { inputPerM: 3.0, outputPerM: 15.0 }; // Sonnet approx

// Free-tier pricing (NVIDIA, local models) — non-zero token tracking but zero cost
export const FREE_PRICING: PricingModel = { inputPerM: 0, outputPerM: 0 };

/**
 * Known pricing entries indexed by model provider or ID prefix.
 * Used by CostTracker to select the right pricing model per-turn.
 */
export const MODEL_PRICING_MAP: Record<string, PricingModel> = {
	nvidia: FREE_PRICING,
	local: FREE_PRICING,
	dashscope: QWEN_PRICING,
	openai: OPENAI_PRICING,
	anthropic: ANTHROPIC_PRICING,
};

export class CostTracker {
	private _totalInputTokens = 0;
	private _totalOutputTokens = 0;
	private _pricing: PricingModel;
	private _pricingMap: Record<string, PricingModel>;
	private _modelId: string;

	constructor(pricing: PricingModel = QWEN_PRICING, modelId?: string, pricingMap?: Record<string, PricingModel>) {
		this._pricing = pricing;
		this._modelId = modelId ?? "";
		this._pricingMap = pricingMap ?? MODEL_PRICING_MAP;
	}

	/** Total input (prompt) tokens consumed. */
	get totalInputTokens(): number {
		return this._totalInputTokens;
	}
	/** Total output (completion) tokens consumed. */
	get totalOutputTokens(): number {
		return this._totalOutputTokens;
	}

	/**
	 * Resolve the pricing model from the current model ID or provider.
	 * Checks the pricing map for exact matches, then prefix matches.
	 */
	private _resolvePricing(): PricingModel {
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
	recordUsage(input: number, output: number): void {
		this._totalInputTokens += input;
		this._totalOutputTokens += output;
	}

	/**
	 * Get current total cost in USD.
	 */
	getTotalCost(): number {
		const pricing = this._resolvePricing();
		const inputCost = (this._totalInputTokens / 1_000_000) * pricing.inputPerM;
		const outputCost = (this._totalOutputTokens / 1_000_000) * pricing.outputPerM;
		return inputCost + outputCost;
	}

	/**
	 * Get summary string for display.
	 */
	getSummary(): string {
		return `$${this.getTotalCost().toFixed(4)} | ${this._totalInputTokens.toLocaleString()} in / ${this._totalOutputTokens.toLocaleString()} out`;
	}
}
