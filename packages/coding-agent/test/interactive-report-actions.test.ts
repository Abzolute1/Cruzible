import { existsSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	getInteractiveWorkspaceSummary,
	renderInteractiveDebugLogStatus,
	renderInteractiveResearchArtifacts,
	renderInteractiveSessionInfo,
	writeInteractiveDebugLog,
} from "../src/modes/interactive/interactive-report-actions.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { RESEARCH_ARTIFACT_ENTRY_TYPE } from "../src/core/research-artifacts.js";

describe("interactive-report-actions", () => {
	const debugLogPath = "/tmp/ag1-debug-report-test.log";

	beforeEach(() => {
		initTheme("dark", false);
	});

	afterEach(() => {
		if (existsSync(debugLogPath)) {
			rmSync(debugLogPath, { force: true });
		}
	});

	test("renders session info through the shared presenter", () => {
		const chatContainer = { addChild: vi.fn() };
		const ui = { requestRender: vi.fn() };

		renderInteractiveSessionInfo({
			chatContainer,
			ui,
			stats: {
				sessionFile: "/tmp/session.jsonl",
				sessionId: "abc",
				userMessages: 1,
				assistantMessages: 2,
				toolCalls: 3,
				toolResults: 3,
				totalMessages: 6,
				tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
				cost: 0,
			},
			sessionName: "demo",
		});

		expect(chatContainer.addChild).toHaveBeenCalledOnce();
		expect(ui.requestRender).toHaveBeenCalledOnce();
	});

	test("renders research artifacts only when they exist", () => {
		const chatContainer = { addChild: vi.fn() };
		const ui = { requestRender: vi.fn() };
		const entries = [
			{
				type: "custom",
				customType: RESEARCH_ARTIFACT_ENTRY_TYPE,
				data: {
					version: 1,
					kind: "search",
					savedAt: "2026-04-13T10:00:00.000Z",
					query: "react 19",
					resultCount: 3,
					sourceUrls: ["https://react.dev"],
				},
			},
		];

		expect(renderInteractiveResearchArtifacts({ chatContainer, ui, sessionEntries: entries, limit: 5 })).toBe(true);
		expect(chatContainer.addChild).toHaveBeenCalledOnce();

		expect(renderInteractiveResearchArtifacts({ chatContainer, ui, sessionEntries: [], limit: 5 })).toBe(false);
	});

	test("writes debug logs and formats status output", () => {
		const logPath = writeInteractiveDebugLog({
			width: 100,
			height: 30,
			renderedLines: ["hello"],
			messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			modelId: "provider/model",
			mode: "interactive",
			stabilization: {
				level: "none",
				reasons: [],
			},
			xmlFallbackCount: 0,
			degradedTurnCount: 0,
			formatRuntimeHealthIssue: (event) => `${event.type}:${event.severity}`,
			debugLogPath,
		});

		expect(logPath).toBe(debugLogPath);

		const chatContainer = { addChild: vi.fn() };
		const ui = { requestRender: vi.fn() };
		renderInteractiveDebugLogStatus({
			chatContainer,
			ui,
			debugLogPath: logPath,
			artifacts: { sessionDir: "/tmp/debug-session" },
		});

		expect(chatContainer.addChild).toHaveBeenCalledOnce();
		expect(ui.requestRender).toHaveBeenCalledOnce();
	});

	test("returns an empty workspace summary when no workspace exists", () => {
		expect(getInteractiveWorkspaceSummary(undefined, false)).toBe("");
	});
});
