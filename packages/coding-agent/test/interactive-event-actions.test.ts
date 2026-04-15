import { Container } from "@mariozechner/pi-tui";
import { describe, expect, test, vi } from "vitest";
import {
	handleInteractiveCompactionEnd,
	handleInteractiveCompactionStart,
	handleInteractiveRecoveryReplaySkipped,
	handleInteractiveDegradedTurnEvent,
	handleInteractiveRetryEnd,
	handleInteractiveRetryStart,
	handleInteractiveXmlFallbackEvent,
} from "../src/modes/interactive/interactive-event-actions.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("interactive-event-actions", () => {
	test("tracks xml fallback warnings and updates runtime health state", () => {
		const footer = { setWarning: vi.fn() };
		const ui = { requestRender: vi.fn() };
		const showWarning = vi.fn();

		const result = handleInteractiveXmlFallbackEvent({
			event: {
				type: "xml_tool_call",
				toolName: "bash",
				arguments: { command: "npm test" },
				iteration: 2,
				callCount: 3,
				assistantStopReason: "max_tokens",
				assistantTextLength: 18000,
				severity: "critical",
				reasons: ["truncated_turn"],
				continuationMode: "guided",
			},
			currentCount: 0,
			persistRuntimeHealthSnapshot: vi.fn(),
			formatWarning: () => "XML fallback critical",
			footer,
			showWarning,
			showStatus: vi.fn(),
			ui,
		});

		expect(result.nextCount).toBe(1);
		expect(footer.setWarning).toHaveBeenCalledWith("XML fallback critical");
		expect(showWarning).toHaveBeenCalledWith("XML fallback critical");
		expect(ui.requestRender).toHaveBeenCalledOnce();
	});

	test("tracks degraded turn warnings and updates runtime health state", () => {
		const footer = { setWarning: vi.fn() };
		const ui = { requestRender: vi.fn() };
		const showStatus = vi.fn();

		const result = handleInteractiveDegradedTurnEvent({
			event: {
				type: "degraded_turn",
				severity: "warning",
				stopReason: "max_tokens",
				outputTokens: 12000,
				textLength: 32000,
				reasons: ["truncated_turn"],
				recoveryHint: "continue briefly",
			},
			currentCount: 2,
			persistRuntimeHealthSnapshot: vi.fn(),
			formatWarning: () => "Turn degraded",
			footer,
			showWarning: vi.fn(),
			showStatus,
			ui,
		});

		expect(result.nextCount).toBe(3);
		expect(footer.setWarning).toHaveBeenCalledWith("Turn degraded");
		expect(showStatus).toHaveBeenCalledWith("Turn degraded");
		expect(ui.requestRender).toHaveBeenCalledOnce();
	});

	test("rebuilds chat and appends a synthetic compaction summary on compaction end", async () => {
		initTheme("dark", false);
		const chatContainer = new Container();
		const rebuildChatFromMessages = vi.fn();
		const addMessageToChat = vi.fn();
		const footer = { invalidate: vi.fn() };
		const statusContainer = { clear: vi.fn() };
		const ui = { requestRender: vi.fn() };
		const defaultEditor: { onEscape?: (() => void) | undefined } = {};

		handleInteractiveCompactionEnd({
			event: {
				type: "compaction_end",
				reason: "manual",
				result: { tokensBefore: 123, summary: "summary" },
				aborted: false,
				willRetry: false,
			},
			defaultEditor,
			previousEscapeHandler: undefined,
			loader: undefined,
			statusContainer,
			chatContainer,
			rebuildChatFromMessages,
			addMessageToChat,
			footer,
			showError: vi.fn(),
			showStatus: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			ui,
		});

		expect(rebuildChatFromMessages).toHaveBeenCalledOnce();
		expect(addMessageToChat).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "compactionSummary",
				tokensBefore: 123,
				summary: "summary",
			}),
		);
		expect(footer.invalidate).toHaveBeenCalledOnce();
		expect(ui.requestRender).toHaveBeenCalledOnce();
	});

	test("creates retry and compaction loaders and restores handlers on end", () => {
		initTheme("dark", false);
		const statusContainer = { clear: vi.fn(), addChild: vi.fn() };
		const ui = { requestRender: vi.fn() };
		const defaultEditor: { onEscape?: (() => void) | undefined } = {};
		const session = { abortRetry: vi.fn(), abortCompaction: vi.fn() };

		const compactionStart = handleInteractiveCompactionStart({
			event: { type: "compaction_start", reason: "overflow" },
			defaultEditor,
			statusContainer,
			session,
			ui,
		});
		expect(statusContainer.addChild).toHaveBeenCalled();
		expect(compactionStart.loader).toBeDefined();

		const retryStart = handleInteractiveRetryStart({
			event: { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1500 },
			defaultEditor,
			statusContainer,
			session,
			ui,
		});
		expect(retryStart.loader).toBeDefined();

		const retryEnd = handleInteractiveRetryEnd({
			event: { type: "auto_retry_end", attempt: 1, maxAttempts: 3, success: false, finalError: "boom" },
			defaultEditor,
			previousEscapeHandler: retryStart.nextEscapeHandler,
			loader: retryStart.loader,
			statusContainer: { clear: vi.fn() },
			showError: vi.fn(),
			ui,
		});
		expect(retryEnd.loader).toBeUndefined();
	});

	test("shows a status message for compaction replay skips but not retry skips", () => {
		const showStatus = vi.fn();
		const ui = { requestRender: vi.fn() };

		handleInteractiveRecoveryReplaySkipped({
			event: {
				type: "recovery_replay_skipped",
				owner: "compaction",
				reason: "state_changed",
				message: "Auto-continue skipped because the session changed before replay.",
			},
			showStatus,
			ui,
		});
		expect(showStatus).toHaveBeenCalledWith("Auto-continue skipped because the session changed before replay.");
		expect(ui.requestRender).toHaveBeenCalledTimes(1);

		handleInteractiveRecoveryReplaySkipped({
			event: {
				type: "recovery_replay_skipped",
				owner: "retry",
				reason: "state_changed",
				message: "Retry skipped because the session changed before replay.",
			},
			showStatus,
			ui,
		});
		expect(showStatus).toHaveBeenCalledTimes(1);
		expect(ui.requestRender).toHaveBeenCalledTimes(1);
	});
});
