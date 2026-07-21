import { describe, expect, it } from "vitest";
import {
	type ContinueReplayState,
	canReplayContinue,
	captureContinueReplaySnapshot,
} from "../src/core/agent-session-continue-replay.js";

describe("agent-session continue replay", () => {
	it("accepts replay when transcript, model, and thinking level are unchanged", () => {
		const state: ContinueReplayState = {
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "hello" }],
					timestamp: 1,
				},
			],
			isStreaming: false,
			model: { provider: "openai", id: "gpt-5.4-mini" },
			thinkingLevel: "medium" as const,
		};

		const snapshot = captureContinueReplaySnapshot(state);

		expect(canReplayContinue(state, snapshot)).toBe(true);
	});

	it("rejects replay when the model changed", () => {
		const state: ContinueReplayState = {
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "hello" }],
					timestamp: 1,
				},
			],
			isStreaming: false,
			model: { provider: "openai", id: "gpt-5.4-mini" },
			thinkingLevel: "medium" as const,
		};

		const snapshot = captureContinueReplaySnapshot(state);
		const changed = {
			...state,
			model: { provider: "openai", id: "gpt-5.4" },
		};

		expect(canReplayContinue(changed, snapshot)).toBe(false);
	});

	it("rejects replay when the thinking level changed", () => {
		const state: ContinueReplayState = {
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "hello" }],
					timestamp: 1,
				},
			],
			isStreaming: false,
			model: { provider: "openai", id: "gpt-5.4-mini" },
			thinkingLevel: "medium" as const,
		};

		const snapshot = captureContinueReplaySnapshot(state);
		const changed = {
			...state,
			thinkingLevel: "high" as const,
		};

		expect(canReplayContinue(changed, snapshot)).toBe(false);
	});
});
