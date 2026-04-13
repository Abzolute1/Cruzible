/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, Model } from "@mariozechner/pi-ai";
import type {
	AutocompleteItem,
	EditorComponent,
	EditorTheme,
	Keybinding,
	KeyId,
	MarkdownTheme,
	OverlayHandle,
	OverlayOptions,
	SlashCommand,
} from "@mariozechner/pi-tui";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	fuzzyFilter,
	Loader,
	Markdown,
	matchesKey,
	ProcessTerminal,
	Spacer,
	setKeybindings,
	Text,
	TruncatedText,
	TUI,
} from "@mariozechner/pi-tui";
import { spawn, spawnSync } from "child_process";
import { APP_NAME, getAgentDir, getAuthPath, getDebugLogPath, getShareViewerUrl, VERSION } from "../../config.js";
import { type AgentSession, type AgentSessionEvent, parseSkillBlock } from "../../core/agent-session.js";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import {
	activateAutonomousWorkspace,
	diffAutonomousWorkspace,
	promoteAutonomousWorkspace,
	type ActivatedAutonomousWorkspace,
	type PreparedAutonomousWorkspace,
} from "../../core/auton/workspace.js";
import {
	formatAutonomousRunLedger,
	getLatestAutonomousRunSnapshot,
	type AutonomousRunSnapshot,
} from "../../core/auton/ledger.js";
import type { AutonomousRunConfig, AutonomousRunResult } from "../../core/auton/runner.js";
import { runAutonomousSession } from "../../core/auton/runner.js";
import type {
	ExtensionContext,
	ExtensionRunner,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
} from "../../core/extensions/index.js";
import { FooterDataProvider, type ReadonlyFooterDataProvider } from "../../core/footer-data-provider.js";
import { type AppKeybinding, KeybindingsManager } from "../../core/keybindings.js";
import { createCompactionSummaryMessage } from "../../core/messages.js";
import { findExactModelReferenceMatch, resolveModelScope } from "../../core/model-resolver.js";
import { deduplicateWarnings, evaluateInteractiveNudges } from "../../core/nudge-warnings.js";
import { DefaultPackageManager } from "../../core/package-manager.js";
import type { ResourceDiagnostic } from "../../core/resource-loader.js";
import { getRecentResearchArtifacts } from "../../core/research-artifacts.js";
import {
	appendRuntimeHealthSnapshotIfChanged,
	createRuntimeHealthSnapshotFromState,
	deriveRuntimeStabilizationProfile,
	getRecentRuntimeHealthSnapshots,
} from "../../core/runtime-health.js";
import type { ToolApprovalRequest, ToolSafetyPolicy } from "../../core/safety-policy.js";
import { formatMissingSessionCwdPrompt, MissingSessionCwdError } from "../../core/session-cwd.js";
import { SessionDebugLogger } from "../../core/session-debug-logger.js";
import { type SessionContext, SessionManager } from "../../core/session-manager.js";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.js";
import type { SourceInfo } from "../../core/source-info.js";
import type { TruncationResult } from "../../core/tools/truncate.js";
import { getChangelogPath, getNewEntries, parseChangelog } from "../../utils/changelog.js";
import { copyToClipboard } from "../../utils/clipboard.js";
import { extensionForImageMimeType, readClipboardImage } from "../../utils/clipboard-image.js";
import { parseGitUrl } from "../../utils/git.js";
import { ensureTool } from "../../utils/tools-manager.js";
import { ArminComponent } from "./components/armin.js";
import { AssistantMessageComponent } from "./components/assistant-message.js";
import { BashExecutionComponent } from "./components/bash-execution.js";
import { BorderedLoader } from "./components/bordered-loader.js";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.js";
import { CenteredBannerComponent } from "./components/centered-banner.js";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.js";
import { ContextInputDialog } from "./components/context-input-dialog.js";
import { CustomEditor } from "./components/custom-editor.js";
import { CustomMessageComponent } from "./components/custom-message.js";
import { DaxnutsComponent } from "./components/daxnuts.js";
import { DynamicBorder } from "./components/dynamic-border.js";
import { EarendilAnnouncementComponent } from "./components/earendil-announcement.js";
import { ExtensionEditorComponent } from "./components/extension-editor.js";
import { ExtensionInputComponent } from "./components/extension-input.js";
import { ExtensionSelectorComponent } from "./components/extension-selector.js";
import { FooterComponent } from "./components/footer.js";
import { keyHint, keyText, rawKeyHint } from "./components/keybinding-hints.js";
import { LoginDialogComponent } from "./components/login-dialog.js";
import { ModelSelectorComponent } from "./components/model-selector.js";
import { OAuthSelectorComponent } from "./components/oauth-selector.js";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.js";
import { SessionSelectorComponent } from "./components/session-selector.js";
import { SettingsSelectorComponent } from "./components/settings-selector.js";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.js";
import { ToolExecutionComponent } from "./components/tool-execution.js";
import { TreeSelectorComponent } from "./components/tree-selector.js";
import { UserMessageComponent } from "./components/user-message.js";
import { UserMessageSelectorComponent } from "./components/user-message-selector.js";
import {
	formatPersistentModeLine,
	getAutonomousScopeGuardReason,
	summarizeAutonomousLiveStatus,
} from "./interactive-autonomous-ui.js";
import { restoreInteractiveRuntimeState } from "./interactive-runtime-state.js";
import { applyConfiguredTheme, applyInteractiveRuntimeSettings } from "./interactive-runtime-settings.js";
import {
	performInteractiveRuntimeReplacement,
	performInteractiveRuntimeTransition,
} from "./interactive-runtime-transitions.js";
import { restoreEditorHost, showEditorHostComponent } from "./interactive-editor-host.js";
import { handleInteractiveEditorSubmitAfterBuiltin } from "./interactive-editor-submit.js";
import {
	clearInteractiveQueuedMessages,
	combineQueuedMessagesForEditor,
	flushInteractiveCompactionQueue,
	getInteractiveQueuedMessages,
	handleInteractiveFollowUpSubmit,
	type CompactionQueuedMessage,
} from "./interactive-queued-messages.js";
import {
	hasLoggedInOAuthProviders,
	performInteractiveOAuthLogout,
	runInteractiveOAuthLogin,
} from "./interactive-auth-flow.js";
import {
	formatAutonomousCheckpointStatus as buildAutonomousCheckpointStatus,
	formatAutonomousControlSummary as buildAutonomousControlSummary,
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
	formatVisualActionRecipeSummary as buildVisualActionRecipeSummary,
	formatXmlFallbackWarning as buildXmlFallbackWarning,
	getAutonomousControlStateFromSnapshot as deriveAutonomousControlStateFromSnapshot,
	getAutonomousEvidenceReadyKind,
	getAutonomousRecoveryActions as buildAutonomousRecoveryActions,
} from "./interactive-session-formatters.js";
import {
	formatAutonomousWorkspaceSummary,
	formatResearchArtifactsSummary,
	formatSessionInfo,
	formatWorkspaceCommandSummary,
	formatWorkspaceDiffSummary,
	formatWorkspaceDiscardSummary,
	formatWorkspacePromotionSummary,
} from "./interactive-command-presenters.js";
import { dispatchInteractiveBuiltinCommand } from "./interactive-command-actions.js";
import { parseInteractiveBuiltinCommand } from "./interactive-command-parser.js";
import {
	applyInteractiveScopedModelSelection,
	createInteractiveScopedModelsCallbacks,
	deriveInteractiveScopedModelSelection,
} from "./interactive-model-scope.js";
import {
	resolveInteractiveContextWindowInput,
} from "./interactive-context-window.js";
import {
	performInteractiveSessionFork,
	performInteractiveSessionResume,
} from "./interactive-session-actions.js";
import {
	applyInteractiveTreeNavigationSuccess,
	performInteractiveTreeNavigation,
} from "./interactive-tree-actions.js";
import {
	buildInteractiveSettingsConfig,
	createInteractiveSettingsCallbacks,
} from "./interactive-settings-selector.js";
import { buildInteractiveDebugReport } from "./interactive-debug-report.js";
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
import { resolveInteractiveBranchSummaryChoice } from "./interactive-tree-navigation.js";

/** Interface for components that can be expanded/collapsed */
interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

type XmlFallbackEvent = Extract<AgentSessionEvent, { type: "xml_tool_call" }>;
type DegradedTurnEvent = Extract<AgentSessionEvent, { type: "degraded_turn" }>;

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
	private pendingWorkingMessage: string | undefined = undefined;
	private readonly defaultWorkingMessage = "Working...";
	private readonly defaultHiddenThinkingLabel = "Thinking...";
	private hiddenThinkingLabel = this.defaultHiddenThinkingLabel;

	private lastSigintTime = 0;
	private lastEscapeTime = 0;
	private changelogMarkdown: string | undefined = undefined;
	private startupNoticesShown = false;

	// Status line tracking (for mutating immediately-sequential status updates)
	private lastStatusSpacer: Spacer | undefined = undefined;
	private lastStatusText: Text | undefined = undefined;

	// Streaming message tracking
	private streamingComponent: AssistantMessageComponent | undefined = undefined;
	private streamingMessage: AssistantMessage | undefined = undefined;

	// Tool execution tracking: toolCallId -> component
	private pendingTools = new Map<string, ToolExecutionComponent>();
	private pendingToolArgs = new Map<string, Record<string, unknown>>();

	// Tool output expansion state
	private toolOutputExpanded = false;

	// Thinking block visibility state
	private hideThinkingBlock = false;

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
	private extensionSelector: ExtensionSelectorComponent | undefined = undefined;
	private extensionInput: ExtensionInputComponent | undefined = undefined;
	private extensionEditor: ExtensionEditorComponent | undefined = undefined;
	private extensionTerminalInputUnsubscribers = new Set<() => void>();

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
	private nudgeTurnIndex = 0;
	private nudgeShownWarnings = new Map<string, number>(); // type -> turnIndex
	private lastNudgeOutputTokens = 0;

	// Autonomous mode state — when enabled, the prompt handler loops instead
	// of waiting for user input after each turn. The loop checks three
	// independent exit conditions: budget (hard stop), nudge engine (stuck
	// detection), and completion (no tool calls + LLM said stop).
	private autonomousMode: boolean;
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

		if (this.shouldShowEarendilAnnouncement()) {
			if (this.chatContainer.children.length > 0) {
				this.chatContainer.addChild(new Spacer(1));
			}
			this.chatContainer.addChild(new EarendilAnnouncementComponent());
		}

		if (!this.changelogMarkdown) {
			return;
		}

		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder());
		if (this.settingsManager.getCollapseChangelog()) {
			const versionMatch = this.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
			const latestVersion = versionMatch ? versionMatch[1] : this.version;
			const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
			this.chatContainer.addChild(new Text(condensedText, 1, 0));
		} else {
			this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Markdown(this.changelogMarkdown.trim(), 1, 0, this.getMarkdownThemeWithSettings()),
			);
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder());
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		// Load changelog (only show new entries, skip for resumed sessions)
		this.changelogMarkdown = this.getChangelogForDisplay();

		// Ensure fd and rg are available (downloads if missing, adds to PATH via getBinDir)
		// Both are needed: fd for autocomplete, rg for grep tool and bash commands
		const [fdPath] = await Promise.all([ensureTool("fd"), ensureTool("rg")]);
		this.fdPath = fdPath;

		// Add header container as first child
		this.ui.addChild(this.headerContainer);

		// Add header with keybindings from config (unless silenced)
		if (this.options.verbose || !this.settingsManager.getQuietStartup()) {
			this.builtInHeader = new CenteredBannerComponent(this.getBuiltInGreeterLines());

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

		// Start version check asynchronously
		this.checkForNewVersion().then((newVersion) => {
			if (newVersion) {
				this.showNewVersionNotification(newVersion);
			}
		});

		// Start package update check asynchronously
		this.checkForPackageUpdates().then((updates) => {
			if (updates.length > 0) {
				this.showPackageUpdateNotification(updates);
			}
		});

		// Check tmux keyboard setup asynchronously
		this.checkTmuxKeyboardSetup().then((warning) => {
			if (warning) {
				this.showWarning(warning);
			}
		});

		// Show startup warnings
		const { migratedProviders, modelFallbackMessage, initialMessage, initialImages, initialMessages } = this.options;

		if (migratedProviders && migratedProviders.length > 0) {
			this.showWarning(`Migrated credentials to auth.json: ${migratedProviders.join(", ")}`);
		}

		const modelsJsonError = this.session.modelRegistry.getError();
		if (modelsJsonError) {
			this.showError(`models.json error: ${modelsJsonError}`);
		}

		if (modelFallbackMessage) {
			this.showWarning(modelFallbackMessage);
		}

		// Process initial messages
		if (initialMessage) {
			try {
				await this.session.prompt(initialMessage, { images: initialImages });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}

		if (initialMessages) {
			for (const message of initialMessages) {
				try {
					await this.session.prompt(message);
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					this.showError(errorMessage);
				}
			}
		}

		// Main interactive loop — in autonomous mode, we loop automatically
		// after each user prompt until budget/nudge/completion says stop.
		// In normal mode, we wait for user input after each turn.
		// initialImages only applies to the first prompt — clear after use.
		let firstPromptImages = initialImages;
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
				await this.runAutonomousLoop(userInput, imagesForThisPrompt);
				// After the autonomous run completes, always return to normal
				// interactive mode. This keeps autonomy as an explicit per-task
				// choice instead of a sticky background state.
				this.autonomousMode = false;
				this.applySafetyPolicy();
				this.updateModeDisplay();
			} else {
				// Normal interactive: single turn, wait for user
				try {
					const stabilizationProfile = this.getAutonomousStabilizationProfile();
					const interactiveUserMessage = this.buildInteractiveUserMessage(userInput);
					if (stabilizationProfile.level !== "none") {
						this.showStatus(
							`Applying ${stabilizationProfile.level} runtime stabilization: ${
								stabilizationProfile.reasons.join(" | ") || "recent runtime degradation"
							}`,
						);
					}
					await this.session.prompt(interactiveUserMessage, { images: imagesForThisPrompt });
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					this.showError(errorMessage);
				}
			}
		}
	}

	/**
	 * Check npm registry for a newer version.
	 */
	private async checkForNewVersion(): Promise<string | undefined> {
		if (process.env.PI_SKIP_VERSION_CHECK || process.env.PI_OFFLINE) return undefined;

		try {
			const response = await fetch("https://registry.npmjs.org/@mariozechner/pi-coding-agent/latest", {
				signal: AbortSignal.timeout(10000),
			});
			if (!response.ok) return undefined;

			const data = (await response.json()) as { version?: string };
			const latestVersion = data.version;

			if (latestVersion && latestVersion !== this.version) {
				return latestVersion;
			}

			return undefined;
		} catch {
			return undefined;
		}
	}

	private async checkForPackageUpdates(): Promise<string[]> {
		if (process.env.PI_OFFLINE) {
			return [];
		}

		try {
			const packageManager = new DefaultPackageManager({
				cwd: this.sessionManager.getCwd(),
				agentDir: getAgentDir(),
				settingsManager: this.settingsManager,
			});
			const updates = await packageManager.checkForAvailableUpdates();
			return updates.map((update) => update.displayName);
		} catch {
			return [];
		}
	}

	private async checkTmuxKeyboardSetup(): Promise<string | undefined> {
		if (!process.env.TMUX) return undefined;

		const runTmuxShow = (option: string): Promise<string | undefined> => {
			return new Promise((resolve) => {
				const proc = spawn("tmux", ["show", "-gv", option], {
					stdio: ["ignore", "pipe", "ignore"],
				});
				let stdout = "";
				const timer = setTimeout(() => {
					proc.kill();
					resolve(undefined);
				}, 2000);

				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.on("error", () => {
					clearTimeout(timer);
					resolve(undefined);
				});
				proc.on("close", (code) => {
					clearTimeout(timer);
					resolve(code === 0 ? stdout.trim() : undefined);
				});
			});
		};

		const [extendedKeys, extendedKeysFormat] = await Promise.all([
			runTmuxShow("extended-keys"),
			runTmuxShow("extended-keys-format"),
		]);

		// If we couldn't query tmux (timeout, sandbox, etc.), don't warn
		if (extendedKeys === undefined) return undefined;

		if (extendedKeys !== "on" && extendedKeys !== "always") {
			return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
		}

		if (extendedKeysFormat === "xterm") {
			return "tmux extended-keys-format is xterm. Pi works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.";
		}

		return undefined;
	}

	/**
	 * Get changelog entries to display on startup.
	 * Only shows new entries since last seen version, skips for resumed sessions.
	 */
	private getChangelogForDisplay(): string | undefined {
		// Skip changelog for resumed/continued sessions (already have messages)
		if (this.session.state.messages.length > 0) {
			return undefined;
		}

		const lastVersion = this.settingsManager.getLastChangelogVersion();
		const changelogPath = getChangelogPath();
		const entries = parseChangelog(changelogPath);

		if (!lastVersion) {
			// Fresh install - just record the version, don't show changelog
			this.settingsManager.setLastChangelogVersion(VERSION);
			return undefined;
		} else {
			const newEntries = getNewEntries(entries, lastVersion);
			if (newEntries.length > 0) {
				this.settingsManager.setLastChangelogVersion(VERSION);
				return newEntries.map((e) => e.content).join("\n\n");
			}
		}

		return undefined;
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

	private formatDisplayPath(p: string): string {
		const home = os.homedir();
		let result = p;

		// Replace home directory with ~
		if (result.startsWith(home)) {
			result = `~${result.slice(home.length)}`;
		}

		return result;
	}

	/**
	 * Get a short path relative to the package root for display.
	 */
	private getShortPath(fullPath: string, sourceInfo?: SourceInfo): string {
		const source = sourceInfo?.source ?? "";
		const npmMatch = fullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
		if (npmMatch && source.startsWith("npm:")) {
			return npmMatch[2];
		}

		const gitMatch = fullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
		if (gitMatch && source.startsWith("git:")) {
			return gitMatch[1];
		}

		return this.formatDisplayPath(fullPath);
	}

	private getDisplaySourceInfo(sourceInfo?: SourceInfo): {
		label: string;
		scopeLabel?: string;
		color: "accent" | "muted";
	} {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "local") {
			if (scope === "user") {
				return { label: "user", color: "muted" };
			}
			if (scope === "project") {
				return { label: "project", color: "muted" };
			}
			if (scope === "temporary") {
				return { label: "path", scopeLabel: "temp", color: "muted" };
			}
			return { label: "path", color: "muted" };
		}

		if (source === "cli") {
			return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined, color: "muted" };
		}

		const scopeLabel =
			scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
		return { label: source, scopeLabel, color: "accent" };
	}

	private getScopeGroup(sourceInfo?: SourceInfo): "user" | "project" | "path" {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "cli" || scope === "temporary") return "path";
		if (scope === "user") return "user";
		if (scope === "project") return "project";
		return "path";
	}

	private isPackageSource(sourceInfo?: SourceInfo): boolean {
		const source = sourceInfo?.source ?? "";
		return source.startsWith("npm:") || source.startsWith("git:");
	}

	private buildScopeGroups(items: Array<{ path: string; sourceInfo?: SourceInfo }>): Array<{
		scope: "user" | "project" | "path";
		paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
		packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
	}> {
		const groups: Record<
			"user" | "project" | "path",
			{
				scope: "user" | "project" | "path";
				paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
				packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
			}
		> = {
			user: { scope: "user", paths: [], packages: new Map() },
			project: { scope: "project", paths: [], packages: new Map() },
			path: { scope: "path", paths: [], packages: new Map() },
		};

		for (const item of items) {
			const groupKey = this.getScopeGroup(item.sourceInfo);
			const group = groups[groupKey];
			const source = item.sourceInfo?.source ?? "local";

			if (this.isPackageSource(item.sourceInfo)) {
				const list = group.packages.get(source) ?? [];
				list.push(item);
				group.packages.set(source, list);
			} else {
				group.paths.push(item);
			}
		}

		return [groups.project, groups.user, groups.path].filter(
			(group) => group.paths.length > 0 || group.packages.size > 0,
		);
	}

	private formatScopeGroups(
		groups: Array<{
			scope: "user" | "project" | "path";
			paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
			packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
		}>,
		options: {
			formatPath: (item: { path: string; sourceInfo?: SourceInfo }) => string;
			formatPackagePath: (item: { path: string; sourceInfo?: SourceInfo }, source: string) => string;
		},
	): string {
		const lines: string[] = [];

		for (const group of groups) {
			lines.push(`  ${theme.fg("accent", group.scope)}`);

			const sortedPaths = [...group.paths].sort((a, b) => a.path.localeCompare(b.path));
			for (const item of sortedPaths) {
				lines.push(theme.fg("dim", `    ${options.formatPath(item)}`));
			}

			const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
			for (const [source, items] of sortedPackages) {
				lines.push(`    ${theme.fg("mdLink", source)}`);
				const sortedPackagePaths = [...items].sort((a, b) => a.path.localeCompare(b.path));
				for (const item of sortedPackagePaths) {
					lines.push(theme.fg("dim", `      ${options.formatPackagePath(item, source)}`));
				}
			}
		}

		return lines.join("\n");
	}

	private findSourceInfoForPath(p: string, sourceInfos: Map<string, SourceInfo>): SourceInfo | undefined {
		const exact = sourceInfos.get(p);
		if (exact) return exact;

		let current = p;
		while (current.includes("/")) {
			current = current.substring(0, current.lastIndexOf("/"));
			const parent = sourceInfos.get(current);
			if (parent) return parent;
		}

		return undefined;
	}

	private formatPathWithSource(p: string, sourceInfo?: SourceInfo): string {
		if (sourceInfo) {
			const shortPath = this.getShortPath(p, sourceInfo);
			const { label, scopeLabel } = this.getDisplaySourceInfo(sourceInfo);
			const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
			return `${labelText} ${shortPath}`;
		}
		return this.formatDisplayPath(p);
	}

	private formatDiagnostics(diagnostics: readonly ResourceDiagnostic[], sourceInfos: Map<string, SourceInfo>): string {
		const lines: string[] = [];

		// Group collision diagnostics by name
		const collisions = new Map<string, ResourceDiagnostic[]>();
		const otherDiagnostics: ResourceDiagnostic[] = [];

		for (const d of diagnostics) {
			if (d.type === "collision" && d.collision) {
				const list = collisions.get(d.collision.name) ?? [];
				list.push(d);
				collisions.set(d.collision.name, list);
			} else {
				otherDiagnostics.push(d);
			}
		}

		// Format collision diagnostics grouped by name
		for (const [name, collisionList] of collisions) {
			const first = collisionList[0]?.collision;
			if (!first) continue;
			lines.push(theme.fg("warning", `  "${name}" collision:`));
			lines.push(
				theme.fg(
					"dim",
					`    ${theme.fg("success", "✓")} ${this.formatPathWithSource(first.winnerPath, this.findSourceInfoForPath(first.winnerPath, sourceInfos))}`,
				),
			);
			for (const d of collisionList) {
				if (d.collision) {
					lines.push(
						theme.fg(
							"dim",
							`    ${theme.fg("warning", "✗")} ${this.formatPathWithSource(d.collision.loserPath, this.findSourceInfoForPath(d.collision.loserPath, sourceInfos))} (skipped)`,
						),
					);
				}
			}
		}

		for (const d of otherDiagnostics) {
			if (d.path) {
				const formattedPath = this.formatPathWithSource(d.path, this.findSourceInfoForPath(d.path, sourceInfos));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${formattedPath}`));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
			} else {
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
			}
		}

		return lines.join("\n");
	}

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
				const contextList = contextFiles
					.map((f) => theme.fg("dim", `  ${this.formatDisplayPath(f.path)}`))
					.join("\n");
				this.chatContainer.addChild(new Text(`${sectionHeader("Context")}\n${contextList}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			const skills = skillsResult.skills;
			if (skills.length > 0) {
				const groups = this.buildScopeGroups(
					skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })),
				);
				const skillList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatDisplayPath(item.path),
					formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
				});
				this.chatContainer.addChild(new Text(`${sectionHeader("Skills")}\n${skillList}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			const templates = this.session.promptTemplates;
			if (templates.length > 0) {
				const groups = this.buildScopeGroups(
					templates.map((template) => ({ path: template.filePath, sourceInfo: template.sourceInfo })),
				);
				const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
				const templateList = this.formatScopeGroups(groups, {
					formatPath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : this.formatDisplayPath(item.path);
					},
					formatPackagePath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : this.formatDisplayPath(item.path);
					},
				});
				this.chatContainer.addChild(new Text(`${sectionHeader("Prompts")}\n${templateList}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			if (extensions.length > 0) {
				const groups = this.buildScopeGroups(extensions);
				const extList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatDisplayPath(item.path),
					formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
				});
				this.chatContainer.addChild(new Text(`${sectionHeader("Extensions", "mdHeading")}\n${extList}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			// Show loaded themes (excluding built-in)
			const loadedThemes = themesResult.themes;
			const customThemes = loadedThemes.filter((t) => t.sourcePath);
			if (customThemes.length > 0) {
				const groups = this.buildScopeGroups(
					customThemes.map((loadedTheme) => ({
						path: loadedTheme.sourcePath!,
						sourceInfo: loadedTheme.sourceInfo,
					})),
				);
				const themeList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatDisplayPath(item.path),
					formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
				});
				this.chatContainer.addChild(new Text(`${sectionHeader("Themes")}\n${themeList}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}
		}

		if (showDiagnostics) {
			const skillDiagnostics = skillsResult.diagnostics;
			if (skillDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(skillDiagnostics, sourceInfos);
				this.chatContainer.addChild(new Text(`${theme.fg("warning", "[Skill conflicts]")}\n${warningLines}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			const promptDiagnostics = promptsResult.diagnostics;
			if (promptDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(promptDiagnostics, sourceInfos);
				this.chatContainer.addChild(
					new Text(`${theme.fg("warning", "[Prompt conflicts]")}\n${warningLines}`, 0, 0),
				);
				this.chatContainer.addChild(new Spacer(1));
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
				const warningLines = this.formatDiagnostics(extensionDiagnostics, sourceInfos);
				this.chatContainer.addChild(
					new Text(`${theme.fg("warning", "[Extension issues]")}\n${warningLines}`, 0, 0),
				);
				this.chatContainer.addChild(new Spacer(1));
			}

			const themeDiagnostics = themesResult.diagnostics;
			if (themeDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(themeDiagnostics, sourceInfos);
				this.chatContainer.addChild(new Text(`${theme.fg("warning", "[Theme conflicts]")}\n${warningLines}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
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
		const mode: ToolSafetyPolicy["mode"] = this.autonomousMode ? "autonomous" : "interactive";
		this.session.setToolSafetyPolicy({
			mode,
			cwd: this.sessionManager.getCwd(),
			approvalHandler: mode === "interactive" ? (request) => this.requestToolApproval(request) : undefined,
		});
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
		if (this.extensionSelector) {
			this.hideExtensionSelector();
		}
		if (this.extensionInput) {
			this.hideExtensionInput();
		}
		if (this.extensionEditor) {
			this.hideExtensionEditor();
		}
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
			this.loadingAnimation.setMessage(`${this.defaultWorkingMessage} (${keyText("app.interrupt")} to interrupt)`);
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
						this.loadingAnimation.setMessage(message);
					} else {
						this.loadingAnimation.setMessage(
							`${this.defaultWorkingMessage} (${keyText("app.interrupt")} to interrupt)`,
						);
					}
				} else {
					// Queue message for when loadingAnimation is created (handles agent_start race)
					this.pendingWorkingMessage = message;
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

	/**
	 * Show a selector for extensions.
	 */
	private showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionSelector();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(option);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout },
			);

			showEditorHostComponent({
				container: this.editorContainer,
				ui: this.ui,
				component: this.extensionSelector,
			});
		});
	}

	/**
	 * Hide the extension selector.
	 */
	private hideExtensionSelector(): void {
		this.extensionSelector?.dispose();
		restoreEditorHost({
			container: this.editorContainer,
			ui: this.ui,
			editor: this.editor,
		});
		this.extensionSelector = undefined;
	}

	/**
	 * Show a confirmation dialog for extensions.
	 */
	private async showExtensionConfirm(
		title: string,
		message: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts);
		return result === "Yes";
	}

	private async promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined> {
		const confirmed = await this.showExtensionConfirm(
			"Session cwd not found",
			formatMissingSessionCwdPrompt(error.issue),
		);
		return confirmed ? error.issue.fallbackCwd : undefined;
	}

	/**
	 * Show a text input for extensions.
	 */
	private showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionInput();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionInput = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(value);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout },
			);

			showEditorHostComponent({
				container: this.editorContainer,
				ui: this.ui,
				component: this.extensionInput,
			});
		});
	}

	/**
	 * Hide the extension input.
	 */
	private hideExtensionInput(): void {
		this.extensionInput?.dispose();
		restoreEditorHost({
			container: this.editorContainer,
			ui: this.ui,
			editor: this.editor,
		});
		this.extensionInput = undefined;
	}

	/**
	 * Show a multi-line editor for extensions (with Ctrl+G support).
	 */
	private showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.extensionEditor = new ExtensionEditorComponent(
				this.ui,
				this.keybindings,
				title,
				prefill,
				(value) => {
					this.hideExtensionEditor();
					resolve(value);
				},
				() => {
					this.hideExtensionEditor();
					resolve(undefined);
				},
			);

			showEditorHostComponent({
				container: this.editorContainer,
				ui: this.ui,
				component: this.extensionEditor,
			});
		});
	}

	/**
	 * Hide the extension editor.
	 */
	private hideExtensionEditor(): void {
		restoreEditorHost({
			container: this.editorContainer,
			ui: this.ui,
			editor: this.editor,
		});
		this.extensionEditor = undefined;
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
		if (type === "error") {
			this.showError(message);
		} else if (type === "warning") {
			this.showWarning(message);
		} else {
			this.showStatus(message);
		}
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
			const fileName = `pi-clipboard-${crypto.randomUUID()}.${ext}`;
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
					handleResearchCommand: (commandText) => this.handleResearchCommand(commandText),
					handleDebugCommand: () => this.handleDebugCommand(),
					handleWorkspaceCommand: (commandText) => this.handleWorkspaceCommand(commandText),
					handleChangelogCommand: () => this.handleChangelogCommand(),
					handleHotkeysCommand: () => this.handleHotkeysCommand(),
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
					shutdown: () => this.shutdown(),
				});
				return;
			}

			await handleInteractiveEditorSubmitAfterBuiltin(
				text,
				{
					isBashRunning: this.session.isBashRunning,
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
					prompt: (value, options) => this.session.prompt(value, options),
					updatePendingMessagesDisplay: () => this.updatePendingMessagesDisplay(),
					requestRender: () => this.ui.requestRender(),
					flushPendingBashComponents: () => this.flushPendingBashComponents(),
					dispatchNormalInput: (value) => {
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
				this.statusContainer.clear();
				this.loadingAnimation = new Loader(
					this.ui,
					(spinner) => theme.fg("accent", spinner),
					(text) => theme.fg("muted", text),
					this.defaultWorkingMessage,
				);
				this.statusContainer.addChild(this.loadingAnimation);
				// Apply any pending working message queued before loader existed
				if (this.pendingWorkingMessage !== undefined) {
					if (this.pendingWorkingMessage) {
						this.loadingAnimation.setMessage(this.pendingWorkingMessage);
					}
					this.pendingWorkingMessage = undefined;
				}
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
					this.addMessageToChat(event.message);
					this.updatePendingMessagesDisplay();
					this.ui.requestRender();
				} else if (event.message.role === "assistant") {
					this.streamingComponent = new AssistantMessageComponent(
						undefined,
						this.hideThinkingBlock,
						this.getMarkdownThemeWithSettings(),
						this.hiddenThinkingLabel,
					);
					this.streamingMessage = event.message;
					this.chatContainer.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(this.streamingMessage);
					this.ui.requestRender();
				}
				break;

			case "message_update":
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					this.streamingComponent.updateContent(this.streamingMessage);

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
								this.chatContainer.addChild(component);
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
				this.pendingToolArgs.set(event.toolCallId, event.args ?? {});
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
					this.chatContainer.addChild(component);
					this.pendingTools.set(event.toolCallId, component);
				}
				component.markExecutionStarted();
				this.ui.requestRender();
				break;
			}

			case "tool_execution_update": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.partialResult, isError: false }, true);
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				const component = this.pendingTools.get(event.toolCallId);
				const toolArgs = this.pendingToolArgs.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError });
					this.pendingTools.delete(event.toolCallId);
					this.pendingToolArgs.delete(event.toolCallId);

					// Track tool outcome for nudge evaluation
					const toolName = event.toolName;
					const isFileTool = ["read", "read_file", "edit", "write", "str_replace_editor"].includes(toolName);
					this.nudgeToolCallHistory.push({
						tool: toolName,
						success: !event.isError,
						file: isFileTool ? this.extractFileFromToolArgs(event.toolName, event.result) : undefined,
						detail: this.extractToolDetail(toolName, toolArgs),
						metadata: this.extractToolMetadata(event.result),
					});

					if (isFileTool) {
						this.nudgeFileAccessHistory.push({
							tool: toolName,
							success: !event.isError,
							file: this.extractFileFromToolArgs(event.toolName, event.result),
							detail: this.extractToolDetail(toolName, toolArgs),
							metadata: this.extractToolMetadata(event.result),
						});
					}

					this.ui.requestRender();
				}
				break;
			}

			case "xml_tool_call": {
				this.xmlFallbackCount += 1;
				this.lastXmlFallbackEvent = event;
				this.persistRuntimeHealthSnapshot();
				const warning = this.formatXmlFallbackWarning(event);
				if (warning) {
					this.footer.setWarning(warning);
					if (event.severity === "critical") {
						this.showWarning(warning);
					} else {
						this.showStatus(warning);
					}
					this.ui.requestRender();
				}
				break;
			}

			case "degraded_turn": {
				this.degradedTurnCount += 1;
				this.lastDegradedTurnEvent = event;
				this.persistRuntimeHealthSnapshot();
				const warning = this.formatDegradedTurnWarning(event);
				if (warning) {
					this.footer.setWarning(warning);
					if (event.severity === "critical") {
						this.showWarning(warning);
					} else {
						this.showStatus(warning);
					}
					this.ui.requestRender();
				}
				break;
			}

			case "agent_end":
				if (this.loadingAnimation) {
					this.loadingAnimation.stop();
					this.loadingAnimation = undefined;
					this.statusContainer.clear();
				}
				if (this.streamingComponent) {
					this.chatContainer.removeChild(this.streamingComponent);
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.pendingTools.clear();
				this.pendingToolArgs.clear();

				// Evaluate nudges after agent turn completes
				this.evaluateAndShowNudgeWarnings();

				await this.checkShutdownRequested();

				this.ui.requestRender();
				break;

			case "compaction_start": {
				// Keep editor active; submissions are queued during compaction.
				this.autoCompactionEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortCompaction();
				};
				this.statusContainer.clear();
				const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
				const label =
					event.reason === "manual"
						? `Compacting context... ${cancelHint}`
						: `${event.reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... ${cancelHint}`;
				this.autoCompactionLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("accent", spinner),
					(text) => theme.fg("muted", text),
					label,
				);
				this.statusContainer.addChild(this.autoCompactionLoader);
				this.ui.requestRender();
				break;
			}

			case "compaction_end": {
				if (this.autoCompactionEscapeHandler) {
					this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
					this.autoCompactionEscapeHandler = undefined;
				}
				if (this.autoCompactionLoader) {
					this.autoCompactionLoader.stop();
					this.autoCompactionLoader = undefined;
					this.statusContainer.clear();
				}
				if (event.aborted) {
					if (event.reason === "manual") {
						this.showError("Compaction cancelled");
					} else {
						this.showStatus("Auto-compaction cancelled");
					}
				} else if (event.result) {
					this.chatContainer.clear();
					this.rebuildChatFromMessages();
					this.addMessageToChat(
						createCompactionSummaryMessage(
							event.result.summary,
							event.result.tokensBefore,
							new Date().toISOString(),
						),
					);
					this.footer.invalidate();
				} else if (event.errorMessage) {
					if (event.reason === "manual") {
						this.showError(event.errorMessage);
					} else {
						this.chatContainer.addChild(new Spacer(1));
						this.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));
					}
				}
				void this.flushCompactionQueue({ willRetry: event.willRetry });
				this.ui.requestRender();
				break;
			}

			case "auto_retry_start": {
				// Set up escape to abort retry
				this.retryEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortRetry();
				};
				// Show retry indicator
				this.statusContainer.clear();
				const delaySeconds = Math.round(event.delayMs / 1000);
				this.retryLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("warning", spinner),
					(text) => theme.fg("muted", text),
					`Retrying (${event.attempt}/${event.maxAttempts}) in ${delaySeconds}s... (${keyText("app.interrupt")} to cancel)`,
				);
				this.statusContainer.addChild(this.retryLoader);
				this.ui.requestRender();
				break;
			}

			case "auto_retry_end": {
				// Restore escape handler
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				// Stop loader
				if (this.retryLoader) {
					this.retryLoader.stop();
					this.retryLoader = undefined;
					this.statusContainer.clear();
				}
				// Show error only on final failure (success shows normal response)
				if (!event.success) {
					this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
				}
				this.ui.requestRender();
				break;
			}
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

		if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
			this.lastStatusText.setText(theme.fg("dim", message));
			this.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new Text(theme.fg("dim", message), 1, 0);
		this.chatContainer.addChild(spacer);
		this.chatContainer.addChild(text);
		this.lastStatusSpacer = spacer;
		this.lastStatusText = text;
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
				const assistantComponent = new AssistantMessageComponent(
					message,
					this.hideThinkingBlock,
					this.getMarkdownThemeWithSettings(),
					this.hiddenThinkingLabel,
				);
				this.chatContainer.addChild(assistantComponent);
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
						this.chatContainer.addChild(component);

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
				prompt: (value, options) => this.session.prompt(value, options),
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
	 * Toggle autonomous mode for the next prompt.
	 *
	 * This is intentionally not a full mode carousel inside the TUI. Print and
	 * RPC are CLI entry modes, while interactive and autonomous share the same
	 * interface and differ only in whether the prompt handler loops after the
	 * first turn. Alt+M arms or disarms that loop for the next task.
	 *
	 * Note: Ctrl+M cannot be used because it produces the same byte as Enter in
	 * terminal protocols.
	 */
	private cycleMode(): void {
		// The TUI owns exactly two execution behaviors: interactive and
		// autonomous. CLI-only modes such as print and rpc are intentionally not
		// part of this keyboard toggle.
		if (!this.autonomousMode) {
			const scopeGuardReason = getAutonomousScopeGuardReason(this.sessionManager.getCwd());
			if (scopeGuardReason) {
				this.showWarning(scopeGuardReason);
				this.updateModeDisplay();
				return;
			}
		}
		this.autonomousMode = !this.autonomousMode;
		this.applySafetyPolicy();
		const modeName = this.autonomousMode ? "Autonomous" : "Interactive";
		this.showStatus(`Execution: ${modeName}`);
		this.updateModeDisplay();
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
			this.chatContainer.addChild(this.streamingComponent);
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
		const tmpFile = path.join(os.tmpdir(), `pi-editor-${Date.now()}.pi.md`);

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
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showNewVersionNotification(_newVersion: string): void {
		// Disabled in AG1 fork
	}

	showPackageUpdateNotification(packages: string[]): void {
		const action = theme.fg("accent", `${APP_NAME} update`);
		const updateInstruction = theme.fg("muted", "Package updates are available. Run ") + action;
		const packageLines = packages.map((pkg) => `- ${pkg}`).join("\n");

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new Text(
				`${theme.bold(theme.fg("warning", "Package Updates Available"))}\n${updateInstruction}\n${theme.fg("muted", "Packages:")}\n${packageLines}`,
				1,
				0,
			),
		);
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.ui.requestRender();
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
		const cleared = clearInteractiveQueuedMessages(
			{ steering, followUp },
			this.compactionQueuedMessages,
		);
		this.compactionQueuedMessages = [];
		return cleared;
	}

	private updatePendingMessagesDisplay(): void {
		this.pendingMessagesContainer.clear();
		const { steering: steeringMessages, followUp: followUpMessages } = this.getAllQueuedMessages();
		if (steeringMessages.length > 0 || followUpMessages.length > 0) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			for (const message of steeringMessages) {
				const text = theme.fg("dim", `Steering: ${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			for (const message of followUpMessages) {
				const text = theme.fg("dim", `Follow-up: ${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			const dequeueHint = this.getAppKeyDisplay("app.message.dequeue");
			const hintText = theme.fg("dim", `↳ ${dequeueHint} to edit all queued messages`);
			this.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
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
				prompt: (text) => this.session.prompt(text),
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
			try {
				await this.session.setModel(model);
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.showStatus(`Model: ${model.id}`);
				this.checkDaxnutsEasterEgg(model);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		this.showModelSelector(searchTerm);
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
				async (model) => {
					try {
						await this.session.setModel(model);
						this.footer.invalidate();
						this.updateEditorBorderColor();
						done();
						this.showStatus(`Model: ${model.id}`);
						this.checkDaxnutsEasterEgg(model);
					} catch (error) {
						done();
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
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
						showCustomInstructionsEditor: () =>
							this.showExtensionEditor("Custom summarization instructions"),
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
					renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
						const next = (nextName ?? "").trim();
						if (!next) return;
						const mgr = SessionManager.open(sessionFilePath);
						mgr.appendSessionInfo(next);
					},
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
		if (this.session.isStreaming) {
			this.showWarning("Wait for the current response to finish before reloading.");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("Wait for compaction to finish before reloading.");
			return;
		}

		this.resetExtensionUI();

		const loader = new BorderedLoader(
			this.ui,
			theme,
			"Reloading keybindings, extensions, skills, prompts, themes...",
			{
				cancellable: false,
			},
		);
		const previousEditor = this.editor;
		showEditorHostComponent({
			container: this.editorContainer,
			ui: this.ui,
			component: loader,
		});

		const dismissLoader = (editor: Component) => {
			loader.dispose();
			restoreEditorHost({
				container: this.editorContainer,
				ui: this.ui,
				editor,
			});
		};

		try {
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
			dismissLoader(this.editor as Component);
			this.showLoadedResources({
				force: false,
				showDiagnosticsWhenQuiet: true,
			});
			const modelsJsonError = this.session.modelRegistry.getError();
			if (modelsJsonError) {
				this.showError(`models.json error: ${modelsJsonError}`);
			}
			this.showStatus("Reloaded keybindings, extensions, skills, prompts, themes");
		} catch (error) {
			dismissLoader(previousEditor as Component);
			this.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async handleExportCommand(text: string): Promise<void> {
		const parts = text.split(/\s+/);
		const outputPath = parts.length > 1 ? parts[1] : undefined;

		try {
			if (outputPath?.endsWith(".jsonl")) {
				const filePath = this.session.exportToJsonl(outputPath);
				this.showStatus(`Session exported to: ${filePath}`);
			} else {
				const filePath = await this.session.exportToHtml(outputPath);
				this.showStatus(`Session exported to: ${filePath}`);
			}
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
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
		// Check if gh is available and logged in
		try {
			const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
			if (authResult.status !== 0) {
				this.showError("GitHub CLI is not logged in. Run 'gh auth login' first.");
				return;
			}
		} catch {
			this.showError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
			return;
		}

		// Export to a temp file
		const tmpFile = path.join(os.tmpdir(), "session.html");
		try {
			await this.session.exportToHtml(tmpFile);
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
			return;
		}

		// Show cancellable loader, replacing the editor
		const loader = new BorderedLoader(this.ui, theme, "Creating gist...");
		showEditorHostComponent({
			container: this.editorContainer,
			ui: this.ui,
			component: loader,
		});

		const restoreEditor = () => {
			loader.dispose();
			restoreEditorHost({
				container: this.editorContainer,
				ui: this.ui,
				editor: this.editor,
			});
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}
		};

		// Create a secret gist asynchronously
		let proc: ReturnType<typeof spawn> | null = null;

		loader.onAbort = () => {
			proc?.kill();
			restoreEditor();
			this.showStatus("Share cancelled");
		};

		try {
			const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
				proc = spawn("gh", ["gist", "create", "--public=false", tmpFile]);
				let stdout = "";
				let stderr = "";
				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.stderr?.on("data", (data) => {
					stderr += data.toString();
				});
				proc.on("close", (code) => resolve({ stdout, stderr, code }));
			});

			if (loader.signal.aborted) return;

			restoreEditor();

			if (result.code !== 0) {
				const errorMsg = result.stderr?.trim() || "Unknown error";
				this.showError(`Failed to create gist: ${errorMsg}`);
				return;
			}

			// Extract gist ID from the URL returned by gh
			// gh returns something like: https://gist.github.com/username/GIST_ID
			const gistUrl = result.stdout?.trim();
			const gistId = gistUrl?.split("/").pop();
			if (!gistId) {
				this.showError("Failed to parse gist ID from gh output");
				return;
			}

			// Create the preview URL
			const previewUrl = getShareViewerUrl(gistId);
			this.showStatus(`Share URL: ${previewUrl}\nGist: ${gistUrl}`);
		} catch (error: unknown) {
			if (!loader.signal.aborted) {
				restoreEditor();
				this.showError(`Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`);
			}
		}
	}

	private async handleCopyCommand(): Promise<void> {
		const text = this.session.getLastAssistantText();
		if (!text) {
			this.showError("No agent messages to copy yet.");
			return;
		}

		try {
			await copyToClipboard(text);
			this.showStatus("Copied last agent message to clipboard");
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
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

	private handleSessionCommand(): void {
		const stats = this.session.getSessionStats();
		const sessionName = this.sessionManager.getSessionName();

		const runtimeHealth = this.formatRuntimeHealthSummary();
		const runtimeTimeline = this.formatRuntimeHealthTimelineSummary();
		const debugArtifacts = this.formatDebugArtifactsSummary();
		const runtimeRecovery = this.formatRuntimeRecoverySummary();
		const stabilization = this.formatAutonomousStabilizationSummary();

		const workspace = this.activeAutonomousWorkspace ?? this.lastAutonomousWorkspace;
		const workspaceSummary = workspace
			? formatAutonomousWorkspaceSummary(workspace, Boolean(this.activeAutonomousWorkspace))
			: "";

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

		const info = formatSessionInfo({
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

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private handleResearchCommand(text: string): void {
		const arg = text.startsWith("/research ") ? text.slice(10).trim() : "";
		if (arg && arg !== "latest") {
			this.showWarning("Usage: /research or /research latest");
			return;
		}

		const limit = arg === "latest" ? 1 : 5;
		const artifacts = getRecentResearchArtifacts(this.session.sessionManager.getEntries(), limit);
		if (artifacts.length === 0) {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(theme.fg("dim", "No research artifacts saved in this session yet."), 1, 0));
			this.ui.requestRender();
			return;
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(formatResearchArtifactsSummary(artifacts), 1, 0));
		this.ui.requestRender();
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
		return buildRuntimeHealthTimelineSummary(getRecentRuntimeHealthSnapshots(this.session.sessionManager.getEntries(), 3));
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

	private resolveAutonomousRunConfig(): AutonomousExecutionConfig {
		const profile = this.getAutonomousStabilizationProfile();
		const resolved: AutonomousExecutionConfig = { ...this.autonomousConfig };

		if (
			profile.recommendedMaxOutputPerTurn &&
			((resolved.maxOutputPerTurn ?? 0) === 0 ||
				(resolved.maxOutputPerTurn ?? 0) > profile.recommendedMaxOutputPerTurn)
		) {
			resolved.maxOutputPerTurn = profile.recommendedMaxOutputPerTurn;
		}
		if (profile.forceBehavioralPrompt) {
			resolved.enableBehavioralPrompt = true;
		}
		if (profile.forceNudges) {
			resolved.enableNudges = true;
		}
		return resolved;
	}

	private buildAutonomousUserMessage(userMessage: string): string {
		const profile = this.getAutonomousStabilizationProfile();
		if (profile.level === "none") return userMessage;

		const lines = [
			userMessage.trim(),
			"",
			"Autonomous stabilization for this run:",
			"- keep responses terse and tool-driven",
			"- do not repeat prior analysis",
			"- execute only the next smallest concrete step before reassessing",
		];
		if (profile.recommendedMaxOutputPerTurn) {
			lines.push(`- keep the next response under ${profile.recommendedMaxOutputPerTurn.toLocaleString()} output tokens unless a final verified summary is required`);
		}
		if (profile.reasons.length > 0) {
			lines.push(`- stabilization reason: ${profile.reasons.join(" | ")}`);
		}
		return lines.join("\n");
	}

	private getAutonomousResumeSnapshot(userMessage: string): AutonomousRunSnapshot | undefined {
		const snapshot = getLatestAutonomousRunSnapshot(this.session.sessionManager.getEntries());
		if (!snapshot) return undefined;
		if (snapshot.stopReason === "complete") return undefined;
		if (!this.isAutonomousResumeRequest(userMessage, snapshot)) return undefined;
		return snapshot;
	}

	private isAutonomousResumeRequest(userMessage: string, snapshot: AutonomousRunSnapshot): boolean {
		const normalizedMessage = userMessage.replace(/\s+/g, " ").trim().toLowerCase();
		const normalizedGoal = snapshot.ledger.goal.replace(/\s+/g, " ").trim().toLowerCase();
		if (!normalizedMessage) return false;
		if (normalizedMessage === normalizedGoal) return true;
		if (
			/\b(resume|continue|continuing|continued|keep going|keep working|carry on|pick up|proceed|finish|retry|recover)\b/i.test(
				userMessage,
			)
		) {
			return true;
		}
		return false;
	}

	private buildInteractiveUserMessage(userMessage: string): string {
		const profile = this.getAutonomousStabilizationProfile();
		if (profile.level === "none") return userMessage;

		const lines = [
			userMessage.trim(),
			"",
			"Runtime stabilization for this turn:",
			"- keep the reply terse and tool-driven",
			"- do not emit XML fallback or raw tool markup",
			"- finish the next smallest concrete step, then stop",
		];
		if (profile.recommendedMaxOutputPerTurn) {
			lines.push(
				`- keep the next response under ${profile.recommendedMaxOutputPerTurn.toLocaleString()} output tokens unless a final answer is required`,
			);
		}
		if (profile.reasons.length > 0) {
			lines.push(`- stabilization reason: ${profile.reasons.join(" | ")}`);
		}
		return lines.join("\n");
	}

	private persistRuntimeHealthSnapshot(): void {
		appendRuntimeHealthSnapshotIfChanged(
			this.session.sessionManager,
			createRuntimeHealthSnapshotFromState({
				modelId: this.session.model ? `${this.session.model.provider}/${this.session.model.id}` : undefined,
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

	private formatVisualActionRecipeSummary(
		steps:
			| Array<{
					type: "click" | "fill" | "wait" | "navigate";
					selector?: string;
					targetHint?: string;
					valueHint?: string;
					ms?: number;
					url?: string;
					urlHint?: string;
			  }>
			| undefined,
	): string | undefined {
		return buildVisualActionRecipeSummary(steps);
	}

	private formatXmlFallbackWarning(event: XmlFallbackEvent): string | undefined {
		return buildXmlFallbackWarning(event);
	}

	private formatDegradedTurnWarning(event: DegradedTurnEvent): string | undefined {
		return buildDegradedTurnWarning(event);
	}

	private formatRequestFailureWarning(message: {
		provider?: string;
		errorMessage?: string;
	}): string | undefined {
		return buildRequestFailureWarning(message);
	}

	private handleAutonomousCheckpoint(snapshot: AutonomousRunSnapshot): void {
		const status = this.formatAutonomousCheckpointStatus(snapshot);
		if (status === this.lastAutonomousLiveStatus) return;
		this.lastAutonomousLiveStatus = status;

		if (this.loadingAnimation) {
			this.loadingAnimation.setMessage(status);
			this.ui.requestRender();
		} else {
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
		this.chatContainer.addChild(new Text(result.dim ? theme.fg("dim", result.output ?? "") : (result.output ?? ""), 1, 0));
		this.ui.requestRender();
	}

	private handleChangelogCommand(): void {
		const changelogPath = getChangelogPath();
		const allEntries = parseChangelog(changelogPath);

		const changelogMarkdown =
			allEntries.length > 0
				? allEntries
						.reverse()
						.map((e) => e.content)
						.join("\n\n")
				: "No changelog entries found.";

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(changelogMarkdown, 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	/**
	 * Capitalize keybinding for display (e.g., "ctrl+c" -> "Ctrl+C").
	 */
	private capitalizeKey(key: string): string {
		return key
			.split("/")
			.map((k) =>
				k
					.split("+")
					.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
					.join("+"),
			)
			.join("/");
	}

	/**
	 * Get capitalized display string for an app keybinding action.
	 */
	private getAppKeyDisplay(action: AppKeybinding): string {
		return this.capitalizeKey(keyText(action));
	}

	/**
	 * Get capitalized display string for an editor keybinding action.
	 */
	private getEditorKeyDisplay(action: Keybinding): string {
		return this.capitalizeKey(keyText(action));
	}

	private handleHotkeysCommand(): void {
		// Navigation keybindings
		const cursorUp = this.getEditorKeyDisplay("tui.editor.cursorUp");
		const cursorDown = this.getEditorKeyDisplay("tui.editor.cursorDown");
		const cursorLeft = this.getEditorKeyDisplay("tui.editor.cursorLeft");
		const cursorRight = this.getEditorKeyDisplay("tui.editor.cursorRight");
		const cursorWordLeft = this.getEditorKeyDisplay("tui.editor.cursorWordLeft");
		const cursorWordRight = this.getEditorKeyDisplay("tui.editor.cursorWordRight");
		const cursorLineStart = this.getEditorKeyDisplay("tui.editor.cursorLineStart");
		const cursorLineEnd = this.getEditorKeyDisplay("tui.editor.cursorLineEnd");
		const jumpForward = this.getEditorKeyDisplay("tui.editor.jumpForward");
		const jumpBackward = this.getEditorKeyDisplay("tui.editor.jumpBackward");
		const pageUp = this.getEditorKeyDisplay("tui.editor.pageUp");
		const pageDown = this.getEditorKeyDisplay("tui.editor.pageDown");

		// Editing keybindings
		const submit = this.getEditorKeyDisplay("tui.input.submit");
		const newLine = this.getEditorKeyDisplay("tui.input.newLine");
		const deleteWordBackward = this.getEditorKeyDisplay("tui.editor.deleteWordBackward");
		const deleteWordForward = this.getEditorKeyDisplay("tui.editor.deleteWordForward");
		const deleteToLineStart = this.getEditorKeyDisplay("tui.editor.deleteToLineStart");
		const deleteToLineEnd = this.getEditorKeyDisplay("tui.editor.deleteToLineEnd");
		const yank = this.getEditorKeyDisplay("tui.editor.yank");
		const yankPop = this.getEditorKeyDisplay("tui.editor.yankPop");
		const undo = this.getEditorKeyDisplay("tui.editor.undo");
		const tab = this.getEditorKeyDisplay("tui.input.tab");

		// App keybindings
		const interrupt = this.getAppKeyDisplay("app.interrupt");
		const clear = this.getAppKeyDisplay("app.clear");
		const exit = this.getAppKeyDisplay("app.exit");
		const suspend = this.getAppKeyDisplay("app.suspend");
		const cycleThinkingLevel = this.getAppKeyDisplay("app.thinking.cycle");
		const cycleModelForward = this.getAppKeyDisplay("app.model.cycleForward");
		const selectModel = this.getAppKeyDisplay("app.model.select");
		const expandTools = this.getAppKeyDisplay("app.tools.expand");
		const toggleThinking = this.getAppKeyDisplay("app.thinking.toggle");
		const externalEditor = this.getAppKeyDisplay("app.editor.external");
		const cycleModelBackward = this.getAppKeyDisplay("app.model.cycleBackward");
		const followUp = this.getAppKeyDisplay("app.message.followUp");
		const dequeue = this.getAppKeyDisplay("app.message.dequeue");
		const pasteImage = this.getAppKeyDisplay("app.clipboard.pasteImage");

		let hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`${cursorUp}\` / \`${cursorDown}\` / \`${cursorLeft}\` / \`${cursorRight}\` | Move cursor / browse history (Up when empty) |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | Move by word |
| \`${cursorLineStart}\` | Start of line |
| \`${cursorLineEnd}\` | End of line |
| \`${jumpForward}\` | Jump forward to character |
| \`${jumpBackward}\` | Jump backward to character |
| \`${pageUp}\` / \`${pageDown}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${submit}\` | Send message |
| \`${newLine}\` | New line${process.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""} |
| \`${deleteWordBackward}\` | Delete word backwards |
| \`${deleteWordForward}\` | Delete word forwards |
| \`${deleteToLineStart}\` | Delete to start of line |
| \`${deleteToLineEnd}\` | Delete to end of line |
| \`${yank}\` | Paste the most-recently-deleted text |
| \`${yankPop}\` | Cycle through the deleted text after pasting |
| \`${undo}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${tab}\` | Path completion / accept autocomplete |
| \`${interrupt}\` | Cancel autocomplete / abort streaming |
| \`${clear}\` | Clear editor (first) / exit (second) |
| \`${exit}\` | Exit (when editor is empty) |
| \`${suspend}\` | Suspend to background |
| \`${cycleThinkingLevel}\` | Cycle thinking level |
| \`${cycleModelForward}\` / \`${cycleModelBackward}\` | Cycle models |
| \`${selectModel}\` | Open model selector |
| \`${expandTools}\` | Toggle tool output expansion |
| \`${toggleThinking}\` | Toggle thinking block visibility |
| \`${externalEditor}\` | Edit message in external editor |
| \`${followUp}\` | Queue follow-up message |
| \`${dequeue}\` | Restore queued messages |
| \`${pasteImage}\` | Paste image from clipboard |
| \`/\` | Slash commands |
| \`!\` | Run bash command |
| \`!!\` | Run bash command (excluded from context) |
`;

		// Add extension-registered shortcuts
		const extensionRunner = this.session.extensionRunner;
		if (extensionRunner) {
			const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
			if (shortcuts.size > 0) {
				hotkeys += `
**Extensions**
| Key | Action |
|-----|--------|
`;
				for (const [key, shortcut] of shortcuts) {
					const description = shortcut.description ?? shortcut.extensionPath;
					const keyDisplay = key.replace(/\b\w/g, (c) => c.toUpperCase());
					hotkeys += `| \`${keyDisplay}\` | ${description} |\n`;
				}
			}
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "Keyboard Shortcuts")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(hotkeys.trim(), 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
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

	private handleDebugCommand(): void {
		const width = this.ui.terminal.columns;
		const height = this.ui.terminal.rows;
		const allLines = this.ui.render(width);
		const artifacts = this.debugLogger?.getArtifacts();
		const modelId = this.session.model ? `${this.session.model.provider}/${this.session.model.id}` : "none";
		const stabilization = this.getAutonomousStabilizationProfile();
		const workspace = this.activeAutonomousWorkspace ?? this.lastAutonomousWorkspace;

		const debugLogPath = getDebugLogPath();
		const debugData = buildInteractiveDebugReport({
			timestamp: new Date().toISOString(),
			width,
			height,
			renderedLines: allLines,
			messages: this.session.messages,
			modelId,
			autonomousMode: this.autonomousMode,
			stabilization,
			xmlFallbackCount: this.xmlFallbackCount,
			degradedTurnCount: this.degradedTurnCount,
			lastXmlFallbackEvent: this.lastXmlFallbackEvent,
			lastDegradedTurnEvent: this.lastDegradedTurnEvent,
			formatRuntimeHealthIssue: (event) => this.formatRuntimeHealthIssue(event),
			workspace,
			artifacts,
		});

		fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
		fs.writeFileSync(debugLogPath, debugData);

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(
				[
					theme.fg("accent", "✓ Debug log written"),
					theme.fg("muted", debugLogPath),
					artifacts?.sessionDir ? theme.fg("muted", `Session artifacts: ${artifacts.sessionDir}`) : undefined,
				]
					.filter(Boolean)
					.join("\n"),
				1,
				1,
			),
		);
		this.ui.requestRender();
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
	private extractFileFromToolArgs(
		toolName: string,
		result: { content: Array<{ type: string; text?: string }> },
	): string | undefined {
		// Try to extract file path from tool result content
		const textContent = result.content
			?.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n");

		if (!textContent) return undefined;

		// Look for file path patterns in the result
		const pathMatch = textContent.match(/(?:Read|Edited|Wrote) file[:\s]+([^\s\n]+)/i);
		if (pathMatch) return pathMatch[1];

		// For read operations, the file might be in the first line
		const firstLine = textContent.split("\n")[0];
		if (toolName === "read" || toolName === "read_file") {
			const readMatch = firstLine.match(/^(.+?)\s+\(/);
			if (readMatch) return readMatch[1];
		}

		return undefined;
	}

	private extractToolDetail(toolName: string, args: Record<string, unknown> | undefined): string | undefined {
		if (!args) return undefined;
		if ((toolName === "bash" || toolName === "verify") && typeof args.command === "string") {
			return args.command;
		}
		if (toolName === "webSearch" && typeof args.query === "string") return args.query;
		if (toolName === "webFetch" && typeof args.url === "string") return args.url;
		if (typeof args.filePath === "string") return args.filePath;
		if (typeof args.path === "string") return args.path;
		return undefined;
	}

	private extractToolMetadata(result: unknown): Record<string, unknown> | undefined {
		if (!result || typeof result !== "object") return undefined;
		if (!("details" in result)) return undefined;
		const details = (result as { details?: unknown }).details;
		return details && typeof details === "object" ? (details as Record<string, unknown>) : undefined;
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
		initialImages: import("@mariozechner/pi-ai").ImageContent[] | undefined,
	): Promise<void> {
		const originalCwd = this.sessionManager.getCwd();
		const scopeGuardReason = getAutonomousScopeGuardReason(originalCwd);
		if (scopeGuardReason) {
			this.showWarning(scopeGuardReason);
			return;
		}
		let isolatedWorkspace: ActivatedAutonomousWorkspace | undefined = undefined;
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
						resumeSnapshot.ledger.resume?.resumeInstruction ?? resumeSnapshot.ledger.taskJournal.plannedNextStep ?? resumeSnapshot.ledger.goal
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
			this.showStatus(
				`Autonomous workspace ready (${isolatedWorkspace.strategy}): ${isolatedWorkspace.activeCwd}`,
			);

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
	 * Updates the mode display in the UI when switching between interactive
	 * and autonomous modes. Called after mode changes via Shift+Tab.
	 */
	private updateModeDisplay(): void {
		this.modeStrip.setLines([this.getPersistentModeLine()]);
		this.ui.requestRender();
	}

	private getBuiltInGreeterLines(): string[] {
		const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);
		const title = theme.bold(theme.fg("accent", APP_NAME)) + theme.fg("dim", ` v${this.version}`);
		const posture = theme.fg("dim", "Stateful coding harness for supervised and autonomous work");
		const actions = [
			rawKeyHint("enter", "prompt"),
			rawKeyHint("!", "shell"),
			hint("app.model.select", "models"),
			hint("app.mode.cycle", "autonomy"),
		].join(theme.fg("dim", " • "));
		const recovery = theme.fg(
			"dim",
			`Use ${theme.bold("/research")} for saved sources and ${theme.bold("/workspace")} for autonomous sandbox review.`,
		);
		return [title, posture, actions, recovery];
	}

	private summarizeAutonomousLiveStatus(): string | undefined {
		return summarizeAutonomousLiveStatus(this.lastAutonomousLiveStatus);
	}

	private getPersistentModeLine(): string {
		return formatPersistentModeLine({
			autonomousMode: this.autonomousMode,
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
	 * Resolve the project root (repository root).
	 * The coding-agent package is at: <repo_root>/pi-fork/packages/coding-agent/
	 * So the repo root is 5 levels up from this file's directory:
	 *   modes/interactive -> modes -> src/dist -> coding-agent -> packages -> pi-fork -> repo_root
	 */
	private resolveProjectRoot(): string {
		// Use import.meta.url to get the directory of this file
		// __dirname equivalent in ESM
		const thisFileDir = path.dirname(new URL(import.meta.url).pathname);
		// 5 levels up to reach repo_root from src/modes/interactive or dist/modes/interactive
		return path.resolve(thisFileDir, "../../../../../..");
	}
}
