/**
 * Session Debug Logger — Non-blocking session debug logger.
 *
 * Records every agent session to disk for post-mortem analysis,
 * model benchmarking, and LLM-based audit.
 *
 * Writes three files per session:
 *  - session.md           — Full detailed turn-by-turn log
 *  - session.compact.md   — Compact one-line-per-turn summary
 *  - timeline.json        — Machine-parseable event timeline
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentSession, AgentSessionEvent } from "./agent-session.js";
import type { ToolOutcome } from "./auton/nudges/types.js";
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
	summarizeToolArgs,
	toSessionDateStr,
	toSessionDateTimeStr,
	toUtcTimestamp,
	truncate,
} from "./debug-formatters.js";
import { evaluateInteractiveNudges, type InteractiveNudgeContext, type NudgeWarning } from "./nudge-warnings.js";
import { extractTrackedFileFromToolResult } from "./tool-outcome-file.js";
import { buildToolOutcomeFingerprint, normalizeToolName } from "./auton/nudges/types.js";

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
	compaction?: CompactionEntry;
	steeringMessages: string[];
	followUpMessages: string[];
	stopReason?: string;
	errorMessage?: string;
	tokenDeltas?: TokenDeltas;
	contextPercent: number | null;
}

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

	// Turn tracking
	private turnCounter = 0;
	private currentTurn: TurnState | null = null;

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
			// message_update, queue_update: no-op for logger
		}
	};

	// -----------------------------------------------------------------------
	// Event Handlers
	// -----------------------------------------------------------------------

	private onAgentStart(_event: any): void {
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
			steeringMessages: [],
			followUpMessages: [],
			contextPercent: null,
		};

		this.turnAnomalies.set(this.turnCounter, []);

		// Timeline event
		this.addTimelineEvent({
			type: "turn_start",
			timestamp: now,
			turn: this.turnCounter,
			inputLength: 0,
			inputPreview: "",
		});
	}

	private onAgentEnd(event: any): void {
		if (!this.currentTurn) return;

		const turn = this.currentTurn;
		const now = Date.now();

		// Capture stop reason
		if (event.stopReason) {
			turn.stopReason = event.stopReason;
			if (event.stopReason === "error" && event.errorMessage) {
				turn.errorMessage = event.errorMessage;
				this.addAnomaly("ERROR");
			} else if (event.stopReason === "aborted") {
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
		};
		toolOutcome.fingerprint = buildToolOutcomeFingerprint(toolOutcome);
		this.toolCallHistoryForNudges.push(toolOutcome);
		if (toolOutcome.file) {
			this.fileAccessHistoryForNudges.push(toolOutcome);
		}
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
	}

	private onNudge(event: any): void {
		this.totalNudges++;
		const nudgeType = event.nudgeType || event.type || "unknown";
		this.addAnomaly(`NUDGE(${nudgeType})`);

		if (this.currentTurn) {
			this.currentTurn.nudgeWarnings.push({
				type: nudgeType,
				message: event.message || event.details || "",
				shouldStop: event.shouldStop || false,
				timestamp: Date.now(),
			});
		}

		this.addTimelineEvent({
			type: "nudge",
			timestamp: Date.now(),
			turn: this.currentTurn?.turn || 0,
			nudgeType,
			details: event.message || event.details || "",
			shouldStop: event.shouldStop || false,
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
		if (!this.currentTurn) return;
		// Track steering and follow-up messages
		if (event.steering && event.steering.length > 0) {
			this.currentTurn.steeringMessages.push(...event.steering);
			this.addAnomaly("STEER");
		}
		if (event.followUp && event.followUp.length > 0) {
			this.currentTurn.followUpMessages.push(...event.followUp);
		}
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
		let content = `## Turn ${turn.turn}\n\n`;
		content += `**Input:** "${truncate(redactSecrets(turn.inputText), 200)}"\n`;
		if (turn.inputImageCount > 0) {
			content += `**Input Images:** ${turn.inputImageCount}\n`;
		}
		content += "\n";

		// Tool calls
		const successfulToolCalls = turn.toolCalls.filter((tc) => tc.result && !tc.result.isError);
		const errorToolCalls = turn.toolCalls.filter((tc) => tc.result?.isError);

		if (successfulToolCalls.length > 0) {
			content += `**Model → Tool Calls:**\n`;
			for (const tc of successfulToolCalls) {
				const r = tc.result!;
				const resultText = formatToolResultContent(r.content, false);
				content += `- \`${tc.name}\` (id: ${tc.toolCallId}): \`${summarizeToolArgs(tc.arguments as Record<string, unknown>, 80)}\`\n`;
				content += `  - **Result (${r.durationMs}ms):** ${r.contentLength} bytes output\n`;
				content += `  - ${truncate(resultText, 200).replace(/\n/g, "\\n")}\n`;
			}
			content += "\n";
		}

		if (errorToolCalls.length > 0) {
			content += `**Model → Tool Calls (Errors):**\n`;
			for (const tc of errorToolCalls) {
				const r = tc.result!;
				const errorText = formatToolResultContent(r.content, true);
				content += `- \`${tc.name}\` (id: ${tc.toolCallId}): \`${summarizeToolArgs(tc.arguments as Record<string, unknown>, 80)}\`\n`;
				content += `  - **Error (${r.durationMs}ms):** ${truncate(errorText, 500).replace(/\n/g, "\\n")}\n`;
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

		// Token deltas
		if (turn.tokenDeltas) {
			const d = turn.tokenDeltas;
			content += `**Token Usage (Turn Delta):**\n`;
			content += `- Input: +${formatTokens(d.inputTokensDelta)}, Output: +${formatTokens(d.outputTokensDelta)}\n`;
			content += `- Cache Read: +${formatTokens(d.cacheReadDelta)}, Cache_Write: +${formatTokens(d.cacheWriteDelta)}\n`;
			content += `- Cost: ${formatCost(d.costDelta)}\n`;
			content += "\n";
		}

		// Context usage
		if (turn.contextPercent !== null) {
			content += `**Context Usage:** ${turn.contextPercent.toFixed(1)}%\n\n`;
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

		// Nudge evaluations
		if (turn.nudgeWarnings.length > 0) {
			content += `**Nudge Evaluations:**\n`;
			for (const n of turn.nudgeWarnings) {
				content += `- Type: ${n.type}, shouldStop: ${n.shouldStop}, Message: ${truncate(n.message, 150)}\n`;
			}
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

		// Duration
		content += `**Duration:** ${formatDurationMs(durationMs)}\n`;

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

	private resolveDebugRoot(): string {
		return path.join(this.projectRoot, "Debug");
	}

	private resolveSessionDir(): string | null {
		const dateTimeStr = toSessionDateTimeStr(this.sessionStartTimestamp || Date.now());
		const model = this.session.model || { provider: "unknown", id: "unknown" };
		const modelName = modelToFolderName(model.provider, model.id);
		const baseName = `${dateTimeStr}_${modelName}`;
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
