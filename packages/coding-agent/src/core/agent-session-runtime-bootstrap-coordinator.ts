import type { AgentTool } from "@ag1/agent-core";
import type { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import type { SessionManager } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";
import { createAllToolDefinitions } from "./tools/index.js";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.js";
import type { ExtensionRunner, ToolDefinition } from "./extensions/index.js";
import { ExtensionRunner as ExtensionRunnerImpl } from "./extensions/index.js";
import { resetApiProviders, type Model } from "@ag1/ai";

export interface AgentSessionRuntimeBootstrapCoordinatorOptions {
	getCwd: () => string;
	getSessionManager: () => SessionManager;
	getSettingsManager: () => SettingsManager;
	getResourceLoader: () => ResourceLoader;
	getModelRegistry: () => ModelRegistry;
	getBaseToolsOverride: () => Record<string, AgentTool> | undefined;
	getCustomTools: () => ToolDefinition[];
	getExtensionRunnerRef: () => { current?: ExtensionRunner } | undefined;
	getActiveToolNames: () => string[];
	bindExtensionCore: (runner: ExtensionRunner) => void;
	applyExtensionBindings: (runner: ExtensionRunner) => void;
	refreshToolRegistry: (options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }) => void;
	setBaseToolDefinitions: (definitions: Map<string, ToolDefinition>) => void;
	setExtensionRunner: (runner: ExtensionRunner | undefined) => void;
	getCurrentModel: () => Model<any> | undefined;
	setCurrentModel: (model: Model<any>) => void;
}

export class AgentSessionRuntimeBootstrapCoordinator {
	constructor(private readonly options: AgentSessionRuntimeBootstrapCoordinatorOptions) {}

	refreshCurrentModelFromRegistry(): void {
		const currentModel = this.options.getCurrentModel();
		if (!currentModel) {
			return;
		}

		const refreshedModel = this.options.getModelRegistry().find(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.options.setCurrentModel(refreshedModel);
	}

	buildRuntime(buildOptions: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const settingsManager = this.options.getSettingsManager();
		const cwd = this.options.getCwd();
		const baseToolsOverride = this.options.getBaseToolsOverride();
		const baseToolDefinitions = baseToolsOverride
			? Object.fromEntries(
					Object.entries(baseToolsOverride).map(([name, tool]) => [name, createToolDefinitionFromAgentTool(tool)]),
				)
			: createAllToolDefinitions(cwd, {
					read: { autoResizeImages: settingsManager.getImageAutoResize() },
					bash: { commandPrefix: settingsManager.getShellCommandPrefix() },
				});

		this.options.setBaseToolDefinitions(
			new Map(Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition])),
		);

		const resourceLoader = this.options.getResourceLoader();
		const extensionsResult = resourceLoader.getExtensions();
		if (buildOptions.flagValues) {
			for (const [name, value] of buildOptions.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		const hasExtensions = extensionsResult.extensions.length > 0;
		const hasCustomTools = this.options.getCustomTools().length > 0;
		const runner =
			hasExtensions || hasCustomTools
				? new ExtensionRunnerImpl(
						extensionsResult.extensions,
						extensionsResult.runtime,
						cwd,
						this.options.getSessionManager(),
						this.options.getModelRegistry(),
					)
				: undefined;

		this.options.setExtensionRunner(runner);
		const runnerRef = this.options.getExtensionRunnerRef();
		if (runnerRef) {
			runnerRef.current = runner;
		}

		if (runner) {
			this.options.bindExtensionCore(runner);
			this.options.applyExtensionBindings(runner);
		}

		const defaultActiveToolNames = baseToolsOverride
			? Object.keys(baseToolsOverride)
			: ["read", "grep", "find", "ls", "bash", "edit", "write", "webSearch", "webFetch"];
		const activeToolNames = buildOptions.activeToolNames ?? defaultActiveToolNames;
		this.options.refreshToolRegistry({
			activeToolNames,
			includeAllExtensionTools: buildOptions.includeAllExtensionTools,
		});
	}

	async reload(): Promise<{ hadBindings: boolean; extensionRunner: ExtensionRunner | undefined }> {
		const previousFlagValues = this.options.getExtensionRunnerRef()?.current?.getFlagValues();
		await this.options.getExtensionRunnerRef()?.current?.emit({ type: "session_shutdown" });
		await this.options.getSettingsManager().reload();
		resetApiProviders();
		await this.options.getResourceLoader().reload();
		this.buildRuntime({
			activeToolNames: this.options.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});
		return {
			hadBindings: Boolean(this.options.getExtensionRunnerRef()?.current),
			extensionRunner: this.options.getExtensionRunnerRef()?.current,
		};
	}
}
