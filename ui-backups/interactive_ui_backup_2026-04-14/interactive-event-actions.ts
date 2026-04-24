import type { AgentSessionEvent } from "../../core/agent-session.js";
import { createCompactionSummaryMessage } from "../../core/messages.js";
import { Loader, Spacer, Text, type TUI } from "@ag1/tui";
import { keyText } from "./components/keybinding-hints.js";
import { theme } from "./theme/theme.js";

type XmlFallbackEvent = Extract<AgentSessionEvent, { type: "xml_tool_call" }>;
type DegradedTurnEvent = Extract<AgentSessionEvent, { type: "degraded_turn" }>;
type CompactionStartEvent = Extract<AgentSessionEvent, { type: "compaction_start" }>;
type CompactionEndEvent = Extract<AgentSessionEvent, { type: "compaction_end" }>;
type RetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type RetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;
type RecoveryReplaySkippedEvent = Extract<AgentSessionEvent, { type: "recovery_replay_skipped" }>;

export function handleInteractiveXmlFallbackEvent(options: {
	event: XmlFallbackEvent;
	currentCount: number;
	persistRuntimeHealthSnapshot(): void;
	formatWarning(event: XmlFallbackEvent): string | undefined;
	footer: { setWarning(message: string): void };
	showWarning(message: string): void;
	showStatus(message: string): void;
	ui: { requestRender(): void };
}): { nextCount: number; lastEvent: XmlFallbackEvent } {
	const nextCount = options.currentCount + 1;
	options.persistRuntimeHealthSnapshot();
	const warning = options.formatWarning(options.event);
	if (warning) {
		options.footer.setWarning(warning);
		if (options.event.severity === "critical") {
			options.showWarning(warning);
		} else {
			options.showStatus(warning);
		}
		options.ui.requestRender();
	}
	return { nextCount, lastEvent: options.event };
}

export function handleInteractiveDegradedTurnEvent(options: {
	event: DegradedTurnEvent;
	currentCount: number;
	persistRuntimeHealthSnapshot(): void;
	formatWarning(event: DegradedTurnEvent): string | undefined;
	footer: { setWarning(message: string): void };
	showWarning(message: string): void;
	showStatus(message: string): void;
	ui: { requestRender(): void };
}): { nextCount: number; lastEvent: DegradedTurnEvent } {
	const nextCount = options.currentCount + 1;
	options.persistRuntimeHealthSnapshot();
	const warning = options.formatWarning(options.event);
	if (warning) {
		options.footer.setWarning(warning);
		if (options.event.severity === "critical") {
			options.showWarning(warning);
		} else {
			options.showStatus(warning);
		}
		options.ui.requestRender();
	}
	return { nextCount, lastEvent: options.event };
}

export function handleInteractiveCompactionStart(options: {
	event: CompactionStartEvent;
	defaultEditor: { onEscape?: (() => void) | undefined };
	statusContainer: { clear(): void; addChild(child: unknown): void };
	session: { abortCompaction(): void };
	ui: TUI;
}): { nextEscapeHandler: (() => void) | undefined; loader: Loader } {
	const nextEscapeHandler = options.defaultEditor.onEscape;
	options.defaultEditor.onEscape = () => {
		options.session.abortCompaction();
	};
	options.statusContainer.clear();
	const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
	const label =
		options.event.reason === "manual"
			? `Compacting context... ${cancelHint}`
			: `${options.event.reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... ${cancelHint}`;
	const loader = new Loader(
		options.ui,
		(spinner) => theme.fg("accent", spinner),
		(text) => theme.fg("muted", text),
		label,
	);
	options.statusContainer.addChild(loader);
	options.ui.requestRender();
	return { nextEscapeHandler, loader };
}

export function handleInteractiveCompactionEnd(options: {
	event: CompactionEndEvent;
	defaultEditor: { onEscape?: (() => void) | undefined };
	previousEscapeHandler: (() => void) | undefined;
	loader: Loader | undefined;
	statusContainer: { clear(): void };
	chatContainer: { clear(): void; addChild(child: unknown): void };
	rebuildChatFromMessages(): void;
	addMessageToChat(message: AgentSessionEvent | any): void;
	footer: { invalidate(): void };
	showError(message: string): void;
	showStatus(message: string): void;
	flushCompactionQueue(options: { willRetry: boolean }): Promise<void>;
	ui: { requestRender(): void };
}): { nextEscapeHandler: undefined; loader: undefined } {
	if (options.previousEscapeHandler) {
		options.defaultEditor.onEscape = options.previousEscapeHandler;
	}
	if (options.loader) {
		options.loader.stop();
		options.statusContainer.clear();
	}
	if (options.event.aborted) {
		if (options.event.reason === "manual") {
			options.showError("Compaction cancelled");
		} else {
			options.showStatus("Auto-compaction cancelled");
		}
	} else if (options.event.result) {
		options.chatContainer.clear();
		options.rebuildChatFromMessages();
		options.addMessageToChat(
			createCompactionSummaryMessage(options.event.result.summary, options.event.result.tokensBefore, new Date().toISOString()),
		);
		options.footer.invalidate();
	} else if (options.event.errorMessage) {
		if (options.event.reason === "manual") {
			options.showError(options.event.errorMessage);
		} else {
			options.chatContainer.addChild(new Spacer(1));
			options.chatContainer.addChild(new Text(theme.fg("error", options.event.errorMessage), 1, 0));
		}
	}
	void options.flushCompactionQueue({ willRetry: options.event.willRetry });
	options.ui.requestRender();
	return { nextEscapeHandler: undefined, loader: undefined };
}

export function handleInteractiveRetryStart(options: {
	event: RetryStartEvent;
	defaultEditor: { onEscape?: (() => void) | undefined };
	statusContainer: { clear(): void; addChild(child: unknown): void };
	session: { abortRetry(): void };
	ui: TUI;
}): { nextEscapeHandler: (() => void) | undefined; loader: Loader } {
	const nextEscapeHandler = options.defaultEditor.onEscape;
	options.defaultEditor.onEscape = () => {
		options.session.abortRetry();
	};
	options.statusContainer.clear();
	const delaySeconds = Math.round(options.event.delayMs / 1000);
	const loader = new Loader(
		options.ui,
		(spinner) => theme.fg("warning", spinner),
		(text) => theme.fg("muted", text),
		`Retrying (${options.event.attempt}/${options.event.maxAttempts}) in ${delaySeconds}s... (${keyText("app.interrupt")} to cancel)`,
	);
	options.statusContainer.addChild(loader);
	options.ui.requestRender();
	return { nextEscapeHandler, loader };
}

export function handleInteractiveRetryEnd(options: {
	event: RetryEndEvent;
	defaultEditor: { onEscape?: (() => void) | undefined };
	previousEscapeHandler: (() => void) | undefined;
	loader: Loader | undefined;
	statusContainer: { clear(): void };
	showError(message: string): void;
	ui: { requestRender(): void };
}): { nextEscapeHandler: undefined; loader: undefined } {
	if (options.previousEscapeHandler) {
		options.defaultEditor.onEscape = options.previousEscapeHandler;
	}
	if (options.loader) {
		options.loader.stop();
		options.statusContainer.clear();
	}
	if (!options.event.success) {
		options.showError(`Retry failed after ${options.event.attempt} attempts: ${options.event.finalError || "Unknown error"}`);
	}
	options.ui.requestRender();
	return { nextEscapeHandler: undefined, loader: undefined };
}

export function handleInteractiveRecoveryReplaySkipped(options: {
	event: RecoveryReplaySkippedEvent;
	showStatus(message: string): void;
	ui: { requestRender(): void };
}): void {
	if (options.event.owner !== "compaction") {
		return;
	}
	options.showStatus(options.event.message);
	options.ui.requestRender();
}
