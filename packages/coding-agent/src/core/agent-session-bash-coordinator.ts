import type { Agent } from "@ag1/agent-core";
import { type BashResult, executeBashWithOperations } from "./bash-executor.js";
import type { BashExecutionMessage } from "./messages.js";
import type { SessionManager } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.js";

export interface AgentSessionBashCoordinatorOptions {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
}

export class AgentSessionBashCoordinator {
	// One controller per in-flight execution: concurrent execute() calls must
	// not overwrite each other's controller (abort would kill the wrong
	// process and isRunning would be corrupted).
	private readonly bashAbortControllers = new Set<AbortController>();
	private pendingBashMessages: BashExecutionMessage[] = [];

	constructor(private readonly options: AgentSessionBashCoordinatorOptions) {}

	get isRunning(): boolean {
		return this.bashAbortControllers.size > 0;
	}

	get hasPendingMessages(): boolean {
		return this.pendingBashMessages.length > 0;
	}

	async execute(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; operations?: BashOperations },
	): Promise<BashResult> {
		const abortController = new AbortController();
		this.bashAbortControllers.add(abortController);

		const prefix = this.options.settingsManager.getShellCommandPrefix();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.options.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations(),
				{
					onChunk,
					signal: abortController.signal,
				},
			);

			this.record(command, result, options);
			return result;
		} finally {
			this.bashAbortControllers.delete(abortController);
		}
	}

	record(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		if (this.options.agent.state.isStreaming) {
			this.pendingBashMessages.push(bashMessage);
			return;
		}

		this.appendToTranscript(bashMessage);
		this.options.sessionManager.appendMessage(bashMessage);
	}

	flushPending(): void {
		if (this.pendingBashMessages.length === 0) return;

		for (const bashMessage of this.pendingBashMessages) {
			this.appendToTranscript(bashMessage);
			this.options.sessionManager.appendMessage(bashMessage);
		}

		this.pendingBashMessages = [];
	}

	private appendToTranscript(message: BashExecutionMessage): void {
		// `Agent.state.messages` returns a copy on read; assign through the setter
		// (which splices in place) instead of pushing into the throwaway copy.
		const { agent } = this.options;
		agent.state.messages = [...agent.state.messages, message];
	}

	abort(): void {
		for (const controller of this.bashAbortControllers) {
			controller.abort();
		}
	}
}
