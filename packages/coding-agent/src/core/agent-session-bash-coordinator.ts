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
	private bashAbortController: AbortController | undefined = undefined;
	private pendingBashMessages: BashExecutionMessage[] = [];

	constructor(private readonly options: AgentSessionBashCoordinatorOptions) {}

	get isRunning(): boolean {
		return this.bashAbortController !== undefined;
	}

	get hasPendingMessages(): boolean {
		return this.pendingBashMessages.length > 0;
	}

	async execute(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; operations?: BashOperations },
	): Promise<BashResult> {
		this.bashAbortController = new AbortController();

		const prefix = this.options.settingsManager.getShellCommandPrefix();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.options.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations(),
				{
					onChunk,
					signal: this.bashAbortController.signal,
				},
			);

			this.record(command, result, options);
			return result;
		} finally {
			this.bashAbortController = undefined;
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

		this.options.agent.state.messages.push(bashMessage);
		this.options.sessionManager.appendMessage(bashMessage);
	}

	flushPending(): void {
		if (this.pendingBashMessages.length === 0) return;

		for (const bashMessage of this.pendingBashMessages) {
			this.options.agent.state.messages.push(bashMessage);
			this.options.sessionManager.appendMessage(bashMessage);
		}

		this.pendingBashMessages = [];
	}

	abort(): void {
		this.bashAbortController?.abort();
	}
}
