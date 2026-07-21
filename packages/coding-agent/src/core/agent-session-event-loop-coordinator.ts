import type { AgentEvent, AgentMessage } from "@ag1/agent-core";
import type { AssistantMessage, ImageContent, Message, TextContent } from "@ag1/ai";
import type { AgentSessionEvent } from "./agent-session.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.js";
import { SessionPersistenceError } from "./session-manager.js";
import { analyzeAssistantTurnHealth } from "./turn-health.js";

export interface AgentSessionEventLoopCoordinatorOptions {
	removeQueuedUserMessage: (text: string) => boolean;
	emitQueueUpdate: () => void;
	emitExtensionEvent: (event: AgentEvent) => Promise<void>;
	emitPublicEvent: (event: AgentSessionEvent) => void;
	appendCustomMessageEntry: (
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details: unknown,
	) => void | Promise<void>;
	appendMessage: (message: Message | CustomMessage | BashExecutionMessage) => void | Promise<void>;
	flushPendingBashMessages: () => void;
	resetOverflowRecovery: () => void;
	/** Reset per-user-turn web research tracking when a user turn actually starts. */
	resetWebResearchRuntimeState: () => void;
	emitDegradedTurn: (event: {
		severity: "elevated" | "critical";
		stopReason?: string;
		outputTokens: number;
		textLength: number;
		reasons: string[];
		recoveryHint?: string;
	}) => void;
	onAssistantSuccess: () => number | undefined;
	emitRetrySuccess: (attempt: number) => void;
	ensurePendingRetryForAgentEnd: (message: AssistantMessage | undefined) => void;
	isRetryableError: (message: AssistantMessage) => boolean;
	handleRetryableError: (message: AssistantMessage) => Promise<boolean>;
	resolveRetry: () => void;
	checkCompaction: (assistantMessage: AssistantMessage) => Promise<void>;
	getUserMessageText: (message: Message) => string;
}

export class AgentSessionEventLoopCoordinator {
	private lastAssistantMessage: AssistantMessage | undefined = undefined;
	private agentEventQueue: Promise<void> = Promise.resolve();

	constructor(private readonly options: AgentSessionEventLoopCoordinatorOptions) {}

	handle(event: AgentEvent): void {
		if (event.type === "agent_end") {
			this.options.ensurePendingRetryForAgentEnd(this.findLastAssistantInMessages(event.messages));
		}

		this.agentEventQueue = this.agentEventQueue.then(
			() => this.process(event),
			() => this.process(event),
		);
		// The chain above always continues (rejection handler), so the queue keeps
		// processing subsequent events. This terminal catch only reports: log every
		// failure and surface persistence failures as a public persistence_error
		// event instead of silently swallowing them.
		this.agentEventQueue.catch((error) => {
			console.error("[AgentSession] Event processing failed:", error);
			if (error instanceof SessionPersistenceError) {
				this.options.emitPublicEvent({ type: "persistence_error", message: error.message });
			}
		});
	}

	async wait(): Promise<void> {
		await this.agentEventQueue;
	}

	private findLastAssistantInMessages(messages: AgentMessage[]): AssistantMessage | undefined {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role === "assistant") {
				return message as AssistantMessage;
			}
		}
		return undefined;
	}

	private async process(event: AgentEvent): Promise<void> {
		if (event.type === "message_start" && event.message.role === "user") {
			this.options.resetOverflowRecovery();
			// A user turn actually starts here — prompt() may have only QUEUED the
			// message mid-stream, so per-turn web research state resets now, not earlier.
			this.options.resetWebResearchRuntimeState();
			const messageText = this.options.getUserMessageText(event.message);
			if (messageText && this.options.removeQueuedUserMessage(messageText)) {
				this.options.emitQueueUpdate();
			}
		}

		await this.options.emitExtensionEvent(event);
		this.options.emitPublicEvent(event);

		if (event.type === "message_end") {
			if (event.message.role === "custom") {
				await this.options.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				await this.options.appendMessage(event.message);
			}

			if (event.message.role === "assistant") {
				this.lastAssistantMessage = event.message;

				const turnHealth = analyzeAssistantTurnHealth(event.message);
				if (turnHealth.severity !== "normal") {
					this.options.emitDegradedTurn({
						severity: turnHealth.severity,
						stopReason: turnHealth.stopReason,
						outputTokens: turnHealth.outputTokens,
						textLength: turnHealth.textLength,
						reasons: turnHealth.reasons,
						recoveryHint: turnHealth.recoveryHint,
					});
				}

				if (event.message.stopReason !== "error") {
					this.options.resetOverflowRecovery();
				}

				const completedRetryAttempt =
					event.message.stopReason !== "error" ? this.options.onAssistantSuccess() : undefined;
				if (completedRetryAttempt !== undefined) {
					this.options.emitRetrySuccess(completedRetryAttempt);
				}
			}
		}

		if (event.type === "agent_end" && this.lastAssistantMessage) {
			const message = this.lastAssistantMessage;
			this.lastAssistantMessage = undefined;

			// Flush bash results recorded during the run before any retry/compaction
			// decision, so they are persisted even if no further prompt follows.
			this.options.flushPendingBashMessages();

			if (this.options.isRetryableError(message)) {
				const didRetry = await this.options.handleRetryableError(message);
				if (didRetry) {
					return;
				}
			}

			this.options.resolveRetry();
			await this.options.checkCompaction(message);
		} else if (event.type === "agent_end") {
			this.options.flushPendingBashMessages();
		}
	}
}
