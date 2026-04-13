// Auton — Compaction Policy
// Ported from Kairos src/agent/compaction-policy.ts
//
// Wired into autonomous-mode.ts: after each cycle, getContextUsage() is checked
// and session.compact() is called proactively when usage exceeds triggerThreshold.
// This prevents silent context overflow in long autonomous sessions.

export type CompactionStrategy = "micro" | "snip" | "auto";

export interface CompactionPolicy {
	contextWindow: number;
	triggerThreshold: number;
	strategies: CompactionStrategy[];
	microCompactThreshold: number;
	autoCompactKeepTurns: number;
	blockingBuffer: number;
}

export function cloudModelPolicy(contextWindow: number): CompactionPolicy {
	return {
		contextWindow,
		triggerThreshold: 0.85,
		strategies: ["auto"],
		microCompactThreshold: 100_000,
		autoCompactKeepTurns: 8,
		blockingBuffer: 10_000,
	};
}

export function moderateContextPolicy(contextWindow: number): CompactionPolicy {
	return {
		contextWindow,
		triggerThreshold: 0.75,
		strategies: ["micro", "auto"],
		microCompactThreshold: 10_000,
		autoCompactKeepTurns: 6,
		blockingBuffer: 8_000,
	};
}

export function localModelPolicy(contextWindow: number): CompactionPolicy {
	return {
		contextWindow,
		triggerThreshold: 0.7,
		strategies: ["micro", "snip", "auto"],
		microCompactThreshold: 2_000,
		autoCompactKeepTurns: 4,
		blockingBuffer: 4_000,
	};
}

export function selectCompactionPolicy(contextWindow: number): CompactionPolicy {
	if (contextWindow >= 500_000) return cloudModelPolicy(contextWindow);
	if (contextWindow >= 100_000) return moderateContextPolicy(contextWindow);
	return localModelPolicy(contextWindow);
}

export function getAutoCompactTrigger(policy: CompactionPolicy): number {
	return Math.floor(policy.contextWindow * policy.triggerThreshold);
}
