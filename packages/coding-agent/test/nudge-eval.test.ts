import { describe, expect, test } from "vitest";
import { evaluateNudge } from "../src/core/auton/nudges/nudge-eval.js";

describe("nudge evaluation", () => {
	test("does not flag duplicate tool calls when the same tool reads different files", () => {
		const result = evaluateNudge({
			turnIndex: 3,
			isContinuation: false,
			toolCallHistory: [
				{ tool: "read", success: true, file: "src/a.ts", detail: "src/a.ts" },
				{ tool: "read", success: true, file: "src/b.ts", detail: "src/b.ts" },
				{ tool: "read", success: true, file: "src/c.ts", detail: "src/c.ts" },
			],
			fileAccessHistory: [],
		});

		expect(result.shouldNudge).toBe(false);
	});

	test("detects lowercase verify failures", () => {
		const result = evaluateNudge({
			turnIndex: 3,
			isContinuation: false,
			toolCallHistory: [
				{ tool: "verify", success: false, detail: "npm test" },
				{ tool: "verify", success: false, detail: "npm test" },
				{ tool: "verify", success: false, detail: "npm test" },
			],
			fileAccessHistory: [],
		});

		expect(result.shouldNudge).toBe(true);
		expect(result.nudgeType).toBe("pivot");
	});

	test("tracks wasted lowercase read tokens and resets after file mutation", () => {
		const looped = evaluateNudge({
			turnIndex: 4,
			isContinuation: false,
			toolCallHistory: [
				{ tool: "read", success: true, file: "src/app.ts", detail: "src/app.ts:1-100", estimatedTokens: 9000 },
				{ tool: "read", success: true, file: "src/app.ts", detail: "src/app.ts:101-200", estimatedTokens: 9000 },
				{ tool: "read", success: true, file: "src/app.ts", detail: "src/app.ts:201-300", estimatedTokens: 9000 },
			],
			fileAccessHistory: [],
		});
		expect(looped.shouldStop).toBe(true);
		expect(looped.nudgeType).toBe("break_loop");

		const reset = evaluateNudge({
			turnIndex: 5,
			isContinuation: false,
			toolCallHistory: [
				{ tool: "read", success: true, file: "src/app.ts", detail: "src/app.ts:1-100", estimatedTokens: 9000 },
				{ tool: "read", success: true, file: "src/app.ts", detail: "src/app.ts:101-200", estimatedTokens: 9000 },
				{ tool: "edit", success: true, file: "src/app.ts", detail: "src/app.ts" },
				{ tool: "read", success: true, file: "src/app.ts", detail: "src/app.ts:201-300", estimatedTokens: 9000 },
			],
			fileAccessHistory: [],
		});
		expect(reset.shouldNudge).toBe(false);
	});
});
