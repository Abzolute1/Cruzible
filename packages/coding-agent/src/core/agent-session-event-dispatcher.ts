import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { appendResearchArtifactFromToolResult } from "./research-artifacts.js";
import type { SessionManager } from "./session-manager.js";
import type {
	ExtensionRunner,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "./extensions/index.js";
import type { AgentSessionEvent, AgentSessionEventListener } from "./agent-session.js";

export class AgentSessionEventDispatcher {
	private readonly listeners: AgentSessionEventListener[] = [];
	private turnIndex = 0;

	constructor(
		private readonly sessionManager: SessionManager,
		private readonly getExtensionRunner: () => ExtensionRunner | undefined,
	) {}

	subscribe(listener: AgentSessionEventListener): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index !== -1) {
				this.listeners.splice(index, 1);
			}
		};
	}

	clearListeners(): void {
		this.listeners.length = 0;
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				console.error("[AgentSession] Event listener error:", error);
			}
		}
	}

	emitQueueUpdate(steering: string[], followUp: string[]): void {
		this.emit({
			type: "queue_update",
			steering: [...steering],
			followUp: [...followUp],
		});
	}

	async emitExtensionEvent(event: AgentEvent): Promise<void> {
		const extensionRunner = this.getExtensionRunner();
		if (!extensionRunner) return;

		if (event.type === "agent_start") {
			this.turnIndex = 0;
			await extensionRunner.emit({ type: "agent_start" });
			return;
		}

		if (event.type === "agent_end") {
			await extensionRunner.emit({ type: "agent_end", messages: event.messages });
			return;
		}

		if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this.turnIndex,
				timestamp: Date.now(),
			};
			await extensionRunner.emit(extensionEvent);
			return;
		}

		if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this.turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await extensionRunner.emit(extensionEvent);
			this.turnIndex++;
			return;
		}

		if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await extensionRunner.emit(extensionEvent);
			return;
		}

		if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await extensionRunner.emit(extensionEvent);
			return;
		}

		if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			await extensionRunner.emit(extensionEvent);
			return;
		}

		if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await extensionRunner.emit(extensionEvent);
			return;
		}

		if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await extensionRunner.emit(extensionEvent);
			return;
		}

		if (event.type === "tool_execution_end") {
			if (!event.isError) {
				appendResearchArtifactFromToolResult(this.sessionManager, event.toolName, event.result.details);
			}
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await extensionRunner.emit(extensionEvent);
		}
	}
}
