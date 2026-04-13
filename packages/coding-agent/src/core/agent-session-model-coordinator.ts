import type { Agent, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { modelsAreEqual, supportsXhigh } from "@mariozechner/pi-ai";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import type { ExtensionRunner } from "./extensions/index.js";
import type { ModelRegistry } from "./model-registry.js";
import type { SessionManager } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
const THINKING_LEVELS_WITH_XHIGH: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export interface AgentSessionModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	isScoped: boolean;
}

export class AgentSessionModelCoordinator {
	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	constructor(
		private readonly options: {
			agent: Agent;
			sessionManager: SessionManager;
			settingsManager: SettingsManager;
			modelRegistry: ModelRegistry;
			getExtensionRunner: () => ExtensionRunner | undefined;
			initialScopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
		},
	) {
		this._scopedModels = options.initialScopedModels ?? [];
	}

	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	get thinkingLevel(): ThinkingLevel {
		return this.options.agent.state.thinkingLevel;
	}

	get model(): Model<any> | undefined {
		return this.options.agent.state.model;
	}

	async setModel(model: Model<any>): Promise<void> {
		if (!this.options.modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.options.agent.state.model = model;
		this.options.sessionManager.appendModelChange(model.provider, model.id);
		this.options.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		this.setThinkingLevel(thinkingLevel);
		await this._emitModelSelect(model, previousModel, "set");
	}

	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<AgentSessionModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction);
		}
		return this._cycleAvailableModel(direction);
	}

	setThinkingLevel(level: ThinkingLevel): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);
		const isChanging = effectiveLevel !== this.options.agent.state.thinkingLevel;
		this.options.agent.state.thinkingLevel = effectiveLevel;

		if (isChanging) {
			this.options.sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (this.supportsThinking() || effectiveLevel !== "off") {
				this.options.settingsManager.setDefaultThinkingLevel(effectiveLevel);
			}
		}
	}

	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.supportsThinking()) return ["off"];
		return this.supportsXhighThinking() ? THINKING_LEVELS_WITH_XHIGH : THINKING_LEVELS;
	}

	supportsXhighThinking(): boolean {
		return this.model ? supportsXhigh(this.model) : false;
	}

	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		const runner = this.options.getExtensionRunner();
		if (!runner) return;
		if (modelsAreEqual(previousModel, nextModel)) return;
		await runner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	private async _cycleScopedModel(
		direction: "forward" | "backward",
	): Promise<AgentSessionModelCycleResult | undefined> {
		const scopedModels = this._scopedModels.filter((scoped) => this.options.modelRegistry.hasConfiguredAuth(scoped.model));
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));
		if (currentIndex === -1) currentIndex = 0;

		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);

		this.options.agent.state.model = next.model;
		this.options.sessionManager.appendModelChange(next.model.provider, next.model.id);
		this.options.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(next.model, currentModel, "cycle");
		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(
		direction: "forward" | "backward",
	): Promise<AgentSessionModelCycleResult | undefined> {
		const availableModels = await this.options.modelRegistry.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));
		if (currentIndex === -1) currentIndex = 0;

		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.options.agent.state.model = nextModel;
		this.options.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		this.options.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(nextModel, currentModel, "cycle");
		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	private _getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		if (!this.supportsThinking()) {
			return this.options.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		}
		return this.thinkingLevel;
	}

	private _clampThinkingLevel(level: ThinkingLevel, availableLevels: ThinkingLevel[]): ThinkingLevel {
		const ordered = THINKING_LEVELS_WITH_XHIGH;
		const available = new Set(availableLevels);
		const requestedIndex = ordered.indexOf(level);
		if (requestedIndex === -1) {
			return availableLevels[0] ?? "off";
		}
		for (let i = requestedIndex; i < ordered.length; i++) {
			const candidate = ordered[i];
			if (available.has(candidate)) return candidate;
		}
		for (let i = requestedIndex - 1; i >= 0; i--) {
			const candidate = ordered[i];
			if (available.has(candidate)) return candidate;
		}
		return availableLevels[0] ?? "off";
	}
}
