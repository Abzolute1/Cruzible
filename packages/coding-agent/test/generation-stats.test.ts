import { describe, expect, it } from "vitest";
import { GenerationStatsTracker } from "../src/modes/interactive/generation-stats.js";

const T0 = 1_800_000_000_000;

function assistantMessage(content: unknown, usage?: { totalTokens: number }) {
	return { role: "assistant", content, usage };
}

describe("GenerationStatsTracker", () => {
	it("reports thinking phase, estimated tokens, rate and elapsed", () => {
		const tracker = new GenerationStatsTracker();
		tracker.handleEvent({ type: "agent_start" }, T0);
		tracker.handleEvent({ type: "message_start", message: assistantMessage([]) }, T0);
		tracker.handleEvent(
			{ type: "message_update", message: assistantMessage([{ type: "thinking", thinking: "x".repeat(200) }]) },
			T0 + 1000,
		);
		tracker.handleEvent(
			{ type: "message_update", message: assistantMessage([{ type: "thinking", thinking: "x".repeat(600) }]) },
			T0 + 3000,
		);
		const line = tracker.statsLine(T0 + 3000);
		expect(line).toBeDefined();
		expect(line!.tone).toBe("normal");
		expect(line!.text).toContain("Thinking…");
		expect(line!.text).toContain("~150 tok"); // 600 chars / 4
		expect(line!.text).toContain("tok/s");
		expect(line!.text).toContain("0:03");
	});

	it("switches to tool_args and tool_run phases", () => {
		const tracker = new GenerationStatsTracker();
		tracker.handleEvent({ type: "agent_start" }, T0);
		tracker.handleEvent({ type: "message_start", message: assistantMessage([]) }, T0);
		tracker.handleEvent(
			{
				type: "message_update",
				message: assistantMessage([{ type: "toolCall", name: "write", arguments: { a: 1 } }]),
			},
			T0 + 1000,
		);
		expect(tracker.statsLine(T0 + 1000)!.text).toContain("Tool args…");
		tracker.handleEvent({ type: "tool_execution_start", toolName: "write" }, T0 + 1500);
		expect(tracker.statsLine(T0 + 1500)!.text).toContain("Running write…");
	});

	it("shows a silence counter with escalating tones", () => {
		const tracker = new GenerationStatsTracker();
		tracker.handleEvent({ type: "agent_start" }, T0);
		tracker.handleEvent({ type: "message_start", message: assistantMessage([]) }, T0);
		tracker.handleEvent(
			{ type: "message_update", message: assistantMessage([{ type: "thinking", thinking: "x".repeat(400) }]) },
			T0 + 1000,
		);
		const at20s = tracker.statsLine(T0 + 21_000);
		expect(at20s!.tone).toBe("normal");
		expect(at20s!.text).toContain("silent 20s");
		expect(tracker.statsLine(T0 + 61_000)!.tone).toBe("warn");
		expect(tracker.statsLine(T0 + 301_000)!.tone).toBe("alert");
	});

	it("uses official usage tokens once message_end arrives", () => {
		const tracker = new GenerationStatsTracker();
		tracker.handleEvent({ type: "agent_start" }, T0);
		tracker.handleEvent({ type: "message_start", message: assistantMessage([]) }, T0);
		tracker.handleEvent(
			{ type: "message_update", message: assistantMessage([{ type: "thinking", thinking: "x".repeat(400) }]) },
			T0 + 1000,
		);
		tracker.handleEvent(
			{ type: "message_end", message: assistantMessage([{ type: "text", text: "done" }], { totalTokens: 4321 }) },
			T0 + 2000,
		);
		tracker.handleEvent({ type: "message_start", message: assistantMessage([]) }, T0 + 3000);
		// turn continues; estimate keeps counting from chars but official number wins for this turn
		expect(tracker.statsLine(T0 + 3000)!.text).toContain("~4,321 tok");
	});

	it("resets on agent_start and hides stats before any assistant turn", () => {
		const tracker = new GenerationStatsTracker();
		expect(tracker.statsLine(T0)).toBeUndefined();
		tracker.handleEvent({ type: "agent_start" }, T0);
		tracker.handleEvent({ type: "message_start", message: assistantMessage([]) }, T0);
		tracker.handleEvent(
			{ type: "message_update", message: assistantMessage([{ type: "thinking", thinking: "x".repeat(400) }]) },
			T0 + 1000,
		);
		expect(tracker.statsLine(T0 + 1000)).toBeDefined();
		tracker.handleEvent({ type: "agent_start" }, T0 + 2000);
		expect(tracker.statsLine(T0 + 2000)).toBeUndefined();
	});
});
