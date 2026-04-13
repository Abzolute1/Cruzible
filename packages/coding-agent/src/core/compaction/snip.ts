/**
 * Layer 2: Snip — drop oldest unprotected message groups.
 *
 * Zero-cost operation (pure array manipulation, no API calls).
 * More aggressive than micro-compact: removes entire message groups, not just truncating content.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "./compaction.js";

/** Minimum number of turns to always preserve (system + first user + recent). */
const DEFAULT_KEEP_TURNS = 2;

/** Marker text inserted when messages are snipped. */
const SNIP_MARKER = "[Previous conversation context removed to free tokens. ~{N}K tokens freed.]";

/**
 * Drops the oldest unprotected message groups from history to free context tokens.
 * More aggressive than micro-compact: removes entire message groups, not just truncating content.
 *
 * This is a zero-cost operation — pure array manipulation, no API calls.
 *
 * @param messages - The session's message history
 * @param targetTokens - Number of tokens to free (estimated)
 * @param keepTurns - Number of most recent turns to protect
 * @returns { freedTokens: number, snippedMessages: AgentMessage[] }
 */
export function snipHistory(
	messages: AgentMessage[],
	targetTokens: number,
	keepTurns = DEFAULT_KEEP_TURNS,
): { freedTokens: number; snippedMessages: AgentMessage[] } {
	if (messages.length === 0) {
		return { freedTokens: 0, snippedMessages: [] };
	}

	// Step 1: Identify protected indices
	const protectedIndices = new Set<number>();

	// Protect the system message (index 0 if it's the first message)
	// In Pi's message model, system messages are part of the agent state but
	// may not be in the messages array. We protect index 0 regardless.
	protectedIndices.add(0);

	// Protect the first user message (find it)
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === "user") {
			protectedIndices.add(i);
			break;
		}
	}

	// Protect the last `keepTurns` user turns
	let userTurnsFound = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			userTurnsFound++;
			if (userTurnsFound <= keepTurns) {
				// Protect this user message and everything after it until the next user message
				for (let j = i; j < messages.length; j++) {
					protectedIndices.add(j);
				}
			} else {
				break;
			}
		}
	}

	// Step 2: Group unprotected messages by "API round"
	// A group is: user message → assistant message → tool_result messages
	const groups: Array<{ start: number; end: number; tokens: number }> = [];
	let i = 0;
	while (i < messages.length) {
		if (protectedIndices.has(i)) {
			i++;
			continue;
		}

		// Start of an unprotected group
		const groupStart = i;
		let groupTokens = 0;

		// Walk forward to find the end of this group
		// A group starts with a user message (or non-user) and ends before the next unprotected user message
		const startsWithUser = messages[i].role === "user";

		if (startsWithUser) {
			// Include this user message
			groupTokens += estimateTokens(messages[i]);
			i++;

			// Include the following assistant message
			if (i < messages.length && messages[i].role === "assistant" && !protectedIndices.has(i)) {
				groupTokens += estimateTokens(messages[i]);
				i++;
			}

			// Include all following tool_result messages
			while (i < messages.length && messages[i].role === "toolResult" && !protectedIndices.has(i)) {
				groupTokens += estimateTokens(messages[i]);
				i++;
			}
		} else {
			// Non-user start (shouldn't normally happen, but handle it)
			// Include this message and any following tool_results
			while (i < messages.length && !protectedIndices.has(i) && messages[i].role !== "user") {
				groupTokens += estimateTokens(messages[i]);
				i++;
			}
		}

		if (groupStart < i) {
			groups.push({ start: groupStart, end: i, tokens: groupTokens });
		}
	}

	// Step 3: Remove oldest groups until we've freed enough tokens
	let freedTokens = 0;
	let snipCount = 0;

	for (const group of groups) {
		if (freedTokens >= targetTokens) break;

		freedTokens += group.tokens;
		snipCount++;
	}

	if (snipCount === 0) {
		return { freedTokens: 0, snippedMessages: [] };
	}

	// Calculate where to insert the marker
	const insertIndex = groups[0].start;

	// Step 4: Remove the snipped messages
	const snippedMessages: AgentMessage[] = [];
	let removeOffset = 0;
	for (let g = 0; g < snipCount; g++) {
		const group = groups[g];
		const start = group.start - removeOffset;
		const end = group.end - removeOffset;
		snippedMessages.push(...messages.splice(start, end - start));
		removeOffset += end - start;
	}

	// Step 5: Insert the snip marker at the boundary
	const freedK = Math.round(freedTokens / 1000);
	const markerText = SNIP_MARKER.replace("{N}", String(freedK));
	const markerMessage: AgentMessage = {
		role: "user",
		content: markerText,
		timestamp: Date.now(),
	};

	// Insert marker at the position where content was removed
	messages.splice(insertIndex, 0, markerMessage);

	return { freedTokens, snippedMessages };
}
