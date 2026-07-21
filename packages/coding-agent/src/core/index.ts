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
	buildEvidencePlan,
	type EvidencePlanAction,
	type EvidencePlanState,
	type EvidencePlanStep,
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
export {
	inferModelCapabilityProfile,
	type ModelCapabilityLevel,
	type ModelCapabilityProfile,
	type ModelCapabilityProfileInput,
	type RecommendedCompactionPolicy,
} from "./model-capability-profile.js";
export {
	normalizePatchIntent,
	type PatchIntent,
	type PatchReplacement,
} from "./patch-intent.js";
export {
	RepairController,
	type RepairControllerOptions,
	type RepairSnapshot,
	type RepairVerifierDecision,
} from "./repair-controller.js";
export {
	buildRunDiagnostics,
	type RunDiagnosticInput,
	type RunDiagnostics,
} from "./run-diagnostics.js";
export { createSyntheticSourceInfo } from "./source-info.js";
export {
	decideStop,
	StopController,
	type StopControllerOptions,
	type StopControllerSnapshot,
	type StopDecision,
	type StopDecisionInput,
} from "./stop-controller.js";
export {
	type ControlledRuntimeMode,
	type ControlledTaskIntent,
	classifyControlledTaskIntent,
	formatTaskPolicy,
	inferTaskPolicy,
	type TaskPolicy,
} from "./task-policy.js";
export {
	type ControlledToolDecision,
	type ControlledToolObservation,
	parseEmbeddedTaskPolicy,
	ToolOrchestrator,
	type ToolOrchestratorOptions,
} from "./tool-orchestrator.js";
export {
	classifyVerificationFailure,
	commandMatchesVerifier,
	selectVerificationCommand,
	type VerificationFailureClassification,
	type VerificationFailureClassificationOptions,
	type VerificationFailureKind,
	type VerificationSelectionOptions,
} from "./verification-controller.js";
export {
	type BuildWorkspaceIndexOptions,
	buildWorkspaceIndex,
	buildWorkspaceManifest,
	formatWorkspaceManifest,
	type WorkspaceImportEdge,
	type WorkspaceIndex,
	type WorkspaceIndexFile,
	type WorkspaceManifest,
	type WorkspaceManifestOptions,
} from "./workspace-index.js";
