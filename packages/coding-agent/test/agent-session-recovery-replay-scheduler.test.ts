import { describe, expect, it, vi } from "vitest";
import { AgentSessionRecoveryArbiter } from "../src/core/agent-session-recovery-arbiter.js";
import { AgentSessionRecoveryReplayScheduler } from "../src/core/agent-session-recovery-replay-scheduler.js";

describe("AgentSessionRecoveryReplayScheduler", () => {
	it("emits a skipped event when another owner already claimed replay", () => {
		const recoveryArbiter = new AgentSessionRecoveryArbiter();
		recoveryArbiter.tryArm("compaction");
		const events: any[] = [];
		const scheduler = new AgentSessionRecoveryReplayScheduler({
			owner: "retry",
			recoveryArbiter,
			getState: () => ({
				messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }] as any,
				isStreaming: false,
				model: { provider: "openai", id: "gpt-5.4-mini" },
				thinkingLevel: "medium",
			}),
			emit: (event) => events.push(event),
		});

		const started = scheduler.schedule({
			delayMs: 0,
			alreadyScheduledMessage: "blocked",
			stateChangedMessage: "stale",
			run: async () => {},
		});

		expect(started).toBe(false);
		expect(events).toEqual([
			{
				type: "recovery_replay_skipped",
				owner: "retry",
				reason: "already_scheduled",
				message: "blocked",
			},
		]);
		expect(recoveryArbiter.owner).toBe("compaction");
	});

	it("cancels the earlier same-owner replay before scheduling a replacement", async () => {
		vi.useFakeTimers();
		try {
			const events: any[] = [];
			const run = vi.fn().mockResolvedValue(undefined);
			const state = {
				messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }] as any,
				isStreaming: false,
				model: { provider: "openai", id: "gpt-5.4-mini" },
				thinkingLevel: "medium" as const,
			};
			const scheduler = new AgentSessionRecoveryReplayScheduler({
				owner: "retry",
				recoveryArbiter: new AgentSessionRecoveryArbiter(),
				getState: () => state,
				emit: (event) => events.push(event),
			});

			expect(
				scheduler.schedule({
					delayMs: 100,
					alreadyScheduledMessage: "blocked",
					stateChangedMessage: "stale",
					run,
				}),
			).toBe(true);
			expect(
				scheduler.schedule({
					delayMs: 100,
					alreadyScheduledMessage: "blocked",
					stateChangedMessage: "stale",
					run,
				}),
			).toBe(true);
			await vi.advanceTimersByTimeAsync(100);

			expect(run).toHaveBeenCalledTimes(1);
			expect(events).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("emits a stale replay skip and does not run when state changes before execution", async () => {
		vi.useFakeTimers();
		try {
			const events: any[] = [];
			const state = {
				messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }] as any,
				isStreaming: false,
				model: { provider: "openai", id: "gpt-5.4-mini" },
				thinkingLevel: "medium" as "medium" | "high",
			};
			const run = vi.fn().mockResolvedValue(undefined);
			const scheduler = new AgentSessionRecoveryReplayScheduler({
				owner: "compaction",
				recoveryArbiter: new AgentSessionRecoveryArbiter(),
				getState: () => state,
				emit: (event) => events.push(event),
			});

			expect(
				scheduler.schedule({
					delayMs: 100,
					alreadyScheduledMessage: "blocked",
					stateChangedMessage: "stale",
					run,
				}),
			).toBe(true);
			state.thinkingLevel = "high";
			await vi.advanceTimersByTimeAsync(100);

			expect(run).not.toHaveBeenCalled();
			expect(events).toEqual([
				{
					type: "recovery_replay_skipped",
					owner: "compaction",
					reason: "state_changed",
					message: "stale",
				},
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels a pending replay and clears ownership", async () => {
		vi.useFakeTimers();
		try {
			const recoveryArbiter = new AgentSessionRecoveryArbiter();
			const run = vi.fn().mockResolvedValue(undefined);
			const scheduler = new AgentSessionRecoveryReplayScheduler({
				owner: "retry",
				recoveryArbiter,
				getState: () => ({
					messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }] as any,
					isStreaming: false,
					model: { provider: "openai", id: "gpt-5.4-mini" },
					thinkingLevel: "medium",
				}),
				emit: () => {},
			});

			scheduler.schedule({
				delayMs: 100,
				alreadyScheduledMessage: "blocked",
				stateChangedMessage: "stale",
				run,
			});
			expect(recoveryArbiter.owner).toBe("retry");

			scheduler.cancel();
			await vi.advanceTimersByTimeAsync(100);

			expect(run).not.toHaveBeenCalled();
			expect(recoveryArbiter.owner).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});
