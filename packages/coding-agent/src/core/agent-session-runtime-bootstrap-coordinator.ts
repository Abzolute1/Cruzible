import type { AgentTool, ThinkingLevel } from "@ag1/agent-core";
import { type Model, resetApiProviders } from "@ag1/ai";
import type { ExtensionRunner, ToolDefinition } from "./extensions/index.js";
import { ExtensionRunner as ExtensionRunnerImpl } from "./extensions/index.js";
import type { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import type { ToolSafetyPolicy } from "./safety-policy.js";
import type { SessionManager } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";
import { createAllToolDefinitions, isTaskToolDisabled, TASK_SESSION_ENTRY_TYPE } from "./tools/index.js";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.js";

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
	/** Active tool safety policy — inherited by subagents below the task boundary. */
	getToolSafety?: () => ToolSafetyPolicy | undefined;
	/** Parent thinking level — inherited by subagents on reasoning models. */
	getThinkingLevel?: () => ThinkingLevel;
	/** Bubble synthesized subagent evidence into the session's tool-outcome stream. */
	recordToolOutcome?: (outcome: { tool: string; success: boolean; detail?: string }) => void;
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
		const taskDeps = this.shouldEnableTaskTool()
			? {
					cwd,
					modelRegistry: this.options.getModelRegistry(),
					getParentModel: () => this.options.getCurrentModel(),
					getParentThinkingLevel: () => this.options.getThinkingLevel?.(),
					getSafetyPolicy: () => this.options.getToolSafety?.(),
					getBashCommandPrefix: () => settingsManager.getShellCommandPrefix(),
					recordTaskEntry: (data: Record<string, unknown>) => {
						this.options.getSessionManager().appendCustomEntry(TASK_SESSION_ENTRY_TYPE, data);
					},
					recordToolOutcome: (outcome: { tool: string; success: boolean; detail?: string }) =>
						this.options.recordToolOutcome?.(outcome),
				}
			: undefined;
		const baseToolDefinitions = baseToolsOverride
			? Object.fromEntries(
					Object.entries(baseToolsOverride).map(([name, tool]) => [name, createToolDefinitionFromAgentTool(tool)]),
				)
			: createAllToolDefinitions(cwd, {
					read: { autoResizeImages: settingsManager.getImageAutoResize() },
					bash: { commandPrefix: settingsManager.getShellCommandPrefix() },
					...(taskDeps ? { task: taskDeps } : {}),
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
			: ["read", "grep", "find", "ls", "bash", "edit", "write", "webSearch", "webFetch", "todo"];
		if (!baseToolsOverride && "task" in baseToolDefinitions && !isTaskToolDisabled()) {
			defaultActiveToolNames.push("task");
		}
		const activeToolNames = buildOptions.activeToolNames ?? defaultActiveToolNames;
		this.options.refreshToolRegistry({
			activeToolNames,
			includeAllExtensionTools: buildOptions.includeAllExtensionTools,
		});
	}

	/**
	 * Task-tool surface. The `task` (subagent) tool is on by default for every
	 * model: capability gating by model profile was removed — subagent quality
	 * is the model's problem, not a reason to hide delegation. Explicit kill
	 * switches remain: AG1_TASK_TOOL=1 forces on, =0 forces off
	 * (AG1_DISABLE_TASK_TOOL=1 also forces off).
	 */
	private shouldEnableTaskTool(): boolean {
		const forced = process.env.AG1_TASK_TOOL;
		if (forced === "1" || forced?.toLowerCase() === "true") return true;
		if (forced === "0" || forced?.toLowerCase() === "false") return false;
		if (isTaskToolDisabled()) return false;
		return true;
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
