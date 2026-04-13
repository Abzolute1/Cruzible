import type { Agent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { isContextOverflow } from "@mariozechner/pi-ai";
import { sleep } from "../utils/sleep.js";
import type { AgentSessionEvent } from "./agent-session.js";
import type { SettingsManager } from "./settings-manager.js";

export interface AgentSessionRetryCoordinatorOptions {
	agent: Agent;
	settingsManager: SettingsManager;
	getContextWindow: () => number | undefined;
	emit: (event: AgentSessionEvent) => void;
}

export class AgentSessionRetryCoordinator {
	private retryAbortController: AbortController | undefined = undefined;
	private retryAttempt = 0;
	private retryPromise: Promise<void> | undefined = undefined;
	private retryResolve: (() => void) | undefined = undefined;

	constructor(private readonly options: AgentSessionRetryCoordinatorOptions) {}

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
		if (this.retryAttempt <= 0) {
			return undefined;
		}
		const attempt = this.retryAttempt;
		this.retryAttempt = 0;
		return attempt;
	}

	resolvePending(): void {
		if (this.retryResolve) {
			this.retryResolve();
			this.retryResolve = undefined;
			this.retryPromise = undefined;
		}
	}

	isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" || !message.errorMessage) return false;
		const contextWindow = this.options.getContextWindow() ?? 0;
		if (isContextOverflow(message, contextWindow)) return false;
		return /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|timed? out|timeout|terminated|retry delay/i.test(
			message.errorMessage,
		);
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

		const messages = this.options.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.options.agent.state.messages = messages.slice(0, -1);
		}

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

		setTimeout(() => {
			this.options.agent.continue().catch(() => {});
		}, 0);

		return true;
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
}
