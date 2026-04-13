import { describe, expect, test, vi } from "vitest";
import { MissingSessionCwdError } from "../src/core/session-cwd.js";
import {
	performInteractiveSessionFork,
	performInteractiveSessionResume,
} from "../src/modes/interactive/interactive-session-actions.js";

describe("interactive-session-actions", () => {
	test("applies successful fork results and reports status", async () => {
		const setEditorText = vi.fn();
		const showStatus = vi.fn();

		const result = await performInteractiveSessionFork({
			clearTransientUi: vi.fn(),
			executeFork: vi.fn(async () => ({ cancelled: false, selectedText: "restored text" })),
			applyRuntimeSessionChange: vi.fn(async () => undefined),
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("should not fail");
			}),
			setEditorText,
			showStatus,
		});

		expect(result).toEqual({ cancelled: false });
		expect(setEditorText).toHaveBeenCalledWith("restored text");
		expect(showStatus).toHaveBeenCalledWith("Forked to new session");
	});

	test("supports a custom fork success message", async () => {
		const showStatus = vi.fn();

		await performInteractiveSessionFork({
			clearTransientUi: vi.fn(),
			executeFork: vi.fn(async () => ({ cancelled: false, selectedText: "" })),
			applyRuntimeSessionChange: vi.fn(async () => undefined),
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("should not fail");
			}),
			setEditorText: vi.fn(),
			showStatus,
			successMessage: "Branched to new session",
		});

		expect(showStatus).toHaveBeenCalledWith("Branched to new session");
	});

	test("resumes with fallback cwd and reports success", async () => {
		const showStatus = vi.fn();
		const executeResume = vi
			.fn()
			.mockRejectedValueOnce(
				new MissingSessionCwdError({
					sessionFile: "/tmp/session.jsonl",
					sessionCwd: "/missing/path",
					fallbackCwd: "/tmp/project",
				}),
			)
			.mockResolvedValueOnce({ cancelled: false });

		await performInteractiveSessionResume({
			clearTransientUi: vi.fn(),
			executeResume,
			promptForMissingSessionCwd: vi.fn(async () => "/tmp/project"),
			applyRuntimeSessionChange: vi.fn(async () => undefined),
			renderCurrentSessionState: vi.fn(),
			showStatus,
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("should not fail");
			}),
		});

		expect(executeResume).toHaveBeenNthCalledWith(2, "/tmp/project");
		expect(showStatus).toHaveBeenCalledWith("Resumed session in current cwd");
	});
});
