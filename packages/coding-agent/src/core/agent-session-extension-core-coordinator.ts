import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type { CustomMessage } from "./messages.js";
import type { ModelRegistry } from "./model-registry.js";
import type { SlashCommandInfo } from "./slash-commands.js";
import type { CompactOptions, ContextUsage, ExtensionRunner, ToolInfo } from "./extensions/index.js";

export interface AgentSessionExtensionCoreCoordinatorOptions {
	runner: ExtensionRunner;
	modelRegistry: ModelRegistry;
	getCommands: () => SlashCommandInfo[];
	sendCustomMessage: (
		message: Pick<CustomMessage<unknown>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	) => Promise<void>;
	sendUserMessage: (
		content: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>,
		options?: { deliverAs?: "steer" | "followUp" },
	) => Promise<void>;
	appendEntry: (customType: string, data: unknown) => void;
	setSessionName: (name: string) => void;
	getSessionName: () => string | undefined;
	setLabel: (entryId: string, label: string | undefined) => void;
	getActiveTools: () => string[];
	getAllTools: () => ToolInfo[];
	setActiveTools: (toolNames: string[]) => void;
	refreshTools: () => void;
	setModel: (model: Model<any>) => Promise<void>;
	getThinkingLevel: () => ThinkingLevel;
	setThinkingLevel: (level: ThinkingLevel) => void;
	getModel: () => Model<any> | undefined;
	isIdle: () => boolean;
	getSignal: () => AbortSignal | undefined;
	abort: () => void;
	hasPendingMessages: () => boolean;
	shutdown: () => void;
	getContextUsage: () => ContextUsage | undefined;
	compact: (options?: CompactOptions) => void;
	getSystemPrompt: () => string;
	refreshCurrentModelFromRegistry: () => void;
}

export class AgentSessionExtensionCoreCoordinator {
	constructor(private readonly options: AgentSessionExtensionCoreCoordinatorOptions) {}

	bind(): void {
		const runner = this.options.runner;
		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.options.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.options.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					this.options.appendEntry(customType, data);
				},
				setSessionName: (name) => {
					this.options.setSessionName(name);
				},
				getSessionName: () => this.options.getSessionName() ?? "",
				setLabel: (entryId, label) => {
					this.options.setLabel(entryId, label);
				},
				getActiveTools: () => this.options.getActiveTools(),
				getAllTools: () => this.options.getAllTools(),
				setActiveTools: (toolNames) => this.options.setActiveTools(toolNames),
				refreshTools: () => this.options.refreshTools(),
				getCommands: () => this.options.getCommands(),
				setModel: async (model) => {
					if (!this.options.modelRegistry.hasConfiguredAuth(model)) return false;
					await this.options.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.options.getThinkingLevel(),
				setThinkingLevel: (level) => this.options.setThinkingLevel(level),
			},
			{
				getModel: () => this.options.getModel(),
				isIdle: () => this.options.isIdle(),
				getSignal: () => this.options.getSignal(),
				abort: () => this.options.abort(),
				hasPendingMessages: () => this.options.hasPendingMessages(),
				shutdown: () => {
					this.options.shutdown();
				},
				getContextUsage: () => this.options.getContextUsage(),
				compact: (options) => {
					this.options.compact(options);
				},
				getSystemPrompt: () => this.options.getSystemPrompt(),
			},
			{
				registerProvider: (name, config) => {
					this.options.modelRegistry.registerProvider(name, config);
					this.options.refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this.options.modelRegistry.unregisterProvider(name);
					this.options.refreshCurrentModelFromRegistry();
				},
			},
		);
	}
}
