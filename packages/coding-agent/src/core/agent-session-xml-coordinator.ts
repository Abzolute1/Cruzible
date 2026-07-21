import type { AgentTool } from "@ag1/agent-core";
import type { AgentSessionEvent } from "./agent-session.js";
import type { ExtensionRunner, ToolCallEventResult } from "./extensions/index.js";
import type { CustomMessage } from "./messages.js";
import { buildTaggedPromptSection } from "./prompt-sections.js";
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
		prompt: (messages: any[]) => Promise<void>;
		continue: () => Promise<void>;
	};
	sessionManager: SessionManager;
	getActiveToolNames: () => string[];
	getTool: (name: string) => AgentTool | undefined;
	getExtensionRunner: () => ExtensionRunner | undefined;
	evaluateToolSafety: (
		toolName: string,
		args: Record<string, unknown>,
	) => Promise<{ block: boolean; reason: string } | undefined>;
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
	private xmlToolCallIteration = 0;
	private readonly maxXmlToolCallIterations = 3;
	private readonly processedAssistantTurnKeys = new Set<string>();
	private toolAbortController: AbortController | undefined = undefined;

	constructor(private readonly options: AgentSessionXmlCoordinatorOptions) {}

	/** Abort any in-flight XML-fallback tool execution. */
	abort(): void {
		this.toolAbortController?.abort();
	}

	resetForPrompt(): void {
		this.xmlToolCallIteration = 0;
		this.processedAssistantTurnKeys.clear();
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
				assistantStopReason:
					typeof lastAssistantMsg.stopReason === "string" ? lastAssistantMsg.stopReason : undefined,
				assistantTextLength: textContent.length,
				severity: xmlAnalysis.severity,
				reasons: xmlAnalysis.reasons,
				continuationMode: xmlAnalysis.continuationMode,
			});
		}

		const recoveryPrompt = buildXmlFallbackRecoveryPrompt(xmlAnalysis, {
			toolNames: xmlCalls.map((xmlCall) => xmlCall.name),
		});
		if (recoveryPrompt) {
			this.appendRecoveryMessage(recoveryPrompt);
		}
		await this.options.agentState.continue();
		await this.options.waitForRetry();

		await this.process();
	}

	/**
	 * Recovery guidance rides the turn tail as a hidden user-context message
	 * (never the system prompt), so the session system prompt stays byte-stable
	 * across XML recovery runs and provider prefix caching is not invalidated.
	 */
	private appendRecoveryMessage(recoveryPrompt: string): void {
		const message: CustomMessage = {
			role: "custom",
			customType: "xml-tool-recovery",
			content: buildTaggedPromptSection("xml-tool-recovery", recoveryPrompt),
			display: false,
			details: undefined,
			timestamp: Date.now(),
		};
		const messages = this.options.agentState.getMessages();
		messages.push(message);
		this.options.agentState.setMessages(messages);
		this.options.sessionManager.appendMessage(message);
	}

	private async processSingleCall(xmlCall: XmlToolCall, activeToolNames: string[]): Promise<void> {
		const tool = this.options.getTool(xmlCall.name);
		const extensionRunner = this.options.getExtensionRunner();

		if (extensionRunner?.hasHandlers("tool_call")) {
			let extensionResult: ToolCallEventResult | undefined;
			try {
				extensionResult = await extensionRunner.emitToolCall({
					type: "tool_call",
					toolName: xmlCall.name,
					toolCallId: xmlCall.id,
					input: xmlCall.arguments as Record<string, unknown>,
				});
			} catch (error) {
				// Tolerate extension failures so one bad handler does not kill the
				// XML fallback loop, but log them instead of silently swallowing.
				console.error(`[XmlCoordinator] Extension tool_call handler failed for '${xmlCall.name}':`, error);
			}
			if (extensionResult?.block) {
				// Honor extension blocks the same way the structured path does:
				// record an error tool result instead of executing.
				await this.appendToolResult(
					xmlCall,
					{
						content: [
							{ type: "text" as const, text: extensionResult.reason ?? `Tool call blocked by extension` },
						],
						details: undefined,
					},
					true,
				);
				return;
			}
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
			? (tool.prepareArguments(xmlCall.arguments) as Record<string, unknown>)
			: (xmlCall.arguments as Record<string, unknown>);
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

		this.toolAbortController = new AbortController();
		try {
			const result = await tool.execute(xmlCall.id, preparedArguments as any, this.toolAbortController.signal);
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
		} finally {
			this.toolAbortController = undefined;
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
