/**
 * Session Debug Logger — non-blocking session recorder and analyzer.
 *
 * Records every agent session to disk for post-mortem analysis,
 * model benchmarking, and LLM-based audit. Beyond raw recording it derives
 * analyzer signals: per-turn state snapshots, typed harness-action events
 * (nudges, retries, stalls, tool changes, vision verdicts), journal entry
 * summaries, loop detection, and a session outcome record.
 *
 * Writes three files per session:
 *  - session.md           — Full detailed turn-by-turn log + outcome analysis
 *  - session.compact.md   — Compact one-line-per-turn summary + outcome block
 *  - timeline.json        — Machine-parseable event timeline
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	getCompletedStepCount,
	getLatestInteractivePlanArtifact,
	INTERACTIVE_PLAN_ARTIFACT_TYPE,
} from "../modes/interactive/interactive-plan-artifacts.js";
import type { AgentSession, AgentSessionEvent } from "./agent-session.js";
import type { ToolOutcome } from "./auton/nudges/types.js";
import { buildToolOutcomeFingerprint, normalizeToolName } from "./auton/nudges/types.js";
import type { CompactionResult } from "./compaction/index.js";
import {
	formatCost,
	formatDurationMs,
	formatModelDisplayName,
	formatTokens,
	formatToolResultContent,
	modelToFolderName,
	padLeft,
	redactSecrets,
	safeJsonPreview,
	sanitizeNamePart,
	summarizeToolArgs,
	toSessionDateStr,
	toSessionDateTimeStr,
	toUtcTimestamp,
	truncate,
} from "./debug-formatters.js";
import { evaluateInteractiveNudges, type InteractiveNudgeContext, type NudgeWarning } from "./nudge-warnings.js";
import type { SessionEntry } from "./session-manager.js";
import { computeSessionMetrics, type SessionMetrics } from "./session-metrics.js";
import { readLatestTodoSnapshot, summarizeTodos, TODO_JOURNAL_TYPE } from "./todos.js";
import { buildToolCallDigest, buildToolResultDigest } from "./tool-outcome-digests.js";
import { extractTrackedFileFromToolResult } from "./tool-outcome-file.js";

/** customType used by the task tool for subagent run records (see core/tools/task.ts). */
const TASK_JOURNAL_TYPE = "ag1.subagent_task";

// ============================================================================
// Types
// ============================================================================

interface DebugLoggerOptions {
	session: AgentSession;
	projectRoot: string;
}

export interface SessionDebugArtifacts {
	sessionDir?: string;
	sessionMd?: string;
	sessionCompactMd?: string;
	timelineJson?: string;
}

interface ToolCallEntry {
	name: string;
	toolCallId: string;
	arguments: Record<string, unknown>;
	source: "structured" | "xml" | "extension";
	timestamp: number;
	result?: ToolResultEntry;
}

interface ToolResultEntry {
	isError: boolean;
	content: unknown;
	contentLength: number;
	contentPreview: string;
	durationMs: number;
	timestamp: number;
}

interface TurnState {
	turn: number;
	turnStartTimestamp: number;
	inputText: string;
	inputImageCount: number;
	inputLength: number;
	toolCalls: ToolCallEntry[];
	prevCumulativeInput: number;
	prevCumulativeOutput: number;
	nudgeWarnings: NudgeWarningEntry[];
	toolFailureWarnings: ToolFailureWarningEntry[];
	xmlToolCalls: XmlToolCallEntry[];
	degradedTurns: DegradedTurnEntry[];
	harnessLines: string[];
	compaction?: CompactionEntry;
	steeringMessages: string[];
	followUpMessages: string[];
	stopReason?: string;
	errorMessage?: string;
	tokenDeltas?: TokenDeltas;
	contextPercent: number | null;
	stateText?: string;
}

/** Tool outcome row fed into session-metrics at session end. */
type ToolOutcomeForMetrics = {
	tool: string;
	success: boolean;
	callDigest?: string;
	resultDigest?: string;
	durationMs: number;
	contentLength: number;
	timestamp: number;
	verdict?: string;
};

interface TokenDeltas {
	inputTokensDelta: number;
	outputTokensDelta: number;
	cacheReadDelta: number;
	cacheWriteDelta: number;
	costDelta: number;
}

interface NudgeWarningEntry {
	type: string;
	message: string;
	shouldStop: boolean;
	timestamp: number;
}

interface ToolFailureWarningEntry {
	toolName: string;
	failureCount: number;
	correctiveMessage: string;
	timestamp: number;
}

interface CompactionEntry {
	reason: "manual" | "threshold" | "overflow";
	tokensBefore: number;
	tokensAfter?: number;
	durationMs?: number;
	aborted: boolean;
	errorMessage?: string;
}

interface TimelineEvent {
	type: string;
	timestamp: number;
	[key: string]: unknown;
}

interface CumulativeTokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

interface XmlToolCallEntry {
	name: string;
	args: Record<string, unknown>;
	result?: unknown;
	iteration?: number;
	callCount?: number;
	assistantStopReason?: string;
	assistantTextLength?: number;
	severity?: string;
	reasons?: string[];
	continuationMode?: string;
}

interface DegradedTurnEntry {
	severity: string;
	stopReason?: string;
	outputTokens: number;
	textLength: number;
	reasons: string[];
	recoveryHint?: string;
	timestamp: number;
}

// ============================================================================
// SessionDebugLogger
// ============================================================================

export class SessionDebugLogger {
	private session: AgentSession;
	private projectRoot: string;
	private sessionDir: string | null = null;
	private sessionMd: string | null = null;
	private sessionCompactMd: string | null = null;
	private timelineJson: string | null = null;
	private writeQueue: Promise<void> = Promise.resolve();
	private disposed = false;

	// Subscription
	private unsubscribe: (() => void) | null = null;
	private unsubscribeEntries: (() => void) | null = null;

	// Turn tracking
	private turnCounter = 0;
	private currentTurn: TurnState | null = null;
	/** True once a real session turn_start event has been seen — turns are then driven by turn_start, not agent_start. */
	private seenTurnEvents = false;
	/** True when the open turn was optimistically opened by agent_start (fallback) and not yet adopted by a turn_start. */
	private currentTurnFromAgentStart = false;
	/** Steering/follow-up messages that arrive between turns are buffered into the next turn block. */
	private pendingSteeringMessages: string[] = [];
	private pendingFollowUpMessages: string[] = [];

	// Analyzer state
	private journalLines: string[] = [];
	private lastFiredNudgeTurns = new Map<string, number>();
	private lastVisionVerdict: string | undefined;
	private prevActiveTools: string[] | null = null;
	private toolOutcomesForMetrics: ToolOutcomeForMetrics[] = [];
	private outcomeWritten = false;

	// Token tracking
	private previousCumulative: CumulativeTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

	// Timeline events
	private timelineEvents: TimelineEvent[] = [];

	// Session-level aggregates
	private sessionStartTimestamp = 0;
	private peakContextPercent = 0;
	private compactionCount = 0;
	private totalToolFailures = 0;
	private totalNudges = 0;
	private totalXmlFallbacks = 0;
	private toolFailureCountsMap = new Map<string, number>();

	// Nudge evaluation tracking
	private toolCallHistoryForNudges: Array<{
		tool: string;
		success: boolean;
		estimatedTokens?: number;
		file?: string;
	}> = [];
	private fileAccessHistoryForNudges: Array<{
		tool: string;
		success: boolean;
		estimatedTokens?: number;
		file?: string;
	}> = [];
	private nudgeTurnIndex = 0;
	private nudgeShownWarnings = new Map<string, number>();
	private lastNudgeOutputTokens = 0;
	private dedupCooldown = 8; // turns

	// Summary stats
	private totalInputTokens = 0;
	private totalOutputTokens = 0;
	private totalCost = 0;

	// Anomaly flags per turn
	private turnAnomalies: Map<number, string[]> = new Map();

	// Compact file tool failure tracking for summary
	private compactToolFailures: Array<{ toolName: string; isError: boolean }> = [];

	private _warned = false;

	constructor(options: DebugLoggerOptions) {
		this.session = options.session;
		this.projectRoot = options.projectRoot;
	}

	// -----------------------------------------------------------------------
	// Public API
	// -----------------------------------------------------------------------

	/**
	 * Start the debug logger. Creates directory, opens files, writes headers.
	 * Call on session_start (after AgentSession is fully constructed and first prompt is about to be sent).
	 */
	start(): void {
		if (this.disposed) return;

		try {
			// Set timestamp FIRST so it's available for directory naming and headers
			this.sessionStartTimestamp = Date.now();

			const sessionDir = this.resolveSessionDir();
			if (!sessionDir) return;

			this.sessionDir = sessionDir;
			this.sessionMd = path.join(sessionDir, "session.md");
			this.sessionCompactMd = path.join(sessionDir, "session.compact.md");
			this.timelineJson = path.join(sessionDir, "timeline.json");

			// Create directory
			fs.mkdirSync(sessionDir, { recursive: true });

			// Write headers
			this.writeSessionMdHeader();
			this.writeCompactMdHeader();

			// Subscribe to session events
			this.unsubscribe = this.session.subscribe(this.handleEvent);

			// Subscribe to journal entries (custom entries become timeline events)
			const sessionManager = this.session.sessionManager;
			if (typeof sessionManager.onEntryAppended === "function") {
				this.unsubscribeEntries = sessionManager.onEntryAppended((entry) => this.onJournalEntryAppended(entry));
			}

			// Emit session_start timeline event
			const model = this.session.model;
			this.addTimelineEvent({
				type: "session_start",
				timestamp: this.sessionStartTimestamp,
				model: model
					? {
							provider: model.provider,
							id: model.id,
							name: model.name || model.id,
						}
					: { provider: "unknown", id: "unknown", name: "unknown" },
				contextWindow: this.session.contextWindow,
				cwd: this.session.sessionManager.getCwd(),
				thinkingLevel: this.session.thinkingLevel,
				tools: this.session.getActiveToolNames(),
				sessionName: this.session.sessionManager.getSessionName() || undefined,
			});

			// Log session start event
			this.enqueueWrite(() => {
				this.appendSessionStartEvent();
			});
		} catch (_err) {
			this.warn(
				`Cannot create debug directory: ${this.resolveDebugRoot()} — debug logging disabled for this session`,
			);
		}
	}

	getArtifacts(): SessionDebugArtifacts {
		return {
			sessionDir: this.sessionDir ?? undefined,
			sessionMd: this.sessionMd ?? undefined,
			sessionCompactMd: this.sessionCompactMd ?? undefined,
			timelineJson: this.timelineJson ?? undefined,
		};
	}

	/**
	 * Dispose the logger. Flushes all pending writes, closes handles.
	 * Call on session_end/session_shutdown.
	 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;

		// Unsubscribe
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = null;
		}
		if (this.unsubscribeEntries) {
			this.unsubscribeEntries();
			this.unsubscribeEntries = null;
		}

		// Flush and close
		this.enqueueWrite(() => {
			this.writeSessionEnd();
		});

		// Final flush — wait for queue
		this.flushSync();
	}

	// -----------------------------------------------------------------------
	// Event Handler
	// -----------------------------------------------------------------------

	private handleEvent = (event: AgentSessionEvent): void => {
		if (!this.sessionDir || this.disposed) return;

		switch (event.type) {
			case "agent_start":
				this.onAgentStart(event);
				break;
			case "agent_end":
				this.onAgentEnd(event);
				break;
			case "turn_start":
				this.onSessionTurnStart(event);
				break;
			case "turn_end":
				this.onSessionTurnEnd(event);
				break;
			case "message_start":
				this.onMessageStart(event);
				break;
			case "message_end":
				this.onMessageEnd(event);
				break;
			case "tool_execution_start":
				this.onToolExecutionStart(event);
				break;
			case "tool_execution_end":
				this.onToolExecutionEnd(event);
				break;
			case "compaction_start":
				this.onCompactionStart(event);
				break;
			case "compaction_end":
				this.onCompactionEnd(event);
				break;
			case "auto_retry_start":
				this.onAutoRetryStart(event);
				break;
			case "auto_retry_end":
				this.onAutoRetryEnd(event);
				break;
			case "xml_tool_call":
				this.onXmlToolCall(event);
				break;
			case "degraded_turn":
				this.onDegradedTurn(event);
				break;
			case "nudge":
				this.onNudge(event);
				break;
			case "tool_failure_warning":
				this.onToolFailureWarning(event);
				break;
			case "queue_update":
				this.onQueueUpdate(event);
				break;
			// message_update: no-op for logger
		}
	};

	// -----------------------------------------------------------------------
	// Event Handlers
	// -----------------------------------------------------------------------

	private onAgentStart(_event: any): void {
		if (this.seenTurnEvents) {
			// Turn events drive segmentation — agent_start only marks the run boundary.
			this.addTimelineEvent({ type: "agent_start", timestamp: Date.now() });
			return;
		}
		// Fallback: no turn events seen (older paths) — a run is one turn.
		this.openTurn();
		this.currentTurnFromAgentStart = true;
	}

	private onAgentEnd(event: any): void {
		if (this.currentTurn) {
			// Fallback mode, or a dangling turn never closed by a turn_end — close it.
			this.closeCurrentTurn(
				typeof event.stopReason === "string" ? event.stopReason : undefined,
				typeof event.errorMessage === "string" ? event.errorMessage : undefined,
			);
		}
		if (this.seenTurnEvents) {
			this.addTimelineEvent({
				type: "agent_end",
				timestamp: Date.now(),
				stopReason: typeof event.stopReason === "string" ? event.stopReason : undefined,
				errorMessage: typeof event.errorMessage === "string" ? event.errorMessage : undefined,
			});
		}
	}

	private onSessionTurnStart(_event: any): void {
		this.seenTurnEvents = true;
		if (this.currentTurn) {
			if (this.currentTurnFromAgentStart && !this.turnHasActivity(this.currentTurn)) {
				// Adopt the turn optimistically opened by agent_start — it is this LLM turn.
				this.currentTurnFromAgentStart = false;
				return;
			}
			// Dangling turn (missing turn_end) — close it before opening the next.
			this.closeCurrentTurn();
		}
		this.openTurn();
	}

	private onSessionTurnEnd(event: any): void {
		if (!this.currentTurn) return;
		const message = event.message;
		this.closeCurrentTurn(
			typeof message?.stopReason === "string" ? message.stopReason : undefined,
			typeof message?.errorMessage === "string" ? message.errorMessage : undefined,
		);
	}

	/** True when anything has already been recorded on the turn (input, tools, signals). */
	private turnHasActivity(turn: TurnState): boolean {
		return (
			turn.inputText.length > 0 ||
			turn.toolCalls.length > 0 ||
			turn.nudgeWarnings.length > 0 ||
			turn.xmlToolCalls.length > 0 ||
			turn.degradedTurns.length > 0 ||
			turn.harnessLines.length > 0 ||
			turn.steeringMessages.length > 0 ||
			turn.followUpMessages.length > 0 ||
			turn.compaction !== undefined
		);
	}

	/** Open a new turn block: increments the counter and emits the timeline turn_start. */
	private openTurn(): void {
		this.turnCounter++;
		const now = Date.now();

		this.currentTurn = {
			turn: this.turnCounter,
			turnStartTimestamp: now,
			inputText: "",
			inputImageCount: 0,
			inputLength: 0,
			toolCalls: [],
			prevCumulativeInput: this.previousCumulative.input,
			prevCumulativeOutput: this.previousCumulative.output,
			nudgeWarnings: [],
			toolFailureWarnings: [],
			xmlToolCalls: [],
			degradedTurns: [],
			harnessLines: [],
			steeringMessages: this.pendingSteeringMessages.splice(0),
			followUpMessages: this.pendingFollowUpMessages.splice(0),
			contextPercent: null,
		};
		this.currentTurnFromAgentStart = false;

		this.turnAnomalies.set(this.turnCounter, []);
		if (this.currentTurn.steeringMessages.length > 0) {
			this.addAnomaly("STEER");
		}

		// Timeline event
		this.addTimelineEvent({
			type: "turn_start",
			timestamp: now,
			turn: this.turnCounter,
			inputLength: 0,
			inputPreview: "",
		});
	}

	private closeCurrentTurn(stopReason?: string, errorMessage?: string): void {
		if (!this.currentTurn) return;

		const turn = this.currentTurn;
		const now = Date.now();

		// Capture stop reason
		if (stopReason) {
			turn.stopReason = stopReason;
			if (stopReason === "error" && errorMessage) {
				turn.errorMessage = errorMessage;
				this.addAnomaly("ERROR");
			} else if (stopReason === "aborted") {
				this.addAnomaly("ABORT");
			}
		}

		// Compute token deltas
		const deltas = this.computeTokenDeltas();
		turn.tokenDeltas = deltas;

		// Update aggregates
		this.totalInputTokens += deltas.inputTokensDelta;
		this.totalOutputTokens += deltas.outputTokensDelta;
		this.totalCost += deltas.costDelta;

		// Context usage
		try {
			const ctxUsage = this.session.getContextUsage();
			if (ctxUsage && ctxUsage.percent !== null) {
				turn.contextPercent = ctxUsage.percent;
				if (ctxUsage.percent > this.peakContextPercent) {
					this.peakContextPercent = ctxUsage.percent;
				}
				if (ctxUsage.percent > 80) {
					this.addAnomaly("CONTEXT_HIGH");
				}
			}
		} catch {
			// ignore
		}

		// Per-turn state snapshot (model, tools, todos, plan, context)
		try {
			const snapshot = this.captureTurnStateSnapshot(turn);
			turn.stateText = snapshot.stateText;
			this.addTimelineEvent({
				type: "state_snapshot",
				timestamp: now,
				turn: turn.turn,
				model: snapshot.model,
				thinkingLevel: snapshot.thinkingLevel,
				contextPercent: turn.contextPercent,
				activeTools: snapshot.activeTools,
				todos: snapshot.todos,
				plan: snapshot.plan,
			});
			if (snapshot.toolsChanged) {
				const { added, removed } = snapshot.toolsChanged;
				this.emitHarnessEvent(
					`tools changed: ${[...added.map((t) => `+${t}`), ...removed.map((t) => `-${t}`)].join(" ")}`,
					{ type: "tools_changed", timestamp: now, turn: turn.turn, added, removed },
				);
			}
		} catch {
			// ignore snapshot errors
		}

		// Vision verdict (emitted when it changes)
		try {
			const model = this.session.model;
			const verdict = model ? this.session.getVisionVerdict?.(model) : undefined;
			if (verdict && verdict !== this.lastVisionVerdict) {
				this.lastVisionVerdict = verdict;
				this.emitHarnessEvent(`vision verdict: ${verdict}`, {
					type: "vision_verdict",
					timestamp: now,
					turn: turn.turn,
					verdict,
				});
			}
		} catch {
			// ignore vision verdict errors
		}

		// Nudge evaluation (interactive mode)
		this.nudgeTurnIndex++;
		this.lastNudgeOutputTokens = deltas.outputTokensDelta;
		try {
			const nudgeContext: InteractiveNudgeContext = {
				turnIndex: this.nudgeTurnIndex,
				toolCallHistory: this.toolCallHistoryForNudges,
				fileAccessHistory: this.fileAccessHistoryForNudges,
				lastOutputTokens: this.lastNudgeOutputTokens,
			};
			const warnings = evaluateInteractiveNudges(nudgeContext);
			// Deduplicate
			const dedupedWarnings = this.deduplicateNudgeWarnings(warnings);
			for (const w of dedupedWarnings) {
				this.totalNudges++;
				this.addAnomaly(`NUDGE(${w.type})`);
				this.lastFiredNudgeTurns.set(w.type, turn.turn);
				turn.nudgeWarnings.push({
					type: w.type,
					message: w.message,
					shouldStop: false,
					timestamp: now,
				});
				this.addTimelineEvent({
					type: "nudge",
					timestamp: now,
					turn: turn.turn,
					nudgeType: w.type,
					details: w.message,
					shouldStop: false,
				});
				this.emitHarnessEvent(`nudge fired (${w.type}): ${truncate(w.message, 140)}`, {
					type: "nudge_fired",
					timestamp: now,
					turn: turn.turn,
					nudgeType: w.type,
					message: w.message,
				});
			}

			// Nudge resolution: a previously-fired type absent from this evaluation
			// is considered resolved.
			const activeTypes = new Set(warnings.map((w) => w.type));
			const resolvedTypes: string[] = [];
			for (const [type, firedTurn] of this.lastFiredNudgeTurns) {
				if (activeTypes.has(type) || firedTurn >= turn.turn) continue;
				resolvedTypes.push(type);
				this.emitHarnessEvent(`nudge resolved (${type}) after ${turn.turn - firedTurn} turn(s)`, {
					type: "nudge_resolved",
					timestamp: now,
					turn: turn.turn,
					nudgeType: type,
					turnsToResolve: turn.turn - firedTurn,
				});
			}
			for (const type of resolvedTypes) {
				this.lastFiredNudgeTurns.delete(type);
			}
		} catch {
			// ignore nudge evaluation errors
		}

		// Reset nudge shown warnings for dedup
		this.nudgeShownWarnings.clear();

		// Trim tool histories
		const maxHistory = 50;
		if (this.toolCallHistoryForNudges.length > maxHistory) {
			this.toolCallHistoryForNudges = this.toolCallHistoryForNudges.slice(-maxHistory);
		}
		if (this.fileAccessHistoryForNudges.length > maxHistory) {
			this.fileAccessHistoryForNudges = this.fileAccessHistoryForNudges.slice(-maxHistory);
		}

		// Turn duration
		const durationMs = now - turn.turnStartTimestamp;

		// Timeline turn_end
		this.addTimelineEvent({
			type: "turn_end",
			timestamp: now,
			turn: turn.turn,
			inputTokensDelta: deltas.inputTokensDelta,
			outputTokensDelta: deltas.outputTokensDelta,
			cacheReadDelta: deltas.cacheReadDelta,
			cacheWriteDelta: deltas.cacheWriteDelta,
			costDelta: deltas.costDelta,
			contextPercent: turn.contextPercent,
			stopReason: turn.stopReason || null,
			errorMessage: turn.errorMessage || undefined,
		});

		// Write turn to session.md
		this.enqueueWrite(() => {
			this.writeTurnToSessionMd(turn, durationMs);
		});

		// Write turn to session.compact.md
		this.enqueueWrite(() => {
			this.writeTurnToCompactMd(turn);
		});

		// Flush timeline incrementally
		this.enqueueWrite(() => {
			this.flushTimeline();
		});

		this.currentTurn = null;
	}

	private onMessageStart(event: any): void {
		if (!this.currentTurn) return;

		if (event.role === "user" || event.message?.role === "user") {
			const msg = event.message || event;
			const text = this.extractUserInputText(msg.content);
			const contentLength = Buffer.byteLength(text, "utf8");
			this.currentTurn.inputText = redactSecrets(text);
			this.currentTurn.inputLength = contentLength;

			// Count images
			if (Array.isArray(msg.content)) {
				this.currentTurn.inputImageCount = msg.content.filter(
					(b: any) => b.type === "image" || b.type === "image_url",
				).length;
			}

			// Update timeline turn_start with input info
			for (let i = this.timelineEvents.length - 1; i >= 0; i--) {
				if (this.timelineEvents[i].type === "turn_start" && this.timelineEvents[i].turn === this.currentTurn.turn) {
					this.timelineEvents[i].inputLength = contentLength;
					this.timelineEvents[i].inputPreview = safeJsonPreview(text, 80);
					if (this.currentTurn.inputImageCount > 0) {
						this.timelineEvents[i].imageCount = this.currentTurn.inputImageCount;
					}
					break;
				}
			}
		}
	}

	/**
	 * Extract raw text from user message content.
	 * Handles: plain string, { type: "text", text: "..." }[], or legacy formats.
	 */
	private extractUserInputText(content: unknown): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((b: any) => b.type === "text" && typeof b.text === "string")
				.map((b: any) => b.text)
				.join("\n");
		}
		return "";
	}

	private onMessageEnd(_event: any): void {
		// No-op for logger — token deltas computed at turn_end from cumulative
		// Compaction is tracked via compaction_start/compaction_end events
	}

	private onToolExecutionStart(event: any): void {
		if (!this.currentTurn) return;

		const toolCall: ToolCallEntry = {
			name: event.toolName,
			toolCallId: event.toolCallId,
			arguments: event.args || event.input || {},
			source: "structured",
			timestamp: Date.now(),
		};

		this.currentTurn.toolCalls.push(toolCall);

		this.addTimelineEvent({
			type: "tool_call",
			timestamp: toolCall.timestamp,
			turn: this.currentTurn.turn,
			toolName: toolCall.name,
			toolCallId: toolCall.toolCallId,
			arguments: toolCall.arguments,
			source: toolCall.source,
		});
	}

	private onToolExecutionEnd(event: any): void {
		if (!this.currentTurn) return;

		// Find matching tool call
		const toolCall = this.currentTurn.toolCalls.find((tc) => tc.toolCallId === event.toolCallId);

		if (!toolCall) return;

		const now = Date.now();
		const durationMs = now - toolCall.timestamp;

		// The event carries `result` (not `content`) — matches ToolExecutionEndEvent
		const rawResult = event.result ?? event.content;
		const textContent = this.extractTextFromToolResult(rawResult);
		const contentLength = Buffer.byteLength(textContent, "utf8");
		const contentPreview = safeJsonPreview(textContent, 200);

		const isError = event.isError === true;

		// rawResult is AgentToolResult { content: [...], details: {... } }
		// Store just the content array for formatting, not the full result object
		const resultContent =
			rawResult && typeof rawResult === "object" && "content" in rawResult ? (rawResult as any).content : rawResult;

		toolCall.result = {
			isError,
			content: resultContent,
			contentLength,
			contentPreview,
			durationMs,
			timestamp: now,
		};

		// Track failures
		this.compactToolFailures.push({ toolName: toolCall.name, isError });

		if (isError) {
			this.totalToolFailures++;
			// Track consecutive failures per tool
			const count = (this.toolFailureCountsMap.get(toolCall.name) || 0) + 1;
			this.toolFailureCountsMap.set(toolCall.name, count);
			this.addAnomaly("TOOL_FAIL");
		} else {
			this.toolFailureCountsMap.set(toolCall.name, 0);
		}

		this.addTimelineEvent({
			type: "tool_result",
			timestamp: now,
			turn: this.currentTurn.turn,
			toolName: toolCall.name,
			toolCallId: toolCall.toolCallId,
			isError,
			contentLength,
			contentPreview: redactSecrets(contentPreview),
			durationMs,
		});

		// Track for nudge evaluation
		const toolOutcome: ToolOutcome = {
			tool: normalizeToolName(toolCall.name),
			success: !isError,
			estimatedTokens: Math.ceil(contentLength / 4),
			file: this.extractFileFromToolResult(toolCall.name, event),
			detail: this.extractToolDetail(toolCall.name, toolCall.arguments),
			metadata: this.extractToolMetadata(event),
			callDigest: buildToolCallDigest(toolCall.name, toolCall.arguments),
			resultDigest: buildToolResultDigest(event?.result, isError),
		};
		toolOutcome.fingerprint = buildToolOutcomeFingerprint(toolOutcome);
		this.toolCallHistoryForNudges.push(toolOutcome);
		if (toolOutcome.file) {
			this.fileAccessHistoryForNudges.push(toolOutcome);
		}

		// Track for session metrics (per-tool totals, loops, verify_ui tally)
		const metricsOutcome: ToolOutcomeForMetrics = {
			tool: toolOutcome.tool,
			success: !isError,
			callDigest: toolOutcome.callDigest,
			resultDigest: toolOutcome.resultDigest,
			durationMs,
			contentLength,
			timestamp: now,
		};
		if (toolOutcome.tool === "verify_ui") {
			const verdict = this.extractVerifyUiVerdict(textContent, rawResult);
			if (verdict) metricsOutcome.verdict = verdict;
		}
		this.toolOutcomesForMetrics.push(metricsOutcome);
	}

	/** Extract a verify_ui verdict from result details or the leading word of the result text. */
	private extractVerifyUiVerdict(textContent: string, rawResult: unknown): string | undefined {
		const details = (rawResult as { details?: { verdict?: unknown } } | null)?.details;
		if (typeof details?.verdict === "string" && details.verdict) return details.verdict.toUpperCase();
		const match = textContent.match(/^\s*(PASS|FAIL|UNCLEAR|UNVERIFIABLE)\b/i);
		return match ? match[1].toUpperCase() : undefined;
	}

	private onCompactionStart(event: any): void {
		if (!this.currentTurn) {
			// Compaction outside a turn — still log it
			this.addTimelineEvent({
				type: "compaction_start",
				timestamp: Date.now(),
				reason: event.reason,
				tokensBefore: 0,
			});
			return;
		}

		// Track on current turn
		this.currentTurn.compaction = {
			reason: event.reason,
			tokensBefore: 0,
			aborted: false,
		};

		this.addTimelineEvent({
			type: "compaction_start",
			timestamp: Date.now(),
			reason: event.reason,
			tokensBefore: 0,
		});
	}

	private extractToolDetail(toolName: string, args: Record<string, unknown>): string | undefined {
		if (!args || typeof args !== "object") return undefined;
		if (toolName === "bash" && typeof args.command === "string") return args.command;
		if (toolName === "verify" && typeof args.command === "string") return args.command;
		if (toolName === "webSearch" && typeof args.query === "string") return args.query;
		if (toolName === "webFetch" && typeof args.url === "string") return args.url;
		if (toolName === "read") {
			const path =
				typeof args.filePath === "string" ? args.filePath : typeof args.path === "string" ? args.path : undefined;
			if (!path) return undefined;
			const suffix: string[] = [];
			if (typeof args.offset === "number") suffix.push(`offset=${args.offset}`);
			if (typeof args.limit === "number") suffix.push(`limit=${args.limit}`);
			return suffix.length > 0 ? `${path} (${suffix.join(", ")})` : path;
		}
		if (typeof args.filePath === "string") return args.filePath;
		if (typeof args.path === "string") return args.path;
		return undefined;
	}

	private extractToolMetadata(event: any): Record<string, unknown> | undefined {
		const details = event?.result?.details;
		return details && typeof details === "object" ? details : undefined;
	}

	private onCompactionEnd(event: any): void {
		const result: CompactionResult | undefined = event.result;
		const now = Date.now();

		if (this.currentTurn?.compaction) {
			const comp = this.currentTurn.compaction;
			comp.tokensAfter = result?.tokensBefore; // tokensBefore is the only token count available
			comp.aborted = event.aborted;
			comp.errorMessage = event.errorMessage;
			comp.durationMs = undefined; // will compute from timeline if needed

			if (event.aborted) {
				this.addAnomaly("COMPACT_FAIL");
			} else {
				this.addAnomaly("COMPACT");
				this.compactionCount++;
			}
		} else {
			// Compaction outside current turn
			if (!event.aborted) {
				this.compactionCount++;
			}
		}

		const tokensBefore = result?.tokensBefore ?? 0;
		const tokensAfter = result?.tokensBefore ?? 0; // same field, no 'after' count available

		this.addTimelineEvent({
			type: "compaction_end",
			timestamp: now,
			reason: event.reason,
			tokensBefore,
			tokensAfter,
			aborted: event.aborted,
			durationMs: undefined,
			errorMessage: event.errorMessage || undefined,
		});
	}

	private onAutoRetryStart(event: any): void {
		this.addTimelineEvent({
			type: "auto_retry_start",
			timestamp: Date.now(),
			attempt: event.attempt,
			maxAttempts: event.maxAttempts,
			delayMs: event.delayMs,
			errorMessage: event.errorMessage,
		});
		this.addAnomaly("RETRY");
		this.emitHarnessEvent(
			`retry attempt ${event.attempt}/${event.maxAttempts}: ${truncate(event.errorMessage ?? "", 120)}`,
			{
				type: "retry",
				timestamp: Date.now(),
				turn: this.currentTurn?.turn || 0,
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
			},
		);
	}

	private onAutoRetryEnd(event: any): void {
		this.addTimelineEvent({
			type: "auto_retry_end",
			timestamp: Date.now(),
			attempt: event.attempt,
			success: event.success,
			finalError: event.finalError || undefined,
		});
	}

	private onXmlToolCall(event: any): void {
		this.totalXmlFallbacks++;
		this.addAnomaly(`XML_FALLBACK(${event.toolName})`);
		if (event.severity === "critical") {
			this.addAnomaly("XML_FALLBACK_CRITICAL");
		} else if (event.severity === "elevated") {
			this.addAnomaly("XML_FALLBACK_ELEVATED");
		}

		if (this.currentTurn) {
			this.currentTurn.xmlToolCalls.push({
				name: event.toolName,
				args: event.arguments || {},
				result: event.result || null,
				iteration: event.iteration,
				callCount: event.callCount,
				assistantStopReason: event.assistantStopReason,
				assistantTextLength: event.assistantTextLength,
				severity: event.severity,
				reasons: event.reasons,
				continuationMode: event.continuationMode,
			});
		}

		this.addTimelineEvent({
			type: "tool_call",
			timestamp: Date.now(),
			turn: this.currentTurn?.turn || 0,
			toolName: event.toolName,
			toolCallId: `xml-call-${this.totalXmlFallbacks - 1}`,
			arguments: event.arguments || {},
			source: "xml",
			iteration: event.iteration,
			callCount: event.callCount,
			assistantStopReason: event.assistantStopReason,
			assistantTextLength: event.assistantTextLength,
			severity: event.severity,
			reasons: event.reasons,
			continuationMode: event.continuationMode,
		});
	}

	private onDegradedTurn(event: any): void {
		this.addAnomaly(`DEGRADED_TURN(${event.severity ?? "unknown"})`);
		if (event.severity === "critical") {
			this.addAnomaly("DEGRADED_TURN_CRITICAL");
		}

		if (this.currentTurn) {
			this.currentTurn.degradedTurns.push({
				severity: event.severity || "unknown",
				stopReason: event.stopReason,
				outputTokens: event.outputTokens ?? 0,
				textLength: event.textLength ?? 0,
				reasons: event.reasons ?? [],
				recoveryHint: event.recoveryHint,
				timestamp: Date.now(),
			});
		}

		this.addTimelineEvent({
			type: "degraded_turn",
			timestamp: Date.now(),
			turn: this.currentTurn?.turn || 0,
			severity: event.severity,
			stopReason: event.stopReason,
			outputTokens: event.outputTokens,
			textLength: event.textLength,
			reasons: event.reasons ?? [],
			recoveryHint: event.recoveryHint,
		});

		const reasons = (event.reasons ?? []).length > 0 ? ` — ${event.reasons.join(", ")}` : "";
		this.emitHarnessEvent(`stall: degraded turn (${event.severity ?? "unknown"})${reasons}`, {
			type: "stall",
			timestamp: Date.now(),
			turn: this.currentTurn?.turn || 0,
			severity: event.severity,
			stopReason: event.stopReason,
			reasons: event.reasons ?? [],
			outputTokens: event.outputTokens,
			textLength: event.textLength,
		});
	}

	private onNudge(event: any): void {
		this.totalNudges++;
		const nudgeType = event.nudgeType || event.type || "unknown";
		const message = event.message || event.details || "";
		this.addAnomaly(`NUDGE(${nudgeType})`);
		this.lastFiredNudgeTurns.set(nudgeType, this.currentTurn?.turn ?? this.turnCounter);

		if (this.currentTurn) {
			this.currentTurn.nudgeWarnings.push({
				type: nudgeType,
				message,
				shouldStop: event.shouldStop || false,
				timestamp: Date.now(),
			});
		}

		this.addTimelineEvent({
			type: "nudge",
			timestamp: Date.now(),
			turn: this.currentTurn?.turn || 0,
			nudgeType,
			details: message,
			shouldStop: event.shouldStop || false,
		});

		this.emitHarnessEvent(`nudge fired (${nudgeType}): ${truncate(message, 140)}`, {
			type: "nudge_fired",
			timestamp: Date.now(),
			turn: this.currentTurn?.turn || 0,
			nudgeType,
			message,
		});
	}

	private onToolFailureWarning(event: any): void {
		if (this.currentTurn) {
			this.currentTurn.toolFailureWarnings.push({
				toolName: event.toolName,
				failureCount: event.failureCount,
				correctiveMessage: event.correctiveMessage || "",
				timestamp: Date.now(),
			});
		}

		this.addTimelineEvent({
			type: "tool_failure_warning",
			timestamp: Date.now(),
			turn: this.currentTurn?.turn || 0,
			toolName: event.toolName,
			failureCount: event.failureCount,
			correctiveMessage: event.correctiveMessage || "",
		});
	}

	private onQueueUpdate(event: any): void {
		const steering: string[] = event.steering && event.steering.length > 0 ? [...event.steering] : [];
		const followUp: string[] = event.followUp && event.followUp.length > 0 ? [...event.followUp] : [];
		if (steering.length === 0 && followUp.length === 0) return;

		if (this.currentTurn) {
			// Track steering and follow-up messages
			if (steering.length > 0) {
				this.currentTurn.steeringMessages.push(...steering);
				this.addAnomaly("STEER");
			}
			if (followUp.length > 0) {
				this.currentTurn.followUpMessages.push(...followUp);
			}
			return;
		}

		// Between turns/runs — buffer so the next turn block picks them up.
		this.pendingSteeringMessages.push(...steering);
		this.pendingFollowUpMessages.push(...followUp);
	}

	// -----------------------------------------------------------------------
	// Journal Entries (custom entries → first-class timeline events)
	// -----------------------------------------------------------------------

	private onJournalEntryAppended(entry: SessionEntry): void {
		if (!this.sessionDir || this.disposed) return;
		if (entry.type !== "custom") return;

		const summary = this.renderCustomEntrySummary(entry.customType, entry.data);
		const timestamp = Date.parse(entry.timestamp) || Date.now();

		this.addTimelineEvent({
			type: "custom_entry",
			timestamp,
			customType: entry.customType,
			summary,
		});

		this.journalLines.push(`- ${formatUtcClock(timestamp)} · ${entry.customType} · ${summary}`);
	}

	/**
	 * Compact one-line rendering of a custom journal entry.
	 * Known types get a structured summary; anything else falls back to
	 * truncated JSON (≤120 chars).
	 */
	private renderCustomEntrySummary(customType: string, data: unknown): string {
		try {
			if (customType === TODO_JOURNAL_TYPE) {
				const snapshot = data as { items?: Array<{ status?: string; title?: string }> } | null;
				const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
				const completed = items.filter((item) => item?.status === "completed").length;
				const inProgress = items.find((item) => item?.status === "in_progress");
				let summary = `todos ${completed}/${items.length}`;
				if (inProgress?.title) summary += ` · in progress: ${inProgress.title}`;
				return summary;
			}
			if (customType === INTERACTIVE_PLAN_ARTIFACT_TYPE) {
				const artifact = data as {
					revision?: number;
					status?: string;
					steps?: unknown[];
					completedStepIndexes?: unknown[];
				} | null;
				const steps = Array.isArray(artifact?.steps) ? artifact.steps.length : 0;
				const done = Array.isArray(artifact?.completedStepIndexes) ? artifact.completedStepIndexes.length : 0;
				return `plan v${artifact?.revision ?? "?"} ${artifact?.status ?? "unknown"} · ${steps} steps · ${done}/${steps} done`;
			}
			if (customType === TASK_JOURNAL_TYPE) {
				const task = data as {
					type?: string;
					state?: string;
					usage?: { totalTokens?: number };
				} | null;
				const tokens =
					typeof task?.usage?.totalTokens === "number" ? ` · ${task.usage.totalTokens.toLocaleString()} tok` : "";
				return `task ${task?.type ?? "unknown"} · ${task?.state ?? "unknown"}${tokens}`;
			}
		} catch {
			// fall through to JSON rendering
		}
		let json: string;
		try {
			json = JSON.stringify(data) ?? "";
		} catch {
			json = String(data);
		}
		return truncate(json.replace(/\s+/g, " "), 120);
	}

	// -----------------------------------------------------------------------
	// File Writing
	// -----------------------------------------------------------------------

	private writeSessionMdHeader(): void {
		const model = this.session.model || { provider: "unknown", id: "unknown", name: "unknown" };
		const contextWindow = this.session.contextWindow;
		const cwd = this.session.sessionManager.getCwd();
		const thinkingLevel = this.session.thinkingLevel;
		const tools = this.session.getActiveToolNames();
		const sessionId = this.session.sessionManager.getSessionId();
		const sessionName = this.session.sessionManager.getSessionName();

		const header = `# Session Log

| Field | Value |
|-------|-------|
| Date | ${toUtcTimestamp(this.sessionStartTimestamp)} |
| Model | ${formatModelDisplayName(model)} |
| Context Window | ${contextWindow || "unknown"} tokens |
| Working Directory | ${cwd} |
| Thinking Level | ${thinkingLevel} |
| Tools Enabled | ${tools.join(", ")} |
| Session ID | ${sessionId}${sessionName ? ` (${sessionName})` : ""} |

---

`;

		fs.writeFileSync(this.sessionMd!, header, "utf8");
	}

	private writeTurnToSessionMd(turn: TurnState, durationMs: number): void {
		// One-line scannable turn header
		const headerParts = [
			`## Turn ${turn.turn}`,
			formatUtcClock(turn.turnStartTimestamp),
			formatDurationMs(durationMs),
		];
		if (turn.tokenDeltas) {
			headerParts.push(
				`in ${turn.tokenDeltas.inputTokensDelta.toLocaleString()} / out ${turn.tokenDeltas.outputTokensDelta.toLocaleString()}`,
			);
		}
		if (turn.contextPercent !== null) headerParts.push(`ctx ${Math.round(turn.contextPercent)}%`);
		if (turn.tokenDeltas) headerParts.push(formatCost(turn.tokenDeltas.costDelta));
		let content = `${headerParts.join(" · ")}\n\n`;

		if (turn.inputText) {
			content += `**Input:** "${truncate(redactSecrets(turn.inputText), 200)}"\n`;
			if (turn.inputImageCount > 0) {
				content += `**Input Images:** ${turn.inputImageCount}\n`;
			}
			content += "\n";
		}

		// Tool calls — one scannable line each, bounded preview underneath
		if (turn.toolCalls.length > 0) {
			for (const tc of turn.toolCalls) {
				if (!tc.result) continue;
				const r = tc.result;
				const detail =
					this.extractToolDetail(tc.name, tc.arguments as Record<string, unknown>) ??
					summarizeToolArgs(tc.arguments as Record<string, unknown>, 60);
				const label = detail ? `${tc.name} ${truncate(detail, 80)}` : tc.name;
				if (r.isError) {
					const errorText = formatToolResultContent(r.content, true).replace(/\s+/g, " ").trim();
					content += `  ✗ ${label} · ${r.durationMs}ms · ${truncate(errorText, 140)}\n`;
				} else {
					content += `  ✓ ${label} · ${r.durationMs}ms · ${formatBytes(r.contentLength)}\n`;
					const preview = formatToolResultContent(r.content, false);
					if (preview) {
						content += `    ↳ ${truncate(preview, 200).replace(/\n/g, "\\n")}\n`;
					}
				}
			}
			content += "\n";
		}

		// XML tool calls
		if (turn.xmlToolCalls.length > 0) {
			content += `**XML Tool Calls Detected:**\n`;
			for (const xml of turn.xmlToolCalls) {
				content += `- \`${xml.name}\`: \`${summarizeToolArgs(xml.args, 80)}\`\n`;
				if (xml.severity) {
					content += `  - Fallback: severity=${xml.severity}`;
					if (typeof xml.iteration === "number") content += `, iteration=${xml.iteration}`;
					if (typeof xml.callCount === "number") content += `, calls=${xml.callCount}`;
					if (typeof xml.assistantTextLength === "number") content += `, text=${xml.assistantTextLength} chars`;
					if (xml.assistantStopReason) content += `, stop=${xml.assistantStopReason}`;
					if (xml.continuationMode) content += `, continuation=${xml.continuationMode}`;
					content += `\n`;
				}
				if (xml.reasons && xml.reasons.length > 0) {
					content += `  - Reasons: ${xml.reasons.join(", ")}\n`;
				}
				if (xml.result) {
					const xmlText = formatToolResultContent(xml.result, false);
					content += `  - Result: ${truncate(xmlText, 200).replace(/\n/g, "\\n")}\n`;
				}
			}
			content += "\n";
		}

		if (turn.degradedTurns.length > 0) {
			content += `**Degraded Turn Signals:**\n`;
			for (const degraded of turn.degradedTurns) {
				content += `- severity=${degraded.severity}, output=${degraded.outputTokens}, text=${degraded.textLength}`;
				if (degraded.stopReason) content += `, stop=${degraded.stopReason}`;
				content += `\n`;
				if (degraded.reasons.length > 0) {
					content += `  - Reasons: ${degraded.reasons.join(", ")}\n`;
				}
				if (degraded.recoveryHint) {
					content += `  - Recovery: ${degraded.recoveryHint}\n`;
				}
			}
			content += "\n";
		}

		// State snapshot line
		if (turn.stateText) {
			content += `  state: ${turn.stateText}\n\n`;
		}

		// Harness-action lines (nudges, retries, stalls, tool changes, vision)
		for (const line of turn.harnessLines) {
			content += `  ⚑ ${line}\n`;
		}
		if (turn.harnessLines.length > 0) content += "\n";

		// Cache deltas (input/output/cost already shown in the header)
		if (turn.tokenDeltas && (turn.tokenDeltas.cacheReadDelta > 0 || turn.tokenDeltas.cacheWriteDelta > 0)) {
			content += `  cache: +${formatTokens(turn.tokenDeltas.cacheReadDelta)} read · +${formatTokens(turn.tokenDeltas.cacheWriteDelta)} write\n\n`;
		}

		// Compaction
		if (turn.compaction) {
			const c = turn.compaction;
			content += `## Event: Compaction\n`;
			content += `- Reason: ${c.reason}\n`;
			content += `- Tokens before: ${c.tokensBefore}\n`;
			if (c.tokensAfter !== undefined) content += `- Tokens after: ${c.tokensAfter}\n`;
			if (c.durationMs !== undefined) content += `- Duration: ${(c.durationMs / 1000).toFixed(1)}s\n`;
			content += `- Aborted: ${c.aborted}\n`;
			if (c.errorMessage) content += `- Error: ${c.errorMessage}\n`;
			content += "\n";
		}

		// Tool failure warnings
		if (turn.toolFailureWarnings.length > 0) {
			content += `**Tool Failure Warnings:**\n`;
			for (const w of turn.toolFailureWarnings) {
				content += `- Tool: ${w.toolName}, Consecutive failures: ${w.failureCount}\n`;
				content += `  - Corrective message: ${truncate(w.correctiveMessage, 150)}\n`;
			}
			content += "\n";
		}

		// Steering / Follow-up
		if (turn.steeringMessages.length > 0) {
			content += `**Steering Messages:**\n`;
			for (const s of turn.steeringMessages) {
				content += `- "${truncate(redactSecrets(s), 150)}"\n`;
			}
			content += "\n";
		}
		if (turn.followUpMessages.length > 0) {
			content += `**Follow-up Messages:**\n`;
			for (const f of turn.followUpMessages) {
				content += `- "${truncate(redactSecrets(f), 150)}"\n`;
			}
			content += "\n";
		}

		// Error/abort
		if (turn.stopReason === "error") {
			content += `**Error:** ${turn.errorMessage || "Unknown error"}\n\n`;
		} else if (turn.stopReason === "aborted") {
			content += `**Aborted by user**\n\n`;
		}

		content += `---\n\n`;

		fs.appendFileSync(this.sessionMd!, content, "utf8");
	}

	private writeCompactMdHeader(): void {
		const model = this.session.model || { provider: "unknown", id: "unknown", name: "unknown" };
		const dateStr = toSessionDateStr(this.sessionStartTimestamp);
		const modelName = model.name || model.id;

		const header = `# Session Compact — ${dateStr} | ${modelName}

Turn | Input ↓ | Output ↑ | Tools | Context | Cost | Anomaly
-----|---------|----------|-------|---------|------|--------
`;

		fs.writeFileSync(this.sessionCompactMd!, header, "utf8");
	}

	private writeTurnToCompactMd(turn: TurnState): void {
		const anomalies = this.turnAnomalies.get(turn.turn) || [];
		const anomalyStr = anomalies.length > 0 ? ` ${anomalies.join(" ")}` : "";

		// Format tool calls
		const toolsStr =
			turn.toolCalls
				.map((tc) => {
					const isError = tc.result?.isError || false;
					return formatToolForCompact(tc.name, tc.arguments as Record<string, unknown>, isError);
				})
				.join(" ") || "—";

		// Context
		const ctxStr = turn.contextPercent !== null ? padLeft(`${turn.contextPercent.toFixed(1)}%`, 5) : padLeft("?", 5);

		// Cost — cumulative at this turn
		const costStr = formatCost(this.totalCost);

		// Token counts — cumulative
		const inputStr = padLeft(formatTokens(this.totalInputTokens), 5);
		const outputStr = padLeft(formatTokens(this.totalOutputTokens), 5);

		const line = `${padLeft(turn.turn, 4)} | ${inputStr} | ${outputStr} | ${truncate(toolsStr, 50)} | ${ctxStr} | ${costStr} |${anomalyStr}\n`;

		fs.appendFileSync(this.sessionCompactMd!, line, "utf8");
	}

	private writeSessionEnd(): void {
		const totalDurationMs = Date.now() - this.sessionStartTimestamp;

		// Compute tool failure breakdown for summary
		const failureBreakdown = this.computeToolFailureBreakdown();

		// Journal section (custom journal entries collected over the session)
		if (this.journalLines.length > 0) {
			const journal = `\n## Journal\n\n${this.journalLines.join("\n")}\n`;
			fs.appendFileSync(this.sessionMd!, journal, "utf8");
		}

		// Session outcome record (outcome + derived metrics + tool totals)
		this.writeSessionOutcome();

		// Write footer to session.md
		const mdFooter = `
## Event: Session Shutdown

| Metric | Value |
|--------|-------|
| Total turns | ${this.turnCounter} |
| Total duration | ${formatDurationMs(totalDurationMs)} |
| Total cost | ${formatCost(this.totalCost)} |
`;
		fs.appendFileSync(this.sessionMd!, mdFooter, "utf8");

		// Write footer summary to session.compact.md
		const compactFooter = `
---

## Summary

| Metric | Value |
|--------|-------|
| Total turns | ${this.turnCounter} |
| Total input tokens | ${this.totalInputTokens.toLocaleString()} |
| Total output tokens | ${this.totalOutputTokens.toLocaleString()} |
| Total cost | ${formatCost(this.totalCost)} |
| Peak context usage | ${this.peakContextPercent.toFixed(1)}% |
| Compactions | ${this.compactionCount} |
| Tool failures | ${this.totalToolFailures}${failureBreakdown ? ` (${failureBreakdown})` : ""} |
| Nudges triggered | ${this.totalNudges} |
| XML fallbacks | ${this.totalXmlFallbacks} |
| Duration | ${formatDurationMs(totalDurationMs)} |
`;
		fs.appendFileSync(this.sessionCompactMd!, compactFooter, "utf8");

		// Write session_end timeline event
		this.addTimelineEvent({
			type: "session_end",
			timestamp: Date.now(),
			totalTurns: this.turnCounter,
			totalInputTokens: this.totalInputTokens,
			totalOutputTokens: this.totalOutputTokens,
			totalCost: this.totalCost,
			peakContextPercent: this.peakContextPercent,
			compactions: this.compactionCount,
			toolFailures: this.totalToolFailures,
			nudges: this.totalNudges,
			xmlFallbacks: this.totalXmlFallbacks,
			durationMs: totalDurationMs,
		});

		// Final timeline flush
		this.flushTimelineSync();
	}

	/**
	 * Write the session outcome record: an outcome summary plus derived metrics
	 * and per-tool totals in session.md, a compact outcome block in
	 * session.compact.md, and final `outcome`/`metrics` timeline events.
	 * Idempotent; callable from any mode (dispose calls it automatically).
	 */
	writeSessionOutcome(endReason: string = "session closed"): void {
		if (this.outcomeWritten || !this.sessionMd) return;
		this.outcomeWritten = true;

		const now = Date.now();
		const metrics = computeSessionMetrics({
			events: this.timelineEvents,
			toolOutcomes: this.toolOutcomesForMetrics,
			startedAt: this.sessionStartTimestamp,
			endedAt: now,
		});

		// Final todo + plan state from the journal
		let todoLine = "none";
		let planLine = "none";
		try {
			const entries = this.session.sessionManager.getEntries();
			const snapshot = readLatestTodoSnapshot(entries);
			if (snapshot && snapshot.items.length > 0) {
				const summary = summarizeTodos(snapshot);
				const pendingTitles = snapshot.items
					.filter((item) => item.status !== "completed")
					.map((item) => item.title);
				todoLine = `${summary.completed}/${summary.total} completed`;
				if (pendingTitles.length > 0) todoLine += ` · pending: ${pendingTitles.join(", ")}`;
			}
			const artifact = getLatestInteractivePlanArtifact(entries);
			if (artifact) {
				planLine = `v${artifact.revision} ${artifact.status} (${getCompletedStepCount(artifact)}/${artifact.steps.length} steps done)`;
			}
		} catch {
			// ignore journal read errors
		}

		const tokensLine = `${this.totalInputTokens.toLocaleString()} in / ${this.totalOutputTokens.toLocaleString()} out`;
		const verifyLine = `${metrics.verifyUi.pass} pass · ${metrics.verifyUi.fail} fail · ${metrics.verifyUi.unclear} unclear`;

		const outcomeMd = `
## Session Outcome

| Field | Value |
|-------|-------|
| End reason | ${endReason} |
| Duration | ${formatDurationMs(metrics.durationMs)} |
| Turns | ${metrics.turns} |
| Total tokens | ${tokensLine} |
| Total cost | ${formatCost(this.totalCost)} |
| Todos | ${todoLine} |
| Plan | ${planLine} |
| verify_ui | ${verifyLine} |

${this.renderDerivedMetricsMd(metrics)}
${this.renderToolTotalsMd(metrics)}`;
		fs.appendFileSync(this.sessionMd, outcomeMd, "utf8");

		if (this.sessionCompactMd) {
			const compactOutcome = `
## Outcome

end: ${endReason} · ${formatDurationMs(metrics.durationMs)} · ${metrics.turns} turns · ${tokensLine} · ${formatCost(this.totalCost)}
todos: ${todoLine}
plan: ${planLine}
verify_ui: ${verifyLine}
`;
			fs.appendFileSync(this.sessionCompactMd, compactOutcome, "utf8");
		}

		this.addTimelineEvent({
			type: "outcome",
			timestamp: now,
			endReason,
			durationMs: metrics.durationMs,
			turns: metrics.turns,
			totalInputTokens: this.totalInputTokens,
			totalOutputTokens: this.totalOutputTokens,
			totalCost: this.totalCost,
			todos: todoLine,
			plan: planLine,
			verifyUi: metrics.verifyUi,
		});
		this.addTimelineEvent({
			type: "metrics",
			timestamp: now,
			metrics,
		});
	}

	private renderDerivedMetricsMd(metrics: SessionMetrics): string {
		const rows: Array<[string, string]> = [
			["Duration", formatDurationMs(metrics.durationMs)],
			["Turns", String(metrics.turns)],
			["Total tokens", metrics.totalTokens.toLocaleString()],
			["Total cost", formatCost(metrics.totalCost)],
			[
				"Time to first mutation",
				metrics.timeToFirstMutationMs !== null ? formatDurationMs(metrics.timeToFirstMutationMs) : "—",
			],
			[
				"No-progress loops",
				`${metrics.loops.noProgressLoopCount}${metrics.loops.maxNoProgressRun > 0 ? ` (max run ${metrics.loops.maxNoProgressRun})` : ""}`,
			],
			[
				"Error loops",
				`${metrics.loops.errorLoopCount}${metrics.loops.maxErrorRun > 0 ? ` (max run ${metrics.loops.maxErrorRun})` : ""}`,
			],
			["Retries", String(metrics.retries)],
			["Stalls", String(metrics.stalls)],
			["Compactions", String(metrics.compactions)],
			[
				"verify_ui",
				`${metrics.verifyUi.pass} pass · ${metrics.verifyUi.fail} fail · ${metrics.verifyUi.unclear} unclear`,
			],
		];
		for (const [type, nudge] of Object.entries(metrics.nudges)) {
			const median =
				nudge.medianTurnsToResolve !== null ? ` · median ${nudge.medianTurnsToResolve} turn(s) to resolve` : "";
			rows.push([`Nudge ${type}`, `fired ${nudge.fired} · resolved ${nudge.resolved}${median}`]);
		}

		let md = `## Derived Metrics\n\n| Metric | Value |\n|--------|-------|\n`;
		for (const [label, value] of rows) {
			md += `| ${label} | ${value} |\n`;
		}
		return md;
	}

	private renderToolTotalsMd(metrics: SessionMetrics): string {
		const entries = Object.entries(metrics.tools).sort((a, b) => b[1].calls - a[1].calls);
		if (entries.length === 0) return `## Tool Totals\n\nNo tool calls recorded.\n`;
		let md = `## Tool Totals\n\n| Tool | Calls | Failures | Time | Bytes |\n|------|-------|----------|------|-------|\n`;
		for (const [name, totals] of entries) {
			md += `| ${name} | ${totals.calls} | ${totals.failures} | ${formatMsSum(totals.totalMs)} | ${formatBytes(totals.totalBytes)} |\n`;
		}
		return md;
	}

	private appendSessionStartEvent(): void {
		const tools = this.session.getActiveToolNames();
		const extensions = (this.session as any)._extensionRunner
			? (((this.session as any)._extensionRunner as any).getRegisteredCommands?.()?.length ?? 0)
			: 0;
		const model = this.session.model || { provider: "unknown", id: "unknown", name: "unknown" };

		const eventText = `
## Event: Session Start
- Model loaded: ${formatModelDisplayName(model)}
- Tools initialized: ${tools.join(", ")}
- Extensions loaded: ${extensions}

`;
		fs.appendFileSync(this.sessionMd!, eventText, "utf8");
	}

	// -----------------------------------------------------------------------
	// Timeline
	// -----------------------------------------------------------------------

	private addTimelineEvent(event: TimelineEvent): void {
		this.timelineEvents.push(event);
	}

	private flushTimeline(): void {
		// Write the current timeline as a complete JSON array (overwrite)
		const json = JSON.stringify(this.timelineEvents, null, 2);
		fs.writeFileSync(this.timelineJson!, json, "utf8");
	}

	private flushTimelineSync(): void {
		this.flushTimeline();
	}

	// -----------------------------------------------------------------------
	// Token Delta Computation
	// -----------------------------------------------------------------------

	private computeTokenDeltas(): TokenDeltas {
		const current = this.readCumulativeTokens();

		const deltas: TokenDeltas = {
			inputTokensDelta: current.input - this.previousCumulative.input,
			outputTokensDelta: current.output - this.previousCumulative.output,
			cacheReadDelta: current.cacheRead - this.previousCumulative.cacheRead,
			cacheWriteDelta: current.cacheWrite - this.previousCumulative.cacheWrite,
			costDelta: current.cost - this.previousCumulative.cost,
		};

		this.previousCumulative = current;

		return deltas;
	}

	private readCumulativeTokens(): CumulativeTokens {
		const entries = this.session.sessionManager.getEntries();
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let cost = 0;

		for (const entry of entries) {
			const msg = (entry as any).message;
			if (msg && msg.role === "assistant" && msg.usage) {
				const u = msg.usage;
				input += u.input || 0;
				output += u.output || 0;
				cacheRead += u.cacheRead || 0;
				cacheWrite += u.cacheWrite || 0;
				cost += u.cost?.total || 0;
			}
		}

		return { input, output, cacheRead, cacheWrite, cost };
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	private extractTextFromToolResult(raw: unknown): string {
		// AgentToolResult: { content: [...], details: {...} }
		if (raw && typeof raw === "object" && "content" in raw) {
			return this.extractTextFromContentBlocks((raw as any).content);
		}
		// Direct string
		if (typeof raw === "string") return raw;
		// Direct array of content blocks
		if (Array.isArray(raw)) return this.extractTextFromContentBlocks(raw);
		// Fallback
		return String(raw);
	}

	private extractTextFromContentBlocks(content: unknown): string {
		if (Array.isArray(content)) {
			return content
				.filter((block: any) => block.type === "text" && typeof block.text === "string")
				.map((block: any) => block.text)
				.join("\n");
		}
		if (typeof content === "string") return content;
		return String(content);
	}

	/**
	 * Extract file path from tool result for nudge tracking.
	 * Applies to Read, Edit, Write, Grep, Glob, Ls tools.
	 */
	private extractFileFromToolResult(toolName: string, event: any): string | undefined {
		const toolCall = this.currentTurn?.toolCalls.find((tc) => tc.toolCallId === event.toolCallId);
		return extractTrackedFileFromToolResult(
			toolName,
			(toolCall?.arguments as Record<string, unknown> | undefined) ?? undefined,
			event.result,
			this.projectRoot,
		);
	}

	/**
	 * Deduplicate nudge warnings using cooldown-based dedup.
	 * Only shows a warning type once per cooldown period.
	 */
	private deduplicateNudgeWarnings(warnings: NudgeWarning[]): NudgeWarning[] {
		const result: NudgeWarning[] = [];
		for (const w of warnings) {
			const lastShown = this.nudgeShownWarnings.get(w.type);
			if (lastShown === undefined || this.nudgeTurnIndex - lastShown >= this.dedupCooldown) {
				result.push(w);
			}
		}
		return result;
	}

	/**
	 * Emit a typed harness-action event: timeline entry plus one `⚑` line in
	 * session.md (inside the current turn block, or appended directly when the
	 * event fires outside a turn).
	 */
	private emitHarnessEvent(line: string, event: TimelineEvent): void {
		this.addTimelineEvent(event);
		if (this.currentTurn) {
			this.currentTurn.harnessLines.push(line);
			return;
		}
		if (!this.sessionMd) return;
		this.enqueueWrite(() => {
			fs.appendFileSync(this.sessionMd!, `  ⚑ ${line}\n\n`, "utf8");
		});
	}

	/**
	 * Capture the per-turn state snapshot: model, thinking level, active tools,
	 * todo summary, plan summary. Diffs active tools against the previous
	 * snapshot so callers can emit a tools_changed event.
	 */
	private captureTurnStateSnapshot(turn: TurnState): {
		stateText: string;
		model: { provider: string; id: string } | null;
		thinkingLevel: string;
		activeTools: string[];
		todos: { total: number; completed: number; inProgressTitle: string | null } | null;
		plan: { revision: number; status: string; steps: number; completedSteps: number } | null;
		toolsChanged: { added: string[]; removed: string[] } | null;
	} {
		const model = this.session.model ? { provider: this.session.model.provider, id: this.session.model.id } : null;

		let activeTools: string[] = [];
		try {
			activeTools = this.session.getActiveToolNames();
		} catch {
			// ignore
		}

		let todos: { total: number; completed: number; inProgressTitle: string | null } | null = null;
		let plan: { revision: number; status: string; steps: number; completedSteps: number } | null = null;
		try {
			const entries = this.session.sessionManager.getEntries();
			const snapshot = readLatestTodoSnapshot(entries);
			if (snapshot) todos = summarizeTodos(snapshot);
			const artifact = getLatestInteractivePlanArtifact(entries);
			if (artifact) {
				plan = {
					revision: artifact.revision,
					status: artifact.status,
					steps: artifact.steps.length,
					completedSteps: getCompletedStepCount(artifact),
				};
			}
		} catch {
			// ignore journal read errors
		}

		// Diff active tools against the previous snapshot
		let toolsChanged: { added: string[]; removed: string[] } | null = null;
		if (this.prevActiveTools) {
			const added = activeTools.filter((tool) => !this.prevActiveTools!.includes(tool));
			const removed = this.prevActiveTools.filter((tool) => !activeTools.includes(tool));
			if (added.length > 0 || removed.length > 0) toolsChanged = { added, removed };
		}
		this.prevActiveTools = [...activeTools];

		// Muted one-line state summary for session.md
		const parts: string[] = [];
		if (todos && todos.total > 0) {
			let todoPart = `todos ${todos.completed}/${todos.total}`;
			if (todos.inProgressTitle) todoPart += ` in:${todos.inProgressTitle}`;
			parts.push(todoPart);
		}
		if (plan) parts.push(`plan v${plan.revision} ${plan.status}`);
		parts.push(`tools ${activeTools.length}`);
		if (turn.contextPercent !== null) parts.push(`ctx ${Math.round(turn.contextPercent)}%`);

		return {
			stateText: parts.join(" · "),
			model,
			thinkingLevel: this.session.thinkingLevel,
			activeTools,
			todos,
			plan,
			toolsChanged,
		};
	}

	private resolveDebugRoot(): string {
		return path.join(this.projectRoot, "Debug");
	}

	private resolveSessionDir(): string | null {
		const dateTimeStr = toSessionDateTimeStr(this.sessionStartTimestamp || Date.now());
		const model = this.session.model || { provider: "unknown", id: "unknown" };
		const modelName = modelToFolderName(model.provider, model.id);
		// Subagent convention: sessions spawned as a delegate (e.g. by the
		// `subagent` extension, which sets AG1_DEBUG_SESSION_NAME for the child
		// process) get the same `subagent_<datetime>_<name>_<model>` naming as
		// built-in `task` runs, so delegated work is instantly recognizable in
		// the Debug root instead of looking like an unrelated top-level session.
		const subagentName = process.env.AG1_DEBUG_SESSION_NAME?.trim();
		const baseName = subagentName
			? `subagent_${dateTimeStr}_${sanitizeNamePart(subagentName)}_${modelName}`
			: `${dateTimeStr}_${modelName}`;
		const debugRoot = this.resolveDebugRoot();

		// Check for counter suffix
		let sessionDir = path.join(debugRoot, baseName);
		let counter = 1;
		while (fs.existsSync(sessionDir)) {
			counter++;
			sessionDir = path.join(debugRoot, `${baseName}-${counter}`);
		}

		return sessionDir;
	}

	private enqueueWrite(fn: () => void): void {
		this.writeQueue = this.writeQueue.then(fn).catch((err) => {
			console.error("[DebugLogger] Write error:", err);
		});
	}

	private flushSync(): void {
		// Wait for the write queue to drain
		// In a sync context, we just call the finalizers directly
		// since the queue is already drained by the time dispose() is called
		// in most cases. For safety, write the timeline one final time.
		try {
			this.flushTimeline();
		} catch {
			// ignore
		}
	}

	private warn(msg: string): void {
		if (!this._warned) {
			this._warned = true;
			console.error(`[DebugLogger] ${msg}`);
		}
	}

	private addAnomaly(flag: string): void {
		if (!this.currentTurn) return;
		const anomalies = this.turnAnomalies.get(this.currentTurn.turn) || [];
		// Deduplicate consecutive same-tool TOOL_FAIL flags
		if (flag === "TOOL_FAIL") {
			// Will be enhanced with count later if needed
		}
		if (!anomalies.includes(flag)) {
			anomalies.push(flag);
			this.turnAnomalies.set(this.currentTurn.turn, anomalies);
		}
	}

	private computeToolFailureBreakdown(): string {
		// Group by tool name
		const groups = new Map<string, number>();
		for (const entry of this.compactToolFailures) {
			if (!entry.isError) continue;
			groups.set(entry.toolName, (groups.get(entry.toolName) || 0) + 1);
		}

		if (groups.size === 0) return "";

		// Sort by count descending
		const sorted = Array.from(groups.entries()).sort((a, b) => b[1] - a[1]);
		return sorted.map(([name, count]) => `${count} ${name}`).join(", ");
	}
}

/**
 * Format tool for compact file: name(args_summary)✓ or name(args_summary)✗
 * Duplicated here for self-containment; also available in debug-formatters.ts.
 */
function formatToolForCompact(toolName: string, args: Record<string, unknown>, isError: boolean): string {
	const argsSummary = summarizeToolArgs(args, 30);
	const status = isError ? "✗" : "✓";
	return `${toolName}(${argsSummary})${status}`;
}

/** Format a timestamp as a UTC time-of-day: "14:02:11Z". */
function formatUtcClock(timestamp: number): string {
	const d = new Date(timestamp);
	const hour = String(d.getUTCHours()).padStart(2, "0");
	const min = String(d.getUTCMinutes()).padStart(2, "0");
	const sec = String(d.getUTCSeconds()).padStart(2, "0");
	return `${hour}:${min}:${sec}Z`;
}

/** Format a byte count for display: "364 B", "3.4 KB", "1.2 MB". */
function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format a summed millisecond total: sub-second stays in ms, larger uses m/s. */
function formatMsSum(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return formatDurationMs(ms);
}
