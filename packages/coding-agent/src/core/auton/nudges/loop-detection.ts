// Loop detection over tool outcome histories.
//
// Philosophy: nudge on lack of progress, never on repeated tool usage.
// A loop is the same call producing the same outcome repeatedly — successful
// work with changing arguments or changing results must never trigger these.
// Thresholds follow OpenHands' stuck detector: 3 for identical errors,
// 4 for identical action↔outcome pairs, 6 for alternating ping-pong cycles.

import { buildToolOutcomeCallKey, buildToolOutcomeResultKey, type ToolOutcome } from "./types.js";

/** Consecutive identical failed calls before flagging an error loop. */
export const ERROR_LOOP_THRESHOLD = 3;
/** Consecutive identical call+result pairs before flagging a no-progress loop. */
export const NO_PROGRESS_LOOP_THRESHOLD = 4;
/** Number of trailing outcomes inspected for an A→B→A→B→A→B ping-pong. */
export const PING_PONG_WINDOW = 6;

export interface ErrorLoopMatch {
	tool: string;
	count: number;
}

export interface NoProgressLoopMatch {
	tool: string;
	count: number;
}

export interface PingPongMatch {
	toolA: string;
	toolB: string;
}

/**
 * The last `ERROR_LOOP_THRESHOLD` calls are the same operation and all failed.
 * Repeating an identical failing call cannot succeed — the arguments or the
 * underlying problem must change first.
 */
export function detectErrorLoop(history: ToolOutcome[]): ErrorLoopMatch | null {
	if (history.length < ERROR_LOOP_THRESHOLD) return null;
	const recent = history.slice(-ERROR_LOOP_THRESHOLD);
	if (recent.some((entry) => entry.success)) return null;
	const firstKey = buildToolOutcomeCallKey(recent[0]);
	if (!recent.every((entry) => buildToolOutcomeCallKey(entry) === firstKey)) return null;
	return { tool: recent[recent.length - 1].tool, count: recent.length };
}

/**
 * The last `NO_PROGRESS_LOOP_THRESHOLD` calls are the same operation and
 * produced the same outcome. Re-running a call whose result you already have
 * yields no new information.
 *
 * Outcomes recorded without a resultDigest all share the empty result key, so
 * identical calls with unrecorded results still count as no progress.
 */
export function detectNoProgressLoop(history: ToolOutcome[]): NoProgressLoopMatch | null {
	if (history.length < NO_PROGRESS_LOOP_THRESHOLD) return null;
	const recent = history.slice(-NO_PROGRESS_LOOP_THRESHOLD);
	const firstCall = buildToolOutcomeCallKey(recent[0]);
	const firstResult = buildToolOutcomeResultKey(recent[0]);
	const allSame = recent.every(
		(entry) => buildToolOutcomeCallKey(entry) === firstCall && buildToolOutcomeResultKey(entry) === firstResult,
	);
	if (!allSame) return null;
	return { tool: recent[recent.length - 1].tool, count: recent.length };
}

/**
 * The trailing `PING_PONG_WINDOW` outcomes alternate between exactly two
 * distinct operations (A→B→A→B→A→B) — the agent is oscillating instead of
 * deciding.
 */
export function detectPingPong(history: ToolOutcome[]): PingPongMatch | null {
	if (history.length < PING_PONG_WINDOW) return null;
	const recent = history.slice(-PING_PONG_WINDOW);
	const keyA = buildToolOutcomeCallKey(recent[0]);
	const keyB = buildToolOutcomeCallKey(recent[1]);
	if (keyA === keyB) return null;
	for (let i = 0; i < recent.length; i++) {
		const expected = i % 2 === 0 ? keyA : keyB;
		if (buildToolOutcomeCallKey(recent[i]) !== expected) return null;
	}
	return { toolA: recent[recent.length - 2].tool, toolB: recent[recent.length - 1].tool };
}
