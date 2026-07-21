import { describe, expect, test } from "vitest";
import {
	getIntentControlDirective,
	isDegradedTurnDirectiveDetail,
	noteIntentControlDirective,
} from "../src/core/auton/intent-control.js";

function state(overrides: Partial<Parameters<typeof getIntentControlDirective>[0]> = {}) {
	return {
		consecutiveIntentDriftCount: 0,
		consecutiveIntentFailureCount: 0,
		replanPromptCount: 0,
		narrowScopePromptCount: 0,
		...overrides,
	};
}

function ledger(taskJournal: Parameters<typeof getIntentControlDirective>[1]["taskJournal"]) {
	return { taskJournal };
}

describe("autonomous intent control", () => {
	test("prioritizes degraded-turn recovery before ledger intent status", () => {
		expect(
			getIntentControlDirective(
				state({
					consecutiveDegradedTurnCount: 1,
					lastDegradedTurnSeverity: "elevated",
					lastDegradedTurnReasons: ["truncated_turn"],
				}),
				ledger({ intentStatus: "failed", lastIntentOutcome: "verification failed" }),
			),
		).toEqual({
			kind: "recover",
			detail: "degraded turn elevated: truncated_turn",
		});

		expect(isDegradedTurnDirectiveDetail("degraded turn critical: very_high_output_tokens")).toBe(true);
	});

	test("escalates repeated critical degraded turns to a hard stop", () => {
		expect(
			getIntentControlDirective(
				state({
					consecutiveCriticalDegradedTurnCount: 3,
					lastDegradedTurnSeverity: "critical",
					lastDegradedTurnReasons: ["very_high_output_tokens"],
				}),
				ledger({}),
			),
		).toEqual({
			kind: "stop_blocked",
			detail:
				"Autonomous run stopped after 3 consecutive critically degraded turns: degraded turn critical: very_high_output_tokens",
		});
	});

	test("escalates repeated failed intent from recover to narrow scope to stop", () => {
		expect(
			getIntentControlDirective(
				state({ consecutiveIntentFailureCount: 1 }),
				ledger({ intentStatus: "failed", lastIntentOutcome: "verification failed" }),
			),
		).toEqual({ kind: "recover", detail: "verification failed" });
		expect(
			getIntentControlDirective(
				state({ consecutiveIntentFailureCount: 2 }),
				ledger({ intentStatus: "failed", lastIntentOutcome: "verification failed" }),
			),
		).toEqual({ kind: "narrow_scope", detail: "verification failed" });
		expect(
			getIntentControlDirective(
				state({ consecutiveIntentFailureCount: 3 }),
				ledger({ intentStatus: "failed", lastIntentOutcome: "verification failed" }),
			),
		).toEqual({
			kind: "stop_blocked",
			detail: "Autonomous run stopped after 3 consecutive failed steps: verification failed",
		});
	});

	test("escalates drift through replan before stopping", () => {
		expect(
			getIntentControlDirective(
				state({ consecutiveIntentDriftCount: 2 }),
				ledger({ intentStatus: "drifted", nextAction: "edit src/app.ts" }),
			),
		).toEqual({ kind: "replan", detail: "edit src/app.ts" });
		expect(
			getIntentControlDirective(
				state({ consecutiveIntentDriftCount: 4 }),
				ledger({ intentStatus: "drifted", nextAction: "edit src/app.ts" }),
			),
		).toEqual({
			kind: "stop_blocked",
			detail: "Autonomous run stopped after 4 consecutive drifted steps: edit src/app.ts",
		});
	});

	test("treats pending ledger intent as no control directive", () => {
		expect(getIntentControlDirective(state(), ledger({ intentStatus: "pending" }))).toEqual({ kind: "none" });
	});

	test("updates directive counters only for replan and narrow-scope directives", () => {
		const base = state();

		expect(noteIntentControlDirective(base, { kind: "none" })).toBe(base);
		expect(noteIntentControlDirective(base, { kind: "replan", detail: "read target" })).toMatchObject({
			replanPromptCount: 1,
			narrowScopePromptCount: 0,
		});
		expect(noteIntentControlDirective(base, { kind: "narrow_scope", detail: "verify only" })).toMatchObject({
			replanPromptCount: 0,
			narrowScopePromptCount: 1,
		});
	});
});
