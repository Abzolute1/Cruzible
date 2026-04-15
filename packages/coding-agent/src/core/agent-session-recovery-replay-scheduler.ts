import type { AgentSessionEvent } from "./agent-session.js";
import {
	canReplayContinue,
	captureContinueReplaySnapshot,
	type ContinueReplaySnapshot,
	type ContinueReplayState,
} from "./agent-session-continue-replay.js";
import type { AgentSessionRecoveryArbiter, RecoveryReplayOwner } from "./agent-session-recovery-arbiter.js";

type ReplaySkipReason = "already_scheduled" | "state_changed";

export interface AgentSessionRecoveryReplaySchedulerOptions {
	owner: RecoveryReplayOwner;
	recoveryArbiter: AgentSessionRecoveryArbiter;
	getState: () => ContinueReplayState;
	emit: (event: AgentSessionEvent) => void;
}

export interface ScheduleRecoveryReplayOptions {
	delayMs: number;
	alreadyScheduledMessage: string;
	stateChangedMessage: string;
	run: () => Promise<void>;
	onSkipped?: (reason: ReplaySkipReason, snapshot: ContinueReplaySnapshot) => void;
	onRunError?: (error: unknown, snapshot: ContinueReplaySnapshot) => void;
}

export class AgentSessionRecoveryReplayScheduler {
	private scheduledReplay: ReturnType<typeof setTimeout> | undefined = undefined;

	constructor(private readonly options: AgentSessionRecoveryReplaySchedulerOptions) {}

	get isScheduled(): boolean {
		return this.scheduledReplay !== undefined;
	}

	cancel(): void {
		if (this.scheduledReplay) {
			clearTimeout(this.scheduledReplay);
			this.scheduledReplay = undefined;
			this.options.recoveryArbiter.clear(this.options.owner);
		}
	}

	schedule(options: ScheduleRecoveryReplayOptions): boolean {
		this.cancel();
		const snapshot = captureContinueReplaySnapshot(this.options.getState());
		if (!this.options.recoveryArbiter.tryArm(this.options.owner)) {
			this.emitReplaySkipped("already_scheduled", options.alreadyScheduledMessage);
			options.onSkipped?.("already_scheduled", snapshot);
			return false;
		}

		this.scheduledReplay = setTimeout(() => {
			this.scheduledReplay = undefined;
			if (!canReplayContinue(this.options.getState(), snapshot)) {
				this.options.recoveryArbiter.clear(this.options.owner);
				this.emitReplaySkipped("state_changed", options.stateChangedMessage);
				options.onSkipped?.("state_changed", snapshot);
				return;
			}

			this.options.recoveryArbiter.clear(this.options.owner);
			options.run().catch((error) => {
				options.onRunError?.(error, snapshot);
			});
		}, options.delayMs);
		return true;
	}

	private emitReplaySkipped(reason: ReplaySkipReason, message: string): void {
		this.options.emit({
			type: "recovery_replay_skipped",
			owner: this.options.owner,
			reason,
			message,
		});
	}
}
