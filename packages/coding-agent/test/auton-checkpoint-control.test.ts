import { describe, expect, test } from "vitest";
import {
	type CheckpointControlState,
	updateCheckpointState,
	updateDegradedTurnCheckpointState,
	updateIntentCheckpointState,
} from "../src/core/auton/checkpoint-control.js";

function state(overrides: Partial<CheckpointControlState> = {}): CheckpointControlState {
	return {
		consecutiveNoToolTurns: 0,
		completionPromptCount: 0,
		verificationPromptCount: 0,
		truncatedTurnCount: 0,
		outputCapPromptCount: 0,
		consecutiveIntentDriftCount: 0,
		consecutiveIntentFailureCount: 0,
		replanPromptCount: 0,
		narrowScopePromptCount: 0,
		budgetPressureLevel: "normal",
		budgetTrimPromptCount: 0,
		budgetSqueezePromptCount: 0,
		lastAssessment: "continue",
		verificationSatisfied: false,
		...overrides,
	};
}

describe("autonomous checkpoint control", () => {
	test("updates turn assessment counters and verification fields", () => {
		expect(
			updateCheckpointState(state({ consecutiveNoToolTurns: 2 }), "confirm_completion", false, {
				hasVerificationCheckpoint: false,
				visualBlockingIssues: [],
			}),
		).toMatchObject({
			consecutiveNoToolTurns: 3,
			completionPromptCount: 1,
			verificationPromptCount: 0,
			truncatedTurnCount: 0,
			lastAssessment: "confirm_completion",
			verificationSatisfied: false,
		});

		expect(
			updateCheckpointState(state({ consecutiveNoToolTurns: 2 }), "confirm_verification", true, {
				hasVerificationCheckpoint: true,
				lastVerificationDetail: "npm test",
				visualBlockingIssues: [],
			}),
		).toMatchObject({
			consecutiveNoToolTurns: 0,
			completionPromptCount: 0,
			verificationPromptCount: 1,
			lastAssessment: "confirm_verification",
			verificationSatisfied: true,
			lastVerificationDetail: "npm test",
		});

		expect(
			updateCheckpointState(state({ truncatedTurnCount: 1 }), "truncated", false, {
				hasVerificationCheckpoint: false,
				visualBlockingIssues: [],
			}),
		).toMatchObject({
			truncatedTurnCount: 2,
			lastAssessment: "truncated",
		});
	});

	test("tracks degraded turn streaks and resets on normal turns", () => {
		const elevated = updateDegradedTurnCheckpointState(state(), {
			severity: "elevated",
			reasons: ["high_output_tokens"],
		});

		expect(elevated).toMatchObject({
			consecutiveDegradedTurnCount: 1,
			consecutiveCriticalDegradedTurnCount: 0,
			lastDegradedTurnSeverity: "elevated",
			lastDegradedTurnReasons: ["high_output_tokens"],
		});

		const critical = updateDegradedTurnCheckpointState(elevated, {
			severity: "critical",
			reasons: ["truncated_turn"],
		});

		expect(critical).toMatchObject({
			consecutiveDegradedTurnCount: 2,
			consecutiveCriticalDegradedTurnCount: 1,
			lastDegradedTurnSeverity: "critical",
			lastDegradedTurnReasons: ["truncated_turn"],
		});

		expect(updateDegradedTurnCheckpointState(critical, undefined)).toMatchObject({
			consecutiveDegradedTurnCount: 0,
			consecutiveCriticalDegradedTurnCount: 0,
			lastDegradedTurnSeverity: undefined,
			lastDegradedTurnReasons: undefined,
		});
	});

	test("tracks intent drift and failure streaks independently", () => {
		const drifted = updateIntentCheckpointState(state(), "drifted");
		expect(drifted).toMatchObject({
			consecutiveIntentDriftCount: 1,
			consecutiveIntentFailureCount: 0,
		});

		const failed = updateIntentCheckpointState(drifted, "failed");
		expect(failed).toMatchObject({
			consecutiveIntentDriftCount: 0,
			consecutiveIntentFailureCount: 1,
		});

		expect(updateIntentCheckpointState(failed, "on_track")).toMatchObject({
			consecutiveIntentDriftCount: 0,
			consecutiveIntentFailureCount: 0,
		});
	});
});
