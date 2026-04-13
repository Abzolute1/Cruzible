// Auton — Nudge types
// Ported from Kairos src/agent/types.ts (nudges portion)

export type OutputTrend = "stable" | "diminishing" | "erratic";
export type NudgeType = "continue" | "wrap_up" | "break_loop" | "pivot" | "none";

export interface ToolOutcome {
	/** Tool name, e.g. "Read", "Verify", "Bash" */
	tool: string;
	/** Whether the tool execution succeeded (isError === false) */
	success: boolean;
	/** Estimated token cost of this tool's result content (optional) */
	estimatedTokens?: number;
	/** File path if this was a file-accessing tool (optional) */
	file?: string;
	/** Concise command or operation detail, when available. */
	detail?: string;
	/** Structured tool metadata when available, e.g. screenshot details. */
	metadata?: Record<string, unknown>;
}

export interface NudgeEvaluation {
	/** Whether to inject a nudge. */
	shouldNudge: boolean;
	/** Type of nudge. */
	nudgeType: NudgeType;
	/** If true, the loop should stop after this turn. */
	shouldStop: boolean;
	/** Reason for stopping (if shouldStop is true). */
	stopReason?: string;
	/** Human-readable explanation (for debug/logging). */
	explanation?: string;
}

export interface NudgeCooldownState {
	/** Last nudge type fired */
	lastNudgeType: NudgeType | null;
	/** Turn index when the last nudge was fired */
	lastNudgeTurn: number;
	/** Escalation level (0 = normal, increments on repeated same nudge) */
	escalationLevel: number;
}
