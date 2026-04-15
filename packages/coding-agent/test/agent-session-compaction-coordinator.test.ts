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
});
