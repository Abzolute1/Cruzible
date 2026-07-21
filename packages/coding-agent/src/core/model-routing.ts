import type { Model } from "@ag1/ai";

export type CheapModelTask = "summarization" | "title" | "direct_lookup" | "duplicate_detection";

export interface CheapModelRoute {
	model: Model<any>;
	reason: "current_is_cheapest" | "cheaper_available" | "no_eligible_cheaper_model";
}

export interface SelectCheapModelOptions {
	task: CheapModelTask;
	currentModel: Model<any>;
	candidates: Model<any>[];
	minContextWindow?: number;
	minMaxTokens?: number;
}

const TASK_DEFAULTS: Record<CheapModelTask, { minContextWindow: number; minMaxTokens: number }> = {
	summarization: { minContextWindow: 32_768, minMaxTokens: 2_048 },
	title: { minContextWindow: 8_192, minMaxTokens: 512 },
	direct_lookup: { minContextWindow: 16_384, minMaxTokens: 1_024 },
	duplicate_detection: { minContextWindow: 8_192, minMaxTokens: 512 },
};

export function selectCheapModelForTask(options: SelectCheapModelOptions): CheapModelRoute {
	const defaults = TASK_DEFAULTS[options.task];
	const minContextWindow = options.minContextWindow ?? defaults.minContextWindow;
	const minMaxTokens = options.minMaxTokens ?? defaults.minMaxTokens;
	const candidates = uniqueModels([options.currentModel, ...options.candidates]).filter((model) =>
		isEligibleCheapTaskModel(model, minContextWindow, minMaxTokens),
	);
	if (candidates.length === 0) {
		return { model: options.currentModel, reason: "no_eligible_cheaper_model" };
	}

	const sorted = candidates.sort(compareModelCost);
	const cheapest = sorted[0] ?? options.currentModel;
	if (sameModel(cheapest, options.currentModel)) {
		return { model: options.currentModel, reason: "current_is_cheapest" };
	}

	if (estimatedBlendedCost(cheapest) < estimatedBlendedCost(options.currentModel)) {
		return { model: cheapest, reason: "cheaper_available" };
	}
	return { model: options.currentModel, reason: "no_eligible_cheaper_model" };
}

function isEligibleCheapTaskModel(model: Model<any>, minContextWindow: number, minMaxTokens: number): boolean {
	if (!model.input?.includes("text")) return false;
	if ((model.contextWindow ?? 0) < minContextWindow) return false;
	if ((model.maxTokens ?? 0) < minMaxTokens) return false;
	return true;
}

function uniqueModels(models: Model<any>[]): Model<any>[] {
	const seen = new Set<string>();
	const unique: Model<any>[] = [];
	for (const model of models) {
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(model);
	}
	return unique;
}

function compareModelCost(left: Model<any>, right: Model<any>): number {
	return (
		estimatedBlendedCost(left) - estimatedBlendedCost(right) ||
		(left.reasoning === right.reasoning ? 0 : left.reasoning ? 1 : -1) ||
		`${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`)
	);
}

function estimatedBlendedCost(model: Model<any>): number {
	if (model.provider === "local") return 0;
	const cost = model.cost;
	return cost.input + cost.output + Math.min(cost.cacheRead, cost.input) + Math.min(cost.cacheWrite, cost.input);
}

function sameModel(left: Model<any>, right: Model<any>): boolean {
	return left.provider === right.provider && left.id === right.id;
}
