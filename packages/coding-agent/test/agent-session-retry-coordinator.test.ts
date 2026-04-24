import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@ag1/ai";
import { AgentSessionRetryCoordinator } from "../src/core/agent-session-retry-coordinator.js";
import { AgentSessionRecoveryArbiter } from "../src/core/agent-session-recovery-arbiter.js";
import { SettingsManager } from "../src/core/settings-manager.js";

function createRetryableErrorMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: "overloaded_error",
		timestamp: Date.now(),
	};
}

describe("AgentSessionRetryCoordinator", () => {
	it("restores the previous assistant message and emits failure when continuation rejects", async () => {
		const errorMessage = createRetryableErrorMessage();
		const agent = {
			state: { messages: [errorMessage], isStreaming: false },
			continue: vi.fn().mockRejectedValue(new Error("continue failed")),
			waitForIdle: vi.fn().mockResolvedValue(undefined),
		};
		const events: any[] = [];
		const coordinator = new AgentSessionRetryCoordinator({
			agent: agent as any,
			settingsManager: SettingsManager.inMemory({
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			}),
			getContextWindow: () => undefined,
			emit: (event) => events.push(event),
			recoveryArbiter: new AgentSessionRecoveryArbiter(),
		});

		const started = await coordinator.handleRetryableError(errorMessage);
		expect(started).toBe(true);

		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(agent.continue).toHaveBeenCalledTimes(1);
		expect(agent.state.messages.at(-1)).toBe(errorMessage);
		expect(coordinator.isRetrying).toBe(false);
		expect(events).toEqual([
			expect.objectContaining({ type: "auto_retry_start", attempt: 1 }),
			expect.objectContaining({ type: "auto_retry_end", success: false, finalError: "continue failed" }),
		]);
	});

	it("skips replay when the session changes before the retry continues", async () => {
		const errorMessage = createRetryableErrorMessage();
		const agent = {
			state: {
				messages: [errorMessage],
				isStreaming: false,
				model: { provider: "anthropic", id: "claude-sonnet-4-5" },
				thinkingLevel: "medium",
			},
			continue: vi.fn().mockResolvedValue(undefined),
			waitForIdle: vi.fn().mockResolvedValue(undefined),
		};
		const events: any[] = [];
		const coordinator = new AgentSessionRetryCoordinator({
			agent: agent as any,
			settingsManager: SettingsManager.inMemory({
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			}),
			getContextWindow: () => undefined,
			emit: (event) => events.push(event),
			recoveryArbiter: new AgentSessionRecoveryArbiter(),
		});

		const started = await coordinator.handleRetryableError(errorMessage);
		expect(started).toBe(true);

		agent.state.messages.push({
			role: "user",
			content: [{ type: "text", text: "newer prompt" }],
			timestamp: Date.now() + 1,
		});

		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(agent.continue).not.toHaveBeenCalled();
		expect(coordinator.isRetrying).toBe(false);
		expect(events).toEqual([
			expect.objectContaining({ type: "auto_retry_start", attempt: 1 }),
			expect.objectContaining({
				type: "recovery_replay_skipped",
				owner: "retry",
				reason: "state_changed",
				message: "Retry skipped because the session changed before replay.",
			}),
			expect.objectContaining({
				type: "auto_retry_end",
				success: false,
				finalError: "Retry skipped because the session changed before replay.",
			}),
		]);
	});

	it("does not retry classified local backend failures", () => {
		const coordinator = new AgentSessionRetryCoordinator({
			agent: {
				state: { messages: [], isStreaming: false },
				continue: vi.fn(),
				waitForIdle: vi.fn(),
			} as any,
			settingsManager: SettingsManager.inMemory({
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			}),
			getContextWindow: () => undefined,
			emit: vi.fn(),
			recoveryArbiter: new AgentSessionRecoveryArbiter(),
		});

		expect(
			coordinator.isRetryableError({
				...createRetryableErrorMessage(),
				provider: "local",
				model: "lm-studio",
				errorMessage: "Connection error.",
			}),
		).toBe(false);
	});

	it("skips replay when the model changes before the retry continues", async () => {
		const errorMessage = createRetryableErrorMessage();
		const agent = {
			state: {
				messages: [errorMessage],
				isStreaming: false,
				model: { provider: "anthropic", id: "claude-sonnet-4-5" },
				thinkingLevel: "medium",
			},
			continue: vi.fn().mockResolvedValue(undefined),
			waitForIdle: vi.fn().mockResolvedValue(undefined),
		};
		const events: any[] = [];
		const coordinator = new AgentSessionRetryCoordinator({
			agent: agent as any,
			settingsManager: SettingsManager.inMemory({
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			}),
			getContextWindow: () => undefined,
			emit: (event) => events.push(event),
			recoveryArbiter: new AgentSessionRecoveryArbiter(),
		});

		const started = await coordinator.handleRetryableError(errorMessage);
		expect(started).toBe(true);

		agent.state.model = { provider: "anthropic", id: "claude-opus-4-6" };

		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(agent.continue).not.toHaveBeenCalled();
		expect(coordinator.isRetrying).toBe(false);
		expect(events).toEqual([
			expect.objectContaining({ type: "auto_retry_start", attempt: 1 }),
			expect.objectContaining({
				type: "recovery_replay_skipped",
				owner: "retry",
				reason: "state_changed",
				message: "Retry skipped because the session changed before replay.",
			}),
			expect.objectContaining({
				type: "auto_retry_end",
				success: false,
				finalError: "Retry skipped because the session changed before replay.",
			}),
		]);
	});

	it("skips replay when the thinking level changes before the retry continues", async () => {
		const errorMessage = createRetryableErrorMessage();
		const agent = {
			state: {
				messages: [errorMessage],
				isStreaming: false,
				model: { provider: "anthropic", id: "claude-sonnet-4-5" },
				thinkingLevel: "medium",
			},
			continue: vi.fn().mockResolvedValue(undefined),
			waitForIdle: vi.fn().mockResolvedValue(undefined),
		};
		const events: any[] = [];
		const coordinator = new AgentSessionRetryCoordinator({
			agent: agent as any,
			settingsManager: SettingsManager.inMemory({
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			}),
			getContextWindow: () => undefined,
			emit: (event) => events.push(event),
			recoveryArbiter: new AgentSessionRecoveryArbiter(),
		});

		const started = await coordinator.handleRetryableError(errorMessage);
		expect(started).toBe(true);

		agent.state.thinkingLevel = "high";

		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(agent.continue).not.toHaveBeenCalled();
		expect(coordinator.isRetrying).toBe(false);
		expect(events).toEqual([
			expect.objectContaining({ type: "auto_retry_start", attempt: 1 }),
			expect.objectContaining({
				type: "recovery_replay_skipped",
				owner: "retry",
				reason: "state_changed",
				message: "Retry skipped because the session changed before replay.",
			}),
			expect.objectContaining({
				type: "auto_retry_end",
				success: false,
				finalError: "Retry skipped because the session changed before replay.",
			}),
		]);
	});

	it("skips retry scheduling when another recovery path already claimed replay", async () => {
		const errorMessage = createRetryableErrorMessage();
		const agent = {
			state: {
				messages: [errorMessage],
				isStreaming: false,
				model: { provider: "anthropic", id: "claude-sonnet-4-5" },
				thinkingLevel: "medium",
			},
			continue: vi.fn().mockResolvedValue(undefined),
			waitForIdle: vi.fn().mockResolvedValue(undefined),
		};
		const events: any[] = [];
		const recoveryArbiter = new AgentSessionRecoveryArbiter();
		recoveryArbiter.tryArm("compaction");
		const coordinator = new AgentSessionRetryCoordinator({
			agent: agent as any,
			settingsManager: SettingsManager.inMemory({
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			}),
			getContextWindow: () => undefined,
			emit: (event) => events.push(event),
			recoveryArbiter,
		});

		const started = await coordinator.handleRetryableError(errorMessage);

		expect(started).toBe(false);
		expect(agent.continue).not.toHaveBeenCalled();
		expect(coordinator.isRetrying).toBe(false);
		expect(events).toEqual([
			expect.objectContaining({ type: "auto_retry_start", attempt: 1 }),
			expect.objectContaining({
				type: "recovery_replay_skipped",
				owner: "retry",
				reason: "already_scheduled",
				message: "Retry skipped because another recovery path is already scheduled.",
			}),
			expect.objectContaining({
				type: "auto_retry_end",
				success: false,
				finalError: "Retry skipped because another recovery path is already scheduled.",
			}),
		]);
		expect(recoveryArbiter.owner).toBe("compaction");
	});
});
