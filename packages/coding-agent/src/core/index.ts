/**
 * Core modules shared between all run modes.
 */

export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ModelCycleResult,
	type PromptOptions,
	type SessionStats,
} from "./agent-session.js";
export {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
	createAgentSessionRuntime,
} from "./agent-session-runtime.js";
export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.js";
export { type BashExecutorOptions, type BashResult, executeBash, executeBashWithOperations } from "./bash-executor.js";
export type { CompactionResult } from "./compaction/index.js";
export { createEventBus, type EventBus, type EventBusController } from "./event-bus.js";
export {
	type EvidencePlanAction,
	type EvidencePlanState,
	type EvidencePlanStep,
	buildEvidencePlan,
	formatEvidencePlanStep,
	nextEvidencePlanStep,
} from "./evidence-planner.js";
// Extensions system
export {
	type AgentEndEvent,
	type AgentStartEvent,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BeforeAgentStartEvent,
	type ContextEvent,
	defineTool,
	discoverAndLoadExtensions,
	type ExecOptions,
	type ExecResult,
	type Extension,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionError,
	type ExtensionEvent,
	type ExtensionFactory,
	type ExtensionFlag,
	type ExtensionHandler,
	ExtensionRunner,
	type ExtensionShortcut,
	type ExtensionUIContext,
	type LoadExtensionsResult,
	type MessageRenderer,
	type RegisteredCommand,
	type SessionBeforeCompactEvent,
	type SessionBeforeForkEvent,
	type SessionBeforeSwitchEvent,
	type SessionBeforeTreeEvent,
	type SessionCompactEvent,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type SessionTreeEvent,
	type ToolCallEvent,
	type ToolCallEventResult,
	type ToolDefinition,
	type ToolRenderResultOptions,
	type ToolResultEvent,
	type TurnEndEvent,
	type TurnStartEvent,
} from "./extensions/index.js";
export { createSyntheticSourceInfo } from "./source-info.js";
export {
	type PatchIntent,
	type PatchReplacement,
	normalizePatchIntent,
} from "./patch-intent.js";
export {
	type RunDiagnosticInput,
	type RunDiagnostics,
	buildRunDiagnostics,
} from "./run-diagnostics.js";
export {
	type RepairControllerOptions,
	type RepairSnapshot,
	type RepairVerifierDecision,
	RepairController,
} from "./repair-controller.js";
export {
	type StopControllerOptions,
	type StopControllerSnapshot,
	type StopDecision,
	type StopDecisionInput,
	StopController,
	decideStop,
} from "./stop-controller.js";
export {
	type VerificationFailureClassification,
	type VerificationFailureClassificationOptions,
	type VerificationFailureKind,
	type VerificationSelectionOptions,
	classifyVerificationFailure,
	commandMatchesVerifier,
	selectVerificationCommand,
} from "./verification-controller.js";
export {
	type ControlledRuntimeMode,
	type ControlledTaskIntent,
	type TaskPolicy,
	classifyControlledTaskIntent,
	formatTaskPolicy,
	inferTaskPolicy,
} from "./task-policy.js";
export {
	type ControlledToolDecision,
	type ControlledToolObservation,
	type ToolOrchestratorOptions,
	ToolOrchestrator,
	parseEmbeddedTaskPolicy,
} from "./tool-orchestrator.js";
export {
	type BuildWorkspaceIndexOptions,
	type WorkspaceImportEdge,
	type WorkspaceIndex,
	type WorkspaceIndexFile,
	type WorkspaceManifest,
	type WorkspaceManifestOptions,
	buildWorkspaceIndex,
	buildWorkspaceManifest,
	formatWorkspaceManifest,
} from "./workspace-index.js";
