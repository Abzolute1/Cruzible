import type { AgentMessage } from "@ag1/agent-core";
import { calculateContextTokens, estimateContextTokens } from "../compaction/index.js";
import type { CompactionEntry, ModelChangeEntry, SessionEntry } from "../session-manager.js";

export interface TurnDebugInfo {
	turnNumber: number;
	entryId: string;
	timestamp: string;
	/** Tokens consumed by this turn (output tokens) */
	tokensOut: number;
	/** Running total of tokens after this turn */
	tokensRunningTotal: number;
	/** Estimated context pressure as % of contextWindow */
	contextPressurePercent: number | null;
	/** Model used for this turn */
	model: string;
	/** If this turn had a tool call, the tool name */
	toolCall?: string;
	/** If this turn was a tool result */
	toolResult?: string;
	/** Whether the tool call resulted in an error */
	toolError?: boolean;
}

export interface HarnessAction {
	type: "compaction" | "model_switch" | "thinking_change";
	turnNumber: number;
	entryId: string;
	timestamp: string;
	details: string;
	/** Tokens before action (for compaction) */
	tokensBefore?: number;
	/** Tokens after action (for compaction) */
	tokensAfter?: number;
}

export interface DebugSummary {
	totalTurns: number;
	totalTokensIn: number;
	totalTokensOut: number;
	totalTokensCacheRead: number;
	totalTokensCacheWrite: number;
	contextWindow: number;
	peakContextPressure: number;
	avgTokensPerTurn: number;
	compactions: number;
	modelSwitches: number;
	thinkingChanges: number;
	toolCalls: number;
	toolErrors: number;
	models: string[];
	harnessActions: HarnessAction[];
	turns: TurnDebugInfo[];
}

/**
 * Analyze session entries to build a per-turn debug timeline.
 * Calculates context pressure, token deltas, and harness actions.
 */
export function analyzeSessionDebug(entries: SessionEntry[], contextWindow: number): DebugSummary {
	const turns: TurnDebugInfo[] = [];
	const harnessActions: HarnessAction[] = [];
	const models = new Set<string>();

	let turnNumber = 0;
	let runningTokens = 0;
	let compactions = 0;
	let modelSwitches = 0;
	let thinkingChanges = 0;
	let toolCalls = 0;
	let toolErrors = 0;
	let peakPressure = 0;
	let totalTokensIn = 0;
	let totalTokensOut = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;

	let currentModel = "unknown";

	// Build cumulative context pressure map
	// After compaction, running total resets based on compaction data
	const pressureAfterCompaction: Map<string, number> = new Map();

	// First pass: collect compaction data
	const compactionEntryMap: Map<string, { tokensBefore: number; entryId: string }> = new Map();
	for (const entry of entries) {
		if (entry.type === "compaction") {
			const compaction = entry as CompactionEntry;
			compactionEntryMap.set(entry.id, {
				tokensBefore: compaction.tokensBefore,
				entryId: compaction.firstKeptEntryId,
			});
		}
	}

	// Second pass: build timeline
	for (const entry of entries) {
		if (entry.type === "compaction") {
			const compaction = entry as CompactionEntry;
			compactions++;

			// Calculate tokens after compaction
			// We need to recalculate from the first kept entry
			const keptEntryIndex = entries.findIndex((e) => e.id === compaction.firstKeptEntryId);
			let tokensAfterCompaction = 0;
			if (keptEntryIndex >= 0) {
				// Sum from kept entry to just before compaction
				for (let i = keptEntryIndex; i < entries.indexOf(entry); i++) {
					const e = entries[i];
					if (e.type === "message") {
						const msg = (e as any).message as AgentMessage;
						if (msg.role === "assistant" && msg.usage) {
							tokensAfterCompaction = calculateContextTokens(msg.usage);
						}
					}
				}
			}

			const tokensAfter = tokensAfterCompaction;
			const pressureAfter = contextWindow > 0 ? (tokensAfter / contextWindow) * 100 : 0;

			harnessActions.push({
				type: "compaction",
				turnNumber,
				entryId: entry.id,
				timestamp: entry.timestamp,
				details: `Compacted: ${compaction.tokensBefore.toLocaleString()} → ~${tokensAfter.toLocaleString()} tokens (${pressureAfter.toFixed(1)}%)`,
				tokensBefore: compaction.tokensBefore,
				tokensAfter,
			});

			// Reset running total to post-compaction value
			runningTokens = tokensAfter;
			continue;
		}

		if (entry.type === "model_change") {
			const mc = entry as ModelChangeEntry;
			modelSwitches++;
			currentModel = `${mc.provider}/${mc.modelId}`;
			models.add(currentModel);

			harnessActions.push({
				type: "model_switch",
				turnNumber,
				entryId: entry.id,
				timestamp: entry.timestamp,
				details: `Model changed to ${currentModel}`,
			});
			continue;
		}

		if (entry.type === "thinking_level_change") {
			thinkingChanges++;
			harnessActions.push({
				type: "thinking_change",
				turnNumber,
				entryId: entry.id,
				timestamp: entry.timestamp,
				details: `Thinking level changed to ${(entry as any).thinkingLevel}`,
			});
			continue;
		}

		if (entry.type !== "message") continue;

		const msg = (entry as any).message as AgentMessage;
		if (!msg) continue;

		if (msg.role === "assistant") {
			const usage = (msg as any).usage;
			let tokensDelta = 0;
			if (usage) {
				tokensDelta = calculateContextTokens(usage);
				totalTokensIn += usage.input || 0;
				totalTokensOut += usage.output || 0;
				totalCacheRead += usage.cacheRead || 0;
				totalCacheWrite += usage.cacheWrite || 0;
			}

			turnNumber++;
			runningTokens += tokensDelta;

			const pressure = contextWindow > 0 ? (runningTokens / contextWindow) * 100 : 0;
			if (pressure > peakPressure) peakPressure = pressure;

			const turn: TurnDebugInfo = {
				turnNumber,
				entryId: entry.id,
				timestamp: entry.timestamp,
				tokensOut: usage?.output || 0,
				tokensRunningTotal: runningTokens,
				contextPressurePercent: pressure,
				model: currentModel,
			};

			// Check for tool calls
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "toolCall") {
						turn.toolCall = block.name;
						toolCalls++;
					}
				}
			}

			turns.push(turn);
		}

		if (msg.role === "toolResult") {
			const toolName = msg.toolName || "unknown";
			// Find the matching turn for this tool result
			const matchingTurn = turns.find((t) => t.toolCall === toolName && !t.toolResult);
			if (matchingTurn) {
				matchingTurn.toolResult = toolName;
				matchingTurn.toolError = msg.isError || false;
				if (msg.isError) toolErrors++;
			}
		}
	}

	// Calculate average tokens per turn
	const avgTokens = turnNumber > 0 ? totalTokensOut / turnNumber : 0;

	// Ensure at least the main model is in the set
	if (models.size === 0 && currentModel !== "unknown") {
		models.add(currentModel);
	}

	return {
		totalTurns: turnNumber,
		totalTokensIn,
		totalTokensOut,
		totalTokensCacheRead: totalCacheRead,
		totalTokensCacheWrite: totalCacheWrite,
		contextWindow,
		peakContextPressure: peakPressure,
		avgTokensPerTurn: avgTokens,
		compactions,
		modelSwitches,
		thinkingChanges,
		toolCalls,
		toolErrors,
		models: Array.from(models),
		harnessActions,
		turns,
	};
}
