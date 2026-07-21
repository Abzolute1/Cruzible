import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionBashCoordinator } from "../src/core/agent-session-bash-coordinator.js";
import { AgentSessionEventLoopCoordinator } from "../src/core/agent-session-event-loop-coordinator.js";
import type { BashResult } from "../src/core/bash-executor.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

const executeBashWithOperationsMock = vi.hoisted(() => vi.fn());

vi.mock("../src/core/bash-executor.js", () => ({
	executeBashWithOperations: executeBashWithOperationsMock,
}));

function createCoordinator(options?: { isStreaming?: boolean }) {
	const agent = { state: { messages: [] as any[], isStreaming: options?.isStreaming ?? false } };
	const sessionManager = SessionManager.inMemory();
	const coordinator = new AgentSessionBashCoordinator({
		agent: agent as any,
		sessionManager,
		settingsManager: SettingsManager.inMemory({}),
	});
	return { coordinator, agent, sessionManager };
}

function deferredResult(signal: AbortSignal) {
	let resolve!: (result: BashResult) => void;
	const promise = new Promise<BashResult>((res) => {
		resolve = res;
	});
	return { promise, resolve, signal };
}

describe("AgentSessionBashCoordinator", () => {
	beforeEach(() => {
		executeBashWithOperationsMock.mockReset();
	});

	it("tracks abort controllers per concurrent execution", async () => {
		const { coordinator } = createCoordinator();
		const executions: Array<ReturnType<typeof deferredResult>> = [];
		executeBashWithOperationsMock.mockImplementation(
			(_command: string, _cwd: string, _operations: unknown, options: { signal: AbortSignal }) => {
				const execution = deferredResult(options.signal);
				executions.push(execution);
				return execution.promise;
			},
		);

		const first = coordinator.execute("sleep 1");
		const second = coordinator.execute("sleep 2");

		expect(coordinator.isRunning).toBe(true);
		expect(executions).toHaveLength(2);
		expect(executions[0].signal).not.toBe(executions[1].signal);

		// Finishing one execution keeps the other running and unaborted.
		executions[0].resolve({ output: "one", exitCode: 0, cancelled: false, truncated: false });
		await first;
		expect(coordinator.isRunning).toBe(true);
		expect(executions[1].signal.aborted).toBe(false);

		// abort() aborts every in-flight execution, not just the latest one.
		coordinator.abort();
		expect(executions[1].signal.aborted).toBe(true);

		executions[1].resolve({ output: "", exitCode: 130, cancelled: true, truncated: false });
		await second;
		expect(coordinator.isRunning).toBe(false);
	});

	it("queues results recorded while streaming and flushes them with persistence", () => {
		const { coordinator, agent, sessionManager } = createCoordinator({ isStreaming: true });
		const result: BashResult = { output: "hello", exitCode: 0, cancelled: false, truncated: false };

		coordinator.record("echo hello", result);

		expect(coordinator.hasPendingMessages).toBe(true);
		expect(agent.state.messages).toHaveLength(0);
		expect(sessionManager.getEntries()).toHaveLength(0);

		agent.state.isStreaming = false;
		coordinator.flushPending();

		expect(coordinator.hasPendingMessages).toBe(false);
		expect(agent.state.messages).toHaveLength(1);
		expect(agent.state.messages[0].role).toBe("bashExecution");
		const entries = sessionManager.getEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0].type).toBe("message");
		expect((entries[0] as any).message.output).toBe("hello");
	});
});

describe("AgentSessionEventLoopCoordinator bash flush", () => {
	function createEventLoopCoordinator(callOrder: string[]) {
		return new AgentSessionEventLoopCoordinator({
			removeQueuedUserMessage: () => false,
			emitQueueUpdate: () => {},
			emitExtensionEvent: async () => {},
			emitPublicEvent: () => {},
			appendCustomMessageEntry: () => {},
			appendMessage: () => {
				callOrder.push("appendMessage");
			},
			flushPendingBashMessages: () => {
				callOrder.push("flushPendingBashMessages");
			},
			resetOverflowRecovery: () => {},
			resetWebResearchRuntimeState: () => {},
			emitDegradedTurn: () => {},
			onAssistantSuccess: () => undefined,
			emitRetrySuccess: () => {},
			ensurePendingRetryForAgentEnd: () => {},
			isRetryableError: () => false,
			handleRetryableError: async () => false,
			resolveRetry: () => {},
			checkCompaction: async () => {
				callOrder.push("checkCompaction");
			},
			getUserMessageText: () => "",
		});
	}

	it("flushes pending bash messages on agent_end even without an assistant message", async () => {
		const callOrder: string[] = [];
		const coordinator = createEventLoopCoordinator(callOrder);

		coordinator.handle({ type: "agent_end", messages: [] });
		await coordinator.wait();

		expect(callOrder).toEqual(["flushPendingBashMessages"]);
	});

	it("flushes pending bash messages after the final message_end, before compaction checks", async () => {
		const callOrder: string[] = [];
		const coordinator = createEventLoopCoordinator(callOrder);
		const assistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			usage: { output: 1 },
			stopReason: "stop",
			timestamp: 1,
		};

		coordinator.handle({ type: "message_end", message: assistantMessage } as any);
		coordinator.handle({ type: "agent_end", messages: [assistantMessage] } as any);
		await coordinator.wait();

		expect(callOrder).toEqual(["appendMessage", "flushPendingBashMessages", "checkCompaction"]);
	});
});
