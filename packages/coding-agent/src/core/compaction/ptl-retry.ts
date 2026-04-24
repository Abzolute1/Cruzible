/**
 * Layer 4: PTL (Prompt-Too-Long) Retry — recovery when auto-compaction itself hits prompt-too-long.
 *
 * When the LLM-based compaction exceeds the API's input limit, this layer truncates
 * the oldest messages and retries. This is a recovery mechanism, not a compaction strategy.
 */

import type { AgentMessage } from "@ag1/agent-core";
import { estimateTokens } from "./compaction.js";

/** Fraction of droppable messages to drop when token gap is unparseable. */
const PTL_FALLBACK_DROP_FRACTION = 0.2;

/** Marker appended to indicate PTL retry truncation occurred. */
const PTL_RETRY_MARKER = "[earlier conversation truncated for compaction retry]";

/** Maximum number of PTL retry attempts before giving up. */
export const MAX_PTL_RETRIES = 3;

/**
 * Group messages into "API rounds": contiguous blocks that form one request.
 * System messages → user → assistant + tool_results = one round.
 */
function groupByApiRound(messages: AgentMessage[]): Array<{ start: number; end: number }> {
	const groups: Array<{ start: number; end: number }> = [];
	if (messages.length === 0) return groups;

	let i = 0;
	while (i < messages.length) {
		const groupStart = i;

		// Walk forward to find the end of this round
		// A round: user message → assistant message → tool_result messages
		if (messages[i].role === "user") {
			i++; // user message
			// assistant message
			if (i < messages.length && messages[i].role === "assistant") {
				i++;
			}
			// tool_result messages
			while (i < messages.length && messages[i].role === "toolResult") {
				i++;
			}
		} else {
			// Non-user message (edge case), just include this one
			i++;
		}

		groups.push({ start: groupStart, end: i });
	}

	return groups;
}

/**
 * Try to parse the token gap from an error message.
 * Looks for patterns like "max 128000, current 150000" or similar.
 * Returns the number of tokens that need to be freed, or null if unparseable.
 */
function parseTokenGap(errorText: string): number | null {
	// Pattern 1: "max.*?(\d+).*?current.*?(\d+)"
	const pattern1 = /max.*?(\d+).*?current.*?(\d+)/i;
	const match1 = errorText.match(pattern1);
	if (match1) {
		const maxTokens = parseInt(match1[1], 10);
		const currentTokens = parseInt(match1[2], 10);
		if (!Number.isNaN(maxTokens) && !Number.isNaN(currentTokens) && currentTokens > maxTokens) {
			return currentTokens - maxTokens;
		}
	}

	// Pattern 2: "(\d+) tokens? over.*?(\d+)"
	const pattern2 = /(\d+)\s*tokens?\s*over.*?(\d+)/i;
	const match2 = errorText.match(pattern2);
	if (match2) {
		const over = parseInt(match2[1], 10);
		if (!Number.isNaN(over) && over > 0) {
			return over;
		}
	}

	// Pattern 3: "input length (\d+) > max (\d+)"
	const pattern3 = /input\s*length\s*(\d+)\s*[>]+\s*max\s*(\d+)/i;
	const match3 = errorText.match(pattern3);
	if (match3) {
		const inputLen = parseInt(match3[1], 10);
		const maxLen = parseInt(match3[2], 10);
		if (!Number.isNaN(inputLen) && !Number.isNaN(maxLen) && inputLen > maxLen) {
			return inputLen - maxLen;
		}
	}

	return null;
}

/**
 * Truncates the oldest messages from a conversation to resolve a prompt-too-long error.
 * Used as a recovery mechanism when the LLM-based compaction itself exceeds the API's input limit.
 *
 * @param messages - The messages that caused the prompt-too-long error
 * @param errorText - The error message from the API (may contain token gap info)
 * @returns { messages: AgentMessage[], droppedTokens: number } or null if all messages would be dropped
 */
export function truncateHeadForPTLRetry(
	messages: AgentMessage[],
	errorText: string,
): { messages: AgentMessage[]; droppedTokens: number } | null {
	if (messages.length === 0) return null;

	// Step 1: Strip any existing PTL_RETRY_MARKER from a previous retry attempt
	const cleanMessages = messages.filter((msg) => {
		if (msg.role === "user" && typeof msg.content === "string") {
			return !msg.content.includes(PTL_RETRY_MARKER);
		}
		return true;
	});

	// Step 2: Group messages by API round
	const groups = groupByApiRound(cleanMessages);
	if (groups.length === 0) return null;

	// Step 3: Identify the system message group (NEVER dropped)
	// The first group is typically the system/summary message
	// Droppable groups are everything after the system group, excluding the last group
	// (we always keep at least 1 droppable group so there's something to summarize)
	const droppableGroups = groups.slice(1, -1);
	if (droppableGroups.length === 0) return null;

	// Step 4: Try to parse the token gap
	const tokenGap = parseTokenGap(errorText);

	let groupsToDrop: typeof droppableGroups;

	if (tokenGap !== null) {
		// Drop oldest droppable groups until accumulated freed tokens >= gap
		let accumulatedTokens = 0;
		let dropCount = 0;
		for (let i = 0; i < droppableGroups.length; i++) {
			const group = droppableGroups[i];
			let groupTokens = 0;
			for (let j = group.start; j < group.end; j++) {
				if (j < cleanMessages.length) {
					groupTokens += estimateTokens(cleanMessages[j]);
				}
			}
			accumulatedTokens += groupTokens;
			dropCount++;
			if (accumulatedTokens >= tokenGap) break;
		}
		groupsToDrop = droppableGroups.slice(0, dropCount);
	} else {
		// Fallback: drop PTL_FALLBACK_DROP_FRACTION (20%) of droppable groups
		const dropCount = Math.max(1, Math.ceil(droppableGroups.length * PTL_FALLBACK_DROP_FRACTION));
		groupsToDrop = droppableGroups.slice(0, dropCount);
	}

	// Ensure we don't drop all droppable groups (keep at least 1)
	if (groupsToDrop.length >= droppableGroups.length) {
		groupsToDrop = droppableGroups.slice(0, droppableGroups.length - 1);
	}

	if (groupsToDrop.length === 0) return null;

	// Step 5: Calculate the cut point
	const cutIndex = groupsToDrop[groupsToDrop.length - 1].end;

	// Step 6: Build the truncated messages
	const truncatedMessages = cleanMessages.slice(cutIndex);

	if (truncatedMessages.length === 0) return null;

	// Step 7: If the result would start with an assistant message, prepend a synthetic user marker
	if (truncatedMessages[0].role === "assistant") {
		truncatedMessages.unshift({
			role: "user",
			content: PTL_RETRY_MARKER,
			timestamp: Date.now(),
		});
	}

	// Step 8: Calculate dropped tokens
	let droppedTokens = 0;
	for (let i = 0; i < cutIndex; i++) {
		droppedTokens += estimateTokens(cleanMessages[i]);
	}

	return { messages: truncatedMessages, droppedTokens };
}
