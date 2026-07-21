import { describe, expect, test } from "vitest";
import { analyzeAssistantTurnHealth } from "../src/core/turn-health.js";

describe("turn health", () => {
	test("marks truncated high-output turns as critical", () => {
		const analysis = analyzeAssistantTurnHealth({
			role: "assistant",
			content: [{ type: "text", text: "x".repeat(50_000) }],
			api: "anthropic-messages",
			provider: "faux",
			model: "faux-1",
			usage: {
				input: 100,
				output: 15_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "length",
			timestamp: Date.now(),
		});

		expect(analysis.severity).toBe("critical");
		expect(analysis.reasons).toEqual(
			expect.arrayContaining(["truncated_turn", "very_high_output_tokens", "very_long_output_text"]),
		);
		expect(analysis.recoveryHint).toContain("Continue from the last concrete point only");
	});

	test("marks verbose but completed turns as elevated", () => {
		const analysis = analyzeAssistantTurnHealth({
			role: "assistant",
			content: [{ type: "text", text: "x".repeat(26_000) }],
			api: "anthropic-messages",
			provider: "faux",
			model: "faux-1",
			usage: {
				input: 100,
				output: 9_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 9_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		expect(analysis.severity).toBe("elevated");
		expect(analysis.reasons).toEqual(expect.arrayContaining(["high_output_tokens", "long_output_text"]));
	});

	test("does not mark authentication/configuration errors as degraded turns", () => {
		const analysis = analyzeAssistantTurnHealth({
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: "anthropic-messages",
			provider: "openai",
			model: "gpt-5.4",
			usage: {
				input: 10,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 10,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "401 Your authentication token is not from a valid issuer.",
			timestamp: Date.now(),
		});

		expect(analysis.severity).toBe("normal");
		expect(analysis.reasons).toEqual([]);
		expect(analysis.recoveryHint).toBeUndefined();
	});

	test("does not mark local backend availability errors as degraded turns", () => {
		const analysis = analyzeAssistantTurnHealth({
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: "openai-responses",
			provider: "local",
			model: "lm-studio",
			usage: {
				input: 10,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 10,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "Connection error.",
			timestamp: Date.now(),
		});

		expect(analysis.severity).toBe("normal");
		expect(analysis.reasons).toEqual([]);
		expect(analysis.recoveryHint).toBeUndefined();
	});
});
