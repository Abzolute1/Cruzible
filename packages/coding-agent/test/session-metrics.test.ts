import { describe, expect, test } from "vitest";
import {
	computeSessionMetrics,
	type SessionMetricsInput,
	type TimelineEventLike,
	type ToolOutcomeLike,
} from "../src/core/session-metrics.js";

const T0 = 1_000_000;

function input(partial: Partial<SessionMetricsInput>): SessionMetricsInput {
	return {
		events: [],
		toolOutcomes: [],
		startedAt: T0,
		endedAt: T0 + 60_000,
		...partial,
	};
}

function outcome(partial: Partial<ToolOutcomeLike>): ToolOutcomeLike {
	return { tool: "read", success: true, ...partial };
}

describe("computeSessionMetrics — basics", () => {
	test("computes duration, turns, tokens, and cost from turn_end events", () => {
		const metrics = computeSessionMetrics(
			input({
				events: [
					{
						type: "turn_end",
						timestamp: T0 + 1000,
						turn: 1,
						inputTokensDelta: 100,
						outputTokensDelta: 50,
						costDelta: 0.001,
					},
					{
						type: "turn_end",
						timestamp: T0 + 2000,
						turn: 2,
						inputTokensDelta: 200,
						outputTokensDelta: 25,
						costDelta: 0.002,
					},
				],
			}),
		);
		expect(metrics.durationMs).toBe(60_000);
		expect(metrics.turns).toBe(2);
		expect(metrics.totalTokens).toBe(375);
		expect(metrics.totalCost).toBeCloseTo(0.003);
	});

	test("falls back to session_end totals when no turn deltas exist", () => {
		const metrics = computeSessionMetrics(
			input({
				events: [
					{
						type: "session_end",
						timestamp: T0 + 5000,
						totalInputTokens: 1000,
						totalOutputTokens: 200,
						totalCost: 0.05,
					},
				],
			}),
		);
		expect(metrics.totalTokens).toBe(1200);
		expect(metrics.totalCost).toBeCloseTo(0.05);
	});

	test("falls back to max turn number when no turn_end events exist", () => {
		const metrics = computeSessionMetrics(
			input({
				events: [
					{ type: "tool_call", turn: 3 },
					{ type: "tool_result", turn: 5 },
				],
			}),
		);
		expect(metrics.turns).toBe(5);
	});
});

describe("computeSessionMetrics — time to first mutation", () => {
	test("returns elapsed time of the first successful mutation tool_result", () => {
		const metrics = computeSessionMetrics(
			input({
				events: [
					{ type: "tool_result", timestamp: T0 + 3000, toolName: "read", isError: false },
					{ type: "tool_result", timestamp: T0 + 8000, toolName: "edit", isError: false },
					{ type: "tool_result", timestamp: T0 + 12000, toolName: "write", isError: false },
				],
			}),
		);
		expect(metrics.timeToFirstMutationMs).toBe(8000);
	});

	test("ignores failed mutations and picks the earliest success", () => {
		const metrics = computeSessionMetrics(
			input({
				events: [
					{ type: "tool_result", timestamp: T0 + 2000, toolName: "edit", isError: true },
					{ type: "tool_result", timestamp: T0 + 9000, toolName: "edit", isError: false },
				],
			}),
		);
		expect(metrics.timeToFirstMutationMs).toBe(9000);
	});

	test("considers tool outcomes as a mutation source", () => {
		const metrics = computeSessionMetrics(
			input({
				toolOutcomes: [outcome({ tool: "str_replace", success: true, timestamp: T0 + 4444 })],
			}),
		);
		expect(metrics.timeToFirstMutationMs).toBe(4444);
	});

	test("returns null when no mutation occurred", () => {
		const metrics = computeSessionMetrics(
			input({
				events: [{ type: "tool_result", timestamp: T0 + 1000, toolName: "read", isError: false }],
				toolOutcomes: [outcome({ tool: "bash", success: true, timestamp: T0 + 1000 })],
			}),
		);
		expect(metrics.timeToFirstMutationMs).toBeNull();
	});
});

describe("computeSessionMetrics — loops", () => {
	const identical = (n: number, overrides: Partial<ToolOutcomeLike> = {}): ToolOutcomeLike[] =>
		Array.from({ length: n }, () =>
			outcome({ tool: "read", callDigest: "read|abc", resultDigest: "ok|xyz", ...overrides }),
		);

	test("counts a run of ≥4 identical successful call+result digests as one no-progress loop", () => {
		const metrics = computeSessionMetrics(input({ toolOutcomes: identical(4) }));
		expect(metrics.loops.noProgressLoopCount).toBe(1);
		expect(metrics.loops.maxNoProgressRun).toBe(4);
	});

	test("does not count runs of 3 identical outcomes", () => {
		const metrics = computeSessionMetrics(input({ toolOutcomes: identical(3) }));
		expect(metrics.loops.noProgressLoopCount).toBe(0);
		expect(metrics.loops.maxNoProgressRun).toBe(3);
	});

	test("tracks max run length across longer runs and counts two separate runs", () => {
		const other = outcome({ tool: "bash", callDigest: "bash|make", resultDigest: "ok|done" });
		const metrics = computeSessionMetrics(input({ toolOutcomes: [...identical(6), other, ...identical(4)] }));
		expect(metrics.loops.noProgressLoopCount).toBe(2);
		expect(metrics.loops.maxNoProgressRun).toBe(6);
	});

	test("a different result digest breaks the no-progress run", () => {
		const outcomes = [
			...identical(3),
			outcome({ tool: "read", callDigest: "read|abc", resultDigest: "ok|different" }),
			...identical(3),
		];
		const metrics = computeSessionMetrics(input({ toolOutcomes: outcomes }));
		expect(metrics.loops.noProgressLoopCount).toBe(0);
	});

	test("counts a run of ≥3 identical failed calls as an error loop", () => {
		const failures = identical(3, { success: false, resultDigest: "err|boom" });
		const metrics = computeSessionMetrics(input({ toolOutcomes: failures }));
		expect(metrics.loops.errorLoopCount).toBe(1);
		expect(metrics.loops.maxErrorRun).toBe(3);
		expect(metrics.loops.noProgressLoopCount).toBe(0);
	});

	test("does not count 2 identical failures; a success breaks the error run", () => {
		const outcomes = [...identical(2, { success: false }), ...identical(1), ...identical(2, { success: false })];
		const metrics = computeSessionMetrics(input({ toolOutcomes: outcomes }));
		expect(metrics.loops.errorLoopCount).toBe(0);
		expect(metrics.loops.maxErrorRun).toBe(2);
	});

	test("different failing calls do not form an error loop", () => {
		const outcomes = [
			outcome({ tool: "edit", success: false, callDigest: "edit|a" }),
			outcome({ tool: "edit", success: false, callDigest: "edit|b" }),
			outcome({ tool: "edit", success: false, callDigest: "edit|c" }),
		];
		const metrics = computeSessionMetrics(input({ toolOutcomes: outcomes }));
		expect(metrics.loops.errorLoopCount).toBe(0);
	});

	test("outcomes without any call identity do not form loops", () => {
		const outcomes = Array.from({ length: 5 }, () => outcome({ tool: "bash" }));
		const metrics = computeSessionMetrics(input({ toolOutcomes: outcomes }));
		expect(metrics.loops.noProgressLoopCount).toBe(0);
		expect(metrics.loops.errorLoopCount).toBe(0);
	});
});

describe("computeSessionMetrics — tools", () => {
	test("aggregates per-tool calls, failures, totalMs, and totalBytes", () => {
		const metrics = computeSessionMetrics(
			input({
				toolOutcomes: [
					outcome({ tool: "Read", success: true, durationMs: 10, contentLength: 100 }),
					outcome({ tool: "read", success: false, durationMs: 5, contentLength: 40 }),
					outcome({ tool: "bash", success: true, durationMs: 200, contentLength: 2048 }),
				],
			}),
		);
		expect(metrics.tools.read).toEqual({ calls: 2, failures: 1, totalMs: 15, totalBytes: 140 });
		expect(metrics.tools.bash).toEqual({ calls: 1, failures: 0, totalMs: 200, totalBytes: 2048 });
	});

	test("falls back to tool_result events when no outcomes are recorded", () => {
		const metrics = computeSessionMetrics(
			input({
				events: [
					{ type: "tool_result", toolName: "grep", isError: false, durationMs: 7, contentLength: 300 },
					{ type: "tool_result", toolName: "grep", isError: true, durationMs: 3, contentLength: 60 },
				],
			}),
		);
		expect(metrics.tools.grep).toEqual({ calls: 2, failures: 1, totalMs: 10, totalBytes: 360 });
	});
});

describe("computeSessionMetrics — nudges", () => {
	test("aggregates fired/resolved counts and median turns to resolve", () => {
		const events: TimelineEventLike[] = [
			{ type: "nudge_fired", nudgeType: "no_progress", timestamp: T0 + 1 },
			{ type: "nudge_fired", nudgeType: "no_progress", timestamp: T0 + 2 },
			{ type: "nudge_fired", nudgeType: "stale_todos", timestamp: T0 + 3 },
			{ type: "nudge_resolved", nudgeType: "no_progress", turnsToResolve: 2, timestamp: T0 + 4 },
			{ type: "nudge_resolved", nudgeType: "no_progress", turnsToResolve: 4, timestamp: T0 + 5 },
		];
		const metrics = computeSessionMetrics(input({ events }));
		expect(metrics.nudges.no_progress).toEqual({ fired: 2, resolved: 2, medianTurnsToResolve: 3 });
		expect(metrics.nudges.stale_todos).toEqual({ fired: 1, resolved: 0, medianTurnsToResolve: null });
	});

	test("median of an odd number of resolutions is the middle value", () => {
		const events: TimelineEventLike[] = [
			{ type: "nudge_resolved", nudgeType: "x", turnsToResolve: 5 },
			{ type: "nudge_resolved", nudgeType: "x", turnsToResolve: 1 },
			{ type: "nudge_resolved", nudgeType: "x", turnsToResolve: 3 },
		];
		const metrics = computeSessionMetrics(input({ events }));
		expect(metrics.nudges.x.medianTurnsToResolve).toBe(3);
	});

	test("falls back to legacy nudge events when no nudge_fired events exist", () => {
		const metrics = computeSessionMetrics(
			input({
				events: [
					{ type: "nudge", nudgeType: "loop_warning" },
					{ type: "nudge", nudgeType: "loop_warning" },
				],
			}),
		);
		expect(metrics.nudges.loop_warning.fired).toBe(2);
	});

	test("does not double-count when both legacy and typed events are present", () => {
		const metrics = computeSessionMetrics(
			input({
				events: [
					{ type: "nudge", nudgeType: "loop_warning" },
					{ type: "nudge_fired", nudgeType: "loop_warning" },
				],
			}),
		);
		expect(metrics.nudges.loop_warning.fired).toBe(1);
	});
});

describe("computeSessionMetrics — verify_ui", () => {
	test("tallies verdicts from the verdict field, details.verdict, and leading text", () => {
		const metrics = computeSessionMetrics(
			input({
				toolOutcomes: [
					outcome({ tool: "verify_ui", verdict: "PASS" }),
					outcome({ tool: "verify_ui", details: { verdict: "FAIL" } }),
					outcome({ tool: "verify_ui", text: "UNCLEAR — element not visible" }),
					outcome({ tool: "verify_ui", text: "UNVERIFIABLE: no screenshot" }),
					outcome({ tool: "verify_ui" }), // no verdict → not counted
					outcome({ tool: "read", verdict: "PASS" }), // wrong tool → not counted
				],
			}),
		);
		expect(metrics.verifyUi).toEqual({ pass: 1, fail: 1, unclear: 2 });
	});

	test("tallies verdicts from tool_result events when no outcomes exist", () => {
		const metrics = computeSessionMetrics(
			input({
				events: [
					{ type: "tool_result", toolName: "verify_ui", contentPreview: "PASS: claim holds", isError: false },
					{ type: "tool_result", toolName: "verify_ui", contentPreview: "FAIL: missing button", isError: false },
				],
			}),
		);
		expect(metrics.verifyUi).toEqual({ pass: 1, fail: 1, unclear: 0 });
	});
});

describe("computeSessionMetrics — friction counts", () => {
	test("counts completed compactions, stalls, and retries with legacy fallbacks", () => {
		const metrics = computeSessionMetrics(
			input({
				events: [
					{ type: "compaction_end", aborted: false },
					{ type: "compaction_end", aborted: true },
					{ type: "stall", severity: "elevated" },
					{ type: "degraded_turn", severity: "critical" },
					{ type: "retry", attempt: 1 },
					{ type: "auto_retry_start", attempt: 1 },
				],
			}),
		);
		expect(metrics.compactions).toBe(1);
		expect(metrics.stalls).toBe(1); // typed stall events win over degraded_turn
		expect(metrics.retries).toBe(1); // typed retry events win over auto_retry_start
	});

	test("legacy fallback: degraded_turn and auto_retry_start counted when no typed events", () => {
		const metrics = computeSessionMetrics(
			input({
				events: [
					{ type: "degraded_turn", severity: "elevated" },
					{ type: "degraded_turn", severity: "critical" },
					{ type: "auto_retry_start", attempt: 1 },
					{ type: "compaction_start" },
				],
			}),
		);
		expect(metrics.stalls).toBe(2);
		expect(metrics.retries).toBe(1);
		expect(metrics.compactions).toBe(1);
	});
});
