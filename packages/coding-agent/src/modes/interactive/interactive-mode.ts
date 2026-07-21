/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@ag1/agent-core";
import type { AssistantMessage, ImageContent, Message, Model } from "@ag1/ai";
import type {
	AutocompleteItem,
	EditorComponent,
	EditorTheme,
	KeyId,
	MarkdownTheme,
	OverlayHandle,
	OverlayOptions,
	SlashCommand,
} from "@ag1/tui";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	fuzzyFilter,
	Loader,
	matchesKey,
	ProcessTerminal,
	Spacer,
	setKeybindings,
	Text,
	TUI,
} from "@ag1/tui";
import { spawnSync } from "child_process";
import { getAgentDir, getAuthPath, getDebugLogPath, VERSION } from "../../config.js";
import { type AgentSession, type AgentSessionEvent, parseSkillBlock } from "../../core/agent-session.js";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import {
	type AutonomousRunSnapshot,
	formatAutonomousRunLedger,
	getLatestAutonomousRunSnapshot,
} from "../../core/auton/ledger.js";
import { buildToolOutcomeFingerprint, normalizeToolName } from "../../core/auton/nudges/types.js";
import type { AutonomousRunConfig, AutonomousRunResult } from "../../core/auton/runner.js";
import { runAutonomousSession } from "../../core/auton/runner.js";
import {
	type ActivatedAutonomousWorkspace,
	activateAutonomousWorkspace,
	type PreparedAutonomousWorkspace,
} from "../../core/auton/workspace.js";
import { DelegationEvidenceTracker } from "../../core/delegation-evidence.js";
import type {
	ExtensionContext,
	ExtensionRunner,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
} from "../../core/extensions/index.js";
import { trustProject } from "../../core/extensions/loader.js";
import { FooterDataProvider, type ReadonlyFooterDataProvider } from "../../core/footer-data-provider.js";
import { KeybindingsManager } from "../../core/keybindings.js";
import {
	buildLocalEvidencePromptAddendum,
	buildRuntimeContinuationMessage,
	isPromptSteeringEnabled,
} from "../../core/local-evidence-steering.js";
import { findExactModelReferenceMatch, resolveModelScope } from "../../core/model-resolver.js";
import { deduplicateWarnings, evaluateInteractiveNudges } from "../../core/nudge-warnings.js";
import { buildPromptIntentAddendum } from "../../core/prompt-intent-steering.js";
import { getRecentResearchArtifacts } from "../../core/research-artifacts.js";
import type { ResourceDiagnostic } from "../../core/resource-loader.js";
import {
	appendRuntimeHealthSnapshotIfChanged,
	createRuntimeHealthSnapshotFromState,
	deriveRuntimeStabilizationProfile,
	getRecentRuntimeHealthSnapshots,
	type RuntimeStabilizationProfile,
} from "../../core/runtime-health.js";
import type { ToolApprovalRequest, ToolSafetyPolicy } from "../../core/safety-policy.js";
import { formatMissingSessionCwdPrompt, type MissingSessionCwdError } from "../../core/session-cwd.js";
import { SessionDebugLogger } from "../../core/session-debug-logger.js";
import { type SessionContext, SessionManager } from "../../core/session-manager.js";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.js";
import type { SourceInfo } from "../../core/source-info.js";
import { collectExistingTestPaths } from "../../core/test-paths.js";
import {
	appendTodoSnapshot,
	clearTodoList,
	isTodoListStale,
	readLatestTodoSnapshot,
	replaceTodoList,
	summarizeTodos,
	type TodoItem,
	type TodoListSnapshot,
} from "../../core/todos.js";
import { buildToolCallDigest, buildToolResultDigest } from "../../core/tool-outcome-digests.js";
import type { TruncationResult } from "../../core/tools/truncate.js";
import { modelSupportsVision } from "../../core/tools/visual/vision.js";
import { getChangelogPath, parseChangelog } from "../../utils/changelog.js";
import { extensionForImageMimeType, readClipboardImage } from "../../utils/clipboard-image.js";
import { parseGitUrl } from "../../utils/git.js";
import { ensureTool } from "../../utils/tools-manager.js";
import { Ag1GreeterComponent, type Ag1GreeterOptions } from "./components/ag1-greeter.js";
import { ArminComponent } from "./components/armin.js";
import { AssistantMessageComponent } from "./components/assistant-message.js";
import { BashExecutionComponent } from "./components/bash-execution.js";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.js";
import { CenteredBannerComponent } from "./components/centered-banner.js";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.js";
import { ContextInputDialog } from "./components/context-input-dialog.js";
import { CustomEditor } from "./components/custom-editor.js";
import { CustomMessageComponent } from "./components/custom-message.js";
import { DaxnutsComponent } from "./components/daxnuts.js";
import { EarendilAnnouncementComponent } from "./components/earendil-announcement.js";
import { FooterComponent } from "./components/footer.js";
import { keyText } from "./components/keybinding-hints.js";
import { LoginDialogComponent } from "./components/login-dialog.js";
import { ModelSelectorComponent } from "./components/model-selector.js";
import { NoticeCardComponent } from "./components/notice-card.js";
import { OAuthSelectorComponent } from "./components/oauth-selector.js";
import type { PlanWorkflowDialogOption } from "./components/plan-workflow-dialog.js";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.js";
import { SessionSelectorComponent } from "./components/session-selector.js";
import { SettingsSelectorComponent } from "./components/settings-selector.js";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.js";
import { ToolExecutionComponent } from "./components/tool-execution.js";
import { TreeSelectorComponent } from "./components/tree-selector.js";
import { TurnRail } from "./components/turn-rail.js";
import { UserMessageComponent } from "./components/user-message.js";
import { UserMessageSelectorComponent } from "./components/user-message-selector.js";
import { type GenerationStatsEvent, GenerationStatsTracker } from "./generation-stats.js";
import {
	hasLoggedInOAuthProviders,
	performInteractiveOAuthLogout,
	runInteractiveOAuthLogin,
} from "./interactive-auth-flow.js";
import {
	buildAutonomousStabilizedUserMessage,
	buildInteractiveStabilizedUserMessage,
	buildPlanningUserMessage,
	getInteractiveAutonomousResumeSnapshot,
	resolveInteractiveAutonomousRunConfig,
} from "./interactive-autonomous-stabilization.js";
import { formatPersistentModeLine, getAutonomousScopeGuardReason } from "./interactive-autonomous-ui.js";
import { dispatchInteractiveBuiltinCommand } from "./interactive-command-actions.js";
import type { InteractiveBuiltinCommand } from "./interactive-command-parser.js";
import { parseInteractiveBuiltinCommand } from "./interactive-command-parser.js";
import { resolveInteractiveContextWindowInput } from "./interactive-context-window.js";
import { restoreEditorHost, showEditorHostComponent } from "./interactive-editor-host.js";
import { handleInteractiveEditorSubmitAfterBuiltin } from "./interactive-editor-submit.js";
import {
	handleInteractiveCompactionEnd,
	handleInteractiveCompactionStart,
	handleInteractiveDegradedTurnEvent,
	handleInteractiveRecoveryReplaySkipped,
	handleInteractiveRetryEnd,
	handleInteractiveRetryStart,
	handleInteractiveXmlFallbackEvent,
} from "./interactive-event-actions.js";
import { ExtensionDialogStack } from "./interactive-extension-dialogs.js";
import {
	performInteractiveCopyLastAssistantMessage,
	performInteractiveReload,
	performInteractiveSessionExport,
	performInteractiveSessionShare,
} from "./interactive-maintenance-actions.js";
import {
	applyInteractiveScopedModelSelection,
	createInteractiveScopedModelsCallbacks,
	deriveInteractiveScopedModelSelection,
} from "./interactive-model-scope.js";
import {
	createInteractivePlanArtifactRef,
	createInteractivePlanSelection,
	getInteractivePlanArtifacts,
	getLatestInteractivePlanArtifact,
	getLatestInteractivePlanSelection,
	INTERACTIVE_PLAN_SELECTION_TYPE,
	type InteractivePlanArtifact,
	type InteractivePlanSelection,
	isSameInteractivePlanArtifactRef,
	resolveInteractivePlanArtifactRef,
	type SubmitPlanSubmission,
} from "./interactive-plan-artifacts.js";
import { handlePlanCommand } from "./interactive-plan-commands.js";
import {
	answerClarifyingPlanArtifact,
	executeNextPlanStep,
	executePlanArtifact,
	getPlanStepSelectorOptions,
	markPlanStepComplete,
	type PlanStepMutationDeps,
	persistLatestPlanArtifact,
	persistPlanExecutionReview,
	type RunPlanningPromptOptions,
	rejectPlanArtifact,
	reopenPlanStep,
	revisePlanArtifact,
	runPlanningPrompt,
	SUBMIT_PLAN_TOOL_NAME,
	showPlanArtifactCard,
} from "./interactive-plan-execution.js";
import {
	createPlanWorkflowOption,
	getPlanInterviewChoiceOptions,
	getPlanInterviewQuestionChoiceOptions,
	PlanInterviewFlow,
	splitPlanInterviewChoiceOptions,
} from "./interactive-plan-interview.js";
import {
	acceptPlanArtifact,
	formatPlanSelectorOption,
	getPlanReviewActions,
	handlePlanReviewAction,
	offerAcceptedPlanHandoff,
	type PlanReviewActionId,
	showImmediatePlanActionSelector,
	showPlanReviewSelector,
} from "./interactive-plan-review.js";
import { buildInteractivePlanReviewLines } from "./interactive-plan-review-ui.js";
import {
	type CompactionQueuedMessage,
	clearInteractiveQueuedMessages,
	combineQueuedMessagesForEditor,
	flushInteractiveCompactionQueue,
	getInteractiveQueuedMessages,
	handleInteractiveFollowUpSubmit,
} from "./interactive-queued-messages.js";
import {
	getInteractiveAppKeyDisplay,
	renderInteractiveChangelog,
	renderInteractiveHotkeys,
} from "./interactive-reference-actions.js";
import {
	getInteractiveWorkspaceSummary,
	renderInteractiveDebugLogStatus,
	renderInteractiveResearchArtifacts,
	renderInteractiveSessionInfo,
	writeInteractiveDebugLog,
} from "./interactive-report-actions.js";
import {
	buildScopeGroups,
	formatDiagnostics,
	formatDisplayPath,
	formatScopeGroups,
	getShortPath,
} from "./interactive-resource-formatting.js";
import { applyConfiguredTheme, applyInteractiveRuntimeSettings } from "./interactive-runtime-settings.js";
import { restoreInteractiveRuntimeState } from "./interactive-runtime-state.js";
import {
	performInteractiveRuntimeReplacement,
	performInteractiveRuntimeTransition,
} from "./interactive-runtime-transitions.js";
import { performInteractiveModelSwitch, renameInteractiveSession } from "./interactive-selector-actions.js";
import { performInteractiveSessionFork, performInteractiveSessionResume } from "./interactive-session-actions.js";
import {
	formatAutonomousCheckpointStatus as buildAutonomousCheckpointStatus,
	formatAutonomousControlSummary as buildAutonomousControlSummary,
	getAutonomousRecoveryActions as buildAutonomousRecoveryActions,
	formatAutonomousRecoverySummary as buildAutonomousRecoverySummary,
	formatAutonomousResearchSummary as buildAutonomousResearchSummary,
	formatAutonomousStabilizationSummary as buildAutonomousStabilizationSummary,
	formatAutonomousVisualSummary as buildAutonomousVisualSummary,
	formatDebugArtifactsSummary as buildDebugArtifactsSummary,
	formatDegradedTurnWarning as buildDegradedTurnWarning,
	formatRequestFailureWarning as buildRequestFailureWarning,
	formatRuntimeHealthIssue as buildRuntimeHealthIssue,
	formatRuntimeHealthSummary as buildRuntimeHealthSummary,
	formatRuntimeHealthTimelineSummary as buildRuntimeHealthTimelineSummary,
	formatRuntimeRecoverySummary as buildRuntimeRecoverySummary,
	formatXmlFallbackWarning as buildXmlFallbackWarning,
	getAutonomousControlStateFromSnapshot as deriveAutonomousControlStateFromSnapshot,
} from "./interactive-session-formatters.js";
import { buildInteractiveSettingsConfig, createInteractiveSettingsCallbacks } from "./interactive-settings-selector.js";
import {
	checkForNewVersion,
	checkForPackageUpdates,
	checkTmuxKeyboardSetup,
	getInteractiveStartupChangelog,
	renderInteractiveStartupNotices,
	renderPackageUpdateNotification,
	runInteractiveStartupPrompts,
} from "./interactive-startup-actions.js";
import {
	estimateInteractiveToolResultTokens,
	extractInteractiveToolDetail,
	extractInteractiveToolFile,
	extractInteractiveToolMetadata,
} from "./interactive-tool-outcomes.js";
import { applyInteractiveTreeNavigationSuccess, performInteractiveTreeNavigation } from "./interactive-tree-actions.js";
import { resolveInteractiveBranchSummaryChoice } from "./interactive-tree-navigation.js";
import {
	buildInteractiveQueuedContextLines,
	normalizeInteractiveWorkspaceSummaryLines,
} from "./interactive-ui-context.js";
import { WorkingActivityTracker } from "./interactive-working-activity.js";
import { WorkingVerbAnimator, type WorkingVerbPhase, type WorkingVerbTone } from "./interactive-working-verbs.js";
import { executeInteractiveWorkspaceCommand } from "./interactive-workspace-actions.js";
import {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getEditorTheme,
	getMarkdownTheme,
	getThemeByName,
	initTheme,
	onThemeChange,
	setRegisteredThemes,
	setTheme,
	setThemeInstance,
	stopThemeWatcher,
	Theme,
	type ThemeColor,
	theme,
} from "./theme/theme.js";

const GREETER_DISPLAY_VERSION = ".01.3";

/** Interface for components that can be expanded/collapsed */
interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

type XmlFallbackEvent = Extract<AgentSessionEvent, { type: "xml_tool_call" }>;
type DegradedTurnEvent = Extract<AgentSessionEvent, { type: "degraded_turn" }>;
type SessionActivityState = { isStreaming?: boolean; isCompacting?: boolean };
type PlanArtifactCommandTarget = "current" | "planning" | "execution";
type ModelRouteMode = "planning" | "execution" | "verifier";

type PlanArtifactCommandResolution = { artifact: InteractivePlanArtifact | undefined; ambiguousRevision?: number };
type PlanArtifactCommandResolver = (
	revision: number | undefined,
	defaultTarget?: PlanArtifactCommandTarget,
) => PlanArtifactCommandResolution;
type PlanSelectionAppender = (updates: Partial<InteractivePlanSelection>) => void;
type PlanSelectionGetter = () => InteractivePlanSelection | undefined;
type PlanSelectionClearer = (artifact: InteractivePlanArtifact) => void;
function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function getOptionalReceiverMethod<T extends (...args: any[]) => any>(receiver: unknown, key: string): T | undefined {
	const candidate = asRecord(receiver)?.[key];
	return typeof candidate === "function" ? (candidate as T) : undefined;
}

function getOptionalReceiverSessionState(receiver: unknown): SessionActivityState | undefined {
	const record = asRecord(receiver);
	if (!record) return undefined;
	if (Object.hasOwn(record, "session")) {
		return asRecord(record.session) as SessionActivityState | undefined;
	}
	return asRecord(asRecord(record.runtimeHost)?.session) as SessionActivityState | undefined;
}

function resolvePlanArtifactForCommandWithFallback(
	receiver: unknown,
	getPlanArtifactByRevision: (revision?: number) => InteractivePlanArtifact | undefined,
	revision: number | undefined,
	defaultTarget: PlanArtifactCommandTarget = "current",
): PlanArtifactCommandResolution {
	const resolver = getOptionalReceiverMethod<PlanArtifactCommandResolver>(receiver, "resolvePlanArtifactForCommand");
	return resolver
		? resolver.call(receiver, revision, defaultTarget)
		: { artifact: getPlanArtifactByRevision(revision) };
}

function appendPlanSelectionForReceiver(receiver: unknown, updates: Partial<InteractivePlanSelection>): void {
	const appendPlanSelection = getOptionalReceiverMethod<PlanSelectionAppender>(receiver, "appendPlanSelection");
	appendPlanSelection?.call(receiver, updates);
}

function getLatestPlanSelectionForReceiver(receiver: unknown): InteractivePlanSelection | undefined {
	const getLatestPlanSelection = getOptionalReceiverMethod<PlanSelectionGetter>(receiver, "getLatestPlanSelection");
	return getLatestPlanSelection?.call(receiver);
}

function clearPlanSelectionForArtifactForReceiver(receiver: unknown, artifact: InteractivePlanArtifact): void {
	const clearPlanSelection = getOptionalReceiverMethod<PlanSelectionClearer>(
		receiver,
		"clearPlanSelectionForArtifact",
	);
	clearPlanSelection?.call(receiver, artifact);
}

export interface AutonomousExecutionConfig extends AutonomousRunConfig {
	/** Optional startup mode for the first prompt only. Normal use is Alt+M in the TUI. */
	startInAutonomousMode?: boolean;
}

/**
 * Options for InteractiveMode initialization.
 */
export interface InteractiveModeOptions {
	/** Providers that were migrated to auth.json (shows warning) */
	migratedProviders?: string[];
	/** Warning message if session model couldn't be restored */
	modelFallbackMessage?: string;
	/** Initial message to send on startup (can include @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Additional messages to send after the initial message */
	initialMessages?: string[];
	/** Force verbose startup (overrides quietStartup setting) */
	verbose?: boolean;
	/** Initial autonomous execution settings. Alt+M remains the primary UX. */
	autonomousConfig?: AutonomousExecutionConfig;
}

export class InteractiveMode {
	private runtimeHost: AgentSessionRuntime;
	private ui: TUI;
	private chatContainer: Container;
	private pendingMessagesContainer: Container;
	private statusContainer: Container;
	private defaultEditor: CustomEditor;
	private editor: EditorComponent;
	private autocompleteProvider: CombinedAutocompleteProvider | undefined;
	private fdPath: string | undefined;
	private editorContainer: Container;
	private modeStripContainer: Container;
	private modeStrip: CenteredBannerComponent;
	private footer: FooterComponent;
	private footerDataProvider: FooterDataProvider;
	// Stored so the same manager can be injected into custom editors, selectors, and extension UI.
	private keybindings: KeybindingsManager;
	private version: string;
	private isInitialized = false;
	private onInputCallback?: (text: string) => void;
	private loadingAnimation: Loader | undefined = undefined;
	/** Left-rail grouping the current assistant turn's rendered content. */
	private currentTurnRail: TurnRail | undefined;

	/** Target container for assistant-turn content (streaming message, tool calls, groups). */
	private assistantContentTarget(): Container {
		// Self-heals after any chatContainer.clear() (rebuilds, /new, verbose toggles).
		if (!this.currentTurnRail || !this.chatContainer.children.includes(this.currentTurnRail)) {
			this.currentTurnRail = new TurnRail();
			this.chatContainer.addChild(this.currentTurnRail);
		}
		return this.currentTurnRail;
	}
	private readonly generationStats = new GenerationStatsTracker();

	/** Live generation stats suffix for the loader (phase, ~tokens, tok/s, elapsed, silence tone). */
	private generationStatsLine(): string | undefined {
		const line = this.generationStats?.statsLine();
		if (!line) return undefined;
		const colored =
			line.tone === "alert"
				? theme.fg("error", line.text)
				: line.tone === "warn"
					? theme.fg("warning", line.text)
					: theme.fg("muted", line.text);
		return `${theme.fg("muted", "·")} ${colored}`;
	}
	private pendingWorkingMessage: string | undefined = undefined;
	private readonly defaultHiddenThinkingLabel = "Thinking...";
	private hiddenThinkingLabel = this.defaultHiddenThinkingLabel;
	private activeWorkingVerb:
		| {
				phase: WorkingVerbPhase;
				verb: string;
				tone: WorkingVerbTone;
				target?: string;
				interruptible: boolean;
		  }
		| undefined = undefined;

	private lastSigintTime = 0;
	private lastEscapeTime = 0;
	private changelogMarkdown: string | undefined = undefined;
	private startupNoticesShown = false;

	// Status line tracking (for mutating immediately-sequential status updates)
	private lastStatusSpacer: Spacer | undefined = undefined;
	private lastStatusNotice: NoticeCardComponent | undefined = undefined;

	// Streaming message tracking
	private streamingComponent: AssistantMessageComponent | undefined = undefined;
	private streamingMessage: AssistantMessage | undefined = undefined;
	private suppressPlanningAssistantTranscript = false;

	// Tool execution tracking: toolCallId -> component
	private pendingTools = new Map<string, ToolExecutionComponent>();
	private pendingToolArgs = new Map<string, Record<string, unknown>>();
	// Bridges delegation outcomes to the ledger: tools like an extension
	// `subagent` return no structured evidence, so observed workspace changes
	// are attached as file evidence instead (see core/delegation-evidence.ts).
	private delegationEvidence = new DelegationEvidenceTracker();

	// Tool output expansion state
	private toolOutputExpanded = false;

	// Thinking block visibility state
	private hideThinkingBlock = false;
	private planningReadOnlyToolsAllowed = true;

	// Skill commands: command name -> skill file path
	private skillCommands = new Map<string, string>();

	// Agent subscription unsubscribe function
	private unsubscribe?: () => void;

	// Session debug logger
	private debugLogger: SessionDebugLogger | undefined = undefined;

	// Track if editor is in bash mode (text starts with !)
	private isBashMode = false;

	// Track current bash execution component
	private bashComponent: BashExecutionComponent | undefined = undefined;

	// Track pending bash components (shown in pending area, moved to chat on submit)
	private pendingBashComponents: BashExecutionComponent[] = [];

	// Working verb animator (extracted)
	private workingVerbAnimator: WorkingVerbAnimator;
	// Working activity tracker (extracted): prompt memory + managed working message logic
	private workingActivity: WorkingActivityTracker;

	// Auto-compaction state
	private autoCompactionLoader: Loader | undefined = undefined;
	private autoCompactionEscapeHandler?: () => void;

	// Auto-retry state
	private retryLoader: Loader | undefined = undefined;
	private retryEscapeHandler?: () => void;

	// Messages queued while compaction is running
	private compactionQueuedMessages: CompactionQueuedMessage[] = [];

	// Shutdown state
	private shutdownRequested = false;

	// Extension UI state
	private extensionDialogs: ExtensionDialogStack;
	private planInterviewFlow: PlanInterviewFlow;
	private extensionTerminalInputUnsubscribers = new Set<() => void>();

	// Workspace-trust prompt for project-local extensions (asked once per app run)
	private projectTrustPromptHandled = false;

	// Extension widgets (components rendered above/below the editor)
	private extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();
	private extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();
	private widgetContainerAbove!: Container;
	private widgetContainerBelow!: Container;

	// Custom footer from extension (undefined = use built-in footer)
	private customFooter: (Component & { dispose?(): void }) | undefined = undefined;

	// Header container that holds the built-in or custom header
	private headerContainer: Container;

	// Built-in header (logo + keybinding hints + changelog)
	private builtInHeader: Component | undefined = undefined;

	// Custom header from extension (undefined = use built-in header)
	private customHeader: (Component & { dispose?(): void }) | undefined = undefined;

	// Nudge warning tracking for interactive mode
	private nudgeToolCallHistory: import("../../core/auton/nudges/types.js").ToolOutcome[] = [];
	private nudgeFileAccessHistory: import("../../core/auton/nudges/types.js").ToolOutcome[] = [];
	private currentTurnToolCallHistory: import("../../core/auton/nudges/types.js").ToolOutcome[] = [];
	private currentTurnFileAccessHistory: import("../../core/auton/nudges/types.js").ToolOutcome[] = [];
	private pendingRuntimePromptAddendum: string | undefined = undefined;
	private nudgeTurnIndex = 0;
	private nudgeShownWarnings = new Map<string, number>(); // type -> turnIndex
	private lastNudgeOutputTokens = 0;

	// Autonomous mode state — when enabled, the prompt handler loops instead
	// of waiting for user input after each turn. The loop checks three
	// independent exit conditions: budget (hard stop), nudge engine (stuck
	// detection), and completion (no tool calls + LLM said stop).
	private autonomousMode: boolean;
	private planningMode = false;
	/** Structured plan payload from the submit_plan tool during the current planning turn. */
	private lastSubmitPlanPayload: SubmitPlanSubmission | undefined;
	/** Current todo list; undefined until lazily seeded from the session journal. */
	private todoSnapshot: TodoListSnapshot | null | undefined;
	/** Tool calls since the last todo write, for staleness nudges. */
	private toolCallsSinceTodoUpdate = 0;
	private autonomousConfig: AutonomousExecutionConfig;
	private activeAutonomousWorkspace: ActivatedAutonomousWorkspace | undefined = undefined;
	private lastAutonomousWorkspace: PreparedAutonomousWorkspace | undefined = undefined;
	private lastAutonomousRunResult: AutonomousRunResult | undefined = undefined;
	private lastAutonomousLiveStatus: string | undefined = undefined;
	private xmlFallbackCount = 0;
	private degradedTurnCount = 0;
	private lastXmlFallbackEvent: XmlFallbackEvent | undefined = undefined;
	private lastDegradedTurnEvent: DegradedTurnEvent | undefined = undefined;

	// Convenience accessors
	private get session(): AgentSession {
		return this.runtimeHost.session;
	}
	private get agent() {
		return this.session.agent;
	}
	private get sessionManager() {
		return this.session.sessionManager;
	}
	private get settingsManager() {
		return this.session.settingsManager;
	}

	constructor(
		runtimeHost: AgentSessionRuntime,
		private options: InteractiveModeOptions = {},
	) {
		this.runtimeHost = runtimeHost;
		this.version = VERSION;
		this.ui = new TUI(new ProcessTerminal(), this.settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		this.headerContainer = new Container();
		this.chatContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: editorPaddingX,
			autocompleteMaxVisible,
		});
		this.editor = this.defaultEditor;
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor as Component);
		this.extensionDialogs = new ExtensionDialogStack({
			ui: this.ui,
			keybindings: this.keybindings,
			editorContainer: this.editorContainer,
			getEditor: () => this.editor,
			showStatus: (message) => this.showStatus(message),
			showWarning: (message) => this.showWarning(message),
			showError: (message) => this.showError(message),
		});
		this.planInterviewFlow = new PlanInterviewFlow({
			sessionManager: this.sessionManager,
			showPlanWorkflowDialog: (title, lines, options, dialogOptions) =>
				this.showPlanWorkflowDialog(title, lines, options, dialogOptions),
			showExtensionEditor: (title, prefill) => this.showExtensionEditor(title, prefill),
			showExtensionInput: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
			updatePendingMessagesDisplay: () => this.updatePendingMessagesDisplay(),
			updateModeDisplay: () => this.updateModeDisplay(),
			showStatus: (message) => this.showStatus(message),
			answerClarifyingPlanArtifact: (artifact, answer) => this.answerClarifyingPlanArtifact(artifact, answer),
			showPlanArtifactCard: (artifact, options) => this.showPlanArtifactCard(artifact, options),
			handlePlanCommand: (command) => this.handlePlanCommand(command),
		});
		this.modeStripContainer = new Container();
		this.modeStrip = new CenteredBannerComponent();
		this.modeStripContainer.addChild(this.modeStrip);
		this.footerDataProvider = new FooterDataProvider(this.sessionManager.getCwd());
		this.footer = new FooterComponent(this.session, this.footerDataProvider);
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);

		// Load hide thinking block setting
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();

		// Autonomous mode is keyboard-first in the TUI. A startup flag may set the
		// initial state for the first prompt, but Alt+M is the primary way to
		// engage or disengage the loop once the UI is running.
		this.autonomousConfig = options.autonomousConfig ?? {};
		this.autonomousMode = this.autonomousConfig.startInAutonomousMode ?? false;

		// Working verb animator (high quality extraction)
		this.workingVerbAnimator = new WorkingVerbAnimator({
			isAutonomous: () => this.autonomousMode,
			setMessage: (msg: string) => {
				if (this.loadingAnimation) {
					this.loadingAnimation.setMessage(msg);
				} else {
					this.pendingWorkingMessage = msg;
				}
			},
			requestRender: () => this.ui.requestRender(),
		});
		this.workingActivity = new WorkingActivityTracker({
			isAutonomous: () => this.autonomousMode,
			getActiveWorkingVerb: () => this.activeWorkingVerb,
			setActiveWorkingVerb: (state) => {
				this.activeWorkingVerb = state;
			},
			animator: this.workingVerbAnimator,
			deliverMessage: (message) => {
				if (this.loadingAnimation) {
					this.loadingAnimation.setMessage(message);
				} else {
					this.pendingWorkingMessage = message;
				}
			},
		});

		// Register themes from resource loader and initialize
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		initTheme(this.settingsManager.getTheme(), true);
	}

	private getAutocompleteSourceTag(sourceInfo?: SourceInfo): string | undefined {
		if (!sourceInfo) {
			return undefined;
		}

		const scopePrefix = sourceInfo.scope === "user" ? "u" : sourceInfo.scope === "project" ? "p" : "t";
		const source = sourceInfo.source.trim();

		if (source === "auto" || source === "local" || source === "cli") {
			return scopePrefix;
		}

		if (source.startsWith("npm:")) {
			return `${scopePrefix}:${source}`;
		}

		const gitSource = parseGitUrl(source);
		if (gitSource) {
			const ref = gitSource.ref ? `@${gitSource.ref}` : "";
			return `${scopePrefix}:git:${gitSource.host}/${gitSource.path}${ref}`;
		}

		return scopePrefix;
	}

	private prefixAutocompleteDescription(description: string | undefined, sourceInfo?: SourceInfo): string | undefined {
		const sourceTag = this.getAutocompleteSourceTag(sourceInfo);
		if (!sourceTag) {
			return description;
		}
		return description ? `[${sourceTag}] ${description}` : `[${sourceTag}]`;
	}

	private getBuiltInCommandConflictDiagnostics(extensionRunner: ExtensionRunner | undefined): ResourceDiagnostic[] {
		if (!extensionRunner) {
			return [];
		}

		const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
		return extensionRunner
			.getRegisteredCommands()
			.filter((command) => builtinNames.has(command.name))
			.map((command) => ({
				type: "warning" as const,
				message:
					command.invocationName === command.name
						? `Extension command '/${command.name}' conflicts with built-in interactive command. Skipping in autocomplete.`
						: `Extension command '/${command.name}' conflicts with built-in interactive command. Available as '/${command.invocationName}'.`,
				path: command.sourceInfo.path,
			}));
	}

	private setupAutocomplete(fdPath: string | undefined): void {
		// Define commands for autocomplete
		const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map((command) => ({
			name: command.name,
			description: command.description,
		}));

		const modelCommand = slashCommands.find((command) => command.name === "model");
		if (modelCommand) {
			modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				// Get available models (scoped or from registry)
				const models =
					this.session.scopedModels.length > 0
						? this.session.scopedModels.map((s) => s.model)
						: this.session.modelRegistry.getAvailable();

				if (models.length === 0) return null;

				// Create items with provider/id format
				const items = models.map((m) => ({
					id: m.id,
					provider: m.provider,
					label: `${m.provider}/${m.id}`,
				}));

				// Fuzzy filter by model ID + provider (allows "opus anthropic" to match)
				const filtered = fuzzyFilter(items, prefix, (item) => `${item.id} ${item.provider}`);

				if (filtered.length === 0) return null;

				return filtered.map((item) => ({
					value: item.label,
					label: item.id,
					description: item.provider,
				}));
			};
		}

		// Convert prompt templates to SlashCommand format for autocomplete
		const templateCommands: SlashCommand[] = this.session.promptTemplates.map((cmd) => ({
			name: cmd.name,
			description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
		}));

		// Convert extension commands to SlashCommand format
		const builtinCommandNames = new Set(slashCommands.map((c) => c.name));
		const extensionCommands: SlashCommand[] = (
			this.session.extensionRunner?.getRegisteredCommands().filter((cmd) => !builtinCommandNames.has(cmd.name)) ?? []
		).map((cmd) => ({
			name: cmd.invocationName,
			description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
			getArgumentCompletions: cmd.getArgumentCompletions,
		}));

		// Build skill commands from session.skills (if enabled)
		this.skillCommands.clear();
		const skillCommandList: SlashCommand[] = [];
		if (this.settingsManager.getEnableSkillCommands()) {
			for (const skill of this.session.resourceLoader.getSkills().skills) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill.filePath);
				skillCommandList.push({
					name: commandName,
					description: this.prefixAutocompleteDescription(skill.description, skill.sourceInfo),
				});
			}
		}

		// Setup autocomplete
		this.autocompleteProvider = new CombinedAutocompleteProvider(
			[...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList],
			this.sessionManager.getCwd(),
			fdPath,
		);
		this.defaultEditor.setAutocompleteProvider(this.autocompleteProvider);
		if (this.editor !== this.defaultEditor) {
			this.editor.setAutocompleteProvider?.(this.autocompleteProvider);
		}
	}

	private shouldShowEarendilAnnouncement(): boolean {
		// Disabled in AG1 fork
		return false;
	}

	private showStartupNoticesIfNeeded(): void {
		if (this.startupNoticesShown) {
			return;
		}
		this.startupNoticesShown = true;
		renderInteractiveStartupNotices({
			chatContainer: this.chatContainer,
			changelogMarkdown: this.changelogMarkdown,
			version: this.version,
			collapseChangelog: this.settingsManager.getCollapseChangelog(),
			currentCwd: this.sessionManager.getCwd(),
			getMarkdownThemeWithSettings: () => this.getMarkdownThemeWithSettings(),
			renderEarendilAnnouncement: this.shouldShowEarendilAnnouncement()
				? () => {
						if (this.chatContainer.children.length > 0) {
							this.chatContainer.addChild(new Spacer(1));
						}
						this.chatContainer.addChild(new EarendilAnnouncementComponent());
					}
				: undefined,
		});
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		// Load changelog (only show new entries, skip for resumed sessions)
		this.changelogMarkdown = this.getChangelogForDisplay();

		// Prefer fd and rg when they are already available. Managed downloads are
		// opt-in via AG1_ALLOW_TOOL_AUTO_DOWNLOAD=1.
		const [fdPath] = await Promise.all([ensureTool("fd"), ensureTool("rg")]);
		this.fdPath = fdPath;

		// Add header container as first child
		this.ui.addChild(this.headerContainer);

		// Add header with keybindings from config (unless silenced)
		if (this.options.verbose || !this.settingsManager.getQuietStartup()) {
			const greeter = this.getBuiltInGreeterContent();
			this.builtInHeader = new Ag1GreeterComponent(greeter);

			// Setup UI layout
			this.headerContainer.addChild(new Spacer(1));
			this.headerContainer.addChild(this.builtInHeader as Component);
			this.headerContainer.addChild(new Spacer(1));
		} else {
			// Minimal header when silenced
			this.builtInHeader = new Text("", 0, 0);
			this.headerContainer.addChild(this.builtInHeader);
		}

		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.statusContainer);
		this.renderWidgets(); // Initialize with default spacer
		this.ui.addChild(this.widgetContainerAbove);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.modeStripContainer);
		this.ui.addChild(this.widgetContainerBelow);
		this.ui.addChild(this.footer);
		this.ui.setFocus(this.editor);
		this.updateModeDisplay();

		this.setupKeyHandlers();
		this.setupEditorSubmitHandler();

		// Start the UI before initializing extensions so session_start handlers can use interactive dialogs
		this.ui.start();
		this.isInitialized = true;
		this.applySafetyPolicy();

		// Initialize extensions first so resources are shown before messages
		await this.bindCurrentSessionExtensions();

		// Render initial messages AFTER showing loaded resources
		this.renderInitialMessages();

		// Set terminal title
		this.updateTerminalTitle();

		// Initialize session debug logger
		this.debugLogger = new SessionDebugLogger({
			session: this.session,
			projectRoot: this.resolveProjectRoot(),
		});
		this.debugLogger.start();

		// Subscribe to agent events
		this.subscribeToAgent();

		// Set up theme file watcher
		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		// Set up git branch watcher (uses provider instead of footer)
		this.footerDataProvider.onBranchChange(() => {
			this.ui.requestRender();
		});

		// Initialize available provider count for footer display
		await this.updateAvailableProviderCount();
	}

	/**
	 * Update terminal title with session name and cwd.
	 */
	private updateTerminalTitle(): void {
		const cwdBasename = path.basename(this.sessionManager.getCwd());
		const sessionName = this.sessionManager.getSessionName();
		if (sessionName) {
			this.ui.terminal.setTitle(`π - ${sessionName} - ${cwdBasename}`);
		} else {
			this.ui.terminal.setTitle(`π - ${cwdBasename}`);
		}
	}

	/**
	 * Run the interactive mode. This is the main entry point.
	 * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
	 */
	async run(): Promise<void> {
		await this.init();

		// Ask once about untrusted project-local extensions before any initial
		// message is sent (accepting reloads resources, which should not race a prompt).
		await this.maybePromptProjectTrust();

		// Version check is performed but notifications are currently disabled in this fork.
		checkForNewVersion({ version: this.version }).then(() => {
			// no-op: showNewVersionNotification is intentionally disabled
		});

		// Start package update check asynchronously
		checkForPackageUpdates({
			cwd: this.sessionManager.getCwd(),
			settingsManager: this.settingsManager,
		}).then((updates) => {
			if (updates.length > 0) {
				renderPackageUpdateNotification({
					chatContainer: this.chatContainer,
					ui: this.ui,
					packages: updates,
				});
			}
		});

		// Check tmux keyboard setup asynchronously
		checkTmuxKeyboardSetup().then((warning) => {
			if (warning) {
				this.showWarning(warning);
			}
		});

		await runInteractiveStartupPrompts({
			session: this.session,
			showWarning: (message) => this.showWarning(message),
			showError: (message) => this.showError(message),
			migratedProviders: this.options.migratedProviders,
			modelFallbackMessage: this.options.modelFallbackMessage,
			initialMessage: this.options.initialMessage,
			initialImages: this.options.initialImages,
			initialMessages: this.options.initialMessages,
		});

		// Main interactive loop — in autonomous mode, we loop automatically
		// after each user prompt until budget/nudge/completion says stop.
		// In normal mode, we wait for user input after each turn.
		// initialImages only applies to the first prompt — clear after use.
		let firstPromptImages = this.options.initialImages;
		while (true) {
			const userInput = await this.getUserInput();
			const imagesForThisPrompt = firstPromptImages;
			firstPromptImages = undefined; // Only apply to first prompt

			if (this.autonomousMode) {
				// Autonomous: loop until done after the initial user prompt.
				// session.prompt() blocks until the full turn completes (tool
				// execution, compaction, retries all handled internally). After
				// each turn we check three independent exit conditions: budget
				// (hard stop), nudge engine (stuck detection), and completion
				// (no tool calls + LLM said stop). The 200-iteration cap is an
				// emergency brake.
				this.pendingRuntimePromptAddendum = undefined;
				await this.runAutonomousLoop(userInput, imagesForThisPrompt);
				// After the autonomous run completes, always return to normal
				// interactive mode. This keeps autonomy as an explicit per-task
				// choice instead of a sticky background state.
				this.setExecutionMode("interactive");
			} else {
				// Normal interactive: single turn, wait for user
				try {
					const stabilizationProfile = this.getAutonomousStabilizationProfile();
					if (this.planningMode) {
						this.pendingRuntimePromptAddendum = undefined;
						await this.runPlanningPrompt(userInput, { images: imagesForThisPrompt });
					} else {
						const interactiveUserMessage = this.buildInteractiveUserMessage(userInput);
						if (stabilizationProfile.level !== "none") {
							this.showStatus(
								`Applying ${stabilizationProfile.level} runtime stabilization: ${
									stabilizationProfile.reasons.join(" | ") || "recent runtime degradation"
								}`,
							);
						}
						await this.promptWithRuntimeSteering(interactiveUserMessage, { images: imagesForThisPrompt });
					}
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					this.showError(errorMessage);
				}
			}
		}
	}

	/**
	 * Get changelog entries to display on startup.
	 * Only shows new entries since last seen version, skips for resumed sessions.
	 */
	private getChangelogForDisplay(): string | undefined {
		return getInteractiveStartupChangelog(this.settingsManager, this.session.state.messages.length);
	}

	private getMarkdownThemeWithSettings(): MarkdownTheme {
		return {
			...getMarkdownTheme(),
			codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
		};
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	private showLoadedResources(options?: {
		extensions?: Array<{ path: string; sourceInfo?: SourceInfo }>;
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
	}): void {
		const showListing = options?.force || this.options.verbose || !this.settingsManager.getQuietStartup();
		const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
		if (!showListing && !showDiagnostics) {
			return;
		}

		const sectionHeader = (name: string, color: ThemeColor = "mdHeading") => theme.fg(color, `[${name}]`);

		const skillsResult = this.session.resourceLoader.getSkills();
		const promptsResult = this.session.resourceLoader.getPrompts();
		const themesResult = this.session.resourceLoader.getThemes();
		const extensions =
			options?.extensions ??
			this.session.resourceLoader.getExtensions().extensions.map((extension) => ({
				path: extension.path,
				sourceInfo: extension.sourceInfo,
			}));
		const sourceInfos = new Map<string, SourceInfo>();
		for (const extension of extensions) {
			if (extension.sourceInfo) {
				sourceInfos.set(extension.path, extension.sourceInfo);
			}
		}
		for (const skill of skillsResult.skills) {
			if (skill.sourceInfo) {
				sourceInfos.set(skill.filePath, skill.sourceInfo);
			}
		}
		for (const prompt of promptsResult.prompts) {
			if (prompt.sourceInfo) {
				sourceInfos.set(prompt.filePath, prompt.sourceInfo);
			}
		}
		for (const loadedTheme of themesResult.themes) {
			if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
				sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
			}
		}

		if (showListing) {
			const contextFiles = this.session.resourceLoader.getAgentsFiles().agentsFiles;
			if (contextFiles.length > 0) {
				this.chatContainer.addChild(new Spacer(1));
				const contextList = contextFiles.map((f) => theme.fg("dim", `  ${formatDisplayPath(f.path)}`)).join("\n");
				this.chatContainer.addChild(new Text(`${sectionHeader("Context")}\n${contextList}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			const skills = skillsResult.skills;
			if (skills.length > 0) {
				const groups = buildScopeGroups(
					skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })),
				);
				const skillList = formatScopeGroups(groups, {
					formatPath: (item) => formatDisplayPath(item.path),
					formatPackagePath: (item) => getShortPath(item.path, item.sourceInfo),
				});
				this.chatContainer.addChild(new Text(`${sectionHeader("Skills")}\n${skillList}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			const templates = this.session.promptTemplates;
			if (templates.length > 0) {
				const groups = buildScopeGroups(
					templates.map((template) => ({ path: template.filePath, sourceInfo: template.sourceInfo })),
				);
				const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
				const templateList = formatScopeGroups(groups, {
					formatPath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : formatDisplayPath(item.path);
					},
					formatPackagePath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : formatDisplayPath(item.path);
					},
				});
				this.chatContainer.addChild(new Text(`${sectionHeader("Prompts")}\n${templateList}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			if (extensions.length > 0) {
				const groups = buildScopeGroups(extensions);
				const extList = formatScopeGroups(groups, {
					formatPath: (item) => formatDisplayPath(item.path),
					formatPackagePath: (item) => getShortPath(item.path, item.sourceInfo),
				});
				this.chatContainer.addChild(new Text(`${sectionHeader("Extensions", "mdHeading")}\n${extList}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			// Show loaded themes (excluding built-in)
			const loadedThemes = themesResult.themes;
			const customThemes = loadedThemes.filter((t) => t.sourcePath);
			if (customThemes.length > 0) {
				const groups = buildScopeGroups(
					customThemes.map((loadedTheme) => ({
						path: loadedTheme.sourcePath!,
						sourceInfo: loadedTheme.sourceInfo,
					})),
				);
				const themeList = formatScopeGroups(groups, {
					formatPath: (item) => formatDisplayPath(item.path),
					formatPackagePath: (item) => getShortPath(item.path, item.sourceInfo),
				});
				this.chatContainer.addChild(new Text(`${sectionHeader("Themes")}\n${themeList}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}
		}

		if (showDiagnostics) {
			const skillDiagnostics = skillsResult.diagnostics;
			if (skillDiagnostics.length > 0) {
				const warningLines = formatDiagnostics(skillDiagnostics, sourceInfos);
				(InteractiveMode as any).prototype.showDiagnosticNotice.call(this, "[Skill conflicts]", warningLines);
			}

			const promptDiagnostics = promptsResult.diagnostics;
			if (promptDiagnostics.length > 0) {
				const warningLines = formatDiagnostics(promptDiagnostics, sourceInfos);
				(InteractiveMode as any).prototype.showDiagnosticNotice.call(this, "[Prompt conflicts]", warningLines);
			}

			const extensionDiagnostics: ResourceDiagnostic[] = [];
			const extensionErrors = this.session.resourceLoader.getExtensions().errors;
			if (extensionErrors.length > 0) {
				for (const error of extensionErrors) {
					extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
				}
			}

			const commandDiagnostics = this.session.extensionRunner?.getCommandDiagnostics() ?? [];
			extensionDiagnostics.push(...commandDiagnostics);
			extensionDiagnostics.push(...this.getBuiltInCommandConflictDiagnostics(this.session.extensionRunner));

			const shortcutDiagnostics = this.session.extensionRunner?.getShortcutDiagnostics() ?? [];
			extensionDiagnostics.push(...shortcutDiagnostics);

			if (extensionDiagnostics.length > 0) {
				const warningLines = formatDiagnostics(extensionDiagnostics, sourceInfos);
				(InteractiveMode as any).prototype.showDiagnosticNotice.call(this, "[Extension issues]", warningLines);
			}

			const themeDiagnostics = themesResult.diagnostics;
			if (themeDiagnostics.length > 0) {
				const warningLines = formatDiagnostics(themeDiagnostics, sourceInfos);
				(InteractiveMode as any).prototype.showDiagnosticNotice.call(this, "[Theme conflicts]", warningLines);
			}
		}
	}

	/**
	 * Initialize the extension system with TUI-based UI context.
	 */
	private async bindCurrentSessionExtensions(): Promise<void> {
		const uiContext = this.createExtensionUIContext();
		await this.session.bindExtensions({
			uiContext,
			commandContextActions: {
				waitForIdle: () => this.session.agent.waitForIdle(),
				newSession: async (options) => this.handleExtensionNewSession(options),
				fork: async (entryId) => this.handleExtensionFork(entryId),
				navigateTree: async (targetId, options) => {
					const result = await this.session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					if (result.cancelled) {
						return { cancelled: true };
					}
					applyInteractiveTreeNavigationSuccess({
						result,
						clearChat: () => this.chatContainer.clear(),
						renderInitialMessages: () => this.renderInitialMessages(),
						getEditorText: () => this.editor.getText(),
						setEditorText: (text) => this.editor.setText(text),
						showStatus: (message) => this.showStatus(message),
					});
					return { cancelled: false };
				},
				switchSession: async (sessionPath) => {
					await this.handleResumeSession(sessionPath);
					return { cancelled: false };
				},
				reload: async () => {
					await this.handleReloadCommand();
				},
			},
			shutdownHandler: () => {
				this.shutdownRequested = true;
				if (!this.session.isStreaming) {
					void this.shutdown();
				}
			},
			onError: (error) => {
				this.showExtensionError(error.extensionPath, error.error, error.stack);
			},
		});

		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.setupAutocomplete(this.fdPath);

		const extensionRunner = this.session.extensionRunner;
		if (!extensionRunner) {
			this.showLoadedResources({ extensions: [], force: false });
			this.showStartupNoticesIfNeeded();
			return;
		}

		this.setupExtensionShortcuts(extensionRunner);
		this.showLoadedResources({ force: false });
		this.showStartupNoticesIfNeeded();
	}

	/**
	 * Workspace-trust prompt for project-local extensions (wave-2 trust gate follow-up).
	 *
	 * The extension loader skips untrusted project-local extensions and records
	 * LoadExtensionsResult.pendingTrustPrompt. We ask the user ONCE here at startup
	 * using the standard confirm dialog (the UI is already running, so a dialog is
	 * feasible and matches how other startup confirmations work). On accept we
	 * persist trust via trustProject() and run the normal /reload flow so the
	 * extensions actually load; on decline the loader warning has already explained
	 * the manual escape hatches (trustedProjects setting, AG1_TRUST_PROJECT=1).
	 */
	private async maybePromptProjectTrust(): Promise<void> {
		if (this.projectTrustPromptHandled) return;
		const pending = this.session.resourceLoader.getExtensions().pendingTrustPrompt;
		if (!pending) return;
		this.projectTrustPromptHandled = true;

		const confirmed = await this.showExtensionConfirm(
			"Trust project extensions?",
			`This project ships ${pending.extensionPaths.length} extension(s) under ${pending.projectConfigDir}.\n` +
				"Extensions can execute arbitrary code with your credentials. Trust and load them?",
		);
		if (!confirmed) {
			this.showWarning(
				"Project extensions remain disabled. To enable them later, trust the project " +
					"and run /reload, or set AG1_TRUST_PROJECT=1.",
			);
			return;
		}
		try {
			await trustProject(pending.projectConfigDir, this.sessionManager.getCwd(), getAgentDir());
			await this.handleReloadCommand();
		} catch (error) {
			this.showError(`Failed to trust project: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private applyRuntimeSettings(): void {
		this.footer.setSession(this.session);
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		this.footerDataProvider.setCwd(this.sessionManager.getCwd());
		this.hideThinkingBlock = applyInteractiveRuntimeSettings({
			settings: this.settingsManager,
			ui: this.ui,
			defaultEditor: this.defaultEditor,
			editor: this.editor,
		}).hideThinkingBlock;
	}

	private clearTransientRuntimeUi(): void {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();
	}

	private async handleRuntimeSessionChange(): Promise<void> {
		this.resetExtensionUI();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		const restored = restoreInteractiveRuntimeState(this.session.sessionManager.getEntries());
		this.lastAutonomousRunResult = restored.lastAutonomousRunResult;
		this.xmlFallbackCount = restored.xmlFallbackCount;
		this.degradedTurnCount = restored.degradedTurnCount;
		this.lastXmlFallbackEvent = restored.lastXmlFallbackEvent;
		this.lastDegradedTurnEvent = restored.lastDegradedTurnEvent;
		this.applyRuntimeSettings();
		this.applySafetyPolicy();
		await this.bindCurrentSessionExtensions();
		this.subscribeToAgent();
		await this.updateAvailableProviderCount();
		this.updateEditorBorderColor();
		this.updateTerminalTitle();
		this.updateModeDisplay();
	}

	private async handleExtensionNewSession(
		options?: Parameters<AgentSessionRuntime["newSession"]>[0],
	): Promise<{ cancelled: boolean }> {
		return performInteractiveRuntimeReplacement({
			clearTransientUi: () => this.clearTransientRuntimeUi(),
			execute: () => this.runtimeHost.newSession(options),
			applyRuntimeSessionChange: () => this.handleRuntimeSessionChange(),
			renderCurrentSessionState: () => this.renderCurrentSessionState(),
			handleFatalRuntimeError: (prefix, error) => this.handleFatalRuntimeError(prefix, error),
			fatalPrefix: "Failed to create session",
			afterApplied: async () => {
				this.ui.requestRender();
			},
		});
	}

	private async handleExtensionFork(entryId: string): Promise<{ cancelled: boolean }> {
		return performInteractiveSessionFork({
			clearTransientUi: () => this.clearTransientRuntimeUi(),
			executeFork: () => this.runtimeHost.fork(entryId),
			applyRuntimeSessionChange: () => this.handleRuntimeSessionChange(),
			renderCurrentSessionState: () => this.renderCurrentSessionState(),
			handleFatalRuntimeError: (prefix, error) => this.handleFatalRuntimeError(prefix, error),
			setEditorText: (text) => this.editor.setText(text),
			showStatus: (message) => this.showStatus(message),
		});
	}

	/**
	 * Apply the current session safety policy.
	 *
	 * Interactive mode is the only place where we can safely ask the user for
	 * approval. We therefore bind the session policy here instead of at runtime
	 * creation. Whenever the active session changes or the user toggles between
	 * interactive and autonomous execution, we refresh the policy so the tool
	 * guardrails stay attached to the current session object.
	 */
	private applySafetyPolicy(): void {
		const mode: ToolSafetyPolicy["mode"] = this.autonomousMode
			? "autonomous"
			: this.planningMode
				? "planning"
				: "interactive";
		this.session.setToolSafetyPolicy({
			mode,
			cwd: this.sessionManager.getCwd(),
			approvalHandler: mode === "interactive" ? (request) => this.requestToolApproval(request) : undefined,
			planningReadOnlyTools:
				mode === "planning" ? (this.planningReadOnlyToolsAllowed ? "allow" : "block") : undefined,
			existingTestPaths: collectExistingTestPaths(this.sessionManager.getCwd()),
			extensionTools:
				this.session.extensionRunner?.getAllRegisteredTools().map((tool) => tool.definition.name) ?? [],
		});
	}

	private getAssistantTextContent(message: AssistantMessage): string {
		return message.content
			.filter(
				(part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string",
			)
			.map((part) => part.text)
			.join("\n")
			.trim();
	}

	private hasVisibleAssistantContent(message: AssistantMessage): boolean {
		return message.content.some(
			(part) =>
				(part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) ||
				(part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim().length > 0),
		);
	}

	private shouldSuppressAssistantMessage(message: AssistantMessage): boolean {
		if (this.suppressPlanningAssistantTranscript) return true;
		const assistantText = this.getAssistantTextContent(message);
		if (!assistantText) return false;
		return this.getPlanArtifacts(25).some((artifact) => artifact.rawPlan.trim() === assistantText);
	}

	private shouldSuppressAssistantToolRendering(message: AssistantMessage): boolean {
		if (!message.content.some((part) => part.type === "toolCall")) return false;
		if (this.shouldSuppressAssistantMessage(message)) return true;
		return this.planningMode && !this.hasVisibleAssistantContent(message);
	}

	private shouldSuppressPlanningToolUi(): boolean {
		return this.planningMode && !this.planningReadOnlyToolsAllowed;
	}

	private getExecutionMode(): "interactive" | "planning" | "autonomous" {
		if (this.autonomousMode) return "autonomous";
		if (this.planningMode) return "planning";
		return "interactive";
	}

	private setExecutionMode(mode: "interactive" | "planning" | "autonomous"): void {
		this.autonomousMode = mode === "autonomous";
		this.planningMode = mode === "planning";
		if (mode !== "planning") {
			this.planningReadOnlyToolsAllowed = true;
		}
		this.applySafetyPolicy();
		this.updateModeDisplay();
	}

	/**
	 * Prompt the user before a guarded tool executes in interactive mode.
	 *
	 * The message is deliberately explicit: tool name, risk, and the concrete
	 * command/path are shown before the model gets to mutate the workspace.
	 */
	private async requestToolApproval(request: ToolApprovalRequest): Promise<boolean> {
		const title =
			request.toolName === "bash"
				? `Approve ${request.toolName} command?`
				: `Approve ${request.toolName} operation?`;
		const message = `${request.summary}\n\nRisk: ${request.risk.toUpperCase()}\n\n${request.details}`;
		return await this.showExtensionConfirm(title, message);
	}

	private async handleFatalRuntimeError(prefix: string, error: unknown): Promise<never> {
		const message = error instanceof Error ? error.message : String(error);
		this.showError(`${prefix}: ${message}`);
		stopThemeWatcher();
		this.stop();
		process.exit(1);
	}

	private renderCurrentSessionState(): void {
		this.chatContainer.clear();
		this.pendingMessagesContainer.clear();
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.pendingTools.clear();
		this.renderInitialMessages();
	}

	/**
	 * Get a registered tool definition by name (for custom rendering).
	 */
	private getRegisteredToolDefinition(toolName: string) {
		return this.session.getToolDefinition(toolName);
	}

	/**
	 * Set up keyboard shortcuts registered by extensions.
	 */
	private setupExtensionShortcuts(extensionRunner: ExtensionRunner): void {
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size === 0) return;

		// Create a context for shortcut handlers
		const createContext = (): ExtensionContext => ({
			ui: this.createExtensionUIContext(),
			hasUI: true,
			cwd: this.sessionManager.getCwd(),
			sessionManager: this.sessionManager,
			modelRegistry: this.session.modelRegistry,
			model: this.session.model,
			isIdle: () => !this.session.isStreaming,
			signal: this.session.agent.signal,
			abort: () => this.session.abort(),
			hasPendingMessages: () => this.session.pendingMessageCount > 0,
			shutdown: () => {
				this.shutdownRequested = true;
			},
			getContextUsage: () => this.session.getContextUsage(),
			compact: (options) => {
				void (async () => {
					try {
						const result = await this.session.compact(options?.customInstructions);
						options?.onComplete?.(result);
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						options?.onError?.(err);
					}
				})();
			},
			getSystemPrompt: () => this.session.systemPrompt,
		});

		// Set up the extension shortcut handler on the default editor
		this.defaultEditor.onExtensionShortcut = (data: string) => {
			for (const [shortcutStr, shortcut] of shortcuts) {
				// Cast to KeyId - extension shortcuts use the same format
				if (matchesKey(data, shortcutStr as KeyId)) {
					// Run handler async, don't block input
					Promise.resolve(shortcut.handler(createContext())).catch((err) => {
						this.showError(`Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`);
					});
					return true;
				}
			}
			return false;
		};
	}

	/**
	 * Set extension status text in the footer.
	 */
	private setExtensionStatus(key: string, text: string | undefined): void {
		this.footerDataProvider.setExtensionStatus(key, text);
		this.ui.requestRender();
	}

	private setHiddenThinkingLabel(label?: string): void {
		this.hiddenThinkingLabel = label ?? this.defaultHiddenThinkingLabel;
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHiddenThinkingLabel(this.hiddenThinkingLabel);
			}
		}
		if (this.streamingComponent) {
			this.streamingComponent.setHiddenThinkingLabel(this.hiddenThinkingLabel);
		}
		this.ui.requestRender();
	}

	/**
	 * Set an extension widget (string array or custom component).
	 */
	private setExtensionWidget(
		key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		const placement = options?.placement ?? "aboveEditor";
		const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
			const existing = map.get(key);
			if (existing?.dispose) existing.dispose();
			map.delete(key);
		};

		removeExisting(this.extensionWidgetsAbove);
		removeExisting(this.extensionWidgetsBelow);

		if (content === undefined) {
			this.renderWidgets();
			return;
		}

		let component: Component & { dispose?(): void };

		if (Array.isArray(content)) {
			// Wrap string array in a Container with Text components
			const container = new Container();
			for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			component = container;
		} else {
			// Factory function - create component
			component = content(this.ui, theme);
		}

		const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
		targetMap.set(key, component);
		this.renderWidgets();
	}

	private clearExtensionWidgets(): void {
		for (const widget of this.extensionWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.extensionWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.extensionWidgetsAbove.clear();
		this.extensionWidgetsBelow.clear();
		this.renderWidgets();
	}

	private resetExtensionUI(): void {
		this.extensionDialogs.resetExtensionDialogs();
		this.ui.hideOverlay();
		this.clearExtensionTerminalInputListeners();
		this.setExtensionFooter(undefined);
		this.setExtensionHeader(undefined);
		this.clearExtensionWidgets();
		this.footerDataProvider.clearExtensionStatuses();
		this.footer.invalidate();
		this.setCustomEditorComponent(undefined);
		this.defaultEditor.onExtensionShortcut = undefined;
		this.updateTerminalTitle();
		if (this.loadingAnimation) {
			this.resetLoadingAnimationMessage();
		}
		this.setHiddenThinkingLabel();
	}

	// Maximum total widget lines to prevent viewport overflow
	private static readonly MAX_WIDGET_LINES = 10;

	/**
	 * Render all extension widgets to the widget container.
	 */
	private renderWidgets(): void {
		if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
		this.renderWidgetContainer(this.widgetContainerAbove, this.extensionWidgetsAbove, true, true);
		this.renderWidgetContainer(this.widgetContainerBelow, this.extensionWidgetsBelow, false, false);
		this.ui.requestRender();
	}

	private renderWidgetContainer(
		container: Container,
		widgets: Map<string, Component & { dispose?(): void }>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		container.clear();

		if (widgets.size === 0) {
			if (spacerWhenEmpty) {
				container.addChild(new Spacer(1));
			}
			return;
		}

		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		for (const component of widgets.values()) {
			container.addChild(component);
		}
	}

	/**
	 * Set a custom footer component, or restore the built-in footer.
	 */
	private setExtensionFooter(
		factory:
			| ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void {
		// Dispose existing custom footer
		if (this.customFooter?.dispose) {
			this.customFooter.dispose();
		}

		// Remove current footer from UI
		if (this.customFooter) {
			this.ui.removeChild(this.customFooter);
		} else {
			this.ui.removeChild(this.footer);
		}

		if (factory) {
			// Create and add custom footer, passing the data provider
			this.customFooter = factory(this.ui, theme, this.footerDataProvider);
			this.ui.addChild(this.customFooter);
		} else {
			// Restore built-in footer
			this.customFooter = undefined;
			this.ui.addChild(this.footer);
		}

		this.ui.requestRender();
	}

	/**
	 * Set a custom header component, or restore the built-in header.
	 */
	private setExtensionHeader(factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined): void {
		// Header may not be initialized yet if called during early initialization
		if (!this.builtInHeader) {
			return;
		}

		// Dispose existing custom header
		if (this.customHeader?.dispose) {
			this.customHeader.dispose();
		}

		// Find the index of the current header in the header container
		const currentHeader = this.customHeader || this.builtInHeader;
		const index = this.headerContainer.children.indexOf(currentHeader);

		if (factory) {
			// Create and add custom header
			this.customHeader = factory(this.ui, theme);
			if (index !== -1) {
				this.headerContainer.children[index] = this.customHeader;
			} else {
				// If not found (e.g. builtInHeader was never added), add at the top
				this.headerContainer.children.unshift(this.customHeader);
			}
		} else {
			// Restore built-in header
			this.customHeader = undefined;
			if (index !== -1) {
				this.headerContainer.children[index] = this.builtInHeader;
			}
		}

		this.ui.requestRender();
	}

	private addExtensionTerminalInputListener(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void {
		const unsubscribe = this.ui.addInputListener(handler);
		this.extensionTerminalInputUnsubscribers.add(unsubscribe);
		return () => {
			unsubscribe();
			this.extensionTerminalInputUnsubscribers.delete(unsubscribe);
		};
	}

	private clearExtensionTerminalInputListeners(): void {
		for (const unsubscribe of this.extensionTerminalInputUnsubscribers) {
			unsubscribe();
		}
		this.extensionTerminalInputUnsubscribers.clear();
	}

	private rememberSubmittedPrompt(text: string): void {
		this.workingActivity.rememberSubmittedPrompt(text);
	}

	private stopWorkingVerbAnimation(): void {
		this.workingVerbAnimator.stopAnimation();
	}

	private disableManagedWorkingMessage(): void {
		this.workingVerbAnimator.setState(undefined, false);
		this.stopWorkingVerbAnimation();
	}

	private getDefaultWorkingMessage(): string {
		return this.workingActivity.getDefaultWorkingMessage();
	}

	private getInterruptibleWorkingMessage(options?: {
		toolName?: string;
		args?: Record<string, unknown>;
		promptText?: string;
	}): string {
		return this.workingActivity.getInterruptibleWorkingMessage(options);
	}

	private resetLoadingAnimationMessage(): void {
		this.workingActivity.resetLoadingAnimationMessage();
	}

	private setToolAwareLoadingMessage(toolName: string, args?: Record<string, unknown>): void {
		this.workingActivity.setToolAwareLoadingMessage(toolName, args);
	}

	/**
	 * Create the ExtensionUIContext for extensions.
	 */
	private createExtensionUIContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) => this.showExtensionSelector(title, options, opts),
			confirm: (title, message, opts) => this.showExtensionConfirm(title, message, opts),
			input: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
			notify: (message, type) => this.showExtensionNotify(message, type),
			onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setExtensionStatus(key, text),
			setWorkingMessage: (message) => {
				if (this.loadingAnimation) {
					if (message) {
						this.disableManagedWorkingMessage();
						this.loadingAnimation.setMessage(message);
					} else {
						this.resetLoadingAnimationMessage();
					}
				} else {
					// Queue message for when loadingAnimation is created (handles agent_start race)
					if (message) {
						this.disableManagedWorkingMessage();
					}
					this.pendingWorkingMessage = message ?? this.getInterruptibleWorkingMessage();
				}
			},
			setHiddenThinkingLabel: (label) => this.setHiddenThinkingLabel(label),
			setWidget: (key, content, options) => this.setExtensionWidget(key, content, options),
			setFooter: (factory) => this.setExtensionFooter(factory),
			setHeader: (factory) => this.setExtensionHeader(factory),
			setTitle: (title) => this.ui.terminal.setTitle(title),
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			pasteToEditor: (text) => this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
			setEditorText: (text) => this.editor.setText(text),
			getEditorText: () => this.editor.getExpandedText?.() ?? this.editor.getText(),
			editor: (title, prefill) => this.showExtensionEditor(title, prefill),
			setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
			get theme() {
				return theme;
			},
			getAllThemes: () => getAvailableThemesWithPaths(),
			getTheme: (name) => getThemeByName(name),
			setTheme: (themeOrName) => {
				if (themeOrName instanceof Theme) {
					setThemeInstance(themeOrName);
					this.ui.requestRender();
					return { success: true };
				}
				const result = setTheme(themeOrName, true);
				if (result.success) {
					if (this.settingsManager.getTheme() !== themeOrName) {
						this.settingsManager.setTheme(themeOrName);
					}
					this.ui.requestRender();
				}
				return result;
			},
			getToolsExpanded: () => this.toolOutputExpanded,
			setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
		};
	}

	private showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return this.extensionDialogs.showExtensionSelector(title, options, opts);
	}

	private showPlanWorkflowDialog(
		title: string,
		lines: string[],
		options: PlanWorkflowDialogOption[],
		dialogOptions?: { accent?: "accent" | "warning" | "success" },
	): Promise<string | undefined> {
		return this.extensionDialogs.showPlanWorkflowDialog(title, lines, options, dialogOptions);
	}

	private async showExtensionConfirm(
		title: string,
		message: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		return this.extensionDialogs.showExtensionConfirm(title, message, opts);
	}

	private async promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined> {
		const confirmed = await this.showExtensionConfirm(
			"Session cwd not found",
			formatMissingSessionCwdPrompt(error.issue),
		);
		return confirmed ? error.issue.fallbackCwd : undefined;
	}

	private showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions & { initialValue?: string },
	): Promise<string | undefined> {
		return this.extensionDialogs.showExtensionInput(title, placeholder, opts);
	}

	private showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> {
		return this.extensionDialogs.showExtensionEditor(title, prefill);
	}

	/**
	 * Set a custom editor component from an extension.
	 * Pass undefined to restore the default editor.
	 */
	private setCustomEditorComponent(
		factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent) | undefined,
	): void {
		// Save text from current editor before switching
		const currentText = this.editor.getText();

		this.editorContainer.clear();

		if (factory) {
			// Create the custom editor with tui, theme, and keybindings
			const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);

			// Wire up callbacks from the default editor
			newEditor.onSubmit = this.defaultEditor.onSubmit;
			newEditor.onChange = this.defaultEditor.onChange;

			// Copy text from previous editor
			newEditor.setText(currentText);

			// Copy appearance settings if supported
			if (newEditor.borderColor !== undefined) {
				newEditor.borderColor = this.defaultEditor.borderColor;
			}
			if (newEditor.setPaddingX !== undefined) {
				newEditor.setPaddingX(this.defaultEditor.getPaddingX());
			}

			// Set autocomplete if supported
			if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
				newEditor.setAutocompleteProvider(this.autocompleteProvider);
			}

			// If extending CustomEditor, copy app-level handlers
			// Use duck typing since instanceof fails across jiti module boundaries
			const customEditor = newEditor as unknown as Record<string, unknown>;
			if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
				if (!customEditor.onEscape) {
					customEditor.onEscape = () => this.defaultEditor.onEscape?.();
				}
				if (!customEditor.onCtrlD) {
					customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
				}
				if (!customEditor.onPasteImage) {
					customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
				}
				if (!customEditor.onExtensionShortcut) {
					customEditor.onExtensionShortcut = (data: string) => this.defaultEditor.onExtensionShortcut?.(data);
				}
				// Copy action handlers (clear, suspend, model switching, etc.)
				for (const [action, handler] of this.defaultEditor.actionHandlers) {
					(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
				}
			}

			this.editor = newEditor;
		} else {
			// Restore default editor with text from custom editor
			this.defaultEditor.setText(currentText);
			this.editor = this.defaultEditor;
		}

		this.editorContainer.addChild(this.editor as Component);
		this.ui.setFocus(this.editor as Component);
		this.ui.requestRender();
	}

	/**
	 * Show a notification for extensions.
	 */
	private showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void {
		this.extensionDialogs.showExtensionNotify(message, type);
	}

	/** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
	private async showExtensionCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> {
		const savedText = this.editor.getText();
		const isOverlay = options?.overlay ?? false;

		const restoreEditor = () => {
			restoreEditorHost({
				container: this.editorContainer,
				ui: this.ui,
				editor: this.editor,
				restoreText: () => this.editor.setText(savedText),
			});
		};

		return new Promise((resolve, reject) => {
			let component: Component & { dispose?(): void };
			let closed = false;

			const close = (result: T) => {
				if (closed) return;
				closed = true;
				if (isOverlay) this.ui.hideOverlay();
				else restoreEditor();
				// Note: both branches above already call requestRender
				resolve(result);
				try {
					component?.dispose?.();
				} catch {
					/* ignore dispose errors */
				}
			};

			Promise.resolve(factory(this.ui, theme, this.keybindings, close))
				.then((c) => {
					if (closed) return;
					component = c;
					if (isOverlay) {
						// Resolve overlay options - can be static or dynamic function
						const resolveOptions = (): OverlayOptions | undefined => {
							if (options?.overlayOptions) {
								const opts =
									typeof options.overlayOptions === "function"
										? options.overlayOptions()
										: options.overlayOptions;
								return opts;
							}
							// Fallback: use component's width property if available
							const w = (component as { width?: number }).width;
							return w ? { width: w } : undefined;
						};
						const handle = this.ui.showOverlay(component, resolveOptions());
						// Expose handle to caller for visibility control
						options?.onHandle?.(handle);
					} else {
						showEditorHostComponent({
							container: this.editorContainer,
							ui: this.ui,
							component,
						});
					}
				})
				.catch((err) => {
					if (closed) return;
					if (!isOverlay) restoreEditor();
					reject(err);
				});
		});
	}

	/**
	 * Show an extension error in the UI.
	 */
	private showExtensionError(extensionPath: string, error: string, stack?: string): void {
		const errorMsg = `Extension "${extensionPath}" error: ${error}`;
		const errorText = new Text(theme.fg("error", errorMsg), 1, 0);
		this.chatContainer.addChild(errorText);
		if (stack) {
			// Show stack trace in dim color, indented
			const stackLines = stack
				.split("\n")
				.slice(1) // Skip first line (duplicates error message)
				.map((line) => theme.fg("dim", `  ${line.trim()}`))
				.join("\n");
			if (stackLines) {
				this.chatContainer.addChild(new Text(stackLines, 1, 0));
			}
		}
		this.ui.requestRender();
	}

	// =========================================================================
	// Key Handlers
	// =========================================================================

	private setupKeyHandlers(): void {
		// Set up handlers on defaultEditor - they use this.editor for text access
		// so they work correctly regardless of which editor is active
		this.defaultEditor.onEscape = () => {
			if (this.loadingAnimation) {
				this.restoreQueuedMessagesToEditor({ abort: true });
			} else if (this.session.isBashRunning) {
				this.session.abortBash();
			} else if (this.isBashMode) {
				this.editor.setText("");
				this.isBashMode = false;
				this.updateEditorBorderColor();
			} else if (!this.editor.getText().trim()) {
				// Double-escape with empty editor triggers /tree, /fork, or nothing based on setting
				const action = this.settingsManager.getDoubleEscapeAction();
				if (action !== "none") {
					const now = Date.now();
					if (now - this.lastEscapeTime < 500) {
						if (action === "tree") {
							this.showTreeSelector();
						} else {
							this.showUserMessageSelector();
						}
						this.lastEscapeTime = 0;
					} else {
						this.lastEscapeTime = now;
					}
				}
			}
		};

		// Register app action handlers
		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onAction("app.suspend", () => this.handleCtrlZ());
		this.defaultEditor.onAction("app.thinking.cycle", () => this.cycleThinkingLevel());
		this.defaultEditor.onAction("app.model.cycleForward", () => this.cycleModel("forward"));
		this.defaultEditor.onAction("app.model.cycleBackward", () => this.cycleModel("backward"));
		this.defaultEditor.onAction("app.mode.cycle", () => this.cycleMode());

		// Global debug handler on TUI (works regardless of focus)
		this.ui.onDebug = () => this.handleDebugCommand();
		this.defaultEditor.onAction("app.model.select", () => this.showModelSelector());
		this.defaultEditor.onAction("app.tools.expand", () => this.toggleToolOutputExpansion());
		this.defaultEditor.onAction("app.thinking.toggle", () => this.toggleThinkingBlockVisibility());
		this.defaultEditor.onAction("app.editor.external", () => this.openExternalEditor());
		this.defaultEditor.onAction("app.message.followUp", () => this.handleFollowUp());
		this.defaultEditor.onAction("app.message.dequeue", () => this.handleDequeue());
		this.defaultEditor.onAction("app.session.new", () => this.handleClearCommand());
		this.defaultEditor.onAction("app.session.tree", () => this.showTreeSelector());
		this.defaultEditor.onAction("app.session.fork", () => this.showUserMessageSelector());
		this.defaultEditor.onAction("app.session.resume", () => this.showSessionSelector());
		this.defaultEditor.onAction("app.plan.review", () => this.showPlanReviewSelector());
		this.defaultEditor.onAction("app.plan.nextStep", () => void this.executeNextPlanStep());

		this.defaultEditor.onChange = (text: string) => {
			const wasBashMode = this.isBashMode;
			this.isBashMode = text.trimStart().startsWith("!");
			if (wasBashMode !== this.isBashMode) {
				this.updateEditorBorderColor();
			}
		};

		// Handle clipboard image paste (triggered on Ctrl+V)
		this.defaultEditor.onPasteImage = () => {
			this.handleClipboardImagePaste();
		};
	}

	private async handleClipboardImagePaste(): Promise<void> {
		try {
			const image = await readClipboardImage();
			if (!image) {
				return;
			}

			// Write to temp file
			const tmpDir = os.tmpdir();
			const ext = extensionForImageMimeType(image.mimeType) ?? "png";
			const fileName = `ag1-clipboard-${crypto.randomUUID()}.${ext}`;
			const filePath = path.join(tmpDir, fileName);
			fs.writeFileSync(filePath, Buffer.from(image.bytes));

			// Insert file path directly
			this.editor.insertTextAtCursor?.(filePath);
			this.ui.requestRender();
		} catch {
			// Silently ignore clipboard errors (may not have permission, etc.)
		}
	}

	private setupEditorSubmitHandler(): void {
		this.defaultEditor.onSubmit = async (text: string) => {
			text = text.trim();
			if (!text) return;

			const builtinCommand = parseInteractiveBuiltinCommand(text);
			if (builtinCommand) {
				await dispatchInteractiveBuiltinCommand(builtinCommand, {
					clearEditor: () => this.editor.setText(""),
					showSettingsSelector: () => this.showSettingsSelector(),
					showModelsSelector: () => this.showModelsSelector(),
					handleModelCommand: (searchTerm) => this.handleModelCommand(searchTerm),
					handleExportCommand: (commandText) => this.handleExportCommand(commandText),
					handleImportCommand: (commandText) => this.handleImportCommand(commandText),
					handleShareCommand: () => this.handleShareCommand(),
					handleCopyCommand: () => this.handleCopyCommand(),
					handleNameCommand: (commandText) => this.handleNameCommand(commandText),
					handleSessionCommand: () => this.handleSessionCommand(),
					handlePlanCommand: (command) => this.handlePlanCommand(command),
					handleResearchCommand: (commandText) => this.handleResearchCommand(commandText),
					handleDebugCommand: () => this.handleDebugCommand(),
					handleWorkspaceCommand: (commandText) => this.handleWorkspaceCommand(commandText),
					handleChangelogCommand: () => this.handleChangelogCommand(),
					handleHotkeysCommand: () => this.handleHotkeysCommand(),
					handleTodoCommand: () => this.handleTodoCommand(),
					showUserMessageSelector: () => this.showUserMessageSelector(),
					showTreeSelector: () => this.showTreeSelector(),
					showOAuthSelector: (mode) => this.showOAuthSelector(mode),
					handleClearCommand: () => this.handleClearCommand(),
					handleCompactCommand: (customInstructions) => this.handleCompactCommand(customInstructions),
					showContextDialog: () => this.showContextDialog(),
					clearCustomContextWindow: () => this.session.setCustomContextWindow(undefined),
					setCustomContextWindow: (value) => this.session.setCustomContextWindow(value),
					showWarning: (message) => this.showWarning(message),
					handleReloadCommand: () => this.handleReloadCommand(),
					handleArminSaysHi: () => this.handleArminSaysHi(),
					showSessionSelector: () => this.showSessionSelector(),
					toggleVerboseMode: () => this.toggleVerboseMode(),
					shutdown: () => this.shutdown(),
				});
				return;
			}

			await handleInteractiveEditorSubmitAfterBuiltin(
				text,
				{
					isBashRunning: this.session.isBashRunning,
					isPlanningMode: this.planningMode,
					isCompacting: this.session.isCompacting,
					isStreaming: this.session.isStreaming,
					isExtensionCommand: (value) => this.isExtensionCommand(value),
				},
				{
					showWarning: (message) => this.showWarning(message),
					restoreEditorText: (value) => this.editor.setText(value),
					addToHistory: (value) => this.editor.addToHistory?.(value),
					clearEditor: () => this.editor.setText(""),
					handleBashCommand: (command, excludeFromContext) => this.handleBashCommand(command, excludeFromContext),
					setBashModeEnabled: (enabled) => {
						this.isBashMode = enabled;
						this.updateEditorBorderColor();
					},
					queueCompactionMessage: (value, mode) => this.queueCompactionMessage(value, mode),
					prompt: (value, options) => {
						this.rememberSubmittedPrompt(value);
						return this.promptWithRuntimeSteering(value, options);
					},
					updatePendingMessagesDisplay: () => this.updatePendingMessagesDisplay(),
					requestRender: () => this.ui.requestRender(),
					flushPendingBashComponents: () => this.flushPendingBashComponents(),
					dispatchNormalInput: (value) => {
						this.rememberSubmittedPrompt(value);
						if (this.onInputCallback) {
							this.onInputCallback(value);
						}
					},
				},
			);
		};
	}

	private subscribeToAgent(): void {
		this.unsubscribe = this.session.subscribe(async (event) => {
			await this.handleEvent(event);
		});
	}

	private async handleEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.isInitialized) {
			await this.init();
		}

		this.footer.invalidate();
		this.generationStats?.handleEvent(event as unknown as GenerationStatsEvent);

		switch (event.type) {
			case "agent_start":
				// Restore main escape handler if retry handler is still active
				// (retry success event fires later, but we need main handler now)
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				if (this.retryLoader) {
					this.retryLoader.stop();
					this.retryLoader = undefined;
				}
				if (this.loadingAnimation) {
					this.loadingAnimation.stop();
				}
				this.stopWorkingVerbAnimation();
				this.activeWorkingVerb = undefined;
				this.workingVerbAnimator.setState(undefined, false);
				this.statusContainer.clear();
				this.loadingAnimation = new Loader(
					this.ui,
					(spinner) => theme.fg("accent", spinner),
					(text) => text,
					this.getDefaultWorkingMessage(),
				);
				this.loadingAnimation.setStatsProvider(() => this.generationStatsLine());
				this.statusContainer.addChild(this.loadingAnimation);
				// Apply any pending working message queued before loader existed
				if (this.pendingWorkingMessage !== undefined) {
					if (this.pendingWorkingMessage) {
						this.loadingAnimation.setMessage(this.pendingWorkingMessage);
					}
					this.pendingWorkingMessage = undefined;
				}
				this.currentTurnToolCallHistory = [];
				this.currentTurnFileAccessHistory = [];
				this.ui.requestRender();
				break;

			case "queue_update":
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				break;

			case "message_start":
				if (event.message.role === "custom") {
					this.addMessageToChat(event.message);
					this.ui.requestRender();
				} else if (event.message.role === "user") {
					this.currentTurnRail = undefined;
					this.addMessageToChat(event.message);
					this.updatePendingMessagesDisplay();
					this.ui.requestRender();
				} else if (event.message.role === "assistant") {
					if (this.shouldSuppressAssistantMessage(event.message)) {
						this.streamingMessage = event.message;
						break;
					}
					this.streamingComponent = new AssistantMessageComponent(
						undefined,
						this.hideThinkingBlock,
						this.getMarkdownThemeWithSettings(),
						this.hiddenThinkingLabel,
					);
					this.streamingComponent.setVerbose(this.settingsManager.getVerboseMode());
					this.streamingComponent.setStreaming(true);
					this.streamingMessage = event.message;
					this.assistantContentTarget().addChild(this.streamingComponent);
					this.streamingComponent.updateContent(this.streamingMessage);
					this.ui.requestRender();
				}
				break;

			case "message_update":
				if (event.message.role === "assistant" && this.shouldSuppressAssistantMessage(event.message)) {
					this.streamingMessage = event.message;
					break;
				}
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					this.streamingComponent.updateContent(this.streamingMessage);
					if (this.shouldSuppressAssistantToolRendering(this.streamingMessage)) {
						this.ui.requestRender();
						break;
					}

					for (const content of this.streamingMessage.content) {
						if (content.type === "toolCall") {
							if (!this.pendingTools.has(content.id)) {
								const component = new ToolExecutionComponent(
									content.name,
									content.id,
									content.arguments,
									{
										showImages: this.settingsManager.getShowImages(),
									},
									this.getRegisteredToolDefinition(content.name),
									this.ui,
									this.sessionManager.getCwd(),
								);
								component.setExpanded(this.toolOutputExpanded);
								component.setVerbose(this.settingsManager.getVerboseMode());
								this.assistantContentTarget().addChild(component);
								this.pendingTools.set(content.id, component);
							} else {
								const component = this.pendingTools.get(content.id);
								if (component) {
									component.updateArgs(content.arguments);
								}
							}
						}
					}
					this.ui.requestRender();
				}
				break;

			case "message_end":
				if (event.message.role === "user") break;
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;

					// Track output tokens for nudge evaluation
					const assistantMsg = event.message as AssistantMessage;
					if (assistantMsg.usage?.output) {
						this.lastNudgeOutputTokens = assistantMsg.usage.output;
					}

					let errorMessage: string | undefined;
					if (this.streamingMessage.stopReason === "aborted") {
						const retryAttempt = this.session.retryAttempt;
						errorMessage =
							retryAttempt > 0
								? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
								: "Operation aborted";
						this.streamingMessage.errorMessage = errorMessage;
					}
					this.streamingComponent.updateContent(this.streamingMessage);
					this.streamingComponent.setStreaming?.(false);

					const requestFailureWarning =
						this.streamingMessage.stopReason === "error"
							? this.formatRequestFailureWarning(this.streamingMessage)
							: undefined;
					if (requestFailureWarning) {
						this.footer.setWarning(requestFailureWarning);
					}

					if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
						if (!errorMessage) {
							errorMessage = this.streamingMessage.errorMessage || "Error";
						}
						for (const [, component] of this.pendingTools.entries()) {
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
						}
						this.pendingTools.clear();
						this.pendingToolArgs.clear();
					} else {
						// Args are now complete - trigger diff computation for edit tools
						for (const [, component] of this.pendingTools.entries()) {
							component.setArgsComplete();
						}
					}
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					this.footer.invalidate();
				}
				this.ui.requestRender();
				break;

			case "tool_execution_start": {
				if (this.shouldSuppressPlanningToolUi()) {
					break;
				}
				this.setToolAwareLoadingMessage(event.toolName, event.args);
				this.pendingToolArgs.set(event.toolCallId, event.args ?? {});
				this.delegationEvidence?.handleToolStart(event.toolName, event.toolCallId, this.sessionManager.getCwd());
				let component = this.pendingTools.get(event.toolCallId);
				if (!component) {
					component = new ToolExecutionComponent(
						event.toolName,
						event.toolCallId,
						event.args,
						{
							showImages: this.settingsManager.getShowImages(),
						},
						this.getRegisteredToolDefinition(event.toolName),
						this.ui,
						this.sessionManager.getCwd(),
					);
					component.setExpanded(this.toolOutputExpanded);
					component.setVerbose(this.settingsManager.getVerboseMode());
					this.assistantContentTarget().addChild(component);
					this.pendingTools.set(event.toolCallId, component);
				}
				// Execution start implies the args are finalized
				component.setArgsComplete();
				component.markExecutionStarted();
				this.ui.requestRender();
				break;
			}

			case "tool_execution_update": {
				if (this.shouldSuppressPlanningToolUi()) {
					break;
				}
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.partialResult, isError: false }, true);
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				if (this.shouldSuppressPlanningToolUi()) {
					this.pendingTools.delete(event.toolCallId);
					this.pendingToolArgs.delete(event.toolCallId);
					this.delegationEvidence?.discard(event.toolCallId);
					break;
				}
				const component = this.pendingTools.get(event.toolCallId);
				const toolArgs = this.pendingToolArgs.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError });
					this.pendingTools.delete(event.toolCallId);
					this.pendingToolArgs.delete(event.toolCallId);

					// Track tool outcome for nudge evaluation
					const toolName = normalizeToolName(event.toolName);
					const filePath = extractInteractiveToolFile({
						toolName,
						args: toolArgs,
						result: event.result,
						cwd: this.sessionManager.getCwd(),
					});
					const detail = extractInteractiveToolDetail(toolName, toolArgs);
					const metadata =
						this.delegationEvidence?.handleToolEnd(
							toolName,
							event.toolCallId,
							this.sessionManager.getCwd(),
							extractInteractiveToolMetadata(event.result),
						) ?? extractInteractiveToolMetadata(event.result);
					const estimatedTokens = estimateInteractiveToolResultTokens(event.result);
					const toolOutcome: import("../../core/auton/nudges/types.js").ToolOutcome = {
						tool: toolName,
						success: !event.isError,
						file: filePath,
						detail,
						estimatedTokens,
						metadata,
						callDigest: buildToolCallDigest(toolName, toolArgs),
						resultDigest: buildToolResultDigest(event.result, event.isError),
					};
					toolOutcome.fingerprint = buildToolOutcomeFingerprint(toolOutcome);
					this.session.recordToolOutcome(toolOutcome);
					this.nudgeToolCallHistory.push(toolOutcome);
					this.currentTurnToolCallHistory.push(toolOutcome);

					if (filePath && !event.isError) {
						this.nudgeFileAccessHistory.push(toolOutcome);
						this.currentTurnFileAccessHistory.push(toolOutcome);
					}

					// Capture structured plan submissions (submit_plan during planning turns)
					if (toolName === SUBMIT_PLAN_TOOL_NAME && !event.isError) {
						const plan = asRecord(asRecord(event.result)?.details)?.plan;
						if (plan) {
							this.lastSubmitPlanPayload = plan as SubmitPlanSubmission;
						}
					}

					// Track todo list state + staleness counter
					this.toolCallsSinceTodoUpdate++;
					if (toolName === "todo" && !event.isError) {
						this.applyTodoToolResult(event.result);
					}

					this.resetLoadingAnimationMessage();
					this.ui.requestRender();
				}
				break;
			}

			case "xml_tool_call": {
				const result = handleInteractiveXmlFallbackEvent({
					event,
					currentCount: this.xmlFallbackCount,
					persistRuntimeHealthSnapshot: () => this.persistRuntimeHealthSnapshot(),
					formatWarning: (value) => this.formatXmlFallbackWarning(value),
					footer: this.footer,
					showWarning: (message) => this.showWarning(message),
					showStatus: (message) => this.showStatus(message),
					ui: this.ui,
				});
				this.xmlFallbackCount = result.nextCount;
				this.lastXmlFallbackEvent = result.lastEvent;
				break;
			}

			case "degraded_turn": {
				const result = handleInteractiveDegradedTurnEvent({
					event,
					currentCount: this.degradedTurnCount,
					persistRuntimeHealthSnapshot: () => this.persistRuntimeHealthSnapshot(),
					formatWarning: (value) => this.formatDegradedTurnWarning(value),
					footer: this.footer,
					showWarning: (message) => this.showWarning(message),
					showStatus: (message) => this.showStatus(message),
					ui: this.ui,
				});
				this.degradedTurnCount = result.nextCount;
				this.lastDegradedTurnEvent = result.lastEvent;
				break;
			}

			case "agent_end":
				this.currentTurnRail = undefined;
				if (this.loadingAnimation) {
					this.loadingAnimation.stop();
					this.loadingAnimation = undefined;
					this.statusContainer.clear();
				}
				this.stopWorkingVerbAnimation();
				this.activeWorkingVerb = undefined;
				this.workingVerbAnimator.setState(undefined, false);
				if (this.streamingComponent) {
					this.chatContainer.removeChild(this.streamingComponent);
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.pendingTools.clear();
				this.pendingToolArgs.clear();
				if (!this.autonomousMode && !this.planningMode) {
					const steeringContext = {
						toolCallHistory: this.currentTurnToolCallHistory,
						fileAccessHistory: this.currentTurnFileAccessHistory,
					};
					this.pendingRuntimePromptAddendum = isPromptSteeringEnabled()
						? buildLocalEvidencePromptAddendum(steeringContext)
						: undefined;
					const continuationMessage = isPromptSteeringEnabled()
						? buildRuntimeContinuationMessage(steeringContext)
						: undefined;
					if (continuationMessage) {
						await this.session.sendCustomMessage(
							{
								customType: "runtime_continuation_state",
								content: continuationMessage,
								display: false,
								details: { kind: "runtime_continuation_state" },
							},
							{ deliverAs: "nextTurn" },
						);
					}
				}
				this.currentTurnToolCallHistory = [];
				this.currentTurnFileAccessHistory = [];

				// Evaluate nudges after agent turn completes
				this.evaluateAndShowNudgeWarnings();

				await this.checkShutdownRequested();

				this.ui.requestRender();
				break;

			case "compaction_start": {
				const result = handleInteractiveCompactionStart({
					event,
					defaultEditor: this.defaultEditor,
					statusContainer: this.statusContainer,
					session: this.session,
					ui: this.ui,
				});
				this.autoCompactionEscapeHandler = result.nextEscapeHandler;
				this.autoCompactionLoader = result.loader;
				break;
			}

			case "compaction_end": {
				handleInteractiveCompactionEnd({
					event,
					defaultEditor: this.defaultEditor,
					previousEscapeHandler: this.autoCompactionEscapeHandler,
					loader: this.autoCompactionLoader,
					statusContainer: this.statusContainer,
					chatContainer: this.chatContainer,
					rebuildChatFromMessages: () => this.rebuildChatFromMessages(),
					addMessageToChat: (message) => this.addMessageToChat(message),
					footer: this.footer,
					showError: (message) => this.showError(message),
					showStatus: (message) => this.showStatus(message),
					flushCompactionQueue: (options) => this.flushCompactionQueue(options),
					ui: this.ui,
				});
				this.autoCompactionEscapeHandler = undefined;
				this.autoCompactionLoader = undefined;
				break;
			}

			case "auto_retry_start": {
				const result = handleInteractiveRetryStart({
					event,
					defaultEditor: this.defaultEditor,
					statusContainer: this.statusContainer,
					session: this.session,
					ui: this.ui,
				});
				this.retryEscapeHandler = result.nextEscapeHandler;
				this.retryLoader = result.loader;
				break;
			}

			case "auto_retry_end": {
				handleInteractiveRetryEnd({
					event,
					defaultEditor: this.defaultEditor,
					previousEscapeHandler: this.retryEscapeHandler,
					loader: this.retryLoader,
					statusContainer: this.statusContainer,
					showError: (message) => this.showError(message),
					ui: this.ui,
				});
				this.retryEscapeHandler = undefined;
				this.retryLoader = undefined;
				break;
			}

			case "recovery_replay_skipped":
				handleInteractiveRecoveryReplaySkipped({
					event,
					showStatus: (message) => this.showStatus(message),
					ui: this.ui,
				});
				break;

			case "recovery_replay_error":
				this.showError(event.message);
				break;
		}
	}

	/** Extract text content from a user message */
	private getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		return textBlocks.map((c) => (c as { text: string }).text).join("");
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
	private showStatus(message: string): void {
		const children = this.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

		if (last && secondLast && last === this.lastStatusNotice && secondLast === this.lastStatusSpacer) {
			this.lastStatusNotice.setLines([theme.fg("dim", message)]);
			this.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const notice = new NoticeCardComponent({
			badge: "status",
			badgeColor: "muted",
			meta: ["live runtime"],
			lines: [theme.fg("dim", message)],
			tone: "info",
			includeLeadingSpacer: false,
		});
		this.chatContainer.addChild(spacer);
		this.chatContainer.addChild(notice);
		this.lastStatusSpacer = spacer;
		this.lastStatusNotice = notice;
		this.ui.requestRender();
	}

	private addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				this.chatContainer.addChild(component);
				break;
			}
			case "custom": {
				if (message.display) {
					const renderer = this.session.extensionRunner?.getMessageRenderer(message.customType);
					const component = new CustomMessageComponent(message, renderer, this.getMarkdownThemeWithSettings());
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "user": {
				this.currentTurnRail = undefined;
				const textContent = this.getUserMessageText(message);
				if (textContent) {
					const skillBlock = parseSkillBlock(textContent);
					if (skillBlock) {
						// Render skill block (collapsible)
						this.chatContainer.addChild(new Spacer(1));
						const component = new SkillInvocationMessageComponent(
							skillBlock,
							this.getMarkdownThemeWithSettings(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						// Render user message separately if present
						if (skillBlock.userMessage) {
							const userComponent = new UserMessageComponent(
								skillBlock.userMessage,
								this.getMarkdownThemeWithSettings(),
							);
							this.chatContainer.addChild(userComponent);
						}
					} else {
						const userComponent = new UserMessageComponent(textContent, this.getMarkdownThemeWithSettings());
						this.chatContainer.addChild(userComponent);
					}
					if (options?.populateHistory) {
						this.editor.addToHistory?.(textContent);
					}
				}
				break;
			}
			case "assistant": {
				if (this.shouldSuppressAssistantMessage(message)) {
					break;
				}
				const assistantComponent = new AssistantMessageComponent(
					message,
					this.hideThinkingBlock,
					this.getMarkdownThemeWithSettings(),
					this.hiddenThinkingLabel,
				);
				assistantComponent.setVerbose(this.settingsManager.getVerboseMode());
				this.assistantContentTarget().addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
			default: {
				const _exhaustive: never = message;
			}
		}
	}

	/**
	 * Render session context to chat. Used for initial load and rebuild after compaction.
	 * @param sessionContext Session context to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	private renderSessionContext(
		sessionContext: SessionContext,
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		this.pendingTools.clear();
		this.pendingToolArgs.clear();

		if (options.updateFooter) {
			this.footer.invalidate();
			this.updateEditorBorderColor();
		}

		for (const message of sessionContext.messages) {
			// Assistant messages need special handling for tool calls
			if (message.role === "assistant") {
				this.addMessageToChat(message);
				if (this.shouldSuppressAssistantToolRendering(message)) {
					continue;
				}
				// Render tool call components
				for (const content of message.content) {
					if (content.type === "toolCall") {
						const component = new ToolExecutionComponent(
							content.name,
							content.id,
							content.arguments,
							{ showImages: this.settingsManager.getShowImages() },
							this.getRegisteredToolDefinition(content.name),
							this.ui,
							this.sessionManager.getCwd(),
						);
						component.setExpanded(this.toolOutputExpanded);
						component.setVerbose(this.settingsManager.getVerboseMode());
						this.assistantContentTarget().addChild(component);

						if (message.stopReason === "aborted" || message.stopReason === "error") {
							let errorMessage: string;
							if (message.stopReason === "aborted") {
								const retryAttempt = this.session.retryAttempt;
								errorMessage =
									retryAttempt > 0
										? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
										: "Operation aborted";
							} else {
								errorMessage = message.errorMessage || "Error";
							}
							component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
						} else {
							this.pendingTools.set(content.id, component);
						}
					}
				}
			} else if (message.role === "toolResult") {
				// Match tool results to pending tool components
				const component = this.pendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					this.pendingTools.delete(message.toolCallId);
				}
			} else {
				// All other messages use standard rendering
				this.addMessageToChat(message, options);
			}
		}

		this.pendingTools.clear();
		this.pendingToolArgs.clear();
		this.ui.requestRender();
	}

	renderInitialMessages(): void {
		// Get aligned messages and entries from session context
		const context = this.sessionManager.buildSessionContext();
		this.renderSessionContext(context, {
			updateFooter: true,
			populateHistory: true,
		});

		// Show compaction info if session was compacted
		const allEntries = this.sessionManager.getEntries();
		const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			this.showStatus(`Session compacted ${times}`);
		}
	}

	async getUserInput(): Promise<string> {
		return new Promise((resolve) => {
			this.onInputCallback = (text: string) => {
				this.onInputCallback = undefined;
				resolve(text);
			};
		});
	}

	private rebuildChatFromMessages(): void {
		this.chatContainer.clear();
		const context = this.sessionManager.buildSessionContext();
		this.renderSessionContext(context);
	}

	// =========================================================================
	// Key handlers
	// =========================================================================

	private handleCtrlC(): void {
		const now = Date.now();
		if (now - this.lastSigintTime < 500) {
			void this.shutdown();
		} else {
			this.clearEditor();
			this.lastSigintTime = now;
		}
	}

	private handleCtrlD(): void {
		// Only called when editor is empty (enforced by CustomEditor)
		void this.shutdown();
	}

	/**
	 * Gracefully shutdown the agent.
	 * Emits shutdown event to extensions, then exits.
	 */
	private isShuttingDown = false;

	private async shutdown(): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;
		await this.runtimeHost.dispose();

		// Wait for any pending renders to complete
		// requestRender() uses process.nextTick(), so we wait one tick
		await new Promise((resolve) => process.nextTick(resolve));

		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		await this.ui.terminal.drainInput(1000);

		this.stop();
		process.exit(0);
	}

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 */
	private async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	private handleCtrlZ(): void {
		// Keep the event loop alive while suspended. Without this, stopping the TUI
		// can leave Node with no ref'ed handles, causing the process to exit on fg
		// before the SIGCONT handler gets a chance to restore the terminal.
		const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

		// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
		// kill the backgrounded process. The handler is removed on resume.
		const ignoreSigint = () => {};
		process.on("SIGINT", ignoreSigint);

		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			this.ui.start();
			this.ui.requestRender(true);
		});

		try {
			// Stop the TUI (restore terminal to normal mode)
			this.ui.stop();

			// Send SIGTSTP to process group (pid=0 means all processes in group)
			process.kill(0, "SIGTSTP");
		} catch (error) {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			throw error;
		}
	}

	private async handleFollowUp(): Promise<void> {
		const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
		if (!text) return;
		await handleInteractiveFollowUpSubmit(
			text,
			{
				isCompacting: this.session.isCompacting,
				isStreaming: this.session.isStreaming,
				isExtensionCommand: (value) => this.isExtensionCommand(value),
			},
			{
				addToHistory: (value) => this.editor.addToHistory?.(value),
				clearEditor: () => this.editor.setText(""),
				prompt: (value, options) => {
					this.rememberSubmittedPrompt(value);
					return this.promptWithRuntimeSteering(value, options);
				},
				queueCompactionMessage: (value, mode) => this.queueCompactionMessage(value, mode),
				updatePendingMessagesDisplay: () => this.updatePendingMessagesDisplay(),
				requestRender: () => this.ui.requestRender(),
				submitNormally: async (value) => {
					if (this.editor.onSubmit) {
						await this.editor.onSubmit(value);
					}
				},
			},
		);
	}

	private handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.showStatus("No queued messages to restore");
		} else {
			this.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	private updateEditorBorderColor(): void {
		if (this.isBashMode) {
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else {
			const level = this.session.thinkingLevel || "off";
			this.editor.borderColor = theme.getThinkingBorderColor(level);
		}
		this.ui.requestRender();
	}

	private cycleThinkingLevel(): void {
		const newLevel = this.session.cycleThinkingLevel();
		if (newLevel === undefined) {
			this.showStatus("Current model does not support thinking");
		} else {
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(`Thinking level: ${newLevel}`);
		}
	}

	private async cycleModel(direction: "forward" | "backward"): Promise<void> {
		try {
			const result = await this.session.cycleModel(direction);
			if (result === undefined) {
				const msg = this.session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available";
				this.showStatus(msg);
			} else {
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.updateModeDisplay();
				const thinkingStr =
					result.model.reasoning && result.thinkingLevel !== "off" ? ` (thinking: ${result.thinkingLevel})` : "";
				this.showStatus(`Switched to ${result.model.name || result.model.id}${thinkingStr}`);
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * Toggle autonomous execution for the next prompt.
	 *
	 * Alt+M is deliberately scoped to autonomy only:
	 * - interactive/planning -> autonomous
	 * - autonomous -> interactive
	 *
	 * Note: Ctrl+M cannot be used because it produces the same byte as Enter in
	 * terminal protocols.
	 */
	private cycleMode(): void {
		const currentMode = this.getExecutionMode();
		if (currentMode !== "autonomous") {
			const scopeGuardReason = getAutonomousScopeGuardReason(this.sessionManager.getCwd());
			if (scopeGuardReason) {
				this.showWarning(scopeGuardReason);
				this.updateModeDisplay();
				return;
			}
			this.setExecutionMode("autonomous");
			this.showStatus("Execution: Autonomous");
			return;
		}
		this.setExecutionMode("interactive");
		this.showStatus("Execution: Interactive");
	}

	private togglePlanningMode(): void {
		const nextMode = this.planningMode ? "interactive" : "planning";
		this.setExecutionMode(nextMode);
		this.showStatus(`Execution: ${nextMode === "planning" ? "Planning" : "Interactive"}`);
	}

	private toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.toolOutputExpanded);
	}

	private setToolsExpanded(expanded: boolean): void {
		this.toolOutputExpanded = expanded;
		for (const child of this.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
			}
		}
		this.ui.requestRender();
	}

	private toggleVerboseMode(): void {
		const next = !this.settingsManager.getVerboseMode();
		this.settingsManager.setVerboseMode(next);
		this.showStatus(
			next
				? "Verbose mode: full thinking, ungrouped tool calls"
				: "Condensed mode: thinking collapsed, tool runs grouped",
		);
		this.chatContainer.clear();
		this.rebuildChatFromMessages();
	}

	private toggleThinkingBlockVisibility(): void {
		this.hideThinkingBlock = !this.hideThinkingBlock;
		this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);

		// Rebuild chat from session messages
		this.chatContainer.clear();
		this.rebuildChatFromMessages();

		// If streaming, re-add the streaming component with updated visibility and re-render
		if (this.streamingComponent && this.streamingMessage) {
			this.streamingComponent.setHideThinkingBlock(this.hideThinkingBlock);
			this.streamingComponent.updateContent(this.streamingMessage);
			this.assistantContentTarget().addChild(this.streamingComponent);
		}

		this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	private openExternalEditor(): void {
		// Determine editor (respect $VISUAL, then $EDITOR)
		const editorCmd = process.env.VISUAL || process.env.EDITOR;
		if (!editorCmd) {
			this.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const currentText = this.editor.getExpandedText?.() ?? this.editor.getText();
		const tmpFile = path.join(os.tmpdir(), `ag1-editor-${Date.now()}.md`);

		try {
			// Write current content to temp file
			fs.writeFileSync(tmpFile, currentText, "utf-8");

			// Stop TUI to release terminal
			this.ui.stop();

			// Split by space to support editor arguments (e.g., "code --wait")
			const [editor, ...editorArgs] = editorCmd.split(" ");

			// Spawn editor synchronously with inherited stdio for interactive editing
			const result = spawnSync(editor, [...editorArgs, tmpFile], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});

			// On successful exit (status 0), replace editor content
			if (result.status === 0) {
				const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
				this.editor.setText(newContent);
			}
			// On non-zero exit, keep original text (no action needed)
		} finally {
			// Clean up temp file
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}

			// Restart TUI
			this.ui.start();
			// Force full re-render since external editor uses alternate screen
			this.ui.requestRender(true);
		}
	}

	// =========================================================================
	// UI helpers
	// =========================================================================

	clearEditor(): void {
		this.editor.setText("");
		this.ui.requestRender();
	}

	showError(errorMessage: string): void {
		this.chatContainer.addChild(
			new NoticeCardComponent({
				badge: "error",
				badgeColor: "error",
				title: "Runtime Error",
				lines: [`${theme.fg("error", "Error:")} ${theme.fg("text", errorMessage)}`],
				tone: "error",
			}),
		);
		this.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		this.chatContainer.addChild(
			new NoticeCardComponent({
				badge: "warning",
				badgeColor: "warning",
				title: "Attention",
				lines: [`${theme.fg("warning", "Warning:")} ${theme.fg("text", warningMessage)}`],
				tone: "warning",
			}),
		);
		this.ui.requestRender();
	}

	private showDiagnosticNotice(title: string, warningLines: string): void {
		this.chatContainer.addChild(
			new NoticeCardComponent({
				badge: "warning",
				badgeColor: "warning",
				title,
				lines: warningLines.split("\n"),
				tone: "warning",
			}),
		);
	}

	/**
	 * Get all queued messages (read-only).
	 * Combines session queue and compaction queue.
	 */
	private getAllQueuedMessages(): { steering: string[]; followUp: string[] } {
		return getInteractiveQueuedMessages(
			{
				steering: this.session.getSteeringMessages(),
				followUp: this.session.getFollowUpMessages(),
			},
			this.compactionQueuedMessages,
		);
	}

	/**
	 * Clear all queued messages and return their contents.
	 * Clears both session queue and compaction queue.
	 */
	private clearAllQueues(): { steering: string[]; followUp: string[] } {
		const { steering, followUp } = this.session.clearQueue();
		const cleared = clearInteractiveQueuedMessages({ steering, followUp }, this.compactionQueuedMessages);
		this.compactionQueuedMessages = [];
		return cleared;
	}

	private updatePendingMessagesDisplay(): void {
		this.pendingMessagesContainer.clear();
		const { steering: steeringMessages, followUp: followUpMessages } = this.getAllQueuedMessages();
		const planReviewLines = buildInteractivePlanReviewLines(this.getLatestPlanArtifact());
		const workspace = this.activeAutonomousWorkspace ?? this.lastAutonomousWorkspace;
		const workspaceSummary = getInteractiveWorkspaceSummary(workspace, Boolean(this.activeAutonomousWorkspace));
		const workspaceLines = normalizeInteractiveWorkspaceSummaryLines(workspaceSummary);
		if (
			steeringMessages.length > 0 ||
			followUpMessages.length > 0 ||
			planReviewLines.length > 0 ||
			workspaceLines.length > 0
		) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
		}
		const queuedLines = buildInteractiveQueuedContextLines({
			steering: steeringMessages,
			followUp: followUpMessages,
			dequeueHint:
				steeringMessages.length > 0 || followUpMessages.length > 0
					? `${getInteractiveAppKeyDisplay("app.message.dequeue")} to edit all queued messages`
					: undefined,
		});
		if (queuedLines.length > 0) {
			this.pendingMessagesContainer.addChild(
				new NoticeCardComponent({
					badge: "queue",
					badgeColor: "muted",
					title: "Queued Context",
					meta: [`${steeringMessages.length + followUpMessages.length} pending`],
					lines: queuedLines.map((line) => (line ? theme.fg("dim", line) : "")),
					tone: "info",
					includeLeadingSpacer: false,
				}),
			);
		}
		if (planReviewLines.length > 0) {
			const latestPlanArtifact = this.getLatestPlanArtifact();
			const badgeColor =
				latestPlanArtifact?.status === "clarifying"
					? "warning"
					: latestPlanArtifact?.status === "accepted"
						? "success"
						: "accent";
			this.pendingMessagesContainer.addChild(
				new NoticeCardComponent({
					badge: "plan",
					badgeColor,
					title: "Plan Context",
					meta: latestPlanArtifact ? [`v${latestPlanArtifact.revision}`, latestPlanArtifact.status] : undefined,
					lines: planReviewLines.map((line) => theme.fg("dim", line)),
					tone:
						latestPlanArtifact?.status === "clarifying"
							? "warning"
							: latestPlanArtifact?.status === "accepted"
								? "success"
								: "info",
					includeLeadingSpacer: false,
				}),
			);
		}
		if (workspaceLines.length > 0) {
			this.pendingMessagesContainer.addChild(
				new NoticeCardComponent({
					badge: "workspace",
					badgeColor: this.activeAutonomousWorkspace ? "success" : "accent",
					title: this.activeAutonomousWorkspace ? "Autonomous Sandbox Active" : "Autonomous Sandbox Preserved",
					meta: workspace ? [workspace.strategy] : undefined,
					lines: workspaceLines.map((line) => theme.fg("dim", line)),
					tone: this.activeAutonomousWorkspace ? "success" : "info",
					includeLeadingSpacer: false,
				}),
			);
		}
	}

	private restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		const queues = this.clearAllQueues();
		const currentText = options?.currentText ?? this.editor.getText();
		const restored = combineQueuedMessagesForEditor(queues, currentText);
		if (restored.restoredCount === 0) {
			this.updatePendingMessagesDisplay();
			if (options?.abort) {
				this.agent.abort();
			}
			return 0;
		}
		this.editor.setText(restored.text);
		this.updatePendingMessagesDisplay();
		if (options?.abort) {
			this.agent.abort();
		}
		return restored.restoredCount;
	}

	private queueCompactionMessage(text: string, mode: "steer" | "followUp"): void {
		this.compactionQueuedMessages.push({ text, mode });
		this.editor.addToHistory?.(text);
		this.editor.setText("");
		this.updatePendingMessagesDisplay();
		this.showStatus("Queued message for after compaction");
	}

	private isExtensionCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;

		const extensionRunner = this.session.extensionRunner;
		if (!extensionRunner) return false;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		return !!extensionRunner.getCommand(commandName);
	}

	private async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		const queuedMessages = [...this.compactionQueuedMessages];
		this.compactionQueuedMessages = [];
		await flushInteractiveCompactionQueue(
			queuedMessages,
			{
				updatePendingMessagesDisplay: () => this.updatePendingMessagesDisplay(),
				isExtensionCommand: (text) => this.isExtensionCommand(text),
				prompt: (text) => this.promptWithRuntimeSteering(text),
				followUp: (text) => this.session.followUp(text),
				steer: (text) => this.session.steer(text),
				clearSessionQueue: () => {
					this.session.clearQueue();
				},
				restoreCompactionQueuedMessages: (messages) => {
					this.compactionQueuedMessages = messages;
				},
				showError: (message) => this.showError(message),
			},
			options,
		);
	}

	/** Move pending bash components from pending area to chat */
	private flushPendingBashComponents(): void {
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.removeChild(component);
			this.chatContainer.addChild(component);
		}
		this.pendingBashComponents = [];
	}

	// =========================================================================
	// Selectors
	// =========================================================================

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	private showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		const done = () => {
			restoreEditorHost({
				container: this.editorContainer,
				ui: this.ui,
				editor: this.editor,
			});
		};
		const { component, focus } = create(done);
		showEditorHostComponent({
			container: this.editorContainer,
			ui: this.ui,
			component,
			focus,
		});
	}

	private showSettingsSelector(): void {
		this.showSelector((done) => {
			const selector = new SettingsSelectorComponent(
				buildInteractiveSettingsConfig({
					session: this.session,
					settingsManager: this.settingsManager,
					hideThinkingBlock: this.hideThinkingBlock,
					availableThemes: getAvailableThemes(),
				}),
				createInteractiveSettingsCallbacks({
					session: this.session,
					settingsManager: this.settingsManager,
					footer: this.footer,
					ui: this.ui,
					defaultEditor: this.defaultEditor,
					editor: this.editor,
					applyTheme: (themeName) => setTheme(themeName, true),
					showError: (message) => this.showError(message),
					setupAutocomplete: () => this.setupAutocomplete(this.fdPath),
					updateEditorBorderColor: () => this.updateEditorBorderColor(),
					applyShowImages: (enabled) => {
						for (const child of this.chatContainer.children) {
							if (child instanceof ToolExecutionComponent) {
								child.setShowImages(enabled);
							} else if (child instanceof TurnRail) {
								for (const nested of child.children) {
									if (nested instanceof ToolExecutionComponent) {
										nested.setShowImages(enabled);
									}
								}
							}
						}
					},
					applyHideThinkingBlock: (hidden) => {
						this.hideThinkingBlock = hidden;
						for (const child of this.chatContainer.children) {
							if (child instanceof AssistantMessageComponent) {
								child.setHideThinkingBlock(hidden);
							}
						}
						this.chatContainer.clear();
						this.rebuildChatFromMessages();
					},
					closeSelector: () => {
						done();
						this.ui.requestRender();
					},
				}),
			);
			return { component: selector, focus: selector.getSettingsList() };
		});
	}

	private async handleModelCommand(searchTerm?: string): Promise<void> {
		if (!searchTerm) {
			this.showModelSelector();
			return;
		}

		const model = await this.findExactModelMatch(searchTerm);
		if (model) {
			await this.applyInteractiveModelSelection(model, `Model: ${model.id}`);
			return;
		}

		this.showModelSelector(searchTerm);
	}

	private async applyInteractiveModelSelection(model: Model<any>, statusMessage?: string): Promise<void> {
		try {
			await this.session.setModel(model);
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.checkDaxnutsEasterEgg(model);
			this.warnIfModelMayHaveUndeclaredVision(model);
			this.watchVisualToolActivation(model);
			if (statusMessage) {
				this.showStatus(statusMessage);
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private visionWarningShownFor = new Set<string>();

	/**
	 * The visual-tools gate trusts registry metadata. Warn once per model when
	 * the name strongly suggests vision support but the metadata doesn't declare
	 * it, so the user knows why screenshot/verify tools are missing.
	 */
	private warnIfModelMayHaveUndeclaredVision(model: Model<any>): void {
		if (this.settingsManager.getVisualToolsMode() !== "auto") return;
		if (modelSupportsVision(model)) return;
		if (this.session.getVisionVerdict(model) !== undefined) return; // probed already — metadata is moot
		const ref = this.formatModelReference(model);
		if (this.visionWarningShownFor.has(ref)) return;
		const name = `${model.provider}/${model.id}`.toLowerCase();
		const looksVisionCapable =
			/vision|\bvl\b|vl[-_.]|llava|pixtral|gpt-4o|gpt-4-turbo|claude-(3|3\.5|4|sonnet|opus|haiku)|gemini|qwen\d*[-_.]?vl|glm-4v|internvl/.test(
				name,
			);
		if (!looksVisionCapable) return;
		this.visionWarningShownFor.add(ref);
		this.showWarning(
			`${ref} looks vision-capable but doesn't declare image input, so visual tools (screenshot_url, verify_ui) are disabled. Set visualTools: "on" in settings to force-enable them.`,
		);
	}

	/**
	 * Vision probing is async. If visual tools aren't active right after model
	 * selection, poll briefly and announce when the probe enables them.
	 */
	private watchVisualToolActivation(model: Model<any>): void {
		if (this.settingsManager.getVisualToolsMode() !== "auto") return;
		if (modelSupportsVision(model)) return;
		const modelKey = this.formatModelReference(model);
		const delays = [2000, 5000, 10000];
		for (const delay of delays) {
			setTimeout(() => {
				if (this.formatModelReference(this.session.model ?? model) !== modelKey) return;
				if (this.session.getActiveToolNames().includes("verify_ui")) {
					this.showStatus(`Vision capability detected via provider probe — visual tools enabled for ${modelKey}.`);
				}
			}, delay);
		}
	}

	private formatModelReference(model: Pick<Model<any>, "provider" | "id">): string {
		return `${model.provider}/${model.id}`;
	}

	private getPreferredPlanningModelRef(): string | undefined {
		return this.settingsManager.getPlanningModel();
	}

	private getPreferredExecutionModelRef(): string | undefined {
		return this.settingsManager.getExecutionModel();
	}

	private getPreferredVerifierModelRef(): string | undefined {
		return this.settingsManager.getVerifierModel();
	}

	private getPreferredModelRef(mode: ModelRouteMode): string | undefined {
		if (mode === "planning") return this.getPreferredPlanningModelRef();
		if (mode === "execution") return this.getPreferredExecutionModelRef();
		return this.getPreferredVerifierModelRef();
	}

	private setPreferredModelRef(mode: ModelRouteMode, ref: string | undefined): void {
		if (mode === "planning") {
			this.settingsManager.setPlanningModel(ref);
		} else if (mode === "execution") {
			this.settingsManager.setExecutionModel(ref);
		} else {
			this.settingsManager.setVerifierModel(ref);
		}
	}

	private modelRouteCommandName(mode: ModelRouteMode): string {
		return mode === "planning" ? "planner-model" : mode === "execution" ? "executor-model" : "verifier-model";
	}

	private shouldAllowPlanningInspection(
		promptBody: string,
		options?: {
			goal?: string;
			previousArtifact?: InteractivePlanArtifact;
			feedback?: string;
		},
	): boolean {
		if (options?.previousArtifact) return false;
		const signalText = (options?.goal ?? promptBody).toLowerCase();
		if (!signalText.trim()) return false;
		const codebaseAnchors = [
			"codebase",
			"repo",
			"repository",
			"workspace",
			"session",
			"current implementation",
			"existing implementation",
			"current code",
			"file",
			"files",
			"path",
			"module",
			"function",
			"class",
			"test",
			"tests",
			"refactor",
			"bug",
			"regression",
			"migration",
			"runtime",
			"bootstrap",
			"cli",
			"tui",
			"provider",
			"artifact",
			"tsconfig",
			"package.json",
			".ts",
			".js",
			".tsx",
			".jsx",
		];
		return codebaseAnchors.some((anchor) => signalText.includes(anchor));
	}

	private formatPlanRouteSummaryLines(): string[] {
		const planning = this.getPreferredPlanningModelRef() ?? "(inherit active model)";
		const execution = this.getPreferredExecutionModelRef() ?? "(inherit active model)";
		const verifier = this.getPreferredVerifierModelRef() ?? "(inherit active model)";
		const active = this.session.model ? this.formatModelReference(this.session.model) : "(no active model)";
		return [
			theme.bold("Plan Routing"),
			`Planning model: ${planning}`,
			`Execution model: ${execution}`,
			`Verifier model: ${verifier}`,
			`Active model: ${active}`,
			"",
			"Commands",
			"/plan planner-model [provider/model|clear]",
			"/plan executor-model [provider/model|clear]",
			"/plan verifier-model [provider/model|clear]",
		];
	}

	private async ensurePreferredModeModel(mode: "planning" | "execution"): Promise<void> {
		const configuredRef = this.getPreferredModelRef(mode);
		if (!configuredRef) return;

		const currentModel = this.session.model;
		if (currentModel && this.formatModelReference(currentModel) === configuredRef) {
			return;
		}

		const model = await this.findExactModelMatch(configuredRef);
		if (!model) {
			this.showWarning(
				`Configured ${mode} model ${configuredRef} is not currently available. Update it with /plan ${this.modelRouteCommandName(mode)}.`,
			);
			return;
		}

		await this.applyInteractiveModelSelection(
			model,
			`Switched to ${mode} model: ${this.formatModelReference(model)}`,
		);
	}

	private async showPlanRouteSelector(mode: ModelRouteMode): Promise<void> {
		const models = await this.getModelCandidates();
		if (models.length === 0) {
			this.showWarning("No models are currently available for plan routing.");
			return;
		}

		const configuredRef = this.getPreferredModelRef(mode);
		const activeRef = this.session.model ? this.formatModelReference(this.session.model) : undefined;
		const modelOptions = models.map((model) => {
			const ref = this.formatModelReference(model);
			const markers = [
				ref === configuredRef ? "configured" : undefined,
				ref === activeRef ? "active" : undefined,
			].filter(Boolean);
			return markers.length > 0 ? `${ref} [${markers.join(", ")}]` : ref;
		});
		const options = [
			...(configuredRef ? [createPlanWorkflowOption("clear_configured_route", "Clear configured route", "d")] : []),
			...modelOptions.map((option) => createPlanWorkflowOption(option, option)),
		];
		const modeLabel = mode === "planning" ? "Planner" : mode === "execution" ? "Executor" : "Verifier";
		const selected = await this.showPlanWorkflowDialog(
			`${modeLabel} model route`,
			[
				`Current route: ${configuredRef ?? "(inherit active model)"}`,
				`Active model: ${activeRef ?? "(no active model)"}`,
				"",
				"Pick a model for this route or clear the override.",
			],
			options,
			{ accent: mode === "planning" ? "warning" : "success" },
		);
		if (!selected) return;
		if (selected === "clear_configured_route") {
			this.setPreferredModelRef(mode, undefined);
			this.showStatus(`Cleared ${mode} model route.`);
			return;
		}

		const modelRef = selected.replace(/\s+\[[^\]]+\]$/, "");
		this.setPreferredModelRef(mode, modelRef);
		this.showStatus(`Set ${mode} model route to ${modelRef}.`);
	}

	private async handlePlanModelRouteCommand(mode: ModelRouteMode, modelRef?: string): Promise<void> {
		const normalized = modelRef?.trim();
		if (!normalized) {
			await this.showPlanRouteSelector(mode);
			return;
		}
		if (normalized.toLowerCase() === "clear") {
			this.setPreferredModelRef(mode, undefined);
			this.showStatus(`Cleared ${mode} model route.`);
			return;
		}

		const model = await this.findExactModelMatch(normalized);
		if (!model) {
			this.showWarning(`Model ${normalized} is not currently available.`);
			return;
		}
		const ref = this.formatModelReference(model);
		this.setPreferredModelRef(mode, ref);
		this.showStatus(`Set ${mode} model route to ${ref}.`);
	}

	private async findExactModelMatch(searchTerm: string): Promise<Model<any> | undefined> {
		const models = await this.getModelCandidates();
		return findExactModelReferenceMatch(searchTerm, models);
	}

	private async getModelCandidates(): Promise<Model<any>[]> {
		if (this.session.scopedModels.length > 0) {
			return this.session.scopedModels.map((scoped) => scoped.model);
		}

		this.session.modelRegistry.refresh();
		try {
			return await this.session.modelRegistry.getAvailable();
		} catch {
			return [];
		}
	}

	/** Update the footer's available provider count from current model candidates */
	private async updateAvailableProviderCount(): Promise<void> {
		const models = await this.getModelCandidates();
		const uniqueProviders = new Set(models.map((m) => m.provider));
		this.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
	}

	private showModelSelector(initialSearchInput?: string): void {
		this.showSelector((done) => {
			const selector = new ModelSelectorComponent(
				this.ui,
				this.session.model,
				this.settingsManager,
				this.session.modelRegistry,
				this.session.scopedModels,
				async (model) =>
					performInteractiveModelSwitch({
						model,
						setModel: (nextModel) => this.session.setModel(nextModel),
						invalidateFooter: () => this.footer.invalidate(),
						updateEditorBorderColor: () => this.updateEditorBorderColor(),
						closeSelector: done,
						showStatus: (message) => this.showStatus(message),
						showError: (message) => this.showError(message),
						onModelSelected: (nextModel) => this.checkDaxnutsEasterEgg(nextModel),
					}),
				() => {
					done();
					this.ui.requestRender();
				},
				initialSearchInput,
			);
			return { component: selector, focus: selector };
		});
	}

	private async showModelsSelector(): Promise<void> {
		// Get all available models
		this.session.modelRegistry.refresh();
		const allModels = this.session.modelRegistry.getAvailable();

		if (allModels.length === 0) {
			this.showStatus("No models available");
			return;
		}

		const derivedSelection = await deriveInteractiveScopedModelSelection({
			sessionScopedModels: this.session.scopedModels,
			settingsEnabledModels: this.settingsManager.getEnabledModels(),
			resolveModelScope: (patterns) => resolveModelScope(patterns, this.session.modelRegistry),
		});

		// Track current enabled state (session-only until persisted)
		const currentEnabledIds = new Set(derivedSelection.enabledModelIds);
		let currentHasFilter = derivedSelection.hasFilter;

		// Helper to update session's scoped models (session-only, no persist)
		const updateSessionModels = async (enabledIds: Set<string>) => {
			await applyInteractiveScopedModelSelection({
				enabledIds,
				allModelCount: allModels.length,
				resolveModelScope: (patterns) => resolveModelScope(patterns, this.session.modelRegistry),
				setScopedModels: (models) => this.session.setScopedModels(models),
				onUpdated: async () => {
					await this.updateAvailableProviderCount();
					this.ui.requestRender();
				},
			});
		};

		this.showSelector((done) => {
			const selector = new ScopedModelsSelectorComponent(
				{
					allModels,
					enabledModelIds: currentEnabledIds,
					hasEnabledModelsFilter: currentHasFilter,
				},
				createInteractiveScopedModelsCallbacks({
					currentEnabledIds,
					setCurrentHasFilter: (hasFilter) => {
						currentHasFilter = hasFilter;
					},
					updateSessionModels,
					allModelCount: allModels.length,
					persistEnabledModels: (patterns) => this.settingsManager.setEnabledModels(patterns),
					showStatus: (message) => this.showStatus(message),
					closeSelector: () => {
						done();
						this.ui.requestRender();
					},
				}),
			);
			return { component: selector, focus: selector };
		});
	}

	private showUserMessageSelector(): void {
		const userMessages = this.session.getUserMessagesForForking();

		if (userMessages.length === 0) {
			this.showStatus("No messages to fork from");
			return;
		}

		this.showSelector((done) => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map((m) => ({ id: m.entryId, text: m.text })),
				async (entryId) => {
					const result = await performInteractiveSessionFork({
						clearTransientUi: () => this.clearTransientRuntimeUi(),
						executeFork: () => this.runtimeHost.fork(entryId),
						applyRuntimeSessionChange: () => this.handleRuntimeSessionChange(),
						renderCurrentSessionState: () => this.renderCurrentSessionState(),
						handleFatalRuntimeError: (prefix, error) => this.handleFatalRuntimeError(prefix, error),
						setEditorText: (text) => this.editor.setText(text),
						showStatus: (message) => this.showStatus(message),
						successMessage: "Branched to new session",
					});
					if (result.cancelled) {
						done();
						this.ui.requestRender();
						return;
					}
					done();
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	private showTreeSelector(initialSelectedId?: string): void {
		const tree = this.sessionManager.getTree();
		const realLeafId = this.sessionManager.getLeafId();
		const initialFilterMode = this.settingsManager.getTreeFilterMode();

		if (tree.length === 0) {
			this.showStatus("No entries in session");
			return;
		}

		this.showSelector((done) => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ui.terminal.rows,
				async (entryId) => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === realLeafId) {
						done();
						this.showStatus("Already at this point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first
					const summaryChoice = await resolveInteractiveBranchSummaryChoice({
						skipPrompt: this.settingsManager.getBranchSummarySkipPrompt(),
						showSummarySelector: () =>
							this.showExtensionSelector("Summarize branch?", [
								"No summary",
								"Summarize",
								"Summarize with custom prompt",
							]),
						showCustomInstructionsEditor: () => this.showExtensionEditor("Custom summarization instructions"),
					});
					if (summaryChoice.cancelledToTree) {
						this.showTreeSelector(entryId);
						return;
					}
					const { wantsSummary, customInstructions } = summaryChoice;

					await performInteractiveTreeNavigation({
						navigateTree: () =>
							this.session.navigateTree(entryId, {
								summarize: wantsSummary,
								customInstructions,
							}),
						enableSummaryUi: wantsSummary
							? () => {
									const originalOnEscape = this.defaultEditor.onEscape;
									this.defaultEditor.onEscape = () => {
										this.session.abortBranchSummary();
									};
									this.chatContainer.addChild(new Spacer(1));
									const summaryLoader = new Loader(
										this.ui,
										(spinner) => theme.fg("accent", spinner),
										(text) => theme.fg("muted", text),
										`Summarizing branch... (${keyText("app.interrupt")} to cancel)`,
									);
									this.statusContainer.addChild(summaryLoader);
									this.ui.requestRender();
									return () => {
										summaryLoader.stop();
										this.statusContainer.clear();
										this.defaultEditor.onEscape = originalOnEscape;
									};
								}
							: undefined,
						applySuccess: (result) =>
							applyInteractiveTreeNavigationSuccess({
								result,
								clearChat: () => this.chatContainer.clear(),
								renderInitialMessages: () => this.renderInitialMessages(),
								getEditorText: () => this.editor.getText(),
								setEditorText: (text) => this.editor.setText(text),
								showStatus: (message) => this.showStatus(message),
							}),
						showStatus: (message) => this.showStatus(message),
						showError: (message) => this.showError(message),
						onAborted: () => this.showTreeSelector(entryId),
					});
				},
				() => {
					done();
					this.ui.requestRender();
				},
				(entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
					this.ui.requestRender();
				},
				initialSelectedId,
				initialFilterMode,
			);
			return { component: selector, focus: selector };
		});
	}

	private showSessionSelector(): void {
		this.showSelector((done) => {
			const selector = new SessionSelectorComponent(
				(onProgress) =>
					SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress),
				SessionManager.listAll,
				async (sessionPath) => {
					done();
					await this.handleResumeSession(sessionPath);
				},
				() => {
					done();
					this.ui.requestRender();
				},
				() => {
					void this.shutdown();
				},
				() => this.ui.requestRender(),
				{
					renameSession: renameInteractiveSession,
					showRenameHint: true,
					keybindings: this.keybindings,
				},

				this.sessionManager.getSessionFile(),
			);
			return { component: selector, focus: selector };
		});
	}

	private async handleResumeSession(sessionPath: string): Promise<void> {
		await performInteractiveSessionResume({
			clearTransientUi: () => {
				if (this.loadingAnimation) {
					this.loadingAnimation.stop();
					this.loadingAnimation = undefined;
				}
				this.stopWorkingVerbAnimation();
				this.statusContainer.clear();
			},
			executeResume: (cwdOverride) => this.runtimeHost.switchSession(sessionPath, cwdOverride),
			promptForMissingSessionCwd: (error) => this.promptForMissingSessionCwd(error),
			applyRuntimeSessionChange: () => this.handleRuntimeSessionChange(),
			renderCurrentSessionState: () => this.renderCurrentSessionState(),
			showStatus: (message) => this.showStatus(message),
			handleFatalRuntimeError: (prefix, error) => this.handleFatalRuntimeError(prefix, error),
		});
	}

	private async showOAuthSelector(mode: "login" | "logout"): Promise<void> {
		if (mode === "logout" && !hasLoggedInOAuthProviders(this.session.modelRegistry.authStorage)) {
			this.showStatus("No OAuth providers logged in. Use /login first.");
			return;
		}

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				mode,
				this.session.modelRegistry.authStorage,
				async (providerId: string) => {
					done();

					if (mode === "login") {
						await this.showLoginDialog(providerId);
					} else {
						await performInteractiveOAuthLogout({
							authStorage: this.session.modelRegistry.authStorage,
							providerId,
							refreshModelRegistry: () => this.session.modelRegistry.refresh(),
							updateAvailableProviderCount: () => this.updateAvailableProviderCount(),
							showStatus: (message) => this.showStatus(message),
							showError: (message) => this.showError(message),
						});
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private async showLoginDialog(providerId: string): Promise<void> {
		const dialog = new LoginDialogComponent(this.ui, providerId, (_success, _message) => {
			// Completion handled below
		});

		showEditorHostComponent({
			container: this.editorContainer,
			ui: this.ui,
			component: dialog,
		});

		// Restore editor helper
		const restoreEditor = () =>
			restoreEditorHost({
				container: this.editorContainer,
				ui: this.ui,
				editor: this.editor,
			});

		await runInteractiveOAuthLogin({
			authStorage: this.session.modelRegistry.authStorage,
			providerId,
			dialog: {
				showAuth: (url, instructions) => dialog.showAuth(url, instructions),
				showManualInput: (prompt) => dialog.showManualInput(prompt),
				showWaiting: (message) => dialog.showWaiting(message),
				showPrompt: (message, placeholder) => dialog.showPrompt(message, placeholder),
				showProgress: (message) => dialog.showProgress(message),
				signal: dialog.signal,
			},
			restoreEditor,
			refreshModelRegistry: () => this.session.modelRegistry.refresh(),
			updateAvailableProviderCount: () => this.updateAvailableProviderCount(),
			showStatus: (message) => this.showStatus(message),
			showError: (message) => this.showError(message),
			authPath: getAuthPath(),
		});
	}

	// =========================================================================
	// Command handlers
	// =========================================================================

	private async handleReloadCommand(): Promise<void> {
		await performInteractiveReload({
			isStreaming: this.session.isStreaming,
			isCompacting: this.session.isCompacting,
			resetExtensionUI: () => this.resetExtensionUI(),
			ui: this.ui,
			editorContainer: this.editorContainer,
			editor: this.editor as Component,
			showWarning: (message) => this.showWarning(message),
			showError: (message) => this.showError(message),
			showStatus: (message) => this.showStatus(message),
			reload: async () => {
				await this.session.reload();
				this.keybindings.reload();
				setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
				const themeResult = applyConfiguredTheme(this.settingsManager, setTheme);
				if (!themeResult.success) {
					this.showError(
						`Failed to load theme "${themeResult.themeName}": ${themeResult.error}\nFell back to dark theme.`,
					);
				}
				this.hideThinkingBlock = applyInteractiveRuntimeSettings({
					settings: this.settingsManager,
					ui: this.ui,
					defaultEditor: this.defaultEditor,
					editor: this.editor,
				}).hideThinkingBlock;
				this.setupAutocomplete(this.fdPath);
				const runner = this.session.extensionRunner;
				if (runner) {
					this.setupExtensionShortcuts(runner);
				}
				this.rebuildChatFromMessages();
				this.showLoadedResources({
					force: false,
					showDiagnosticsWhenQuiet: true,
				});
				const modelsJsonError = this.session.modelRegistry.getError();
				if (modelsJsonError) {
					this.showError(`models.json error: ${modelsJsonError}`);
				}
			},
		});
	}

	private async handleExportCommand(text: string): Promise<void> {
		await performInteractiveSessionExport(text, {
			exportToJsonl: (outputPath) => this.session.exportToJsonl(outputPath),
			exportToHtml: (outputPath) => this.session.exportToHtml(outputPath),
			showStatus: (message) => this.showStatus(message),
			showError: (message) => this.showError(message),
		});
	}

	private async handleImportCommand(text: string): Promise<void> {
		const parts = text.split(/\s+/);
		if (parts.length < 2 || !parts[1]) {
			this.showError("Usage: /import <path.jsonl>");
			return;
		}
		const inputPath = parts[1];

		const confirmed = await this.showExtensionConfirm("Import session", `Replace current session with ${inputPath}?`);
		if (!confirmed) {
			this.showStatus("Import cancelled");
			return;
		}
		await performInteractiveRuntimeTransition({
			clearTransientUi: () => {
				if (this.loadingAnimation) {
					this.loadingAnimation.stop();
					this.loadingAnimation = undefined;
				}
				this.stopWorkingVerbAnimation();
				this.statusContainer.clear();
			},
			execute: (cwdOverride) => this.runtimeHost.importFromJsonl(inputPath, cwdOverride),
			promptForMissingSessionCwd: (error) => this.promptForMissingSessionCwd(error),
			applyRuntimeSessionChange: () => this.handleRuntimeSessionChange(),
			renderCurrentSessionState: () => this.renderCurrentSessionState(),
			showStatus: (message) => this.showStatus(message),
			handleFatalRuntimeError: (prefix, error) => this.handleFatalRuntimeError(prefix, error),
			successMessage: () => `Session imported from: ${inputPath}`,
			cancelMessage: "Import cancelled",
			fatalPrefix: "Failed to import session",
		});
	}

	private async handleShareCommand(): Promise<void> {
		await performInteractiveSessionShare({
			ui: this.ui,
			editorContainer: this.editorContainer,
			editor: this.editor as Component,
			exportToHtml: (outputPath) => this.session.exportToHtml(outputPath),
			showStatus: (message) => this.showStatus(message),
			showError: (message) => this.showError(message),
		});
	}

	private async handleCopyCommand(): Promise<void> {
		await performInteractiveCopyLastAssistantMessage({
			getLastAssistantText: () => this.session.getLastAssistantText(),
			showStatus: (message) => this.showStatus(message),
			showError: (message) => this.showError(message),
		});
	}

	private handleNameCommand(text: string): void {
		const name = text.replace(/^\/name\s*/, "").trim();
		if (!name) {
			const currentName = this.sessionManager.getSessionName();
			if (currentName) {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(theme.fg("dim", `Session name: ${currentName}`), 1, 0));
			} else {
				this.showWarning("Usage: /name <name>");
			}
			this.ui.requestRender();
			return;
		}

		this.sessionManager.appendSessionInfo(name);
		this.updateTerminalTitle();
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", `Session name set: ${name}`), 1, 0));
		this.ui.requestRender();
	}

	private async handlePlanCommand(command: Extract<InteractiveBuiltinCommand, { kind: "plan" }>): Promise<void> {
		return handlePlanCommand(
			{
				resolvePlanArtifact: (revision, defaultTarget) =>
					resolvePlanArtifactForCommandWithFallback(
						this,
						this.getPlanArtifactByRevision.bind(this),
						revision,
						defaultTarget,
					),
				getSessionActivityState: () => getOptionalReceiverSessionState(this),
				showWarning: (message) => this.showWarning(message),
				showStatus: (message) => this.showStatus(message),
				showError: (message) => this.showError(message),
				togglePlanningMode: () => this.togglePlanningMode(),
				chatContainer: this.chatContainer,
				ui: this.ui,
				formatPlanRouteSummaryLines: () => this.formatPlanRouteSummaryLines(),
				handlePlanModelRouteCommand: (mode, modelRef) => this.handlePlanModelRouteCommand(mode, modelRef),
				showPlanReviewSelector: () => this.showPlanReviewSelector(),
				showPlanInterview: (artifact) => this.showPlanInterview(artifact),
				answerClarifyingPlanArtifact: (artifact, answer) => this.answerClarifyingPlanArtifact(artifact, answer),
				showPlanArtifactCard: (cardArtifact, cardOptions) =>
					cardOptions === undefined
						? this.showPlanArtifactCard(cardArtifact)
						: this.showPlanArtifactCard(cardArtifact, cardOptions),
				getPlanArtifacts: (limit) => this.getPlanArtifacts(limit),
				acceptPlanArtifact: (planArtifact, options) =>
					options === undefined
						? this.acceptPlanArtifact(planArtifact)
						: this.acceptPlanArtifact(planArtifact, options),
				rejectPlanArtifact: (planArtifact, reason) => this.rejectPlanArtifact(planArtifact, reason),
				sessionManager: this.sessionManager,
				clearPlanSelectionForArtifact: (planArtifact) =>
					clearPlanSelectionForArtifactForReceiver(this, planArtifact),
				updatePendingMessagesDisplay: () => this.updatePendingMessagesDisplay(),
				updateModeDisplay: () => this.updateModeDisplay(),
				setExecutionMode: (mode) => this.setExecutionMode(mode),
				runPlanningPrompt: (promptBody, options) => this.runPlanningPrompt(promptBody, options),
				markPlanStepComplete: (planArtifact, stepIndex) => this.markPlanStepComplete(planArtifact, stepIndex),
				reopenPlanStep: (planArtifact, stepIndex) => this.reopenPlanStep(planArtifact, stepIndex),
				executeNextPlanStep: (revision) => this.executeNextPlanStep(revision),
				executePlanArtifact: (planArtifact, stepIndex) =>
					stepIndex === undefined
						? this.executePlanArtifact(planArtifact)
						: this.executePlanArtifact(planArtifact, stepIndex),
			},
			command,
		);
	}

	private async executeNextPlanStep(revision?: number): Promise<void> {
		return executeNextPlanStep(
			{
				resolvePlanArtifact: (rev, defaultTarget) =>
					resolvePlanArtifactForCommandWithFallback(
						this,
						this.getPlanArtifactByRevision.bind(this),
						rev,
						defaultTarget,
					),
				showWarning: (message) => this.showWarning(message),
				executePlanArtifact: (artifact, stepIndex) => this.executePlanArtifact(artifact, stepIndex),
			},
			revision,
		);
	}

	private handleSessionCommand(): void {
		const stats = this.session.getSessionStats();
		const sessionName = this.sessionManager.getSessionName();
		const latestPlan = this.getLatestPlanArtifact();

		const runtimeHealth = this.formatRuntimeHealthSummary();
		const runtimeTimeline = this.formatRuntimeHealthTimelineSummary();
		const debugArtifacts = this.formatDebugArtifactsSummary();
		const runtimeRecovery = this.formatRuntimeRecoverySummary();
		const stabilization = this.formatAutonomousStabilizationSummary();

		const workspace = this.activeAutonomousWorkspace ?? this.lastAutonomousWorkspace;
		const workspaceSummary = getInteractiveWorkspaceSummary(workspace, Boolean(this.activeAutonomousWorkspace));

		let autonomousRunSummary = "";
		if (this.lastAutonomousRunResult) {
			autonomousRunSummary += `\n\n${theme.bold("Autonomous Run")}\n`;
			autonomousRunSummary += `${theme.fg("dim", "Stop Reason:")} ${this.lastAutonomousRunResult.stopReason}\n`;
			autonomousRunSummary += `${theme.fg("dim", "Turns:")} ${this.lastAutonomousRunResult.budgetStatus.turnsUsed}\n`;
			autonomousRunSummary += `${theme.fg("dim", "Cost:")} ${this.lastAutonomousRunResult.costSummary}\n`;
			autonomousRunSummary += this.formatAutonomousControlSummary(this.lastAutonomousRunResult);
			autonomousRunSummary += this.formatAutonomousResearchSummary(this.lastAutonomousRunResult);
			autonomousRunSummary += this.formatAutonomousVisualSummary(this.lastAutonomousRunResult);
			autonomousRunSummary += this.formatAutonomousRecoverySummary(
				this.lastAutonomousRunResult,
				this.activeAutonomousWorkspace ?? this.lastAutonomousWorkspace,
			);
			autonomousRunSummary += "\n";
			autonomousRunSummary += formatAutonomousRunLedger(this.lastAutonomousRunResult.ledger);
		}

		this.chatContainer.addChild(new Spacer(1));
		renderInteractiveSessionInfo({
			chatContainer: this.chatContainer,
			ui: this.ui,
			stats,
			sessionName,
			runtimeHealth,
			runtimeTimeline,
			debugArtifacts,
			runtimeRecovery,
			stabilization,
			workspaceSummary,
			autonomousRunSummary,
		});
		if (latestPlan) {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(
					`${theme.bold("Latest Plan")}\n${theme.fg("dim", "Revision:")} ${latestPlan.revision}\n${theme.fg("dim", "Status:")} ${latestPlan.status}\n${theme.fg("dim", "Steps:")} ${latestPlan.steps.length}`,
					1,
					0,
				),
			);
		}
	}

	private handleResearchCommand(text: string): void {
		const arg = text.startsWith("/research ") ? text.slice(10).trim() : "";
		if (arg && arg !== "latest") {
			this.showWarning("Usage: /research or /research latest");
			return;
		}

		const limit = arg === "latest" ? 1 : 5;
		if (
			!renderInteractiveResearchArtifacts({
				chatContainer: this.chatContainer,
				ui: this.ui,
				sessionEntries: this.session.sessionManager.getEntries(),
				limit,
			})
		) {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(theme.fg("dim", "No research artifacts saved in this session yet."), 1, 0),
			);
			this.ui.requestRender();
		}
	}

	private formatRuntimeHealthSummary(): string {
		return buildRuntimeHealthSummary({
			xmlFallbackCount: this.xmlFallbackCount,
			degradedTurnCount: this.degradedTurnCount,
			lastXmlFallbackEvent: this.lastXmlFallbackEvent,
			lastDegradedTurnEvent: this.lastDegradedTurnEvent,
		});
	}

	private formatAutonomousResearchSummary(result: AutonomousRunResult): string {
		return buildAutonomousResearchSummary(
			result,
			getRecentResearchArtifacts(this.session.sessionManager.getEntries(), 5).length,
		);
	}

	private formatRuntimeHealthTimelineSummary(): string {
		return buildRuntimeHealthTimelineSummary(
			getRecentRuntimeHealthSnapshots(this.session.sessionManager.getEntries(), 3),
		);
	}

	private formatDebugArtifactsSummary(): string {
		return buildDebugArtifactsSummary(this.debugLogger?.getArtifacts());
	}

	private formatRuntimeRecoverySummary(): string {
		return buildRuntimeRecoverySummary({
			lastDegradedTurnEvent: this.lastDegradedTurnEvent,
			lastXmlFallbackEvent: this.lastXmlFallbackEvent,
			lastAutonomousRunResult: this.lastAutonomousRunResult,
			hasDebugArtifacts: Boolean(this.debugLogger?.getArtifacts().sessionDir),
		});
	}

	private formatAutonomousStabilizationSummary(): string {
		return buildAutonomousStabilizationSummary(this.getAutonomousStabilizationProfile());
	}

	private getAutonomousStabilizationProfile() {
		return deriveRuntimeStabilizationProfile(
			this.session.sessionManager.getEntries(),
			this.session.model ? `${this.session.model.provider}/${this.session.model.id}` : undefined,
		);
	}

	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: invoked reflectively by runPlanningPrompt via its deps.receiver probe (getOptionalReceiverMethod-style lookup)
	private getPlanningStabilizationProfile(): RuntimeStabilizationProfile {
		return {
			level: "none",
			reasons: [],
			forceBehavioralPrompt: false,
			forceNudges: false,
		};
	}

	private resolveAutonomousRunConfig(): AutonomousExecutionConfig {
		return resolveInteractiveAutonomousRunConfig(this.autonomousConfig, this.getAutonomousStabilizationProfile());
	}

	private buildAutonomousUserMessage(userMessage: string): string {
		return buildAutonomousStabilizedUserMessage(userMessage, this.getAutonomousStabilizationProfile());
	}

	private getAutonomousResumeSnapshot(userMessage: string): AutonomousRunSnapshot | undefined {
		return getInteractiveAutonomousResumeSnapshot(
			userMessage,
			getLatestAutonomousRunSnapshot(this.session.sessionManager.getEntries()),
		);
	}

	private buildInteractiveUserMessage(userMessage: string): string {
		return buildInteractiveStabilizedUserMessage(userMessage, this.getAutonomousStabilizationProfile());
	}

	private buildPlanningUserMessage(userMessage: string): string {
		return buildPlanningUserMessage(userMessage, this.getAutonomousStabilizationProfile());
	}

	private getLatestPlanSelection(): InteractivePlanSelection | undefined {
		return getLatestInteractivePlanSelection(this.sessionManager.getEntries());
	}

	private appendPlanSelection(
		updates: Partial<Pick<InteractivePlanSelection, "planning" | "accepted" | "executing">>,
	): InteractivePlanSelection {
		const selection = createInteractivePlanSelection(this.getLatestPlanSelection(), updates);
		this.sessionManager.appendCustomEntry(INTERACTIVE_PLAN_SELECTION_TYPE, selection);
		return selection;
	}

	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: invoked reflectively by clearPlanSelectionForArtifactForReceiver via getOptionalReceiverMethod(receiver, "clearPlanSelectionForArtifact")
	private clearPlanSelectionForArtifact(artifact: InteractivePlanArtifact): InteractivePlanSelection {
		const ref = createInteractivePlanArtifactRef(artifact);
		const selection = this.getLatestPlanSelection();
		return this.appendPlanSelection({
			planning: isSameInteractivePlanArtifactRef(selection?.planning, ref) ? undefined : selection?.planning,
			accepted: isSameInteractivePlanArtifactRef(selection?.accepted, ref) ? undefined : selection?.accepted,
			executing: isSameInteractivePlanArtifactRef(selection?.executing, ref) ? undefined : selection?.executing,
		});
	}

	private resolvePlanSelectionArtifact(
		ref: ReturnType<typeof createInteractivePlanArtifactRef> | undefined,
	): InteractivePlanArtifact | undefined {
		return resolveInteractivePlanArtifactRef(this.sessionManager.getEntries(), ref);
	}

	private getCurrentPlanningArtifact(): InteractivePlanArtifact | undefined {
		const selection = this.getLatestPlanSelection();
		const selected = this.resolvePlanSelectionArtifact(selection?.planning);
		if (selected) return selected;
		const latest = getLatestInteractivePlanArtifact(this.sessionManager.getEntries());
		if (latest?.status === "draft" || latest?.status === "clarifying") {
			return latest;
		}
		return undefined;
	}

	private getActiveExecutablePlanArtifact(): InteractivePlanArtifact | undefined {
		const selection = this.getLatestPlanSelection();
		return (
			this.resolvePlanSelectionArtifact(selection?.executing) ??
			this.resolvePlanSelectionArtifact(selection?.accepted) ??
			this.getPlanArtifacts().find((artifact) => artifact.status === "executing" || artifact.status === "accepted")
		);
	}

	private getLatestPlanArtifact(): InteractivePlanArtifact | undefined {
		return this.planningMode
			? this.getCurrentPlanningArtifact()
			: (this.getActiveExecutablePlanArtifact() ?? this.getCurrentPlanningArtifact());
	}

	private getPlanArtifacts(limit?: number): InteractivePlanArtifact[] {
		return getInteractivePlanArtifacts(this.sessionManager.getEntries(), limit);
	}

	private getPlanArtifactsByRevision(revision: number): InteractivePlanArtifact[] {
		return this.getPlanArtifacts().filter((artifact) => artifact.revision === revision);
	}

	private resolvePlanArtifactForCommand(
		revision: number | undefined,
		defaultTarget: "current" | "planning" | "execution" = "current",
	): { artifact?: InteractivePlanArtifact; ambiguousRevision?: number } {
		if (revision === undefined) {
			if (defaultTarget === "planning") {
				return { artifact: this.getCurrentPlanningArtifact() };
			}
			if (defaultTarget === "execution") {
				return { artifact: this.getActiveExecutablePlanArtifact() };
			}
			return {
				artifact: this.planningMode
					? this.getCurrentPlanningArtifact()
					: (this.getActiveExecutablePlanArtifact() ?? this.getCurrentPlanningArtifact()),
			};
		}
		const matches = this.getPlanArtifactsByRevision(revision);
		if (matches.length > 1) {
			return { ambiguousRevision: revision };
		}
		return { artifact: matches[0] };
	}

	private getPlanArtifactByRevision(revision: number | undefined): InteractivePlanArtifact | undefined {
		return this.resolvePlanArtifactForCommand(revision).artifact;
	}

	private formatPlanSelectorOption(artifact: InteractivePlanArtifact): string {
		return formatPlanSelectorOption(artifact);
	}

	private getPlanReviewActions(artifact: InteractivePlanArtifact): PlanWorkflowDialogOption[] {
		return getPlanReviewActions(artifact);
	}

	private async acceptPlanArtifact(
		artifact: InteractivePlanArtifact,
		options?: { compactContext?: boolean },
	): Promise<void> {
		return acceptPlanArtifact(
			{
				planningMode: this.planningMode,
				sessionManager: this.sessionManager,
				appendPlanSelection: (updates) => appendPlanSelectionForReceiver(this, updates),
				setExecutionMode: (mode) => this.setExecutionMode(mode),
				updatePendingMessagesDisplay: () => this.updatePendingMessagesDisplay(),
				updateModeDisplay: () => this.updateModeDisplay(),
				showPlanArtifactCard: (cardArtifact, cardOptions) =>
					cardOptions === undefined
						? this.showPlanArtifactCard(cardArtifact)
						: this.showPlanArtifactCard(cardArtifact, cardOptions),
				showWarning: (message) => this.showWarning(message),
				showStatus: (message) => this.showStatus(message),
				ensurePreferredModeModel: (mode) => this.ensurePreferredModeModel(mode),
				handleCompactCommand: (customInstructions) => this.handleCompactCommand(customInstructions),
				offerAcceptedPlanHandoff: (acceptedArtifact) => this.offerAcceptedPlanHandoff(acceptedArtifact),
			},
			artifact,
			options,
		);
	}

	private async offerAcceptedPlanHandoff(artifact: InteractivePlanArtifact): Promise<boolean> {
		return offerAcceptedPlanHandoff(
			{
				showPlanWorkflowDialog: (title, lines, options, dialogOptions) =>
					this.showPlanWorkflowDialog(title, lines, options, dialogOptions),
				executePlanArtifact: (planArtifact, stepIndex) =>
					stepIndex === undefined
						? this.executePlanArtifact(planArtifact)
						: this.executePlanArtifact(planArtifact, stepIndex),
			},
			artifact,
		);
	}

	private async handlePlanReviewAction(artifact: InteractivePlanArtifact, action: PlanReviewActionId): Promise<void> {
		return handlePlanReviewAction(
			{
				handlePlanCommand: (command) => this.handlePlanCommand(command),
				acceptPlanArtifact: (planArtifact, options) => this.acceptPlanArtifact(planArtifact, options),
				setExecutionMode: (mode) => this.setExecutionMode(mode),
				handleCompactCommand: (customInstructions) => this.handleCompactCommand(customInstructions),
				showStatus: (message) => this.showStatus(message),
				showWarning: (message) => this.showWarning(message),
				executePlanArtifact: (planArtifact, stepIndex) =>
					stepIndex === undefined
						? this.executePlanArtifact(planArtifact)
						: this.executePlanArtifact(planArtifact, stepIndex),
				showExtensionSelector: (title, options, opts) => this.showExtensionSelector(title, options, opts),
				getPlanStepSelectorOptions: (planArtifact, mode) => this.getPlanStepSelectorOptions(planArtifact, mode),
				markPlanStepComplete: (planArtifact, stepIndex) => this.markPlanStepComplete(planArtifact, stepIndex),
				reopenPlanStep: (planArtifact, stepIndex) => this.reopenPlanStep(planArtifact, stepIndex),
				showExtensionInput: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
				rejectPlanArtifact: (planArtifact, reason) => this.rejectPlanArtifact(planArtifact, reason),
				showExtensionEditor: (title, prefill) => this.showExtensionEditor(title, prefill),
				revisePlanArtifact: (planArtifact, feedback) => this.revisePlanArtifact(planArtifact, feedback),
				continuePlanInterview: (planArtifact, options) => this.continuePlanInterview(planArtifact, options),
				showPlanInterview: (planArtifact) => this.showPlanInterview(planArtifact),
			},
			artifact,
			action,
		);
	}

	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: invoked reflectively by tests via (InteractiveMode as any).prototype.splitPlanInterviewChoiceOptions
	private splitPlanInterviewChoiceOptions(text: string): string[] {
		return splitPlanInterviewChoiceOptions(text);
	}

	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: invoked reflectively by tests via (InteractiveMode as any).prototype.getPlanInterviewChoiceOptions
	private getPlanInterviewChoiceOptions(question: string): string[] {
		return getPlanInterviewChoiceOptions(question);
	}

	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: invoked reflectively by tests via (InteractiveMode as any).prototype.getPlanInterviewQuestionChoiceOptions
	private getPlanInterviewQuestionChoiceOptions(artifact: InteractivePlanArtifact, questionIndex: number): string[] {
		return getPlanInterviewQuestionChoiceOptions(artifact, questionIndex);
	}

	private async continuePlanInterview(
		artifact: InteractivePlanArtifact,
		options?: { skipRemaining?: boolean },
	): Promise<void> {
		return this.planInterviewFlow.continuePlanInterview(artifact, options);
	}

	private async showPlanInterview(artifact: InteractivePlanArtifact): Promise<void> {
		return this.planInterviewFlow.showPlanInterview(artifact);
	}

	private async revisePlanArtifact(artifact: InteractivePlanArtifact, feedback: string): Promise<void> {
		return revisePlanArtifact(
			{
				setExecutionMode: (mode) => this.setExecutionMode(mode),
				runPlanningPrompt: (promptBody, options) => this.runPlanningPrompt(promptBody, options),
			},
			artifact,
			feedback,
		);
	}

	private async rejectPlanArtifact(artifact: InteractivePlanArtifact, reason: string): Promise<void> {
		return rejectPlanArtifact(
			{
				sessionManager: this.sessionManager,
				clearPlanSelectionForArtifact: (planArtifact) =>
					clearPlanSelectionForArtifactForReceiver(this, planArtifact),
				updatePendingMessagesDisplay: () => this.updatePendingMessagesDisplay(),
				updateModeDisplay: () => this.updateModeDisplay(),
				showPlanArtifactCard: (cardArtifact, cardOptions) =>
					cardOptions === undefined
						? this.showPlanArtifactCard(cardArtifact)
						: this.showPlanArtifactCard(cardArtifact, cardOptions),
				showStatus: (message) => this.showStatus(message),
			},
			artifact,
			reason,
		);
	}

	private async answerClarifyingPlanArtifact(artifact: InteractivePlanArtifact, answer: string): Promise<void> {
		return answerClarifyingPlanArtifact(
			{
				setExecutionMode: (mode) => this.setExecutionMode(mode),
				runPlanningPrompt: (promptBody, options) => this.runPlanningPrompt(promptBody, options),
			},
			artifact,
			answer,
		);
	}

	private async executePlanArtifact(artifact: InteractivePlanArtifact, stepIndex?: number): Promise<void> {
		return executePlanArtifact(
			{
				sessionManager: this.sessionManager,
				getLatestPlanSelection: () => getLatestPlanSelectionForReceiver(this),
				appendPlanSelection: (updates) => appendPlanSelectionForReceiver(this, updates),
				setExecutionMode: (mode) => this.setExecutionMode(mode),
				ensurePreferredModeModel: (mode) => this.ensurePreferredModeModel(mode),
				clearPendingRuntimePromptAddendum: () => {
					this.pendingRuntimePromptAddendum = undefined;
				},
				updatePendingMessagesDisplay: () => this.updatePendingMessagesDisplay(),
				updateModeDisplay: () => this.updateModeDisplay(),
				showPlanArtifactCard: (cardArtifact, cardOptions) =>
					cardOptions === undefined
						? this.showPlanArtifactCard(cardArtifact)
						: this.showPlanArtifactCard(cardArtifact, cardOptions),
				session: this.session,
				buildInteractiveUserMessage: (userMessage) => this.buildInteractiveUserMessage(userMessage),
				persistPlanExecutionReview: (reviewArtifact, step) => this.persistPlanExecutionReview(reviewArtifact, step),
				showWarning: (message) => this.showWarning(message),
			},
			artifact,
			stepIndex,
		);
	}

	private persistPlanExecutionReview(artifact: InteractivePlanArtifact, stepIndex: number): void {
		persistPlanExecutionReview(
			{
				session: this.session,
				sessionManager: this.sessionManager,
				updatePendingMessagesDisplay: () => this.updatePendingMessagesDisplay(),
				updateModeDisplay: () => this.updateModeDisplay(),
				showPlanArtifactCard: (cardArtifact, cardOptions) =>
					cardOptions === undefined
						? this.showPlanArtifactCard(cardArtifact)
						: this.showPlanArtifactCard(cardArtifact, cardOptions),
				showStatus: (message) => this.showStatus(message),
				showWarning: (message) => this.showWarning(message),
			},
			artifact,
			stepIndex,
		);
	}

	private getPlanStepSelectorOptions(
		artifact: InteractivePlanArtifact,
		mode: "all" | "remaining" | "completed",
	): string[] {
		return getPlanStepSelectorOptions(artifact, mode);
	}

	private async markPlanStepComplete(artifact: InteractivePlanArtifact, stepIndex: number): Promise<void> {
		return markPlanStepComplete(this.planStepMutationDeps(), artifact, stepIndex);
	}

	private async reopenPlanStep(artifact: InteractivePlanArtifact, stepIndex: number): Promise<void> {
		return reopenPlanStep(this.planStepMutationDeps(), artifact, stepIndex);
	}

	private planStepMutationDeps(): PlanStepMutationDeps {
		return {
			sessionManager: this.sessionManager,
			appendPlanSelection: (updates) => appendPlanSelectionForReceiver(this, updates),
			updatePendingMessagesDisplay: () => this.updatePendingMessagesDisplay(),
			updateModeDisplay: () => this.updateModeDisplay(),
			showPlanArtifactCard: (cardArtifact, cardOptions) =>
				cardOptions === undefined
					? this.showPlanArtifactCard(cardArtifact)
					: this.showPlanArtifactCard(cardArtifact, cardOptions),
			showStatus: (message) => this.showStatus(message),
			showWarning: (message) => this.showWarning(message),
		};
	}

	private showPlanArtifactCard(artifact: InteractivePlanArtifact, options?: { expanded?: boolean }): void {
		showPlanArtifactCard({ chatContainer: this.chatContainer, ui: this.ui }, artifact, options);
	}

	private async showPlanReviewSelector(): Promise<void> {
		return showPlanReviewSelector({
			getPlanArtifacts: (limit) => this.getPlanArtifacts(limit),
			showWarning: (message) => this.showWarning(message),
			formatPlanSelectorOption: (artifact) => this.formatPlanSelectorOption(artifact),
			showExtensionSelector: (title, options, opts) => this.showExtensionSelector(title, options, opts),
			showPlanWorkflowDialog: (title, lines, options, dialogOptions) =>
				this.showPlanWorkflowDialog(title, lines, options, dialogOptions),
			getPlanReviewActions: (artifact) => this.getPlanReviewActions(artifact),
			handlePlanReviewAction: (artifact, action) => this.handlePlanReviewAction(artifact, action),
		});
	}

	private async showImmediatePlanActionSelector(artifact: InteractivePlanArtifact): Promise<void> {
		return showImmediatePlanActionSelector(
			{
				showPlanInterview: (planArtifact) => this.showPlanInterview(planArtifact),
				showPlanWorkflowDialog: (title, lines, options, dialogOptions) =>
					this.showPlanWorkflowDialog(title, lines, options, dialogOptions),
				getPlanReviewActions: (planArtifact) => this.getPlanReviewActions(planArtifact),
				handlePlanReviewAction: (planArtifact, action) => this.handlePlanReviewAction(planArtifact, action),
			},
			artifact,
		);
	}

	private persistLatestPlanArtifact(options: {
		goal: string;
		previousArtifact?: InteractivePlanArtifact;
		feedback?: string;
	}): InteractivePlanArtifact | undefined {
		return persistLatestPlanArtifact(
			{
				getLastSubmitPlanPayload: () => this.lastSubmitPlanPayload,
				setLastSubmitPlanPayload: (value) => {
					this.lastSubmitPlanPayload = value;
				},
				session: this.session,
				sessionManager: this.sessionManager,
				appendPlanSelection: (updates) => appendPlanSelectionForReceiver(this, updates),
				showPlanArtifactCard: (cardArtifact, cardOptions) =>
					cardOptions === undefined
						? this.showPlanArtifactCard(cardArtifact)
						: this.showPlanArtifactCard(cardArtifact, cardOptions),
			},
			options,
		);
	}

	private async runPlanningPrompt(promptBody: string, options?: RunPlanningPromptOptions): Promise<void> {
		return runPlanningPrompt(
			{
				receiver: this,
				ensurePreferredModeModel: (mode) => this.ensurePreferredModeModel(mode),
				clearPendingRuntimePromptAddendum: () => {
					this.pendingRuntimePromptAddendum = undefined;
				},
				setLastSubmitPlanPayload: (value) => {
					this.lastSubmitPlanPayload = value;
				},
				setPlanningReadOnlyToolsAllowed: (allowed) => {
					this.planningReadOnlyToolsAllowed = allowed;
				},
				shouldAllowPlanningInspection: (body, inspectionOptions) =>
					this.shouldAllowPlanningInspection(body, inspectionOptions),
				applySafetyPolicy: () => this.applySafetyPolicy(),
				setSuppressPlanningAssistantTranscript: (value) => {
					this.suppressPlanningAssistantTranscript = value;
				},
				session: this.session,
				buildPlanningUserMessage: (userMessage) => this.buildPlanningUserMessage(userMessage),
				persistLatestPlanArtifact: (persistOptions) => this.persistLatestPlanArtifact(persistOptions),
				updatePendingMessagesDisplay: () => this.updatePendingMessagesDisplay(),
				updateModeDisplay: () => this.updateModeDisplay(),
				showStatus: (message) => this.showStatus(message),
				showImmediatePlanActionSelector: (artifact) => this.showImmediatePlanActionSelector(artifact),
				appendPlanSelection: (updates) => appendPlanSelectionForReceiver(this, updates),
			},
			promptBody,
			options,
		);
	}

	private persistRuntimeHealthSnapshot(): void {
		appendRuntimeHealthSnapshotIfChanged(
			this.session.sessionManager,
			createRuntimeHealthSnapshotFromState({
				modelId: this.session.model?.id,
				xmlFallbackCount: this.xmlFallbackCount,
				degradedTurnCount: this.degradedTurnCount,
				lastXmlFallbackEvent: this.lastXmlFallbackEvent,
				lastDegradedTurnEvent: this.lastDegradedTurnEvent,
			}),
		);
		this.updateModeDisplay();
	}

	private formatRuntimeHealthIssue(event: XmlFallbackEvent | DegradedTurnEvent): string {
		return buildRuntimeHealthIssue(event);
	}

	private formatAutonomousControlSummary(result: AutonomousRunResult): string {
		return buildAutonomousControlSummary(result);
	}

	private formatAutonomousVisualSummary(result: AutonomousRunResult): string {
		return buildAutonomousVisualSummary(result);
	}

	private getAutonomousRecoveryActions(
		result: AutonomousRunResult,
		workspace: PreparedAutonomousWorkspace | ActivatedAutonomousWorkspace | undefined,
	): string[] {
		return buildAutonomousRecoveryActions(result, workspace);
	}

	private formatAutonomousRecoverySummary(
		result: AutonomousRunResult,
		workspace: PreparedAutonomousWorkspace | ActivatedAutonomousWorkspace | undefined,
	): string {
		return buildAutonomousRecoverySummary(result, workspace);
	}

	private getAutonomousControlStateFromSnapshot(
		snapshot: Pick<AutonomousRunSnapshot, "checkpointState" | "ledger" | "phase" | "stopReason">,
	): string {
		return deriveAutonomousControlStateFromSnapshot(snapshot);
	}

	private formatAutonomousCheckpointStatus(snapshot: AutonomousRunSnapshot): string {
		return buildAutonomousCheckpointStatus(snapshot);
	}

	private formatXmlFallbackWarning(event: XmlFallbackEvent): string | undefined {
		return buildXmlFallbackWarning(event);
	}

	private formatDegradedTurnWarning(event: DegradedTurnEvent): string | undefined {
		return buildDegradedTurnWarning(event);
	}

	private formatRequestFailureWarning(message: { provider?: string; errorMessage?: string }): string | undefined {
		return buildRequestFailureWarning(message);
	}

	private handleAutonomousCheckpoint(snapshot: AutonomousRunSnapshot): void {
		const status = this.formatAutonomousCheckpointStatus(snapshot);
		if (status === this.lastAutonomousLiveStatus) return;
		this.lastAutonomousLiveStatus = status;

		if (this.loadingAnimation) {
			this.stopWorkingVerbAnimation?.();
			this.loadingAnimation.setMessage(status);
			this.ui.requestRender();
		} else {
			this.stopWorkingVerbAnimation?.();
			this.pendingWorkingMessage = status;
		}

		const controlState = this.getAutonomousControlStateFromSnapshot(snapshot);
		const shouldAnnounce =
			snapshot.phase === "final" ||
			controlState === "stabilizing degraded turn" ||
			controlState === "researching sources" ||
			controlState === "synthesizing evidence" ||
			controlState === "resuming verification" ||
			controlState === "resuming repair" ||
			controlState === "visual blocker" ||
			controlState === "visual recapture" ||
			controlState === "recovering blocker" ||
			controlState === "replanned" ||
			controlState === "scope narrowed" ||
			controlState === "blocked stop";
		if (shouldAnnounce) {
			this.showStatus(status);
		}
		if (snapshot.phase === "final" && controlState === "blocked stop") {
			const actions = this.getAutonomousRecoveryActions(
				{
					iterations: snapshot.iterations,
					stopReason: snapshot.stopReason,
					budgetStatus: snapshot.budgetStatus,
					costSummary: snapshot.costSummary,
					checkpointState: snapshot.checkpointState,
					ledger: snapshot.ledger,
				},
				this.activeAutonomousWorkspace ?? this.lastAutonomousWorkspace,
			);
			if (actions.length > 0) {
				this.showStatus(`Recovery: ${actions.slice(0, 3).join(" | ")}`);
			}
		}
	}

	private handleWorkspaceCommand(text: string): void {
		const result = executeInteractiveWorkspaceCommand({
			text,
			activeWorkspace: this.activeAutonomousWorkspace,
			lastWorkspace: this.lastAutonomousWorkspace,
		});
		if (result.warning) {
			this.showWarning(result.warning);
			return;
		}
		if ("nextLastWorkspace" in result) {
			this.lastAutonomousWorkspace = result.nextLastWorkspace;
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(result.dim ? theme.fg("dim", result.output ?? "") : (result.output ?? ""), 1, 0),
		);
		this.ui.requestRender();
	}

	private handleChangelogCommand(): void {
		renderInteractiveChangelog({
			chatContainer: this.chatContainer,
			ui: this.ui,
			getMarkdownThemeWithSettings: () => this.getMarkdownThemeWithSettings(),
			entries: parseChangelog(getChangelogPath()),
		});
	}

	private handleHotkeysCommand(): void {
		const extensionRunner = this.session.extensionRunner;
		const extensionShortcuts = extensionRunner
			? Array.from(extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig()), ([key, shortcut]) => ({
					key,
					description: shortcut.description ?? shortcut.extensionPath,
				}))
			: [];
		renderInteractiveHotkeys({
			chatContainer: this.chatContainer,
			ui: this.ui,
			getMarkdownThemeWithSettings: () => this.getMarkdownThemeWithSettings(),
			platform: process.platform,
			extensionShortcuts,
		});
	}

	private async handleClearCommand(): Promise<void> {
		await performInteractiveRuntimeReplacement({
			clearTransientUi: () => this.clearTransientRuntimeUi(),
			execute: () => this.runtimeHost.newSession(),
			applyRuntimeSessionChange: () => this.handleRuntimeSessionChange(),
			renderCurrentSessionState: () => this.renderCurrentSessionState(),
			handleFatalRuntimeError: (prefix, error) => this.handleFatalRuntimeError(prefix, error),
			fatalPrefix: "Failed to create session",
			afterApplied: async () => {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(`${theme.fg("accent", "✓ New session started")}`, 1, 1));
				this.ui.requestRender();
			},
		});
	}

	private getTodoSnapshot(): TodoListSnapshot | null {
		if (this.todoSnapshot === undefined) {
			this.todoSnapshot = readLatestTodoSnapshot(this.sessionManager.getEntries());
		}
		return this.todoSnapshot;
	}

	private applyTodoToolResult(result: unknown): void {
		const details = asRecord(asRecord(result)?.details);
		if (!details) return;
		if (details.cleared === true) {
			this.todoSnapshot = clearTodoList();
		} else if (Array.isArray(details.todos)) {
			this.todoSnapshot = replaceTodoList(this.getTodoSnapshot(), details.todos as TodoItem[]);
		} else {
			// Query call — no state change
			return;
		}
		this.toolCallsSinceTodoUpdate = 0;
		appendTodoSnapshot(this.sessionManager, this.todoSnapshot);
	}

	/**
	 * Keep the current todo list in the model's context every turn while open
	 * items exist. Content is stable between todo writes, so prompt-prefix
	 * caching is unaffected; it also survives compaction without special casing.
	 */
	private buildTodoPromptAddendum(): string | undefined {
		const snapshot = this.getTodoSnapshot();
		if (!snapshot) return undefined;
		if (!snapshot.items.some((item) => item.status !== "completed")) return undefined;
		const lines = snapshot.items.slice(0, 20).map((item) => `- [${item.status}] ${item.title}`);
		return `Current todo list (keep it updated with the todo tool as you make progress):\n${lines.join("\n")}`;
	}

	private handleTodoCommand(): void {
		const snapshot = this.getTodoSnapshot();
		if (!snapshot || snapshot.items.length === 0) {
			this.showStatus("No todos yet. The model tracks multi-step work with the todo tool.");
			return;
		}
		const summary = summarizeTodos(snapshot);
		const lines = [
			`todos · ${summary.completed}/${summary.total} done`,
			...snapshot.items.map((item) => {
				if (item.status === "completed") return theme.fg("success", `✓ ${item.title}`);
				if (item.status === "in_progress") return theme.fg("accent", `◐ ${item.title}`);
				return theme.fg("muted", `○ ${item.title}`);
			}),
		];
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(lines.join("\n"), 1, 1));
		this.ui.requestRender();
	}

	private handleDebugCommand(): void {
		const width = this.ui.terminal.columns;
		const height = this.ui.terminal.rows;
		const allLines = this.ui.render(width);
		const artifacts = this.debugLogger?.getArtifacts();
		const modelId = this.session.model ? `${this.session.model.provider}/${this.session.model.id}` : "none";
		const stabilization = this.getAutonomousStabilizationProfile();
		const workspace = this.activeAutonomousWorkspace ?? this.lastAutonomousWorkspace;

		const debugLogPath = getDebugLogPath();
		writeInteractiveDebugLog({
			width,
			height,
			renderedLines: allLines,
			messages: this.session.messages,
			modelId,
			mode: this.getExecutionMode(),
			stabilization,
			xmlFallbackCount: this.xmlFallbackCount,
			degradedTurnCount: this.degradedTurnCount,
			lastXmlFallbackEvent: this.lastXmlFallbackEvent,
			lastDegradedTurnEvent: this.lastDegradedTurnEvent,
			formatRuntimeHealthIssue: (event) => this.formatRuntimeHealthIssue(event),
			workspace,
			artifacts,
			debugLogPath,
		});

		this.chatContainer.addChild(new Spacer(1));
		renderInteractiveDebugLogStatus({
			chatContainer: this.chatContainer,
			ui: this.ui,
			debugLogPath,
			artifacts,
		});
	}

	private handleArminSaysHi(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new ArminComponent(this.ui));
		this.ui.requestRender();
	}

	private handleDaxnuts(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DaxnutsComponent(this.ui));
		this.ui.requestRender();
	}

	private checkDaxnutsEasterEgg(model: { provider: string; id: string }): void {
		if (model.provider === "opencode" && model.id.toLowerCase().includes("kimi-k2.5")) {
			this.handleDaxnuts();
		}
	}

	private async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const extensionRunner = this.session.extensionRunner;

		// Emit user_bash event to let extensions intercept
		const eventResult = extensionRunner
			? await extensionRunner.emitUserBash({
					type: "user_bash",
					command,
					excludeFromContext,
					cwd: this.sessionManager.getCwd(),
				})
			: undefined;

		// If extension returned a full result, use it directly
		if (eventResult?.result) {
			const result = eventResult.result;

			// Create UI component for display
			this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
			if (this.session.isStreaming) {
				this.pendingMessagesContainer.addChild(this.bashComponent);
				this.pendingBashComponents.push(this.bashComponent);
			} else {
				this.chatContainer.addChild(this.bashComponent);
			}

			// Show output and complete
			if (result.output) {
				this.bashComponent.appendOutput(result.output);
			}
			this.bashComponent.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
			);

			// Record the result in session
			this.session.recordBashResult(command, result, { excludeFromContext });
			this.bashComponent = undefined;
			this.ui.requestRender();
			return;
		}

		// Normal execution path (possibly with custom operations)
		const isDeferred = this.session.isStreaming;
		this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);

		if (isDeferred) {
			// Show in pending area when agent is streaming
			this.pendingMessagesContainer.addChild(this.bashComponent);
			this.pendingBashComponents.push(this.bashComponent);
		} else {
			// Show in chat immediately when agent is idle
			this.chatContainer.addChild(this.bashComponent);
		}
		this.ui.requestRender();

		try {
			const result = await this.session.executeBash(
				command,
				(chunk) => {
					if (this.bashComponent) {
						this.bashComponent.appendOutput(chunk);
						this.ui.requestRender();
					}
				},
				{ excludeFromContext, operations: eventResult?.operations },
			);

			if (this.bashComponent) {
				this.bashComponent.setComplete(
					result.exitCode,
					result.cancelled,
					result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
					result.fullOutputPath,
				);
			}
		} catch (error) {
			if (this.bashComponent) {
				this.bashComponent.setComplete(undefined, false);
			}
			this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.bashComponent = undefined;
		this.ui.requestRender();
	}

	private async handleCompactCommand(customInstructions?: string): Promise<void> {
		const entries = this.sessionManager.getEntries();
		const messageCount = entries.filter((e) => e.type === "message").length;

		if (messageCount < 2) {
			this.showWarning("Nothing to compact (no messages yet)");
			return;
		}

		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.stopWorkingVerbAnimation();
		this.statusContainer.clear();

		try {
			await this.session.compact(customInstructions);
		} catch {
			// Ignore, will be emitted as an event
		}
	}

	private showContextDialog(): void {
		this.showSelector((done) => {
			const dialog = new ContextInputDialog(this.ui, (raw) => {
				done();
				const action = resolveInteractiveContextWindowInput(raw);
				if (action.type === "clear") return;
				if (action.type === "invalid") {
					this.showWarning(action.message);
					return;
				}
				this.session.setCustomContextWindow(action.value);
			});
			dialog.show();
			return { component: dialog, focus: dialog };
		});
	}

	/**
	 * Extract file path from tool execution result for nudge tracking.
	 */
	private consumeRuntimePromptAddendum(existing?: string): string | undefined {
		const pending = this.pendingRuntimePromptAddendum;
		this.pendingRuntimePromptAddendum = undefined;
		if (!pending) return existing;
		return existing ? `${existing}\n\n${pending}` : pending;
	}

	private async promptWithRuntimeSteering(
		text: string,
		options?: Parameters<AgentSession["prompt"]>[1],
	): Promise<void> {
		const addenda = [
			isPromptSteeringEnabled() ? buildPromptIntentAddendum(text) : undefined,
			this.consumeRuntimePromptAddendum(options?.systemPromptAddendum),
			this.buildTodoPromptAddendum(),
		].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
		const systemPromptAddendum = addenda.length > 0 ? addenda.join("\n\n") : undefined;
		await this.session.prompt(text, {
			...options,
			systemPromptAddendum,
		});
	}

	/**
	 * Evaluate nudge conditions and update footer warning.
	 */
	private evaluateAndShowNudgeWarnings(): void {
		// Increment turn index
		this.nudgeTurnIndex++;

		// Build context for nudge evaluation
		const context = {
			turnIndex: this.nudgeTurnIndex,
			toolCallHistory: this.nudgeToolCallHistory,
			fileAccessHistory: this.nudgeFileAccessHistory,
			lastOutputTokens: this.lastNudgeOutputTokens,
			todoStale: isTodoListStale(this.getTodoSnapshot(), this.toolCallsSinceTodoUpdate),
			visualToolsActive: this.session.getActiveToolNames().includes("verify_ui"),
		};

		// Evaluate nudges
		const warnings = evaluateInteractiveNudges(context);
		const dedupedWarnings = deduplicateWarnings(warnings, this.nudgeShownWarnings, this.nudgeTurnIndex);

		if (dedupedWarnings.length > 0) {
			// Show the first/most important warning
			const warning = dedupedWarnings[0];
			this.footer.setWarning(warning.message);
			// Track that we've shown this warning
			this.nudgeShownWarnings.set(warning.type, this.nudgeTurnIndex);
		} else {
			// Clear warning if no issues
			this.footer.setWarning(null);
		}

		// Reset histories for next turn (keep last 50 entries to avoid unbounded growth)
		const maxHistoryLength = 50;
		if (this.nudgeToolCallHistory.length > maxHistoryLength) {
			this.nudgeToolCallHistory = this.nudgeToolCallHistory.slice(-maxHistoryLength);
		}
		if (this.nudgeFileAccessHistory.length > maxHistoryLength) {
			this.nudgeFileAccessHistory = this.nudgeFileAccessHistory.slice(-maxHistoryLength);
		}
	}

	// ── Autonomous Mode Implementation ─────────────────────────────────

	/**
	 * Runs the autonomous loop: sends the user's prompt, then keeps calling
	 * session.prompt() with a continuation message until one of three exit
	 * conditions triggers:
	 *
	 * 1. Budget exceeded (cost, tokens, or turns) — hard stop from AutonHook
	 * 2. Nudge engine says stop (stuck detection, diminishing output) — the
	 *    nudge cooldown + escalation logic from core/auton/nudges/nudge-eval.ts
	 * 3. Looks complete (no tool calls in last turn + assistant signaled stop) —
	 *    the LLM has nothing more to do, so we exit gracefully
	 *
	 * The 200-iteration cap is an emergency brake — the loop should exit via
	 * one of the three conditions first.
	 *
	 * The actual execution loop now lives in core/auton/runner.ts so the TUI
	 * is only responsible for collecting input and forwarding UI callbacks.
	 */
	private async runAutonomousLoop(
		userMessage: string,
		initialImages: import("@ag1/ai").ImageContent[] | undefined,
	): Promise<void> {
		const originalCwd = this.sessionManager.getCwd();
		const scopeGuardReason = getAutonomousScopeGuardReason(originalCwd);
		if (scopeGuardReason) {
			this.showWarning(scopeGuardReason);
			return;
		}
		let isolatedWorkspace: ActivatedAutonomousWorkspace | undefined;
		const resumeSnapshot = this.getAutonomousResumeSnapshot(userMessage);

		try {
			this.lastAutonomousLiveStatus = undefined;
			const resolvedAutonomousConfig = this.resolveAutonomousRunConfig();
			const stabilizationProfile = this.getAutonomousStabilizationProfile();
			const autonomousUserMessage = this.buildAutonomousUserMessage(userMessage);
			if (stabilizationProfile.level !== "none") {
				this.showStatus(
					`Applying ${stabilizationProfile.level} autonomous stabilization: ${
						stabilizationProfile.reasons.join(" | ") || "recent runtime degradation"
					}`,
				);
			}
			if (resumeSnapshot) {
				this.showStatus(
					`Resuming autonomous run from ${resumeSnapshot.savedAt}: ${
						resumeSnapshot.ledger.resume?.resumeInstruction ??
						resumeSnapshot.ledger.taskJournal.plannedNextStep ??
						resumeSnapshot.ledger.goal
					}`,
				);
			}
			this.showStatus("Preparing isolated autonomous workspace...");
			isolatedWorkspace = await activateAutonomousWorkspace(this.runtimeHost, {
				agentDir: getAgentDir(),
			});
			this.activeAutonomousWorkspace = isolatedWorkspace;
			this.lastAutonomousWorkspace = isolatedWorkspace;
			await this.handleRuntimeSessionChange();
			this.renderCurrentSessionState();
			this.showStatus(`Autonomous workspace ready (${isolatedWorkspace.strategy}): ${isolatedWorkspace.activeCwd}`);

			this.lastAutonomousRunResult = await runAutonomousSession({
				runtimeHost: this.runtimeHost,
				userMessage: autonomousUserMessage,
				initialImages,
				config: resolvedAutonomousConfig,
				resumeSnapshot,
				projectRoot: this.resolveProjectRoot(),
				getToolCallHistory: () => this.nudgeToolCallHistory,
				getFileAccessHistory: () => this.nudgeFileAccessHistory,
				onStatus: (status) => this.showStatus(status),
				onCheckpoint: (snapshot) => this.handleAutonomousCheckpoint(snapshot),
				onError: (message) => this.showError(message),
			});
		} finally {
			this.lastAutonomousLiveStatus = undefined;
			if (isolatedWorkspace) {
				this.activeAutonomousWorkspace = undefined;
				await isolatedWorkspace.restore();
				await this.handleRuntimeSessionChange();
				this.renderCurrentSessionState();
				this.showStatus(
					`Returned to ${originalCwd}. Autonomous workspace preserved at ${isolatedWorkspace.workspaceRoot}`,
				);
			}
		}
	}

	/**
	 * Updates the mode display in the UI when switching execution posture.
	 */
	private updateModeDisplay(): void {
		const line = this.getPersistentModeLine();
		this.modeStrip.setLines(line ? [line] : []);
		this.ui.requestRender();
	}

	private getBuiltInGreeterContent(): Ag1GreeterOptions {
		const model = this.session.model;
		return {
			version: GREETER_DISPLAY_VERSION,
			cwd: this.sessionManager.getCwd(),
			modeLine: "interactive · planning · autonomous",
			providerLabel: model?.provider ?? "local",
			modelLabel: model?.id ?? "model pending",
		};
	}

	private getPersistentModeLine(): string {
		return formatPersistentModeLine({
			autonomousMode: this.autonomousMode,
			planningMode: this.planningMode,
			latestPlanArtifact: this.getLatestPlanArtifact?.(),
			lastAutonomousWorkspace: this.lastAutonomousWorkspace,
			profile: this.getAutonomousStabilizationProfile(),
			currentCwd: this.sessionManager?.getCwd?.() ?? process.cwd(),
			lastAutonomousLiveStatus: this.lastAutonomousLiveStatus,
		});
	}

	stop(): void {
		// Dispose debug logger
		if (this.debugLogger) {
			this.debugLogger.dispose();
			this.debugLogger = undefined;
		}
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.stopWorkingVerbAnimation();
		this.clearExtensionTerminalInputListeners();
		this.footer.dispose();
		this.footerDataProvider.dispose();
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}

	/**
	 * Resolve the workspace root used for debug artifacts.
	 * This should follow the user's active/source project, not the coding-agent repo itself.
	 */
	private resolveProjectRoot(): string {
		if (this.activeAutonomousWorkspace?.sourceCwd) {
			return this.activeAutonomousWorkspace.sourceCwd;
		}
		if (this.lastAutonomousWorkspace?.sourceCwd) {
			return this.lastAutonomousWorkspace.sourceCwd;
		}
		return this.sessionManager.getCwd();
	}
}
