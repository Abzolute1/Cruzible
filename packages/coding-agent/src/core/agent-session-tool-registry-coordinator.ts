import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionRunner, ToolDefinition } from "./extensions/index.js";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.js";
import { wrapRegisteredTools } from "./extensions/index.js";
import { wrapToolDefinition } from "./tools/tool-definition-wrapper.js";
import {
	createInteractThenScreenshotToolDefinition,
	createScreenshotUrlToolDefinition,
} from "./tools/visual/index.js";

export interface ToolDefinitionEntryState {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

export interface AgentSessionToolRegistryCoordinatorOptions {
	getModel: () => Model<any> | undefined;
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
		const model = this.options.getModel();
		if (!model || !AgentSessionToolRegistryCoordinator.modelSupportsVision(model)) {
			return [];
		}

		return [
			createScreenshotUrlToolDefinition() as ToolDefinition<any, any>,
			createInteractThenScreenshotToolDefinition() as ToolDefinition<any, any>,
		];
	}

	private static modelSupportsVision(model: Model<any>): boolean {
		const inputTypes = (model.input ?? []) as string[];
		if (inputTypes.includes("image") || inputTypes.includes("image_url") || inputTypes.includes("vision")) {
			return true;
		}

		const capabilities = (model as any).capabilities;
		if (Array.isArray(capabilities) && capabilities.includes("vision")) return true;
		if (capabilities?.vision === true) return true;

		return false;
	}
}
