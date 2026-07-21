/**
 * Session Metrics — pure derivation functions.
 *
 * Computes analyzer-grade metrics from a session's timeline events and tool
 * outcomes: durations, token/cost totals, time-to-first-mutation, loop
 * detection (no-progress and error runs), nudge resolution stats, per-tool
 * totals, verify_ui verdict tally, and harness friction counts (compactions,
 * stalls, retries).
 *
 * Input types are deliberately loose (structural) so the functions are easy
 * to unit-test and reusable across modes.
 */

// ============================================================================
// Types
// ============================================================================

export interface TimelineEventLike {
	type: string;
	timestamp?: number;
	turn?: number;
	[key: string]: unknown;
}

export interface ToolOutcomeLike {
	tool?: string;
	success?: boolean;
	isError?: boolean;
	callDigest?: string;
	fingerprint?: string;
	resultDigest?: string;
	file?: string;
	detail?: string;
	durationMs?: number;
	contentLength?: number;
	timestamp?: number;
	verdict?: string;
	details?: unknown;
	text?: string;
	[key: string]: unknown;
}

export interface SessionMetricsInput {
	events: TimelineEventLike[];
	toolOutcomes: ToolOutcomeLike[];
	startedAt: number;
	endedAt: number;
}

export interface LoopMetrics {
	/** Runs of ≥4 identical consecutive successful call+result digests. */
	noProgressLoopCount: number;
	maxNoProgressRun: number;
	/** Runs of ≥3 identical consecutive failed calls. */
	errorLoopCount: number;
	maxErrorRun: number;
}

export interface NudgeTypeMetrics {
	fired: number;
	resolved: number;
	medianTurnsToResolve: number | null;
}

export interface ToolMetrics {
	calls: number;
	failures: number;
	totalMs: number;
	totalBytes: number;
}

export interface VerifyUiTally {
	pass: number;
	fail: number;
	unclear: number;
}

export interface SessionMetrics {
	durationMs: number;
	turns: number;
	totalTokens: number;
	totalCost: number;
	timeToFirstMutationMs: number | null;
	loops: LoopMetrics;
	nudges: Record<string, NudgeTypeMetrics>;
	tools: Record<string, ToolMetrics>;
	verifyUi: VerifyUiTally;
	compactions: number;
	stalls: number;
	retries: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Tools whose successful execution mutates the workspace. */
const MUTATION_TOOLS = new Set(["edit", "multi_edit", "write", "str_replace", "str_replace_editor", "patch"]);

/** Minimum run length of identical successful call+result digests to count as a no-progress loop. */
export const NO_PROGRESS_RUN_THRESHOLD = 4;

/** Minimum run length of identical failed calls to count as an error loop. */
export const ERROR_RUN_THRESHOLD = 3;

const VERIFY_UI_TOOL = "verify_ui";

// ============================================================================
// Helpers
// ============================================================================

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeToolName(name: unknown): string {
	return asString(name).trim().toLowerCase();
}

function isFailure(outcome: ToolOutcomeLike): boolean {
	if (typeof outcome.success === "boolean") return !outcome.success;
	if (typeof outcome.isError === "boolean") return outcome.isError;
	return false;
}

/** Semantic identity of the call itself; empty string when nothing identifies it. */
function callKey(outcome: ToolOutcomeLike): string {
	const digest = asString(outcome.callDigest).trim() || asString(outcome.fingerprint).trim();
	if (digest) return digest;
	const file = asString(outcome.file).trim();
	const detail = asString(outcome.detail).trim();
	if (!file && !detail) return "";
	return `${normalizeToolName(outcome.tool)}|${file.toLowerCase()}|${detail.replace(/\s+/g, " ").toLowerCase()}`;
}

function resultKey(outcome: ToolOutcomeLike): string {
	return asString(outcome.resultDigest).trim();
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[mid];
	return (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Extract a verify_ui verdict from an outcome: verdict field, details.verdict, or leading word of text. */
function extractVerifyUiVerdict(outcome: ToolOutcomeLike): "pass" | "fail" | "unclear" | null {
	let raw = asString(outcome.verdict).trim();
	if (!raw && outcome.details && typeof outcome.details === "object") {
		raw = asString((outcome.details as { verdict?: unknown }).verdict).trim();
	}
	if (!raw) {
		const text = asString(outcome.text);
		const match = text.match(/^\s*(PASS|FAIL|UNCLEAR|UNVERIFIABLE)\b/i);
		if (match) raw = match[1];
	}
	if (!raw) return null;
	const upper = raw.toUpperCase();
	if (upper === "PASS") return "pass";
	if (upper === "FAIL") return "fail";
	if (upper === "UNCLEAR" || upper === "UNVERIFIABLE") return "unclear";
	return null;
}

/**
 * Outcome rows used for per-tool totals, verify_ui tally, and loop detection.
 * Prefers explicit tool outcomes; falls back to tool_result timeline events
 * when no outcomes were recorded.
 */
function collectOutcomeRows(input: SessionMetricsInput): ToolOutcomeLike[] {
	if (input.toolOutcomes.length > 0) return input.toolOutcomes;
	const rows: ToolOutcomeLike[] = [];
	for (const event of input.events) {
		if (event.type !== "tool_result") continue;
		rows.push({
			tool: asString(event.toolName),
			success: event.isError !== true,
			durationMs: asNumber(event.durationMs),
			contentLength: asNumber(event.contentLength),
			timestamp: typeof event.timestamp === "number" ? event.timestamp : undefined,
			text: asString(event.contentPreview),
		});
	}
	return rows;
}

// ============================================================================
// Derivations
// ============================================================================

function deriveTurns(events: TimelineEventLike[]): number {
	const turnEnds = events.filter((e) => e.type === "turn_end").length;
	if (turnEnds > 0) return turnEnds;
	let maxTurn = 0;
	for (const event of events) {
		if (typeof event.turn === "number" && event.turn > maxTurn) maxTurn = event.turn;
	}
	return maxTurn;
}

function deriveTokensAndCost(events: TimelineEventLike[]): { totalTokens: number; totalCost: number } {
	let tokens = 0;
	let cost = 0;
	let sawDelta = false;
	for (const event of events) {
		if (event.type !== "turn_end") continue;
		const input = asNumber(event.inputTokensDelta);
		const output = asNumber(event.outputTokensDelta);
		const costDelta = asNumber(event.costDelta);
		if (input || output || costDelta) sawDelta = true;
		tokens += input + output;
		cost += costDelta;
	}
	if (sawDelta) return { totalTokens: tokens, totalCost: cost };
	// Fallback: session-level totals carried by a terminal event.
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (event.type !== "session_end" && event.type !== "outcome") continue;
		const total = asNumber(event.totalInputTokens) + asNumber(event.totalOutputTokens);
		const totalCost = asNumber(event.totalCost);
		if (total || totalCost) return { totalTokens: total, totalCost };
	}
	return { totalTokens: tokens, totalCost: cost };
}

function deriveTimeToFirstMutation(input: SessionMetricsInput): number | null {
	let first: number | null = null;
	const consider = (timestamp: unknown): void => {
		if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return;
		if (first === null || timestamp < first) first = timestamp;
	};
	for (const event of input.events) {
		if (event.type !== "tool_result" && event.type !== "tool_execution_end" && event.type !== "tool_execution") {
			continue;
		}
		if (!MUTATION_TOOLS.has(normalizeToolName(event.toolName ?? event.name))) continue;
		if (event.isError === true) continue;
		consider(event.timestamp);
	}
	for (const outcome of input.toolOutcomes) {
		if (!MUTATION_TOOLS.has(normalizeToolName(outcome.tool))) continue;
		if (isFailure(outcome)) continue;
		consider(outcome.timestamp);
	}
	if (first === null) return null;
	return (first as number) - input.startedAt;
}

function deriveLoops(outcomes: ToolOutcomeLike[]): LoopMetrics {
	const loops: LoopMetrics = {
		noProgressLoopCount: 0,
		maxNoProgressRun: 0,
		errorLoopCount: 0,
		maxErrorRun: 0,
	};

	let noProgressRun = 0;
	let errorRun = 0;
	let prevNoProgressKey = "";
	let prevErrorKey = "";

	for (const outcome of outcomes) {
		const key = callKey(outcome);
		const failed = isFailure(outcome);

		// No-progress runs: consecutive identical successful call+result digests.
		if (!failed && key) {
			const combined = `${key}::${resultKey(outcome)}`;
			noProgressRun = combined === prevNoProgressKey ? noProgressRun + 1 : 1;
			prevNoProgressKey = combined;
		} else {
			noProgressRun = 0;
			prevNoProgressKey = "";
		}
		if (noProgressRun === NO_PROGRESS_RUN_THRESHOLD) loops.noProgressLoopCount++;
		if (noProgressRun > loops.maxNoProgressRun) loops.maxNoProgressRun = noProgressRun;

		// Error runs: consecutive identical failed calls.
		if (failed && key) {
			errorRun = key === prevErrorKey ? errorRun + 1 : 1;
			prevErrorKey = key;
		} else {
			errorRun = 0;
			prevErrorKey = "";
		}
		if (errorRun === ERROR_RUN_THRESHOLD) loops.errorLoopCount++;
		if (errorRun > loops.maxErrorRun) loops.maxErrorRun = errorRun;
	}

	return loops;
}

function deriveNudges(events: TimelineEventLike[]): Record<string, NudgeTypeMetrics> {
	const result: Record<string, NudgeTypeMetrics> = {};
	const resolutions = new Map<string, number[]>();

	const hasTypedFired = events.some((e) => e.type === "nudge_fired");
	for (const event of events) {
		if (event.type === "nudge_fired" || (!hasTypedFired && event.type === "nudge")) {
			const type = asString(event.nudgeType) || "unknown";
			if (!result[type]) result[type] = { fired: 0, resolved: 0, medianTurnsToResolve: null };
			result[type].fired++;
		} else if (event.type === "nudge_resolved") {
			const type = asString(event.nudgeType) || "unknown";
			if (!result[type]) result[type] = { fired: 0, resolved: 0, medianTurnsToResolve: null };
			result[type].resolved++;
			if (typeof event.turnsToResolve === "number" && Number.isFinite(event.turnsToResolve)) {
				const list = resolutions.get(type) ?? [];
				list.push(event.turnsToResolve);
				resolutions.set(type, list);
			}
		}
	}

	for (const [type, metrics] of Object.entries(result)) {
		metrics.medianTurnsToResolve = median(resolutions.get(type) ?? []);
	}
	return result;
}

function deriveTools(outcomes: ToolOutcomeLike[]): Record<string, ToolMetrics> {
	const tools: Record<string, ToolMetrics> = {};
	for (const outcome of outcomes) {
		const name = normalizeToolName(outcome.tool) || "unknown";
		if (!tools[name]) tools[name] = { calls: 0, failures: 0, totalMs: 0, totalBytes: 0 };
		const entry = tools[name];
		entry.calls++;
		if (isFailure(outcome)) entry.failures++;
		entry.totalMs += asNumber(outcome.durationMs);
		entry.totalBytes += asNumber(outcome.contentLength);
	}
	return tools;
}

function deriveVerifyUi(outcomes: ToolOutcomeLike[]): VerifyUiTally {
	const tally: VerifyUiTally = { pass: 0, fail: 0, unclear: 0 };
	for (const outcome of outcomes) {
		if (normalizeToolName(outcome.tool) !== VERIFY_UI_TOOL) continue;
		const verdict = extractVerifyUiVerdict(outcome);
		if (!verdict) continue;
		tally[verdict]++;
	}
	return tally;
}

function deriveCompactions(events: TimelineEventLike[]): number {
	const ends = events.filter((e) => e.type === "compaction_end");
	if (ends.length > 0) return ends.filter((e) => e.aborted !== true).length;
	return events.filter((e) => e.type === "compaction_start").length;
}

function deriveStalls(events: TimelineEventLike[]): number {
	const stalls = events.filter((e) => e.type === "stall").length;
	if (stalls > 0) return stalls;
	return events.filter((e) => e.type === "degraded_turn").length;
}

function deriveRetries(events: TimelineEventLike[]): number {
	const retries = events.filter((e) => e.type === "retry").length;
	if (retries > 0) return retries;
	return events.filter((e) => e.type === "auto_retry_start").length;
}

// ============================================================================
// Public API
// ============================================================================

/** Compute derived session metrics from timeline events and tool outcomes. */
export function computeSessionMetrics(input: SessionMetricsInput): SessionMetrics {
	const rows = collectOutcomeRows(input);
	return {
		durationMs: input.endedAt - input.startedAt,
		turns: deriveTurns(input.events),
		...deriveTokensAndCost(input.events),
		timeToFirstMutationMs: deriveTimeToFirstMutation(input),
		loops: deriveLoops(rows),
		nudges: deriveNudges(input.events),
		tools: deriveTools(rows),
		verifyUi: deriveVerifyUi(rows),
		compactions: deriveCompactions(input.events),
		stalls: deriveStalls(input.events),
		retries: deriveRetries(input.events),
	};
}
