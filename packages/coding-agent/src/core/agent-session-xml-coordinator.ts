import type { AgentTool } from "@ag1/agent-core";
import type { AgentSessionEvent } from "./agent-session.js";
import type { ExtensionRunner } from "./extensions/index.js";
import { appendResearchArtifactFromToolResult } from "./research-artifacts.js";
import type { SessionManager } from "./session-manager.js";
import {
	analyzeXmlFallbackTurn,
	buildXmlFallbackRecoveryPrompt,
	parseXmlToolCalls,
	type XmlToolCall,
} from "./xml-tool-parser.js";

export interface AgentSessionXmlCoordinatorOptions {
	agentState: {
		getMessages: () => any[];
		setMessages: (messages: any[]) => void;
		getSystemPrompt: () => string;
		setSystemPrompt: (prompt: string) => void;
		prompt: (messages: any[]) => Promise<void>;
		continue: () => Promise<void>;
	};
	sessionManager: SessionManager;
	getActiveToolNames: () => string[];
	getTool: (name: string) => AgentTool | undefined;
	getExtensionRunner: () => ExtensionRunner | undefined;
	evaluateToolSafety: (toolName: string, args: Record<string, unknown>) => Promise<{ block: boolean; reason: string } | undefined>;
	noteToolResult?: (observation: {
		toolName: string;
		args: Record<string, unknown>;
		result?: unknown;
		isError: boolean;
	}) => void;
	emit: (event: AgentSessionEvent) => void;
	waitForRetry: () => Promise<void>;
}

export class AgentSessionXmlCoordinator {
	private structuredToolCallCountThisPrompt = 0;
	private xmlToolCallIteration = 0;
	private readonly maxXmlToolCallIterations = 3;
	private readonly processedAssistantTurnKeys = new Set<string>();

	constructor(private readonly options: AgentSessionXmlCoordinatorOptions) {}

	resetForPrompt(): void {
		this.structuredToolCallCountThisPrompt = 0;
		this.xmlToolCallIteration = 0;
		this.processedAssistantTurnKeys.clear();
	}

	noteStructuredToolCall(): void {
		this.structuredToolCallCountThisPrompt++;
	}

	async process(): Promise<void> {
		if (this.xmlToolCallIteration >= this.maxXmlToolCallIterations) return;

		const messages = this.options.agentState.getMessages();
		let lastAssistantMsg: any = null;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "assistant") {
				lastAssistantMsg = messages[i];
				break;
			}
		}
		if (!lastAssistantMsg) return;

		let textContent = "";
		const content = lastAssistantMsg.content;
		if (typeof content === "string") {
			textContent = content;
		} else if (Array.isArray(content)) {
			textContent = content
				.filter((c: any) => c.type === "text" || c.type === "thinking")
				.map((c: any) => (c.type === "thinking" ? c.thinking || "" : c.text || ""))
				.join("\n");
		}
		if (!textContent.trim()) return;
		const assistantTurnKey = `${String((lastAssistantMsg as { timestamp?: unknown }).timestamp ?? "")}:${textContent}`;
		if (this.processedAssistantTurnKeys.has(assistantTurnKey)) return;

		const activeToolNames = this.options.getActiveToolNames();
		const xmlCalls = parseXmlToolCalls(textContent, activeToolNames);
		if (xmlCalls.length === 0) return;
		this.processedAssistantTurnKeys.add(assistantTurnKey);

		const xmlAnalysis = analyzeXmlFallbackTurn({
			callCount: xmlCalls.length,
			assistantTextLength: textContent.length,
			assistantStopReason: typeof lastAssistantMsg.stopReason === "string" ? lastAssistantMsg.stopReason : undefined,
			iteration: this.xmlToolCallIteration,
		});

		this.xmlToolCallIteration++;
		for (const xmlCall of xmlCalls) {
			await this.processSingleCall(xmlCall, activeToolNames);
		}

		for (const xmlCall of xmlCalls) {
			this.options.emit({
				type: "xml_tool_call",
				toolName: xmlCall.name,
				arguments: xmlCall.arguments as Record<string, unknown>,
				iteration: this.xmlToolCallIteration,
				callCount: xmlCalls.length,
				assistantStopReason: typeof lastAssistantMsg.stopReason === "string" ? lastAssistantMsg.stopReason : undefined,
				assistantTextLength: textContent.length,
				severity: xmlAnalysis.severity,
				reasons: xmlAnalysis.reasons,
				continuationMode: xmlAnalysis.continuationMode,
			});
		}

		const previousSystemPrompt = this.options.agentState.getSystemPrompt();
		const recoveryPrompt = buildXmlFallbackRecoveryPrompt(xmlAnalysis, {
			toolNames: xmlCalls.map((xmlCall) => xmlCall.name),
		});
		if (recoveryPrompt) {
			this.options.agentState.setSystemPrompt(`${previousSystemPrompt}\n\n${recoveryPrompt}`);
		}
		this.structuredToolCallCountThisPrompt = 0;
		try {
			await this.options.agentState.continue();
			await this.options.waitForRetry();
		} finally {
			if (recoveryPrompt) {
				this.options.agentState.setSystemPrompt(previousSystemPrompt);
			}
		}

		await this.process();
	}

	private async processSingleCall(xmlCall: XmlToolCall, activeToolNames: string[]): Promise<void> {
		const tool = this.options.getTool(xmlCall.name);
		const extensionRunner = this.options.getExtensionRunner();

		if (extensionRunner?.hasHandlers("tool_call")) {
			await extensionRunner
				.emitToolCall({
					type: "tool_call",
					toolName: xmlCall.name,
					toolCallId: xmlCall.id,
					input: xmlCall.arguments as Record<string, unknown>,
				})
				.catch(() => {});
		}

		if (!tool) {
			await this.appendToolResult(
				xmlCall,
				{
					content: [
						{
							type: "text" as const,
							text: `Tool '${xmlCall.name}' is not available. Available tools: ${activeToolNames.join(", ")}`,
						},
					],
					details: undefined,
				},
				true,
			);
			return;
		}

		const preparedArguments = tool.prepareArguments
			? tool.prepareArguments(xmlCall.arguments) as Record<string, unknown>
			: xmlCall.arguments as Record<string, unknown>;
		const safetyBlock = await this.options.evaluateToolSafety(xmlCall.name, preparedArguments);
		if (safetyBlock) {
			await this.appendToolResult(
				xmlCall,
				{
					content: [{ type: "text", text: safetyBlock.reason }],
					details: undefined,
				},
				true,
			);
			return;
		}

		try {
			const result = await tool.execute(xmlCall.id, preparedArguments as any, undefined);
			if (extensionRunner?.hasHandlers("tool_result")) {
				await extensionRunner
					.emitToolResult({
						type: "tool_result",
						toolName: xmlCall.name,
						toolCallId: xmlCall.id,
						input: preparedArguments,
						content: result.content,
						details: result.details,
						isError: false,
					})
					.catch(() => {});
			}
			this.options.noteToolResult?.({
				toolName: xmlCall.name,
				args: preparedArguments,
				result,
				isError: false,
			});
			await this.appendToolResult(xmlCall, result, false, preparedArguments);
		} catch (error) {
			const errorResult = {
				content: [
					{
						type: "text" as const,
						text: `Error executing '${xmlCall.name}': ${error instanceof Error ? error.message : String(error)}`,
					},
				],
				details: undefined,
			};

			if (extensionRunner?.hasHandlers("tool_result")) {
				await extensionRunner
					.emitToolResult({
						type: "tool_result",
						toolName: xmlCall.name,
						toolCallId: xmlCall.id,
						input: xmlCall.arguments as Record<string, unknown>,
						content: errorResult.content,
						details: undefined,
						isError: true,
					})
					.catch(() => {});
			}

			this.options.noteToolResult?.({
				toolName: xmlCall.name,
				args: preparedArguments,
				result: errorResult,
				isError: true,
			});
			await this.appendToolResult(xmlCall, errorResult, true, preparedArguments);
		}
	}

	private async appendToolResult(
		xmlCall: XmlToolCall,
		result: { content: any[]; details?: any },
		isError: boolean,
		args: Record<string, unknown> = xmlCall.arguments as Record<string, unknown>,
	): Promise<void> {
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: xmlCall.id,
			toolName: xmlCall.name,
			content: result.content,
			details: result.details,
			isError,
			timestamp: Date.now(),
		};

		this.options.emit({
			type: "tool_execution_start",
			toolCallId: xmlCall.id,
			toolName: xmlCall.name,
			args,
		});

		this.options.emit({
			type: "tool_execution_end",
			toolCallId: xmlCall.id,
			toolName: xmlCall.name,
			result: { content: result.content, details: result.details },
			isError,
		});

		if (!isError) {
			appendResearchArtifactFromToolResult(this.options.sessionManager, xmlCall.name, result.details);
		}

		const messages = this.options.agentState.getMessages();
		messages.push(toolResult as any);
		this.options.agentState.setMessages(messages);
		this.options.sessionManager.appendMessage(toolResult as any);
	}
}
