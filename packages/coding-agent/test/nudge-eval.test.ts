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

	test("does not treat inspection-only bash churn as concrete progress", () => {
		const result = evaluateNudge({
			turnIndex: 5,
			isContinuation: true,
			toolCallHistory: [
				{ tool: "bash", success: true, detail: "find . -type f -name \"*.ts\" | head -50" },
				{ tool: "bash", success: true, detail: "ls -la" },
			],
			fileAccessHistory: [],
			trendTracker: {
				isDiminishing: () => true,
				hasRecentOutput: () => true,
				getLastOutputTokens: () => 8,
			} as any,
		});

		expect(result.shouldNudge).toBe(true);
		expect(result.nudgeType).toBe("continue");
		expect(result.shouldStop).toBe(false);
		expect(result.explanation).toContain("no concrete task progress");
	});

	test("does not hard-stop on exploration cap when there was recent concrete progress", () => {
		const result = evaluateNudge({
			turnIndex: 12,
			isContinuation: true,
			toolCallHistory: [
				{ tool: "read", success: true, file: "src/search-url.mjs", detail: "src/search-url.mjs" },
				{ tool: "edit", success: true, file: "src/search-url.mjs", detail: "preserved explicit zero limit" },
				{ tool: "read", success: true, file: "tests/search-url.test.mjs", detail: "tests/search-url.test.mjs" },
				{ tool: "read", success: true, file: "scripts/check-regression-test.mjs", detail: "scripts/check-regression-test.mjs" },
			],
			fileAccessHistory: [],
			trendTracker: {
				hasRecentOutput: () => false,
				isDiminishing: () => false,
				getLastOutputTokens: () => 0,
			} as any,
		});

		expect(result.shouldNudge).toBe(true);
		expect(result.nudgeType).toBe("continue");
		expect(result.shouldStop).toBe(false);
		expect(result.explanation).toContain("recent concrete progress");
	});

	test("does not hard-stop diminishing output immediately after a failed edit attempt", () => {
		const result = evaluateNudge({
			turnIndex: 10,
			isContinuation: true,
			toolCallHistory: [
				{ tool: "read", success: true, file: "src/search-url.mjs", detail: "src/search-url.mjs" },
				{ tool: "edit", success: false, file: "src/search-url.mjs", detail: "invalid edit command" },
				{ tool: "read", success: true, file: "tests/search-url.test.mjs", detail: "tests/search-url.test.mjs" },
			],
			fileAccessHistory: [],
			trendTracker: {
				hasRecentOutput: () => true,
				isDiminishing: () => true,
				getLastOutputTokens: () => 6,
			} as any,
		});

		expect(result.shouldNudge).toBe(true);
		expect(result.nudgeType).toBe("continue");
		expect(result.shouldStop).toBe(false);
		expect(result.explanation).toContain("failed change attempt");
	});

	test("does not hard-stop diminishing output when a recent edit still needs verification", () => {
		const result = evaluateNudge({
			turnIndex: 10,
			isContinuation: true,
			toolCallHistory: [
				{ tool: "read", success: true, file: "src/search-url.mjs", detail: "src/search-url.mjs" },
				{ tool: "edit", success: true, file: "src/search-url.mjs", detail: "preserved explicit zero limit" },
				{ tool: "ls", success: true, detail: "tests" },
				{ tool: "read", success: true, file: "tests/search-url.test.mjs", detail: "tests/search-url.test.mjs" },
			],
			fileAccessHistory: [],
			trendTracker: {
				hasRecentOutput: () => true,
				isDiminishing: () => true,
				getLastOutputTokens: () => 6,
			} as any,
		});

		expect(result.shouldNudge).toBe(true);
		expect(result.nudgeType).toBe("continue");
		expect(result.shouldStop).toBe(false);
		expect(result.explanation).toContain("recent unverified implementation progress");
	});

	test("does not hard-stop diminishing output immediately after a failed verification", () => {
		const result = evaluateNudge({
			turnIndex: 10,
			isContinuation: true,
			toolCallHistory: [
				{ tool: "read", success: true, file: "tests/render-report.test.mjs", detail: "tests/render-report.test.mjs" },
				{ tool: "read", success: true, file: "cli/render-report.mjs", detail: "cli/render-report.mjs" },
				{ tool: "bash", success: false, detail: "node --test tests/render-report.test.mjs" },
			],
			fileAccessHistory: [],
			trendTracker: {
				hasRecentOutput: () => true,
				isDiminishing: () => true,
				getLastOutputTokens: () => 6,
			} as any,
		});

		expect(result.shouldNudge).toBe(true);
		expect(result.nudgeType).toBe("continue");
		expect(result.shouldStop).toBe(false);
		expect(result.explanation).toContain("failed verification");
	});

	test("does not treat ls output mentioning tests directories as verification progress", () => {
		const result = evaluateNudge({
			turnIndex: 8,
			isContinuation: true,
			toolCallHistory: [
				{ tool: "ls", success: true, detail: "." },
				{ tool: "bash", success: true, detail: "ls cli/ src/ tests/ reference/ test/ 2>/dev/null" },
			],
			fileAccessHistory: [],
			trendTracker: {
				hasRecentOutput: () => true,
				isDiminishing: () => true,
				getLastOutputTokens: () => 6,
			} as any,
		});

		expect(result.shouldNudge).toBe(true);
		expect(result.nudgeType).toBe("continue");
		expect(result.shouldStop).toBe(false);
		expect(result.explanation).toContain("no concrete task progress");
	});

	test("does not treat piped verification previews as reliable verification progress", () => {
		const result = evaluateNudge({
			turnIndex: 8,
			isContinuation: true,
			toolCallHistory: [{ tool: "bash", success: true, detail: "node --test 2>&1 | head -50" }],
			fileAccessHistory: [],
			trendTracker: {
				hasRecentOutput: () => true,
				isDiminishing: () => true,
				getLastOutputTokens: () => 6,
			} as any,
		});

		expect(result.shouldNudge).toBe(true);
		expect(result.nudgeType).toBe("continue");
		expect(result.shouldStop).toBe(false);
		expect(result.explanation).toContain("no concrete task progress");
	});
});
