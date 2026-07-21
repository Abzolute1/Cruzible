import type { Agent } from "@ag1/agent-core";
import type { AssistantMessage } from "@ag1/ai";
import { isContextOverflow } from "@ag1/ai";
import { sleep } from "../utils/sleep.js";
import type { AgentSessionEvent } from "./agent-session.js";
import { canReplayContinue } from "./agent-session-continue-replay.js";
import type { AgentSessionRecoveryArbiter } from "./agent-session-recovery-arbiter.js";
import { AgentSessionRecoveryReplayScheduler } from "./agent-session-recovery-replay-scheduler.js";
import { classifyRequestFailure } from "./request-failure.js";
import { findMessageEntryOnBranch, type SessionManager, type SessionMessageEntry } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";

/**
 * Fallback retry heuristic: string-matches provider error prose when no
 * structured marker is present (see isRetryableErrorMessage).
 */
const RETRYABLE_ERROR_TEXT =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|timed? out|timeout|terminated|retry delay/i;

export interface AgentSessionRetryCoordinatorOptions {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	getContextWindow: () => number | undefined;
	emit: (event: AgentSessionEvent) => void;
	recoveryArbiter: AgentSessionRecoveryArbiter;
}

export class AgentSessionRetryCoordinator {
	private retryAbortController: AbortController | undefined = undefined;
	private retryAttempt = 0;
	private retryPromise: Promise<void> | undefined = undefined;
	private retryResolve: (() => void) | undefined = undefined;
	private readonly replayScheduler: AgentSessionRecoveryReplayScheduler;

	constructor(private readonly options: AgentSessionRetryCoordinatorOptions) {
		this.replayScheduler = new AgentSessionRecoveryReplayScheduler({
			owner: "retry",
			recoveryArbiter: this.options.recoveryArbiter,
			getState: () => ({
				messages: this.options.agent.state.messages,
				isStreaming: this.options.agent.state.isStreaming === true,
				model: this.options.agent.state.model,
				thinkingLevel: this.options.agent.state.thinkingLevel,
			}),
			emit: this.options.emit,
		});
	}

	get currentAttempt(): number {
		return this.retryAttempt;
	}

	get isRetrying(): boolean {
		return this.retryPromise !== undefined;
	}

	get enabled(): boolean {
		return this.options.settingsManager.getRetryEnabled();
	}

	ensurePendingRetryForAgentEnd(message: AssistantMessage | undefined): void {
		if (this.retryPromise) return;
		const settings = this.options.settingsManager.getRetrySettings();
		if (!settings.enabled) return;
		if (!message || !this.isRetryableError(message)) return;
		this.retryPromise = new Promise((resolve) => {
			this.retryResolve = resolve;
		});
	}

	onAssistantSuccess(): number | undefined {
		this.options.recoveryArbiter.clear("retry");
		if (this.retryAttempt <= 0) {
			return undefined;
		}
		const attempt = this.retryAttempt;
		this.retryAttempt = 0;
		return attempt;
	}

	resolvePending(): void {
		this.replayScheduler.cancel();
		this.options.recoveryArbiter.clear("retry");
		if (this.retryResolve) {
			this.retryResolve();
			this.retryResolve = undefined;
			this.retryPromise = undefined;
		}
	}

	isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" || !message.errorMessage) return false;
		if (classifyRequestFailure(message)) return false;
		const contextWindow = this.options.getContextWindow() ?? 0;
		if (isContextOverflow(message, contextWindow)) return false;
		return this.isRetryableErrorMessage(message.errorMessage);
	}

	/**
	 * Retry classification. Structured markers the ai package normalizes into
	 * errorMessage are checked first (post-wave-2 providers emit these):
	 * - "Provider stop_reason: X" / "Provider finish_reason: X" — terminal
	 *   (refusal/sensitive/content_filter), except explicit transport reasons.
	 * - "Provider response status: X" — terminal response state (failed/cancelled).
	 * - "<Provider> API error (NNN)" — HTTP status: retry 429 and 5xx only.
	 * The free-text regex stays as a fallback for providers that only return prose.
	 */
	private isRetryableErrorMessage(errorMessage: string): boolean {
		const providerReason = errorMessage.match(/Provider (?:stop_reason|finish_reason):\s*([\w-]+)/i);
		if (providerReason) {
			return providerReason[1].toLowerCase() === "network_error";
		}
		if (/Provider response status:/i.test(errorMessage)) {
			return false;
		}
		const apiStatus = errorMessage.match(/API error \((\d{3})\)/i);
		if (apiStatus) {
			const status = Number(apiStatus[1]);
			return status === 429 || status >= 500;
		}
		return RETRYABLE_ERROR_TEXT.test(errorMessage);
	}

	async handleRetryableError(message: AssistantMessage): Promise<boolean> {
		const settings = this.options.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			this.resolvePending();
			return false;
		}

		if (!this.retryPromise) {
			this.retryPromise = new Promise((resolve) => {
				this.retryResolve = resolve;
			});
		}

		this.retryAttempt++;
		if (this.retryAttempt > settings.maxRetries) {
			this.options.emit({
				type: "auto_retry_end",
				success: false,
				attempt: this.retryAttempt - 1,
				finalError: message.errorMessage,
			});
			this.retryAttempt = 0;
			this.resolvePending();
			return false;
		}

		const delayMs = settings.baseDelayMs * 2 ** (this.retryAttempt - 1);
		this.options.emit({
			type: "auto_retry_start",
			attempt: this.retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		this.retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this.retryAbortController.signal);
		} catch {
			const attempt = this.retryAttempt;
			this.retryAttempt = 0;
			this.retryAbortController = undefined;
			this.options.emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			this.resolvePending();
			return false;
		}
		this.retryAbortController = undefined;

		const messages = this.options.agent.state.messages;
		const removedAssistant =
			messages.length > 0 && messages[messages.length - 1].role === "assistant"
				? (messages[messages.length - 1] as AssistantMessage)
				: undefined;
		let removedEntry: SessionMessageEntry | undefined;
		if (removedAssistant) {
			// The failed assistant message was already persisted at message_end, so
			// dropping it only from live state makes it reappear on resume/fork.
			// Instead move the session leaf to the failed entry's parent — the retry
			// then continues on a branch that excludes the failure — and rebuild live
			// state from the session file (the source of truth). The failed entry
			// stays in the file as an abandoned branch.
			removedEntry = findMessageEntryOnBranch(this.options.sessionManager, removedAssistant);
			if (removedEntry) {
				if (removedEntry.parentId) {
					this.options.sessionManager.branch(removedEntry.parentId);
				} else {
					this.options.sessionManager.resetLeaf();
				}
				this.options.agent.state.messages = this.options.sessionManager.buildSessionContext().messages;
			} else {
				this.options.agent.state.messages = messages.slice(0, -1);
			}
		}

		return this.replayScheduler.schedule({
			delayMs: 0,
			alreadyScheduledMessage: "Retry skipped because another recovery path is already scheduled.",
			stateChangedMessage: "Retry skipped because the session changed before replay.",
			run: () => this.options.agent.continue(),
			onSkipped: (reason) => {
				const attempt = this.retryAttempt;
				this.retryAttempt = 0;
				this.options.emit({
					type: "auto_retry_end",
					success: false,
					attempt,
					finalError:
						reason === "already_scheduled"
							? "Retry skipped because another recovery path is already scheduled."
							: "Retry skipped because the session changed before replay.",
				});
				this.resolvePending();
			},
			onRunError: (error, snapshot) => {
				if (removedAssistant && canReplayContinue(this.getReplayState(), snapshot)) {
					if (removedEntry) {
						// Roll back: restore the failed entry as the branch tip again.
						this.options.sessionManager.branch(removedEntry.id);
						this.options.agent.state.messages = this.options.sessionManager.buildSessionContext().messages;
					} else {
						this.options.agent.state.messages = [...this.options.agent.state.messages, removedAssistant];
					}
				}
				const attempt = this.retryAttempt;
				this.retryAttempt = 0;
				this.options.emit({
					type: "auto_retry_end",
					success: false,
					attempt,
					finalError: error instanceof Error ? error.message : String(error),
				});
				this.resolvePending();
			},
		});
	}

	abort(): void {
		this.retryAbortController?.abort();
		this.resolvePending();
	}

	async wait(): Promise<void> {
		if (!this.retryPromise) {
			return;
		}
		await this.retryPromise;
		await this.options.agent.waitForIdle();
	}

	private getReplayState() {
		return {
			messages: this.options.agent.state.messages,
			isStreaming: this.options.agent.state.isStreaming === true,
			model: this.options.agent.state.model,
			thinkingLevel: this.options.agent.state.thinkingLevel,
		};
	}
}
