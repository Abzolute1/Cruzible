import { describe, expect, it } from "vitest";
import type { SessionStats } from "../src/core/agent-session.js";
import { formatSessionInfo } from "../src/modes/interactive/interactive-command-presenters.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("interactive command presenters", () => {
	it("shows context attribution in session info", () => {
		initTheme("dark", false);
		const stats: SessionStats = {
			sessionFile: "/tmp/session.jsonl",
			sessionId: "session-1",
			userMessages: 1,
			assistantMessages: 1,
			toolCalls: 1,
			toolResults: 1,
			totalMessages: 3,
			tokens: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				total: 15,
			},
			cost: 0,
			contextUsage: {
				tokens: 300,
				contextWindow: 10_000,
				percent: 3,
				estimated: true,
				attribution: {
					systemPrompt: 50,
					toolSchemas: 60,
					retainedTranscript: 70,
					summaries: 80,
					toolOutputs: 40,
					estimatedTotal: 300,
					overhead: 0,
				},
			},
		};

		const output = formatSessionInfo({ stats });

		expect(output).toContain("Context Attribution");
		expect(output).toContain("System Prompt:");
		expect(output).toContain("Tool Schemas:");
		expect(output).toContain("Retained Transcript:");
		expect(output).toContain("Summaries:");
		expect(output).toContain("Tool Outputs:");
	});
});
