/**
 * Layer 1: Micro-compact — truncate old compactable tool results.
 *
 * Zero-cost operation (pure string manipulation, no API calls).
 * Prevents stale 50KB tool outputs from consuming context budget.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";

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

/** Truncate tool results longer than this to this many characters. */
const MAX_TOOL_RESULT_CHARS = 500;

/** Preview length for truncated tool result display. */
const PREVIEW_CHARS = 120;

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
export function microCompact(messages: AgentMessage[], keepTurns = DEFAULT_KEEP_TURNS): number {
	if (messages.length === 0) return 0;

	// Step 1: Identify protected turns by walking backwards
	// Count user→assistant(+tool_result) groups from the end
	const protectedIndices = new Set<number>();
	let userTurnsFound = 0;

	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];

		// Count user messages as turn boundaries
		if (msg.role === "user") {
			userTurnsFound++;
			if (userTurnsFound <= keepTurns) {
				// Protect this user message and everything after it
				for (let j = i; j < messages.length; j++) {
					protectedIndices.add(j);
				}
			} else {
				// We've found enough turns, stop
				break;
			}
		}
	}

	// Step 2: Process unprotected messages
	let truncatedCount = 0;

	for (let i = 0; i < messages.length; i++) {
		if (protectedIndices.has(i)) continue;

		const msg = messages[i];
		if (msg.role !== "toolResult") continue;

		const content = getToolResultContent(msg);
		if (content.length <= MAX_TOOL_RESULT_CHARS) continue;

		// Find the tool name from the preceding assistant message
		// Walk backwards to find the nearest assistant message with tool calls
		let toolName: string | undefined;
		for (let j = i - 1; j >= 0; j--) {
			if (messages[j].role === "assistant") {
				// Count how many tool_result messages are between this assistant and current msg
				let toolResultOffset = 0;
				for (let k = j + 1; k < i; k++) {
					if (messages[k].role === "toolResult") {
						toolResultOffset++;
					}
				}
				toolName = getToolNameFromAssistant(messages[j], toolResultOffset);
				break;
			}
			// Stop if we hit another user message (different turn)
			if (messages[j].role === "user") break;
		}

		if (!toolName) continue;

		// Check if this tool is compactable
		if (!COMPACTABLE_TOOLS.has(toolName)) continue;

		// Truncate the content
		const preview = content.slice(0, PREVIEW_CHARS).replace(/\n/g, " ");
		const originalLength = content.length;
		const truncated = `[truncated] ${toolName} result: ${preview}... [original was ${originalLength} chars]`;

		setToolResultContent(msg, truncated);
		truncatedCount++;
	}

	return truncatedCount;
}
