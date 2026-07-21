import { describe, expect, it, vi } from "vitest";
import { AgentSessionCompactionCoordinator } from "../src/core/agent-session-compaction-coordinator.js";
import { AgentSessionRecoveryArbiter } from "../src/core/agent-session-recovery-arbiter.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("AgentSessionCompactionCoordinator", () => {
	it("does not schedule auto-continue when another recovery path already claimed replay", async () => {
		vi.useFakeTimers();
		try {
			const continueSpy = vi.fn().mockResolvedValue(undefined);
			const agent = {
				state: {
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: "hello" }],
							timestamp: 1,
						},
					],
					isStreaming: false,
					model: { provider: "openai", id: "gpt-5.4-mini" },
					thinkingLevel: "medium",
				},
				continue: continueSpy,
			};
			const recoveryArbiter = new AgentSessionRecoveryArbiter();
			recoveryArbiter.tryArm("retry");
			const events: any[] = [];
			const coordinator = new AgentSessionCompactionCoordinator({
				agent: agent as any,
				sessionManager: SessionManager.inMemory(),
				settingsManager: SettingsManager.inMemory({}),
				modelRegistry: {} as any,
				getModel: () => agent.state.model as any,
				getContextWindow: () => undefined,
				getExtensionRunner: () => undefined,
				getRequiredRequestAuth: async () => ({ apiKey: "test-key" }),
				emit: (event) => events.push(event),
				disconnectFromAgent: () => {},
				reconnectToAgent: () => {},
				abortAgent: async () => {},
				recoveryArbiter,
			});

			(coordinator as any).scheduleAutoContinue(100);
			await vi.advanceTimersByTimeAsync(100);

			expect(continueSpy).not.toHaveBeenCalled();
			expect(recoveryArbiter.owner).toBe("retry");
			expect(events).toContainEqual({
				type: "recovery_replay_skipped",
				owner: "compaction",
				reason: "already_scheduled",
				message: "Auto-continue skipped because another recovery path is already scheduled.",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("emits a replay-skipped event when auto-continue becomes stale before replay", async () => {
		vi.useFakeTimers();
		try {
			const continueSpy = vi.fn().mockResolvedValue(undefined);
			const agent = {
				state: {
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: "hello" }],
							timestamp: 1,
						},
					],
					isStreaming: false,
					model: { provider: "openai", id: "gpt-5.4-mini" },
					thinkingLevel: "medium",
				},
				continue: continueSpy,
			};
			const events: any[] = [];
			const coordinator = new AgentSessionCompactionCoordinator({
				agent: agent as any,
				sessionManager: SessionManager.inMemory(),
				settingsManager: SettingsManager.inMemory({}),
				modelRegistry: {} as any,
				getModel: () => agent.state.model as any,
				getContextWindow: () => undefined,
				getExtensionRunner: () => undefined,
				getRequiredRequestAuth: async () => ({ apiKey: "test-key" }),
				emit: (event) => events.push(event),
				disconnectFromAgent: () => {},
				reconnectToAgent: () => {},
				abortAgent: async () => {},
				recoveryArbiter: new AgentSessionRecoveryArbiter(),
			});

			(coordinator as any).scheduleAutoContinue(100);
			agent.state.thinkingLevel = "high";
			await vi.advanceTimersByTimeAsync(100);

			expect(continueSpy).not.toHaveBeenCalled();
			expect(events).toContainEqual({
				type: "recovery_replay_skipped",
				owner: "compaction",
				reason: "state_changed",
				message: "Auto-continue skipped because the session changed before replay.",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects a manual compact while another compaction is in progress", async () => {
		const coordinator = new AgentSessionCompactionCoordinator({
			agent: { state: { messages: [], isStreaming: false } } as any,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.inMemory({}),
			modelRegistry: {} as any,
			getModel: () => undefined,
			getContextWindow: () => undefined,
			getExtensionRunner: () => undefined,
			getRequiredRequestAuth: async () => ({ apiKey: "test-key" }),
			emit: vi.fn(),
			disconnectFromAgent: () => {},
			reconnectToAgent: () => {},
			abortAgent: async () => {},
			recoveryArbiter: new AgentSessionRecoveryArbiter(),
		});

		// Simulate an active compaction (manual or auto).
		(coordinator as any).manualAbortController = new AbortController();

		await expect(coordinator.compact()).rejects.toThrow("Compaction already in progress");
	});

	it("skips auto-compaction while another compaction is in progress", async () => {
		const agent = {
			state: {
				messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
				isStreaming: false,
			},
		};
		const events: any[] = [];
		const coordinator = new AgentSessionCompactionCoordinator({
			agent: agent as any,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.inMemory({}),
			modelRegistry: {} as any,
			getModel: () => undefined,
			getContextWindow: () => undefined,
			getExtensionRunner: () => undefined,
			getRequiredRequestAuth: async () => ({ apiKey: "test-key" }),
			emit: (event) => events.push(event),
			disconnectFromAgent: () => {},
			reconnectToAgent: () => {},
			abortAgent: async () => {},
			recoveryArbiter: new AgentSessionRecoveryArbiter(),
		});

		// Simulate an active manual compaction.
		(coordinator as any).manualAbortController = new AbortController();

		await coordinator.runAuto("threshold", false);

		// No compaction_start, a single no-op compaction_end, and no state churn.
		expect(events).toEqual([
			{ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false },
		]);
	});
});
