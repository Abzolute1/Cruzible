import { describe, expect, test, vi } from "vitest";
import { MissingSessionCwdError } from "../src/core/session-cwd.js";
import {
	performInteractiveRuntimeReplacement,
	performInteractiveRuntimeTransition,
} from "../src/modes/interactive/interactive-runtime-transitions.js";

describe("interactive-runtime-transitions", () => {
	test("retries with fallback cwd when session cwd is missing", async () => {
		const clearTransientUi = vi.fn();
		const applyRuntimeSessionChange = vi.fn(async () => undefined);
		const renderCurrentSessionState = vi.fn();
		const showStatus = vi.fn();
		const promptForMissingSessionCwd = vi.fn(async () => "/tmp/project");
		const execute = vi
			.fn()
			.mockRejectedValueOnce(
				new MissingSessionCwdError({
					sessionFile: "/tmp/session.jsonl",
					sessionCwd: "/missing/path",
					fallbackCwd: "/tmp/project",
				}),
			)
			.mockResolvedValueOnce({ cancelled: false });

		await performInteractiveRuntimeTransition({
			clearTransientUi,
			execute,
			promptForMissingSessionCwd,
			applyRuntimeSessionChange,
			renderCurrentSessionState,
			showStatus,
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("should not fail");
			}),
			successMessage: (_result, usedFallbackCwd) =>
				usedFallbackCwd ? "Resumed session in current cwd" : "Resumed session",
			cancelMessage: "Resume cancelled",
			fatalPrefix: "Failed to resume session",
		});

		expect(clearTransientUi).toHaveBeenCalledTimes(1);
		expect(promptForMissingSessionCwd).toHaveBeenCalledTimes(1);
		expect(execute.mock.calls[0]).toEqual([]);
		expect(execute).toHaveBeenNthCalledWith(2, "/tmp/project");
		expect(applyRuntimeSessionChange).toHaveBeenCalledTimes(1);
		expect(renderCurrentSessionState).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith("Resumed session in current cwd");
	});

	test("shows cancel message when the user declines fallback cwd", async () => {
		const showStatus = vi.fn();
		const execute = vi.fn().mockRejectedValue(
			new MissingSessionCwdError({
				sessionFile: "/tmp/session.jsonl",
				sessionCwd: "/missing/path",
				fallbackCwd: "/tmp/project",
			}),
		);

		const result = await performInteractiveRuntimeTransition({
			clearTransientUi: vi.fn(),
			execute,
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			applyRuntimeSessionChange: vi.fn(async () => undefined),
			renderCurrentSessionState: vi.fn(),
			showStatus,
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("should not fail");
			}),
			successMessage: () => "unused",
			cancelMessage: "Import cancelled",
			fatalPrefix: "Failed to import session",
		});

		expect(result).toBeUndefined();
		expect(showStatus).toHaveBeenCalledWith("Import cancelled");
	});

	test("applies runtime replacement once for successful transitions", async () => {
		const clearTransientUi = vi.fn();
		const applyRuntimeSessionChange = vi.fn(async () => undefined);
		const renderCurrentSessionState = vi.fn();
		const afterApplied = vi.fn();

		const result = await performInteractiveRuntimeReplacement({
			clearTransientUi,
			execute: vi.fn(async () => ({ cancelled: false, selectedText: "hello" })),
			applyRuntimeSessionChange,
			renderCurrentSessionState,
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("should not fail");
			}),
			fatalPrefix: "Failed to fork session",
			afterApplied,
		});

		expect(result.cancelled).toBe(false);
		expect(clearTransientUi).toHaveBeenCalledTimes(1);
		expect(applyRuntimeSessionChange).toHaveBeenCalledTimes(1);
		expect(renderCurrentSessionState).toHaveBeenCalledTimes(1);
		expect(afterApplied).toHaveBeenCalledTimes(1);
	});

	test("returns cancelled replacement results without applying state", async () => {
		const applyRuntimeSessionChange = vi.fn(async () => undefined);
		const renderCurrentSessionState = vi.fn();
		const onCancelled = vi.fn();

		const result = await performInteractiveRuntimeReplacement({
			clearTransientUi: vi.fn(),
			execute: vi.fn(async () => ({ cancelled: true })),
			applyRuntimeSessionChange,
			renderCurrentSessionState,
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("should not fail");
			}),
			fatalPrefix: "Failed to create session",
			onCancelled,
		});

		expect(result.cancelled).toBe(true);
		expect(applyRuntimeSessionChange).not.toHaveBeenCalled();
		expect(renderCurrentSessionState).not.toHaveBeenCalled();
		expect(onCancelled).toHaveBeenCalledTimes(1);
	});
});
