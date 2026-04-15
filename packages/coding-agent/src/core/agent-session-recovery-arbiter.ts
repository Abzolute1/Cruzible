export type RecoveryReplayOwner = "retry" | "compaction";

export class AgentSessionRecoveryArbiter {
	private armedOwner: RecoveryReplayOwner | undefined = undefined;

	tryArm(owner: RecoveryReplayOwner): boolean {
		if (this.armedOwner && this.armedOwner !== owner) {
			return false;
		}
		this.armedOwner = owner;
		return true;
	}

	clear(owner?: RecoveryReplayOwner): void {
		if (!owner || this.armedOwner === owner) {
			this.armedOwner = undefined;
		}
	}

	get owner(): RecoveryReplayOwner | undefined {
		return this.armedOwner;
	}
}
