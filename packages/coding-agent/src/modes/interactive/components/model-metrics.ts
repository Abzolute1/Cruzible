import type { Model } from "@ag1/ai";

type ModelCost = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
};

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatTokenMetric(label: string, count: number): string {
	return `${label} ${formatTokens(count)}`;
}

function getModelCost(model: Pick<Model<any>, "cost">): ModelCost | undefined {
	return model.cost;
}

function hasConfiguredPricing(model: Pick<Model<any>, "cost">): boolean {
	const cost = getModelCost(model);
	if (!cost) return false;
	return cost.input > 0 || cost.output > 0 || cost.cacheRead > 0 || cost.cacheWrite > 0;
}

function formatUsdPerMillion(value: number): string {
	return `$${value.toFixed(2)}`;
}

export function formatCompactModelPricing(model: Pick<Model<any>, "cost">): string | null {
	if (!hasConfiguredPricing(model)) return null;
	const cost = getModelCost(model)!;
	return `${formatUsdPerMillion(cost.input)}/${formatUsdPerMillion(cost.output)}`;
}

export function formatModelPricingDetails(model: Pick<Model<any>, "cost">): string[] {
	if (!hasConfiguredPricing(model)) return [];
	const cost = getModelCost(model)!;
	const lines = [`Pricing: ${formatUsdPerMillion(cost.input)} in / ${formatUsdPerMillion(cost.output)} out per 1M`];
	const cacheParts: string[] = [];
	if (cost.cacheRead > 0) cacheParts.push(`${formatUsdPerMillion(cost.cacheRead)} cache read`);
	if (cost.cacheWrite > 0) cacheParts.push(`${formatUsdPerMillion(cost.cacheWrite)} cache write`);
	if (cacheParts.length > 0) {
		lines.push(`Cache: ${cacheParts.join(" / ")} per 1M`);
	}
	return lines;
}
