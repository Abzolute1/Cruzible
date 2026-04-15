import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import { MissingSessionCwdError } from "../../core/session-cwd.js";
import {
	performInteractiveRuntimeReplacement,
	performInteractiveRuntimeTransition,
} from "./interactive-runtime-transitions.js";

export async function performInteractiveSessionFork(options: {
	clearTransientUi: () => void;
	executeFork: () => Promise<Awaited<ReturnType<AgentSessionRuntime["fork"]>>>;
	applyRuntimeSessionChange: () => Promise<void>;
	renderCurrentSessionState: () => void;
	handleFatalRuntimeError: (prefix: string, error: unknown) => Promise<never>;
	setEditorText: (text: string) => void;
	showStatus: (message: string) => void;
	successMessage?: string;
}): Promise<{ cancelled: boolean }> {
	const result = await performInteractiveRuntimeReplacement({
		clearTransientUi: options.clearTransientUi,
		execute: options.executeFork,
		applyRuntimeSessionChange: options.applyRuntimeSessionChange,
		renderCurrentSessionState: options.renderCurrentSessionState,
		handleFatalRuntimeError: options.handleFatalRuntimeError,
		fatalPrefix: "Failed to fork session",
		afterApplied: async (forkResult) => {
			options.setEditorText(forkResult.selectedText ?? "");
			options.showStatus(options.successMessage ?? "Forked to new session");
		},
	});

	return { cancelled: result.cancelled };
}

export async function performInteractiveSessionResume(options: {
	clearTransientUi: () => void;
	executeResume: (cwdOverride?: string) => Promise<{ cancelled: boolean }>;
	promptForMissingSessionCwd: (error: MissingSessionCwdError) => Promise<string | undefined>;
	applyRuntimeSessionChange: () => Promise<void>;
	renderCurrentSessionState: () => void;
	showStatus: (message: string) => void;
	handleFatalRuntimeError: (prefix: string, error: unknown) => Promise<never>;
}): Promise<{ cancelled: boolean } | undefined> {
	return performInteractiveRuntimeTransition({
		clearTransientUi: options.clearTransientUi,
		execute: options.executeResume,
		promptForMissingSessionCwd: options.promptForMissingSessionCwd,
		applyRuntimeSessionChange: options.applyRuntimeSessionChange,
		renderCurrentSessionState: options.renderCurrentSessionState,
		showStatus: options.showStatus,
		handleFatalRuntimeError: options.handleFatalRuntimeError,
		successMessage: (_result, usedFallbackCwd) =>
			usedFallbackCwd ? "Resumed session in current cwd" : "Resumed session",
		cancelMessage: "Resume cancelled",
		fatalPrefix: "Failed to resume session",
	});
}
