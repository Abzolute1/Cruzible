import { join } from "node:path";
import type { AgentMessage } from "@ag1/agent-core";
import type { AssistantMessage, ImageContent, Model, TextContent } from "@ag1/ai";
import { getDocsPath } from "../config.js";
import { appendTaggedPromptSection } from "./prompt-sections.js";
import type { AgentSessionEvent } from "./agent-session.js";
import type { ExtensionRunner, InputSource } from "./extensions/index.js";
import type { CustomMessage } from "./messages.js";

export interface AgentSessionPromptOptions {
	expandPromptTemplates?: boolean;
	images?: ImageContent[];
	streamingBehavior?: "steer" | "followUp";
	source?: InputSource;
	systemPromptAddendum?: string;
}

export interface AgentSessionPromptCoordinatorOptions {
	agentState: {
		isStreaming: () => boolean;
		prompt: (messages: AgentMessage[]) => Promise<void>;
		setSystemPrompt: (prompt: string) => void;
	};
	getModel: () => Model<any> | undefined;
	hasConfiguredAuth: (model: Model<any>) => boolean;
	isUsingOAuth: (model: Model<any>) => boolean;
	getExtensionRunner: () => ExtensionRunner | undefined;
	flushPendingBashMessages: () => void;
	findLastAssistantMessage: () => AssistantMessage | undefined;
	checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<void>;
	takePendingNextTurnMessages: () => CustomMessage[];
	checkToolFailures: () => {
		message: CustomMessage | undefined;
		warnings: Array<{ toolName: string; failureCount: number; correctiveMessage: string }>;
	};
	emit: (event: AgentSessionEvent) => void;
	getBaseSystemPrompt: () => string;
	tryExecuteExtensionCommand: (text: string) => Promise<boolean>;
	expandPromptText: (text: string) => string;
	queueSteer: (text: string, images?: ImageContent[]) => Promise<void>;
	queueFollowUp: (text: string, images?: ImageContent[]) => Promise<void>;
	resetXmlPromptState: () => void;
	waitForRetry: () => Promise<void>;
	waitForEventLoop: () => Promise<void>;
	processXmlToolCalls: () => Promise<void>;
}

export class AgentSessionPromptCoordinator {
	constructor(private readonly options: AgentSessionPromptCoordinatorOptions) {}

	async prompt(text: string, promptOptions?: AgentSessionPromptOptions): Promise<void> {
		const expandPromptTemplates = promptOptions?.expandPromptTemplates ?? true;

		if (expandPromptTemplates && text.startsWith("/")) {
			const handled = await this.options.tryExecuteExtensionCommand(text);
			if (handled) {
				return;
			}
		}

		let currentText = text;
		let currentImages = promptOptions?.images;
		const extensionRunner = this.options.getExtensionRunner();
		if (extensionRunner?.hasHandlers("input")) {
			const inputResult = await extensionRunner.emitInput(
				currentText,
				currentImages,
				promptOptions?.source ?? "interactive",
			);
			if (inputResult.action === "handled") {
				return;
			}
			if (inputResult.action === "transform") {
				currentText = inputResult.text;
				currentImages = inputResult.images ?? currentImages;
			}
		}

		const expandedText = expandPromptTemplates ? this.options.expandPromptText(currentText) : currentText;

		if (this.options.agentState.isStreaming()) {
			if (!promptOptions?.streamingBehavior) {
				throw new Error(
					"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
				);
			}
			if (promptOptions.streamingBehavior === "followUp") {
				await this.options.queueFollowUp(expandedText, currentImages);
			} else {
				await this.options.queueSteer(expandedText, currentImages);
			}
			return;
		}

		this.options.flushPendingBashMessages();
		this.ensureModelReady();

		const lastAssistant = this.options.findLastAssistantMessage();
		if (lastAssistant) {
			await this.options.checkCompaction(lastAssistant, false);
		}

		const messages = this.buildPromptMessages(expandedText, currentImages);
		await this.applyBeforeAgentStart(messages, expandedText, currentImages, promptOptions?.systemPromptAddendum);

		this.options.resetXmlPromptState();
		await this.options.agentState.prompt(messages);
		await this.options.waitForRetry();
		await this.options.waitForEventLoop();
		await this.options.processXmlToolCalls();
	}

	private ensureModelReady(): void {
		const model = this.options.getModel();
		if (!model) {
			throw new Error(
				"No model selected.\n\n" +
					`Use /login or set an API key environment variable. See ${join(getDocsPath(), "providers.md")}\n\n` +
					"Then use /model to select a model.",
			);
		}

		if (this.options.hasConfiguredAuth(model)) {
			return;
		}

		if (this.options.isUsingOAuth(model)) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}

		throw new Error(
			`No API key found for ${model.provider}.\n\n` +
				`Use /login or set an API key environment variable. See ${join(getDocsPath(), "providers.md")}`,
		);
	}

	private buildPromptMessages(text: string, images?: ImageContent[]): AgentMessage[] {
		const messages: AgentMessage[] = [];
		const userContent: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			userContent.push(...images);
		}
		messages.push({
			role: "user",
			content: userContent,
			timestamp: Date.now(),
		});

		for (const message of this.options.takePendingNextTurnMessages()) {
			messages.push(message);
		}

		const toolFailureGuidance = this.options.checkToolFailures();
		if (toolFailureGuidance.message) {
			messages.push(toolFailureGuidance.message);
			for (const warning of toolFailureGuidance.warnings) {
				this.options.emit({
					type: "tool_failure_warning",
					toolName: warning.toolName,
					failureCount: warning.failureCount,
					correctiveMessage: warning.correctiveMessage,
				});
			}
		}

		return messages;
	}

	private async applyBeforeAgentStart(
		messages: AgentMessage[],
		text: string,
		images?: ImageContent[],
		systemPromptAddendum?: string,
	): Promise<void> {
		const extensionRunner = this.options.getExtensionRunner();
		const baseSystemPrompt = this.options.getBaseSystemPrompt();
		const effectiveSystemPrompt = appendTaggedPromptSection(
			baseSystemPrompt,
			"session-runtime-addendum",
			systemPromptAddendum,
		);
		if (!extensionRunner) {
			this.options.agentState.setSystemPrompt(effectiveSystemPrompt);
			return;
		}

		const result = await extensionRunner.emitBeforeAgentStart(text, images, effectiveSystemPrompt);
		if (result?.messages) {
			for (const message of result.messages) {
				messages.push({
					role: "custom",
					customType: message.customType,
					content: message.content,
					display: message.display,
					details: message.details,
					timestamp: Date.now(),
				});
			}
		}

		this.options.agentState.setSystemPrompt(result?.systemPrompt ?? effectiveSystemPrompt);
	}
}
