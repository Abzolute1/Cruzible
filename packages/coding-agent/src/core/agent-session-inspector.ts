import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentState, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { theme } from "../modes/interactive/theme/theme.js";
import {
	calculateContextTokens,
	estimateContextTokens,
	estimateTokens,
} from "./compaction/index.js";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.js";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.js";
import type { ContextUsage, ToolDefinition } from "./extensions/index.js";
import { CURRENT_SESSION_VERSION, getLatestCompactionEntry, type SessionHeader, type SessionManager } from "./session-manager.js";

export interface AgentSessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

export function buildAgentSessionStats(options: {
	state: AgentState;
	sessionFile: string | undefined;
	sessionId: string;
	contextUsage: ContextUsage | undefined;
}): AgentSessionStats {
	const userMessages = options.state.messages.filter((m) => m.role === "user").length;
	const assistantMessages = options.state.messages.filter((m) => m.role === "assistant").length;
	const toolResults = options.state.messages.filter((m) => m.role === "toolResult").length;

	let toolCalls = 0;
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;

	for (const message of options.state.messages) {
		if (message.role !== "assistant") continue;
		const assistantMsg = message as AssistantMessage;
		toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
		totalInput += assistantMsg.usage.input;
		totalOutput += assistantMsg.usage.output;
		totalCacheRead += assistantMsg.usage.cacheRead;
		totalCacheWrite += assistantMsg.usage.cacheWrite;
		totalCost += assistantMsg.usage.cost.total;
	}

	return {
		sessionFile: options.sessionFile,
		sessionId: options.sessionId,
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults,
		totalMessages: options.state.messages.length,
		tokens: {
			input: totalInput,
			output: totalOutput,
			cacheRead: totalCacheRead,
			cacheWrite: totalCacheWrite,
			total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
		},
		cost: totalCost,
		contextUsage: options.contextUsage,
	};
}

export function deriveAgentSessionContextUsage(options: {
	contextWindow: number | undefined;
	messages: AgentState["messages"];
	sessionManager: SessionManager;
}): ContextUsage | undefined {
	const contextWindow = options.contextWindow;
	if (!contextWindow || contextWindow <= 0) return undefined;

	const branchEntries = options.sessionManager.getBranch();
	const latestCompaction = getLatestCompactionEntry(branchEntries);

	if (latestCompaction) {
		const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
		let hasPostCompactionUsage = false;
		for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
			const entry = branchEntries[i];
			if (entry.type === "message" && entry.message.role === "assistant") {
				const assistant = entry.message;
				if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
					const contextTokens = calculateContextTokens(assistant.usage);
					if (contextTokens > 0) {
						hasPostCompactionUsage = true;
					}
					break;
				}
			}
		}

		if (!hasPostCompactionUsage) {
			const estimatedTokens = options.messages.reduce((total, message) => total + estimateTokens(message), 0);
			return {
				tokens: estimatedTokens,
				contextWindow,
				percent: (estimatedTokens / contextWindow) * 100,
				estimated: true,
			};
		}
	}

	const estimate = estimateContextTokens(options.messages);
	return {
		tokens: estimate.tokens,
		contextWindow,
		percent: (estimate.tokens / contextWindow) * 100,
		estimated: estimate.lastUsageIndex === null,
	};
}

export async function exportAgentSessionHtml(options: {
	sessionManager: SessionManager;
	state: AgentState;
	outputPath?: string;
	themeName: string;
	getToolDefinition: (name: string) => ToolDefinition | undefined;
	cwd: string;
}): Promise<string> {
	const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
		getToolDefinition: (name) => options.getToolDefinition(name),
		theme,
		cwd: options.cwd,
	});

	return exportSessionToHtml(options.sessionManager, options.state, {
		outputPath: options.outputPath,
		themeName: options.themeName,
		toolRenderer,
	});
}

export function exportAgentSessionJsonl(options: {
	sessionManager: SessionManager;
	outputPath?: string;
}): string {
	const filePath = resolve(options.outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: options.sessionManager.getSessionId(),
		timestamp: new Date().toISOString(),
		cwd: options.sessionManager.getCwd(),
	};

	const branchEntries = options.sessionManager.getBranch();
	const lines = [JSON.stringify(header)];
	let prevId: string | null = null;
	for (const entry of branchEntries) {
		const linear = { ...entry, parentId: prevId };
		lines.push(JSON.stringify(linear));
		prevId = entry.id;
	}

	writeFileSync(filePath, `${lines.join("\n")}\n`);
	return filePath;
}

export function getLastAgentAssistantText(messages: AgentState["messages"]): string | undefined {
	const lastAssistant = messages
		.slice()
		.reverse()
		.find((m) => {
			if (m.role !== "assistant") return false;
			const msg = m as AssistantMessage;
			if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
			return true;
		});

	if (!lastAssistant) return undefined;

	let text = "";
	for (const content of (lastAssistant as AssistantMessage).content) {
		if (content.type === "text") {
			text += content.text;
		}
	}

	return text.trim() || undefined;
}
