export interface InteractiveModelIdentity {
	provider: string;
	id: string;
}

export interface InteractiveScopedModelLike<
	TModel extends InteractiveModelIdentity = InteractiveModelIdentity,
	TThinkingLevel = string,
> {
	model: TModel;
	thinkingLevel?: TThinkingLevel;
}

export function getInteractiveScopedModelId(model: InteractiveModelIdentity): string {
	return `${model.provider}/${model.id}`;
}

export async function deriveInteractiveScopedModelSelection<
	TModel extends InteractiveModelIdentity,
	TThinkingLevel,
>(options: {
	sessionScopedModels: readonly InteractiveScopedModelLike<TModel, TThinkingLevel>[];
	settingsEnabledModels: string[] | undefined;
	resolveModelScope: (patterns: string[]) => Promise<readonly InteractiveScopedModelLike<TModel, TThinkingLevel>[]>;
}): Promise<{
	enabledModelIds: Set<string>;
	hasFilter: boolean;
}> {
	const enabledModelIds = new Set<string>();

	if (options.sessionScopedModels.length > 0) {
		for (const scopedModel of options.sessionScopedModels) {
			enabledModelIds.add(getInteractiveScopedModelId(scopedModel.model));
		}
		return {
			enabledModelIds,
			hasFilter: true,
		};
	}

	const patterns = options.settingsEnabledModels;
	if (patterns !== undefined && patterns.length > 0) {
		const scopedModels = await options.resolveModelScope(patterns);
		for (const scopedModel of scopedModels) {
			enabledModelIds.add(getInteractiveScopedModelId(scopedModel.model));
		}
		return {
			enabledModelIds,
			hasFilter: true,
		};
	}

	return {
		enabledModelIds,
		hasFilter: false,
	};
}

export async function applyInteractiveScopedModelSelection<
	TModel extends InteractiveModelIdentity,
	TThinkingLevel,
>(options: {
	enabledIds: Set<string>;
	allModelCount: number;
	resolveModelScope: (patterns: string[]) => Promise<readonly InteractiveScopedModelLike<TModel, TThinkingLevel>[]>;
	setScopedModels: (models: Array<{ model: TModel; thinkingLevel?: TThinkingLevel }>) => void;
	onUpdated?: () => Promise<void> | void;
}): Promise<void> {
	if (options.enabledIds.size > 0 && options.enabledIds.size < options.allModelCount) {
		const scopedModels = await options.resolveModelScope(Array.from(options.enabledIds));
		options.setScopedModels(
			scopedModels.map((scopedModel) => ({
				model: scopedModel.model,
				thinkingLevel: scopedModel.thinkingLevel,
			})),
		);
	} else {
		options.setScopedModels([]);
	}

	await options.onUpdated?.();
}

export interface InteractiveScopedModelsCallbacks {
	onModelToggle: (modelId: string, enabled: boolean) => Promise<void> | void;
	onPersist: (enabledModelIds: string[]) => void;
	onEnableAll: (allModelIds: string[]) => Promise<void> | void;
	onClearAll: () => Promise<void> | void;
	onToggleProvider: (provider: string, modelIds: string[], enabled: boolean) => Promise<void> | void;
	onCancel: () => void;
}

export function createInteractiveScopedModelsCallbacks(options: {
	currentEnabledIds: Set<string>;
	setCurrentHasFilter: (hasFilter: boolean) => void;
	updateSessionModels: (enabledIds: Set<string>) => Promise<void>;
	allModelCount: number;
	persistEnabledModels: (patterns: string[] | undefined) => void;
	showStatus: (message: string) => void;
	closeSelector: () => void;
}): InteractiveScopedModelsCallbacks {
	return {
		onModelToggle: async (modelId, enabled) => {
			if (enabled) {
				options.currentEnabledIds.add(modelId);
			} else {
				options.currentEnabledIds.delete(modelId);
			}
			options.setCurrentHasFilter(true);
			await options.updateSessionModels(options.currentEnabledIds);
		},
		onEnableAll: async (allModelIds) => {
			options.currentEnabledIds.clear();
			for (const id of allModelIds) {
				options.currentEnabledIds.add(id);
			}
			options.setCurrentHasFilter(false);
			await options.updateSessionModels(options.currentEnabledIds);
		},
		onClearAll: async () => {
			options.currentEnabledIds.clear();
			options.setCurrentHasFilter(true);
			await options.updateSessionModels(options.currentEnabledIds);
		},
		onToggleProvider: async (_provider, modelIds, enabled) => {
			for (const id of modelIds) {
				if (enabled) {
					options.currentEnabledIds.add(id);
				} else {
					options.currentEnabledIds.delete(id);
				}
			}
			options.setCurrentHasFilter(true);
			await options.updateSessionModels(options.currentEnabledIds);
		},
		onPersist: (enabledIds) => {
			const newPatterns = enabledIds.length === options.allModelCount ? undefined : enabledIds;
			options.persistEnabledModels(newPatterns);
			options.showStatus("Model selection saved to settings");
		},
		onCancel: () => {
			options.closeSelector();
		},
	};
}
