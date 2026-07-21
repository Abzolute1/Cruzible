import type { AgentTool } from "@ag1/agent-core";
import type { Model } from "@ag1/ai";
import type { ExtensionRunner, ToolDefinition } from "./extensions/index.js";
import { wrapRegisteredTools } from "./extensions/index.js";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.js";
import { wrapToolDefinition } from "./tools/tool-definition-wrapper.js";
import { createInteractThenScreenshotToolDefinition, createScreenshotUrlToolDefinition } from "./tools/visual/index.js";
import { createVerifyUiToolDefinition } from "./tools/visual/verify-ui.js";
import { modelSupportsVision } from "./tools/visual/vision.js";

export interface ToolDefinitionEntryState {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

export interface AgentSessionToolRegistryCoordinatorOptions {
	getModel: () => Model<any> | undefined;
	/** Independent reviewer model for verify_ui's judge; falls back to getModel when unset or unresolvable. */
	getVerifierModel?: () => Model<any> | undefined;
	/** "auto" (default): visual tools only when the model declares vision; "on": force-enable; "off": disable. */
	getVisualToolsMode?: () => "auto" | "on" | "off";
	/** Probed vision verdict, layered over registry metadata in "auto" mode. */
	getVisionVerdict?: (model: Model<any>) => "yes" | "no" | undefined;
	getExtensionRunner: () => ExtensionRunner | undefined;
	getBaseToolDefinitions: () => Map<string, ToolDefinition>;
	getCustomTools: () => ToolDefinition[];
	getCurrentToolRegistryNames: () => string[];
	getCurrentActiveToolNames: () => string[];
	normalizePromptSnippet: (text: string | undefined) => string | undefined;
	normalizePromptGuidelines: (guidelines: string[] | undefined) => string[];
	setState: (state: {
		toolDefinitions: Map<string, ToolDefinitionEntryState>;
		toolPromptSnippets: Map<string, string>;
		toolPromptGuidelines: Map<string, string[]>;
		toolRegistry: Map<string, AgentTool>;
	}) => void;
	applyActiveToolNames: (toolNames: string[]) => void;
}

export class AgentSessionToolRegistryCoordinator {
	constructor(private readonly options: AgentSessionToolRegistryCoordinatorOptions) {}

	refresh(refreshOptions?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		const previousRegistryNames = new Set(this.options.getCurrentToolRegistryNames());
		const previousActiveToolNames = this.options.getCurrentActiveToolNames();
		const extensionRunner = this.options.getExtensionRunner();
		const registeredTools = extensionRunner?.getAllRegisteredTools() ?? [];

		const visualToolDefinitions = this.getVisualToolDefinitions();
		const extensionTools = registeredTools;
		const standaloneCustomTools = [
			...this.options.getCustomTools().map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
			...visualToolDefinitions.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<visual:${definition.name}>`, { source: "visual" }),
			})),
		];

		const definitionRegistry = new Map<string, ToolDefinitionEntryState>(
			Array.from(this.options.getBaseToolDefinitions().entries()).map(([name, definition]) => [
				name,
				{
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
				},
			]),
		);
		for (const tool of [...extensionTools, ...standaloneCustomTools]) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}

		const toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this.options.normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);

		const toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this.options.normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);

		const wrappedExtensionTools = extensionRunner ? wrapRegisteredTools(extensionTools, extensionRunner) : [];
		const wrappedStandaloneTools = standaloneCustomTools.map((tool) => wrapToolDefinition(tool.definition));
		const toolRegistry = new Map(
			Array.from(this.options.getBaseToolDefinitions().values()).map((definition) => [
				definition.name,
				wrapToolDefinition(definition),
			]),
		);
		for (const tool of wrappedStandaloneTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}

		this.options.setState({
			toolDefinitions: definitionRegistry,
			toolPromptSnippets,
			toolPromptGuidelines,
			toolRegistry,
		});

		const nextActiveToolNames = refreshOptions?.activeToolNames
			? [...refreshOptions.activeToolNames]
			: [...previousActiveToolNames];

		for (const tool of wrappedStandaloneTools) {
			nextActiveToolNames.push(tool.name);
		}

		if (refreshOptions?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!refreshOptions?.activeToolNames) {
			for (const toolName of toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		this.options.applyActiveToolNames([...new Set(nextActiveToolNames)]);
	}

	private getVisualToolDefinitions(): ToolDefinition<any, any>[] {
		const mode = this.options.getVisualToolsMode?.() ?? "auto";
		if (mode === "off") return [];

		const model = this.options.getModel();
		if (mode === "auto") {
			// A probed verdict wins over registry metadata in both directions;
			// without one, fall back to declared metadata.
			const verdict = model ? this.options.getVisionVerdict?.(model) : undefined;
			if (verdict === "no") return [];
			if (verdict !== "yes" && (!model || !modelSupportsVision(model))) return [];
		}

		return [
			createScreenshotUrlToolDefinition() as ToolDefinition<any, any>,
			createInteractThenScreenshotToolDefinition() as ToolDefinition<any, any>,
			createVerifyUiToolDefinition({
				getJudgeModel: () => this.options.getVerifierModel?.() ?? this.options.getModel(),
			}) as ToolDefinition<any, any>,
		];
	}
}
