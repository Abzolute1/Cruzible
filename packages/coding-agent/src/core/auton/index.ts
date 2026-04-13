// Auton — Index: Export all Auton intelligence modules

// Core intelligence
export { type AutonConfig, AutonHook, attachAutonHook, type BudgetStatus, createAutonHook } from "./auton-hook.js";
export { AUTON_BEHAVIORAL_PROMPT } from "./behavioral-prompt.js";
export {
	type CompactionPolicy,
	type CompactionStrategy,
	cloudModelPolicy,
	getAutoCompactTrigger,
	localModelPolicy,
	moderateContextPolicy,
	selectCompactionPolicy,
} from "./compaction-policy.js";
export {
	ANTHROPIC_PRICING,
	CostTracker,
	FREE_PRICING,
	MODEL_PRICING_MAP,
	OPENAI_PRICING,
	type PricingModel,
	QWEN_PRICING,
} from "./cost-tracker.js";

// Nudges
export {
	evaluateNudge,
	evaluateNudgeWithCooldown,
	getNudgeMessage,
	MAX_ESCALATION_LEVEL,
	NUDGE_COOLDOWN_TURNS,
	type NudgeContext,
} from "./nudges/nudge-eval.js";
export { DIMINISHING_THRESHOLD, MAX_DIMINISHING_CONTINUATIONS, OutputTrendTracker } from "./nudges/output-trend.js";
export type { NudgeCooldownState, NudgeEvaluation, NudgeType, OutputTrend, ToolOutcome } from "./nudges/types.js";
export {
	runAutonomousSession,
	type AutonomousRunConfig,
	type AutonomousRunOptions,
	type AutonomousRunResult,
} from "./runner.js";
export {
	AUTONOMOUS_RUN_SNAPSHOT_ENTRY_TYPE,
	applyAutonomousLedgerEvents,
	appendAutonomousRunSnapshot,
	appendAutonomousRunSnapshotState,
	buildAutonomousCompactionInstructions,
	createAutonomousRunLedger,
	createAutonomousRunSnapshot,
	createAutonomousRunSnapshotFromState,
	formatAutonomousRunLedger,
	getLatestAutonomousRunSnapshot,
	updateAutonomousRunLedger,
	type AutonomousRunCheckpointPhase,
	type AutonomousLedgerEvent,
	type AutonomousRunLedger,
	type AutonomousRunSnapshot,
} from "./ledger.js";
export {
	activateAutonomousWorkspace,
	diffAutonomousWorkspace,
	prepareAutonomousWorkspace,
	promoteAutonomousWorkspace,
	type ActivatedAutonomousWorkspace,
	type AutonomousWorkspaceDiff,
	type AutonomousWorkspaceStrategy,
	type PreparedAutonomousWorkspace,
	type PromotedAutonomousWorkspace,
} from "./workspace.js";
export { agentToolDefinition } from "./tools/agent.js";
export { gitWorktreeToolDefinition } from "./tools/git-worktree.js";
export { lspToolDefinition } from "./tools/lsp.js";
export { notebookEditToolDefinition } from "./tools/notebook-edit.js";
export { skillToolDefinition } from "./tools/skill.js";
export { taskManagerToolDefinition } from "./tools/task-manager.js";
export { todoWriteToolDefinition } from "./tools/todowrite.js";
// Tools
export { type VerifyCommandResult, type VerifyResult, verifyToolDefinition } from "./tools/verify.js";
export { webFetchToolDefinition } from "./tools/webfetch.js";
export { webSearchToolDefinition } from "./tools/websearch.js";

import { agentToolDefinition } from "./tools/agent.js";
import { gitWorktreeToolDefinition } from "./tools/git-worktree.js";
import { lspToolDefinition } from "./tools/lsp.js";
import { notebookEditToolDefinition } from "./tools/notebook-edit.js";
import { skillToolDefinition } from "./tools/skill.js";
import { taskManagerToolDefinition } from "./tools/task-manager.js";
import { todoWriteToolDefinition } from "./tools/todowrite.js";
import { verifyToolDefinition } from "./tools/verify.js";
import { webFetchToolDefinition } from "./tools/webfetch.js";
import { webSearchToolDefinition } from "./tools/websearch.js";

export const autonTools = [
	verifyToolDefinition,
	lspToolDefinition,
	webSearchToolDefinition,
	webFetchToolDefinition,
	notebookEditToolDefinition,
	gitWorktreeToolDefinition,
	taskManagerToolDefinition,
	todoWriteToolDefinition,
	skillToolDefinition,
	agentToolDefinition,
] as const;
