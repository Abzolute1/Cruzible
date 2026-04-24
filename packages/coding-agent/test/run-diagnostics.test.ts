import { describe, expect, test } from "vitest";
import { buildRunDiagnostics } from "../src/core/run-diagnostics.js";

describe("run-diagnostics", () => {
	test("labels verified but wasteful runs separately from correctness failures", () => {
		const diagnostics = buildRunDiagnostics({
			status: "ok",
			finalAnswerDetected: true,
			verifyCommand: "node --test",
			verifyStatus: "passed",
			toolSequence: ["read", "read", "edit", "bash", "read"],
			repeatedTools: "read:3",
			maxConsecutiveSameTool: 2,
			totalTokens: 42000,
			toolCallsBeforeFinalAnswer: 5,
			changedFiles: ["src/config-parser.mjs"],
			requiredChangedPaths: ["src/config-parser.mjs"],
			allowedChangedPaths: ["src/config-parser.mjs"],
			policyBlockReasons: [
				"Controlled runtime: verifier already passed after the latest mutation. Stop using tools and provide the final summary.",
			],
		});

		expect(diagnostics.failureLabels).toEqual([]);
		expect(diagnostics.wasteLabels).toEqual(
			expect.arrayContaining(["repeated_tool_calls", "post_verifier_tool_attempt", "high_token_use", "policy_blocked_waste"]),
		);
		expect(diagnostics.policyLabels).toEqual(["post_verifier_tool_block"]);
	});

	test("labels target and verification failures", () => {
		const diagnostics = buildRunDiagnostics({
			status: "error",
			finalAnswerDetected: false,
			verifyCommand: "node --test",
			verifyStatus: "failed",
			toolSequence: ["read", "edit", "bash"],
			changedFiles: ["src/wrong-file.mjs"],
			requiredChangedPaths: ["src/right-file.mjs"],
			allowedChangedPaths: ["src/right-file.mjs"],
		});

		expect(diagnostics.failureLabels).toEqual(
			expect.arrayContaining(["final_answer_missing", "verification_failed", "missing_required_change", "wrong_target"]),
		);
	});

	test("labels missing final answer after verifier pass as stopping failure", () => {
		const diagnostics = buildRunDiagnostics({
			status: "partial",
			finalAnswerDetected: false,
			verifyCommand: "node --test",
			verifyStatus: "passed",
			toolSequence: ["edit", "bash"],
			changedFiles: ["src/config-parser.mjs"],
			requiredChangedPaths: ["src/config-parser.mjs"],
			allowedChangedPaths: ["src/config-parser.mjs"],
		});

		expect(diagnostics.failureLabels).toEqual(expect.arrayContaining(["final_answer_missing", "stopping_failure"]));
		expect(diagnostics.failureLabels).not.toContain("verification_failed");
	});

	test("classifies controlled runtime block reasons", () => {
		const diagnostics = buildRunDiagnostics({
			policyBlockReasons: [
				"Controlled runtime: run the verifier exactly as specified: node --test",
				"Controlled runtime: verifier is blocked until expected mutation paths are edited: src/a.mjs.",
				"Controlled runtime: edit target src/b.mjs is outside the expected mutation set: src/a.mjs.",
				"Controlled runtime: verifier already failed with the current code (assertion). Repair before rerunning verifier: AssertionError",
				"Controlled runtime: multiple tool calls in one assistant turn are blocked.",
			],
		});

		expect(diagnostics.policyLabels).toEqual([
			"non_exact_verifier_block",
			"early_verifier_block",
			"wrong_target_block",
			"repair_loop_block",
			"multi_tool_turn_block",
		]);
	});
});
