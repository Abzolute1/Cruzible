/**
 * Layer 1: Micro-compact — truncate old compactable tool results.
 *
 * Zero-cost operation (pure string manipulation, no API calls).
 * Prevents stale 50KB tool outputs from consuming context budget.
 */

import type { AgentMessage } from "@ag1/agent-core";
import type { AssistantMessage } from "@ag1/ai";

/** Tools whose results are reproducible and safe to truncate. */
const COMPACTABLE_TOOLS = new Set<string>([
	"read",
	"bash",
	"grep",
	"glob",
	"webSearch",
	"webFetch",
	"cat",
	"ls",
	"find",
]);

/** Keep this many most recent turns untouched. */
const DEFAULT_KEEP_TURNS = 6;
const DEFAULT_LIVE_CONTEXT_KEEP_TURNS = 3;
const DEFAULT_LIVE_CONTEXT_MAX_TOOL_RESULT_CHARS = 220;
const DEFAULT_LIVE_CONTEXT_MAX_HIDDEN_CUSTOM_CHARS = 180;
const LIVE_POST_TOOL_CONTINUATION_TRIGGER_CHARS = 500;

/** Truncate tool results longer than this to this many characters. */
const MAX_TOOL_RESULT_CHARS = 500;

/** Preview length for truncated tool result display. */
const PREVIEW_CHARS = 120;
const OLDER_IMAGE_PLACEHOLDER = "[older image attachment omitted to preserve context]";
const OLDER_ATTACHMENT_PLACEHOLDER = "[older non-text attachment omitted to preserve context]";
const OLDER_THINKING_PLACEHOLDER = "[older reasoning omitted to preserve context]";
const OLDER_HIDDEN_CUSTOM_PLACEHOLDER = "[older hidden runtime message omitted to preserve context]";
const POST_TOOL_CONTINUATION_CUSTOM_TYPE = "post_tool_continuation_state";

export interface ContextHygieneOptions {
	keepTurns?: number;
	maxToolResultChars?: number;
	maxHiddenCustomChars?: number;
}

function resolveContextHygieneOptions(
	options: number | ContextHygieneOptions | undefined,
): Required<ContextHygieneOptions> {
	if (typeof options === "number") {
		return {
			keepTurns: options,
			maxToolResultChars: DEFAULT_LIVE_CONTEXT_MAX_TOOL_RESULT_CHARS,
			maxHiddenCustomChars: DEFAULT_LIVE_CONTEXT_MAX_HIDDEN_CUSTOM_CHARS,
		};
	}
	return {
		keepTurns: options?.keepTurns ?? DEFAULT_LIVE_CONTEXT_KEEP_TURNS,
		maxToolResultChars: options?.maxToolResultChars ?? DEFAULT_LIVE_CONTEXT_MAX_TOOL_RESULT_CHARS,
		maxHiddenCustomChars: options?.maxHiddenCustomChars ?? DEFAULT_LIVE_CONTEXT_MAX_HIDDEN_CUSTOM_CHARS,
	};
}

/**
 * Extract tool name from an assistant message's tool call by tool_result index.
 *
 * The tool_result message has an index property that corresponds to the position
 * of the tool_call in the preceding assistant message's content array.
 */
function getToolNameFromAssistant(assistantMsg: AgentMessage, toolResultIndex: number): string | undefined {
	if (assistantMsg.role !== "assistant") return undefined;
	const assistant = assistantMsg as AssistantMessage;
	if (!Array.isArray(assistant.content)) return undefined;

	// Find the toolCall block at the given index among toolCall blocks
	let toolCallIdx = 0;
	for (const block of assistant.content) {
		if (block.type === "toolCall" && "name" in block) {
			if (toolCallIdx === toolResultIndex) {
				return block.name;
			}
			toolCallIdx++;
		}
	}
	return undefined;
}

/**
 * Get the text content from a tool_result message.
 */
function getToolResultContent(msg: AgentMessage): string {
	if (msg.role !== "toolResult") return "";
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		return msg.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");
	}
	return "";
}

/**
 * Set the text content of a tool_result message.
 */
function setToolResultContent(msg: AgentMessage, newText: string): void {
	if (msg.role !== "toolResult") return;
	if (typeof msg.content === "string") {
		(msg as any).content = newText;
	} else if (Array.isArray(msg.content)) {
		for (const block of msg.content) {
			if (block.type === "text") {
				block.text = newText;
				break;
			}
		}
	}
}

function collectProtectedIndices(messages: AgentMessage[], keepTurns: number): Set<number> {
	const protectedIndices = new Set<number>();
	let userTurnsFound = 0;

	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "user") continue;
		userTurnsFound++;
		if (userTurnsFound <= keepTurns) {
			for (let j = i; j < messages.length; j++) {
				protectedIndices.add(j);
			}
			continue;
		}
		break;
	}

	return protectedIndices;
}

function getToolNameForResult(messages: AgentMessage[], toolResultIndex: number): string | undefined {
	for (let j = toolResultIndex - 1; j >= 0; j--) {
		if (messages[j].role === "assistant") {
			let toolResultOffset = 0;
			for (let k = j + 1; k < toolResultIndex; k++) {
				if (messages[k].role === "toolResult") {
					toolResultOffset++;
				}
			}
			return getToolNameFromAssistant(messages[j], toolResultOffset);
		}
		if (messages[j].role === "user") break;
	}
	return undefined;
}

function truncateToolResult(toolName: string, content: string): string {
	const preview = content.slice(0, PREVIEW_CHARS).replace(/\n/g, " ");
	const originalLength = content.length;
	return `[truncated] ${toolName} result: ${preview}... [original was ${originalLength} chars]`;
}

function getOlderAttachmentPlaceholder(msg: AgentMessage): string {
	if (
		(msg.role === "user" || msg.role === "custom" || msg.role === "toolResult") &&
		Array.isArray(msg.content) &&
		msg.content.some((block) => block.type === "image")
	) {
		return OLDER_IMAGE_PLACEHOLDER;
	}
	return OLDER_ATTACHMENT_PLACEHOLDER;
}

function hasNonTextAttachmentBlocks(msg: AgentMessage): boolean {
	return (
		(msg.role === "user" || msg.role === "custom" || msg.role === "toolResult") &&
		Array.isArray(msg.content) &&
		msg.content.some((block) => block.type !== "text")
	);
}

function getMessageTextContent(msg: AgentMessage): string {
	if (msg.role !== "user" && msg.role !== "custom" && msg.role !== "toolResult") return "";
	if (typeof msg.content === "string") return msg.content;
	if (!Array.isArray(msg.content)) return "";
	return msg.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function buildCompactToolResultText(
	toolName: string | undefined,
	content: string,
	stripAttachments: boolean,
	attachmentPlaceholder: string,
	shouldCompactText: boolean,
): string {
	let nextText = shouldCompactText && toolName ? truncateToolResult(toolName, content) : content;
	if (stripAttachments) {
		nextText = nextText.trim() ? `${nextText}\n\n${attachmentPlaceholder}` : attachmentPlaceholder;
	}
	return nextText;
}

function cloneMessageWithTextOnly(msg: AgentMessage, text: string): AgentMessage {
	if (msg.role === "toolResult" || msg.role === "user" || msg.role === "custom") {
		return {
			...msg,
			content: [{ type: "text", text }],
		};
	}
	return msg;
}

function hasThinkingBlocks(msg: AgentMessage): boolean {
	return msg.role === "assistant" && msg.content.some((block) => block.type === "thinking");
}

function cloneAssistantWithoutThinking(msg: AgentMessage): AgentMessage {
	if (msg.role !== "assistant") return msg;
	const filteredContent = msg.content.filter((block) => block.type !== "thinking");
	if (filteredContent.length > 0) {
		return { ...msg, content: filteredContent };
	}
	return {
		...msg,
		content: [{ type: "text", text: OLDER_THINKING_PLACEHOLDER }],
	};
}

function getHiddenCustomPlaceholder(msg: AgentMessage): string {
	if (msg.role !== "custom") return OLDER_HIDDEN_CUSTOM_PLACEHOLDER;
	if (msg.customType === "runtime_continuation_state") {
		return "[older hidden continuation state omitted to preserve context]";
	}
	if (msg.customType === POST_TOOL_CONTINUATION_CUSTOM_TYPE) {
		return "[older hidden tool continuation state omitted to preserve context]";
	}
	if (msg.customType === "tool_failure_warning") {
		return "[older hidden tool failure warning omitted to preserve context]";
	}
	return OLDER_HIDDEN_CUSTOM_PLACEHOLDER;
}

function getToolResultTextLength(msg: AgentMessage): number {
	return getToolResultContent(msg).trim().length;
}

function isBulkyTrailingToolResult(msg: AgentMessage): boolean {
	if (msg.role !== "toolResult") return false;
	if ((msg as { isError?: boolean }).isError === true) return false;
	return getToolResultTextLength(msg) >= LIVE_POST_TOOL_CONTINUATION_TRIGGER_CHARS;
}

function getTrailingToolResults(messages: AgentMessage[]): AgentMessage[] {
	const trailing: AgentMessage[] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "toolResult") {
			trailing.unshift(msg);
			continue;
		}
		if (msg.role === "custom" && msg.display === false) {
			continue;
		}
		break;
	}
	return trailing;
}

function describeTrailingToolResult(msg: AgentMessage): string | undefined {
	if (msg.role !== "toolResult") return undefined;
	const toolName = typeof msg.toolName === "string" ? msg.toolName : "tool";
	const details = (msg as { details?: Record<string, unknown> }).details;
	const detail =
		typeof details?.url === "string"
			? details.url
			: typeof details?.path === "string"
				? details.path
				: typeof details?.query === "string"
					? details.query
					: typeof details?.command === "string"
						? details.command
						: undefined;
	return detail ? `${toolName} around \`${detail}\`` : toolName;
}

function buildPostToolContinuationText(trailingToolResults: AgentMessage[]): string {
	if (trailingToolResults.length === 1) {
		const described = describeTrailingToolResult(trailingToolResults[0]) ?? "tool output";
		return `Runtime continuation: The bulky ${described} output above should be compressed into a compact working state before continuing. Summarize the task tool output above and continue with your task. Reuse the result above instead of quoting it verbatim or rerunning the same broad tool step. If it already answers the user's request, answer now. Otherwise extract only the decisive facts, paths, symbols, errors, or URLs needed for one next step.`;
	}
	return "Runtime continuation: The bulky tool outputs above should be compressed into a compact working state before continuing. Summarize the task tool output above and continue with your task. Reuse the results above instead of quoting them verbatim or restarting broad discovery. If the tool results already answer the user's request, answer now. Otherwise extract only the decisive facts, paths, symbols, errors, or URLs needed for one next step.";
}

function mutateTextOnlyMessage(msg: AgentMessage, text: string): void {
	if (msg.role === "toolResult" || msg.role === "user" || msg.role === "custom") {
		(msg as Extract<AgentMessage, { role: "toolResult" | "user" | "custom" }>).content = [{ type: "text", text }];
	}
}

/**
 * Truncates large tool results from compactable tools (Read, Bash, Grep, etc.)
 * in message history, preserving only the most recent N turns.
 *
 * This is a zero-cost operation — pure string manipulation, no API calls.
 * It prevents stale 50KB tool outputs from consuming context budget.
 *
 * @param messages - The session's message history (will be mutated in-place for performance)
 * @param keepTurns - Number of most recent user-initiated turns to leave untouched
 * @returns The number of tool results that were truncated
 */
export function microCompact(
	messages: AgentMessage[],
	keepTurns = DEFAULT_KEEP_TURNS,
	recordToolOutcome?: (outcome: any) => void,
): number {
	if (messages.length === 0) return 0;

	const protectedIndices = collectProtectedIndices(messages, keepTurns);

	// Step 2: Process unprotected messages
	let compactedCount = 0;

	for (let i = 0; i < messages.length; i++) {
		if (protectedIndices.has(i)) continue;

		const msg = messages[i];

		if (msg.role === "assistant" && hasThinkingBlocks(msg)) {
			messages[i] = cloneAssistantWithoutThinking(msg);
			compactedCount++;
			continue;
		}

		if (msg.role === "custom" && msg.display === false) {
			const textContent = getMessageTextContent(msg);
			if (textContent.length > DEFAULT_LIVE_CONTEXT_MAX_HIDDEN_CUSTOM_CHARS) {
				mutateTextOnlyMessage(msg, getHiddenCustomPlaceholder(msg));
				compactedCount++;
				continue;
			}
		}

		if (msg.role === "toolResult") {
			const content = getToolResultContent(msg);
			const toolName = getToolNameForResult(messages, i);
			const isCompactable = toolName !== undefined && COMPACTABLE_TOOLS.has(toolName);
			const shouldCompactText = isCompactable && content.length > MAX_TOOL_RESULT_CHARS;
			const shouldStripAttachments = hasNonTextAttachmentBlocks(msg);
			if (shouldCompactText || shouldStripAttachments) {
				const nextText = buildCompactToolResultText(
					toolName,
					content,
					shouldStripAttachments,
					getOlderAttachmentPlaceholder(msg),
					shouldCompactText,
				);
				setToolResultContent(msg, nextText);
				if (shouldStripAttachments && Array.isArray(msg.content)) {
					msg.content = [{ type: "text", text: nextText }];
				}
				if (recordToolOutcome && toolName && COMPACTABLE_TOOLS.has(toolName)) {
					// Record fact before truncation so cache remembers the result (no extra cost, preserves knowledge)
					recordToolOutcome({ tool: toolName, success: true, detail: content.slice(0, 100) });
				}
				compactedCount++;
				continue;
			}
		}

		if ((msg.role === "user" || msg.role === "custom") && hasNonTextAttachmentBlocks(msg)) {
			const textContent = getMessageTextContent(msg);
			const placeholder = getOlderAttachmentPlaceholder(msg);
			mutateTextOnlyMessage(msg, textContent.trim() ? `${textContent}\n\n${placeholder}` : placeholder);
			compactedCount++;
		}
	}

	return compactedCount;
}

/**
 * Create an immutable copy of messages optimized for live provider context.
 *
 * This is more aggressive than saved-history fidelity:
 * - old large tool results are compacted before they reach the provider
 * - stale image attachments in old tool results are replaced with a short placeholder
 *
 * Recent turns are preserved untouched to keep active execution quality high.
 */
export function createContextHygieneCopy(
	messages: AgentMessage[],
	options?: number | ContextHygieneOptions,
	recordToolOutcome?: (outcome: any) => void,
): AgentMessage[] {
	if (messages.length === 0) return messages;

	const { keepTurns, maxToolResultChars, maxHiddenCustomChars } = resolveContextHygieneOptions(options);
	const protectedIndices = collectProtectedIndices(messages, keepTurns);
	let nextMessages: AgentMessage[] | undefined;

	for (let i = 0; i < messages.length; i++) {
		if (protectedIndices.has(i)) continue;
		const msg = messages[i];
		if (msg.role !== "toolResult") continue;

		const toolName = getToolNameForResult(messages, i);
		const isCompactable = toolName !== undefined && COMPACTABLE_TOOLS.has(toolName);
		const textContent = getToolResultContent(msg);
		const shouldCompactText = isCompactable && textContent.length > maxToolResultChars;
		const shouldStripAttachments = hasNonTextAttachmentBlocks(msg);

		if (!shouldCompactText && !shouldStripAttachments) continue;

		const compactText = buildCompactToolResultText(
			toolName,
			textContent,
			shouldStripAttachments,
			getOlderAttachmentPlaceholder(msg),
			shouldCompactText,
		);
		if (!nextMessages) {
			nextMessages = [...messages];
		}
		nextMessages[i] = cloneMessageWithTextOnly(msg, compactText);
		if (recordToolOutcome && toolName && COMPACTABLE_TOOLS.has(toolName)) {
			recordToolOutcome({ tool: toolName, success: true, detail: textContent.slice(0, 100) });
		}
	}

	for (let i = 0; i < messages.length; i++) {
		if (protectedIndices.has(i)) continue;
		const msg = messages[i];
		if (msg.role !== "user" && msg.role !== "custom") continue;
		if (!hasNonTextAttachmentBlocks(msg)) continue;

		const compactText = buildCompactToolResultText(
			undefined,
			getMessageTextContent(msg),
			true,
			getOlderAttachmentPlaceholder(msg),
			false,
		);
		if (!nextMessages) {
			nextMessages = [...messages];
		}
		nextMessages[i] = cloneMessageWithTextOnly(msg, compactText);
	}

	for (let i = 0; i < messages.length; i++) {
		if (protectedIndices.has(i)) continue;
		const msg = messages[i];
		if (!hasThinkingBlocks(msg)) continue;

		if (!nextMessages) {
			nextMessages = [...messages];
		}
		nextMessages[i] = cloneAssistantWithoutThinking(msg);
	}

	for (let i = 0; i < messages.length; i++) {
		if (protectedIndices.has(i)) continue;
		const msg = messages[i];
		if (msg.role !== "custom" || msg.display !== false) continue;

		const textContent = getMessageTextContent(msg);
		const shouldCompactText = textContent.length > maxHiddenCustomChars;
		const shouldStripAttachments = hasNonTextAttachmentBlocks(msg);
		if (!shouldCompactText && !shouldStripAttachments) continue;

		const compactText = shouldCompactText
			? getHiddenCustomPlaceholder(msg)
			: buildCompactToolResultText(undefined, textContent, true, getOlderAttachmentPlaceholder(msg), false);
		if (!nextMessages) {
			nextMessages = [...messages];
		}
		nextMessages[i] = cloneMessageWithTextOnly(msg, compactText);
	}

	return nextMessages ?? messages;
}

/**
 * Append an ephemeral hidden continuation-compression hint when the live prompt
 * is about to continue from bulky trailing tool results.
 */
export function createLiveProviderContext(messages: AgentMessage[]): AgentMessage[] {
	const trailingToolResults = getTrailingToolResults(messages);
	if (trailingToolResults.length === 0 || !trailingToolResults.some(isBulkyTrailingToolResult)) {
		return messages;
	}

	return [
		...messages,
		{
			role: "custom",
			customType: POST_TOOL_CONTINUATION_CUSTOM_TYPE,
			display: false,
			content: [{ type: "text", text: buildPostToolContinuationText(trailingToolResults) }],
			details: { kind: POST_TOOL_CONTINUATION_CUSTOM_TYPE },
			timestamp: Date.now(),
		},
	];
}
