/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	Agent,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	ThinkingLevel,
} from "@ag1/agent-core";
import type { AssistantMessage, ImageContent, Message, Model, TextContent } from "@ag1/ai";
import { isContextOverflow } from "@ag1/ai";
import { stripFrontmatter } from "../utils/frontmatter.js";
import { sleep } from "../utils/sleep.js";
import { AgentSessionBashCoordinator } from "./agent-session-bash-coordinator.js";
import { AgentSessionCompactionCoordinator } from "./agent-session-compaction-coordinator.js";
import { AgentSessionExtensionCoreCoordinator } from "./agent-session-extension-core-coordinator.js";
import { AgentSessionEventDispatcher } from "./agent-session-event-dispatcher.js";
import { AgentSessionEventLoopCoordinator } from "./agent-session-event-loop-coordinator.js";
import { AgentSessionExtensionLifecycleCoordinator } from "./agent-session-extension-lifecycle-coordinator.js";
import {
	buildAgentSessionStats,
	deriveAgentSessionContextUsage,
	exportAgentSessionHtml,
	exportAgentSessionJsonl,
	getLastAgentAssistantText,
} from "./agent-session-inspector.js";
import {
	AgentSessionPromptCoordinator,
	type AgentSessionPromptOptions,
} from "./agent-session-prompt-coordinator.js";
import { AgentSessionRecoveryArbiter } from "./agent-session-recovery-arbiter.js";
import { AgentSessionRetryCoordinator } from "./agent-session-retry-coordinator.js";
import { AgentSessionRuntimeBootstrapCoordinator } from "./agent-session-runtime-bootstrap-coordinator.js";
import { AgentSessionToolRegistryCoordinator } from "./agent-session-tool-registry-coordinator.js";
import { AgentSessionToolFailureCoordinator } from "./agent-session-tool-failure-coordinator.js";
import { AgentSessionTreeCoordinator } from "./agent-session-tree-coordinator.js";
import { AgentSessionXmlCoordinator } from "./agent-session-xml-coordinator.js";
import {
	type AgentSessionModelCycleResult,
	AgentSessionModelCoordinator,
} from "./agent-session-model-coordinator.js";
import type { BashResult } from "./bash-executor.js";
import {
	type CompactionResult,
	calculateContextTokens,
	compact,
	estimateContextTokens,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.js";
import {
	type ContextUsage,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolInfo,
} from "./extensions/index.js";
import { getEffectiveContextWindow } from "./lmstudio-settings.js";
import type { CustomMessage } from "./messages.js";
import type { ModelRegistry } from "./model-registry.js";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.js";
import type { ResourceLoader } from "./resource-loader.js";
import { evaluateToolSafety, type ToolSafetyPolicy } from "./safety-policy.js";
import { getLatestCompactionEntry, type BranchSummaryEntry, type CompactionEntry, type SessionManager } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";
import type { SlashCommandInfo } from "./slash-commands.js";
import type { SourceInfo } from "./source-info.js";
import { buildSystemPrompt } from "./system-prompt.js";
import type { TaskPolicy } from "./task-policy.js";
import { ToolOrchestrator } from "./tool-orchestrator.js";
import type { BashOperations } from "./tools/bash.js";
import { getResearchUrlHint } from "./tools/research-intent.js";
import { type TurnDegradationSeverity } from "./turn-health.js";
import { type XmlFallbackSeverity } from "./xml-tool-parser.js";

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| AgentEvent
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "recovery_replay_skipped";
			owner: "retry" | "compaction";
			reason: "already_scheduled" | "state_changed";
			message: string;
	  }
	| {
			type: "xml_tool_call";
			toolName: string;
			arguments: Record<string, unknown>;
			result?: unknown;
			iteration?: number;
			callCount?: number;
			assistantStopReason?: string;
			assistantTextLength?: number;
			severity?: XmlFallbackSeverity;
			reasons?: string[];
			continuationMode?: "default" | "guided";
	  }
	| {
			type: "degraded_turn";
			severity: TurnDegradationSeverity;
			stopReason?: string;
			outputTokens: number;
			textLength: number;
			reasons: string[];
			recoveryHint?: string;
	  }
	| { type: "nudge"; nudgeType: string; message?: string; details?: string; shouldStop: boolean }
	| { type: "tool_failure_warning"; toolName: string; failureCount: number; correctiveMessage: string };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for skills, prompts, themes, context files, system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Model registry for API key resolution and model discovery */
	modelRegistry: ModelRegistry;
	/** Initial active built-in tool names. Default: [read, bash, edit, write] */
	initialActiveToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
	/** Optional tool safety policy. Disabled by default so SDK/tests remain opt-in. */
	toolSafety?: ToolSafetyPolicy;
	/** Optional controlled-runtime tool policy. Disabled by default. */
	toolPolicy?: TaskPolicy;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	commandContextActions?: ExtensionCommandContextActions;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Per-turn system prompt addendum. Not shown in the visible transcript. */
	systemPromptAddendum?: string;
}

export type ModelCycleResult = AgentSessionModelCycleResult;

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

type WebResearchCoverageKind = "current_events" | "docs" | "pricing" | "release" | "error";

interface WebResearchRuntimeFetch {
	url: string;
	host: string;
	path: string;
	status?: string;
	coverageKind?: WebResearchCoverageKind;
	coverageComplete?: boolean;
	authoritative?: boolean;
}

interface WebResearchRuntimeState {
	searchQueries: string[];
	fetches: WebResearchRuntimeFetch[];
	placeholderHosts: Map<string, string[]>;
	completedCoverageKinds: Set<WebResearchCoverageKind>;
	authoritativeCompletedCoverageKinds: Set<WebResearchCoverageKind>;
	missingCoverageByKind: Map<WebResearchCoverageKind, string[]>;
}

function createWebResearchRuntimeState(): WebResearchRuntimeState {
	return {
		searchQueries: [],
		fetches: [],
		placeholderHosts: new Map(),
		completedCoverageKinds: new Set(),
		authoritativeCompletedCoverageKinds: new Set(),
		missingCoverageByKind: new Map(),
	};
}

function getStringArg(args: unknown, key: string): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

function normalizeWebResearchValue(value: string | undefined): string | undefined {
	const normalized = value?.trim().toLowerCase().replace(/\s+/g, " ");
	return normalized || undefined;
}

function normalizeWebResearchUrl(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = new URL(trimmed);
		parsed.hash = "";
		if ((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80")) {
			parsed.port = "";
		}
		return parsed.toString().replace(/\/$/, "").toLowerCase();
	} catch {
		return normalizeWebResearchValue(trimmed);
	}
}

function parseWebResearchUrl(value: string | undefined): { normalized: string; host: string; path: string } | undefined {
	const normalized = normalizeWebResearchUrl(value);
	if (!normalized) return undefined;
	try {
		const parsed = new URL(normalized);
		return {
			normalized,
			host: parsed.hostname.toLowerCase().replace(/^www\./, ""),
			path: normalizeWebResearchPath(parsed.pathname),
		};
	} catch {
		return {
			normalized,
			host: "",
			path: normalizeWebResearchPath(normalized),
		};
	}
}

function normalizeWebResearchPath(path: string): string {
	const cleaned = path.trim().toLowerCase().replace(/\/+/g, "/").replace(/\/$/, "");
	return cleaned || "/";
}

const WEB_RESEARCH_GENERIC_TERMS = new Set([
	"about",
	"best",
	"brief",
	"briefly",
	"current",
	"find",
	"happened",
	"latest",
	"news",
	"recent",
	"research",
	"search",
	"source",
	"sources",
	"strongest",
	"summarize",
	"summary",
	"the",
	"weeks",
]);

function getWebResearchTerms(value: string | undefined): Set<string> {
	const normalized = normalizeWebResearchValue(value);
	if (!normalized) return new Set();
	return new Set(
		normalized
			.match(/[a-z0-9][a-z0-9.-]*/g)
			?.filter((term) => term.length >= 3 && !WEB_RESEARCH_GENERIC_TERMS.has(term)) ?? [],
	);
}

function isNearDuplicateWebSearch(previousQuery: string, nextQuery: string): boolean {
	if (previousQuery === nextQuery) return true;
	const previousTerms = getWebResearchTerms(previousQuery);
	const nextTerms = getWebResearchTerms(nextQuery);
	if (previousTerms.size === 0 || nextTerms.size === 0) return false;
	let overlap = 0;
	for (const term of nextTerms) {
		if (previousTerms.has(term)) overlap++;
	}
	const newTerms = [...nextTerms].filter((term) => !previousTerms.has(term));
	return overlap >= 3 && newTerms.length === 0;
}

function isBroadWebResearchQueryAfterSpecific(previousQuery: string, nextQuery: string): boolean {
	const previousTerms = getWebResearchTerms(previousQuery);
	const nextTerms = getWebResearchTerms(nextQuery);
	if (previousTerms.size < 4 || nextTerms.size === 0 || nextTerms.size >= previousTerms.size) return false;
	let overlap = 0;
	for (const term of nextTerms) {
		if (previousTerms.has(term)) overlap++;
	}
	return overlap >= Math.max(2, nextTerms.size - 1);
}

function areWebResearchPathsMateriallyDifferent(previousPath: string, nextPath: string): boolean {
	const previousSegments = previousPath.split("/").filter(Boolean);
	const nextSegments = nextPath.split("/").filter(Boolean);
	if (previousPath === nextPath) return false;
	if (previousSegments.length === 0 || nextSegments.length === 0) return false;
	if (previousSegments[0] !== nextSegments[0]) return true;
	if (previousSegments.length >= 2 && nextSegments.length >= 2 && previousSegments[1] !== nextSegments[1]) return true;
	return false;
}

function extractWebResearchCoverageKind(value: unknown): WebResearchCoverageKind | undefined {
	if (value === "current_events" || value === "docs" || value === "pricing" || value === "release" || value === "error") {
		return value;
	}
	return undefined;
}

function getWebResearchCoverageFromDetails(details: unknown): {
	kind?: WebResearchCoverageKind;
	complete: boolean;
	missing: string[];
} {
	if (!details || typeof details !== "object") {
		return { complete: false, missing: [] };
	}
	const record = details as Record<string, unknown>;
	const coverage = record.coverage && typeof record.coverage === "object" ? record.coverage as Record<string, unknown> : undefined;
	const kind = extractWebResearchCoverageKind(coverage?.kind) ?? extractWebResearchCoverageKind(record.coverageKind);
	const missing = Array.isArray(coverage?.missing)
		? coverage.missing.filter((entry): entry is string => typeof entry === "string")
		: [];
	const present = Array.isArray(coverage?.present)
		? coverage.present.filter((entry): entry is string => typeof entry === "string")
		: [];
	return {
		kind,
		complete: Boolean(kind && present.length > 0 && missing.length === 0),
		missing,
	};
}

// ============================================================================
// Constants
// ============================================================================

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private readonly _eventDispatcher: AgentSessionEventDispatcher;
	private readonly _compactionCoordinator: AgentSessionCompactionCoordinator;
	private readonly _eventLoopCoordinator: AgentSessionEventLoopCoordinator;

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];

	// Retry state
	private readonly _recoveryArbiter: AgentSessionRecoveryArbiter;
	private readonly _retryCoordinator: AgentSessionRetryCoordinator;
	private readonly _promptCoordinator: AgentSessionPromptCoordinator;
	private readonly _toolRegistryCoordinator: AgentSessionToolRegistryCoordinator;
	private readonly _runtimeBootstrapCoordinator: AgentSessionRuntimeBootstrapCoordinator;
	private _extensionCoreCoordinator?: AgentSessionExtensionCoreCoordinator;

	// Bash execution state
	private readonly _bashCoordinator: AgentSessionBashCoordinator;

	// Extension system
	private _extensionRunner: ExtensionRunner | undefined = undefined;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _toolSafety: ToolSafetyPolicy | undefined;
	private _toolOrchestrator: ToolOrchestrator | undefined;
	private _controlledToolTurnKey = "";
	private _controlledToolCallsThisTurn = 0;
	private readonly _webResearchBudgetDisabled = process.env.AG1_DISABLE_WEB_RESEARCH_BUDGET === "1";
	private _webResearchRuntimeState: WebResearchRuntimeState = createWebResearchRuntimeState();

	/** Custom context window override (tokens), set via /set-context. Overrides model.contextWindow. */
	private _customContextWindow: number | undefined;
	private readonly _extensionLifecycleCoordinator: AgentSessionExtensionLifecycleCoordinator;

	// Model registry for API key resolution
	private _modelRegistry: ModelRegistry;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	// Base system prompt (without extension appends) - used to apply fresh appends each turn
	private _baseSystemPrompt = "";

	// Tool failure tracking for resilience
	private readonly _toolFailureCoordinator = new AgentSessionToolFailureCoordinator();

	private readonly _xmlCoordinator: AgentSessionXmlCoordinator;
	private readonly _treeCoordinator: AgentSessionTreeCoordinator;
	private readonly _modelCoordinator: AgentSessionModelCoordinator;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRegistry = config.modelRegistry;
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this._toolSafety = config.toolSafety;
		this._toolOrchestrator = config.toolPolicy ? new ToolOrchestrator({ cwd: this._cwd, policy: config.toolPolicy }) : undefined;
		this._eventDispatcher = new AgentSessionEventDispatcher(this.sessionManager, () => this._extensionRunner);
		this._recoveryArbiter = new AgentSessionRecoveryArbiter();
		this._compactionCoordinator = new AgentSessionCompactionCoordinator({
			agent: this.agent,
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			modelRegistry: this._modelRegistry,
			getModel: () => this.model,
			getContextWindow: () => this.contextWindow,
			getExtensionRunner: () => this._extensionRunner,
			getRequiredRequestAuth: (model) => this._getRequiredRequestAuth(model),
			emit: (event) => this._emit(event),
			disconnectFromAgent: () => this._disconnectFromAgent(),
			reconnectToAgent: () => this._reconnectToAgent(),
			abortAgent: () => this.abort(),
			recoveryArbiter: this._recoveryArbiter,
		});
		this._retryCoordinator = new AgentSessionRetryCoordinator({
			agent: this.agent,
			settingsManager: this.settingsManager,
			getContextWindow: () => this.contextWindow,
			emit: (event) => this._emit(event),
			recoveryArbiter: this._recoveryArbiter,
		});
		this._eventLoopCoordinator = new AgentSessionEventLoopCoordinator({
			removeQueuedUserMessage: (text) => {
				const steeringIndex = this._steeringMessages.indexOf(text);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					return true;
				}
				const followUpIndex = this._followUpMessages.indexOf(text);
				if (followUpIndex !== -1) {
					this._followUpMessages.splice(followUpIndex, 1);
					return true;
				}
				return false;
			},
			emitQueueUpdate: () => this._emitQueueUpdate(),
			emitExtensionEvent: (event) => this._emitExtensionEvent(event),
			emitPublicEvent: (event) => this._emit(event),
			appendCustomMessageEntry: (customType, content, display, details) => {
				this.sessionManager.appendCustomMessageEntry(customType, content, display ?? true, details);
			},
			appendMessage: (message) => {
				this.sessionManager.appendMessage(message);
			},
			resetOverflowRecovery: () => this._compactionCoordinator.resetOverflowRecovery(),
			emitDegradedTurn: (event) => {
				this._emit({
					type: "degraded_turn",
					severity: event.severity,
					stopReason: event.stopReason,
					outputTokens: event.outputTokens,
					textLength: event.textLength,
					reasons: event.reasons,
					recoveryHint: event.recoveryHint,
				});
			},
			onAssistantSuccess: () => this._retryCoordinator.onAssistantSuccess(),
			emitRetrySuccess: (attempt) => {
				this._emit({
					type: "auto_retry_end",
					success: true,
					attempt,
				});
			},
			ensurePendingRetryForAgentEnd: (message) => this._retryCoordinator.ensurePendingRetryForAgentEnd(message),
			isRetryableError: (message) => this._isRetryableError(message),
			handleRetryableError: (message) => this._handleRetryableError(message),
			resolveRetry: () => this._retryCoordinator.resolvePending(),
			checkCompaction: (assistantMessage) => this._checkCompaction(assistantMessage),
			getUserMessageText: (message) => this._getUserMessageText(message),
		});
		this._promptCoordinator = new AgentSessionPromptCoordinator({
			agentState: {
				isStreaming: () => this.isStreaming,
				prompt: (messages) => this.agent.prompt(messages),
				setSystemPrompt: (prompt) => {
					this.agent.state.systemPrompt = prompt;
				},
			},
			getModel: () => this.model,
			hasConfiguredAuth: (model) => this._modelRegistry.hasConfiguredAuth(model),
			isUsingOAuth: (model) => this._modelRegistry.isUsingOAuth(model),
			getExtensionRunner: () => this._extensionRunner,
			flushPendingBashMessages: () => this._flushPendingBashMessages(),
			findLastAssistantMessage: () => this._findLastAssistantMessage(),
			checkCompaction: (assistantMessage, skipAbortedCheck) =>
				this._checkCompaction(assistantMessage, skipAbortedCheck),
			takePendingNextTurnMessages: () => {
				const messages = [...this._pendingNextTurnMessages];
				this._pendingNextTurnMessages = [];
				return messages;
			},
			checkToolFailures: () => this._checkToolFailures(),
			emit: (event) => this._emit(event),
			getBaseSystemPrompt: () => this._baseSystemPrompt,
			tryExecuteExtensionCommand: (text) => this._tryExecuteExtensionCommand(text),
			expandPromptText: (text) => {
				let expandedText = this._expandSkillCommand(text);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
				return expandedText;
			},
			queueSteer: (text, images) => this._queueSteer(text, images),
			queueFollowUp: (text, images) => this._queueFollowUp(text, images),
			resetXmlPromptState: () => this._xmlCoordinator.resetForPrompt(),
			waitForRetry: () => this.waitForRetry(),
			waitForEventLoop: () => this._eventLoopCoordinator.wait(),
			processXmlToolCalls: () => this._xmlCoordinator.process(),
		});
		this._extensionLifecycleCoordinator = new AgentSessionExtensionLifecycleCoordinator({
			getExtensionRunner: () => this._extensionRunner,
			getSessionStartEvent: () => this._sessionStartEvent,
			getCwd: () => this._cwd,
			getResourceLoader: () => this._resourceLoader,
			getActiveToolNames: () => this.getActiveToolNames(),
			rebuildSystemPrompt: (toolNames) => this._rebuildSystemPrompt(toolNames),
			applySystemPrompt: (prompt) => {
				this._baseSystemPrompt = prompt;
				this.agent.state.systemPrompt = prompt;
			},
		});
		this._toolRegistryCoordinator = new AgentSessionToolRegistryCoordinator({
			getModel: () => this.model,
			getExtensionRunner: () => this._extensionRunner,
			getBaseToolDefinitions: () => this._baseToolDefinitions,
			getCustomTools: () => this._customTools,
			getCurrentToolRegistryNames: () => [...this._toolRegistry.keys()],
			getCurrentActiveToolNames: () => this.getActiveToolNames(),
			normalizePromptSnippet: (text) => this._normalizePromptSnippet(text),
			normalizePromptGuidelines: (guidelines) => this._normalizePromptGuidelines(guidelines),
			setState: ({ toolDefinitions, toolPromptSnippets, toolPromptGuidelines, toolRegistry }) => {
				this._toolDefinitions = toolDefinitions;
				this._toolPromptSnippets = toolPromptSnippets;
				this._toolPromptGuidelines = toolPromptGuidelines;
				this._toolRegistry = toolRegistry;
			},
			applyActiveToolNames: (toolNames) => this.setActiveToolsByName(toolNames),
		});
		this._runtimeBootstrapCoordinator = new AgentSessionRuntimeBootstrapCoordinator({
			getCwd: () => this._cwd,
			getSessionManager: () => this.sessionManager,
			getSettingsManager: () => this.settingsManager,
			getResourceLoader: () => this._resourceLoader,
			getModelRegistry: () => this._modelRegistry,
			getBaseToolsOverride: () => this._baseToolsOverride,
			getCustomTools: () => this._customTools,
			getExtensionRunnerRef: () => this._extensionRunnerRef,
			getActiveToolNames: () => this.getActiveToolNames(),
			bindExtensionCore: (runner) => this._bindExtensionCore(runner),
			applyExtensionBindings: (runner) => this._applyExtensionBindings(runner),
			refreshToolRegistry: (options) => this._refreshToolRegistry(options),
			setBaseToolDefinitions: (definitions) => {
				this._baseToolDefinitions = definitions;
			},
			setExtensionRunner: (runner) => {
				this._extensionRunner = runner;
			},
			getCurrentModel: () => this.model,
			setCurrentModel: (model) => {
				this.agent.state.model = model;
			},
		});
		this._treeCoordinator = new AgentSessionTreeCoordinator({
			agent: this.agent,
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			getModel: () => this.model,
			getExtensionRunner: () => this._extensionRunner,
			getRequiredRequestAuth: (model) => this._getRequiredRequestAuth(model),
		});
		this._bashCoordinator = new AgentSessionBashCoordinator({
			agent: this.agent,
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
		});
		this._xmlCoordinator = new AgentSessionXmlCoordinator({
			agentState: {
				getMessages: () => this.agent.state.messages,
				setMessages: (messages) => {
					this.agent.state.messages = messages;
				},
				getSystemPrompt: () => this.agent.state.systemPrompt,
				setSystemPrompt: (prompt) => {
					this.agent.state.systemPrompt = prompt;
				},
				prompt: (messages) => this.agent.prompt(messages),
				continue: () => this.agent.continue(),
			},
			sessionManager: this.sessionManager,
			getActiveToolNames: () => this.getActiveToolNames(),
			getTool: (name) => this._toolRegistry.get(name),
			getExtensionRunner: () => this._extensionRunner,
			evaluateToolSafety: (toolName, args) => this._evaluateToolSafety(toolName, args),
			noteToolResult: (observation) => this._toolOrchestrator?.noteToolResult(observation),
			emit: (event) => this._emit(event),
			waitForRetry: () => this.waitForRetry(),
		});
		this._modelCoordinator = new AgentSessionModelCoordinator({
			agent: this.agent,
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			modelRegistry: this._modelRegistry,
			getExtensionRunner: () => this._extensionRunner,
			initialScopedModels: config.scopedModels,
		});

		// Restore persisted context window from settings
		const savedContextWindow = this.settingsManager.getContextWindow();
		if (savedContextWindow !== undefined) {
			this._customContextWindow = savedContextWindow;
		}

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
	}

	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}

	/**
	 * Replace the active tool safety policy for this session.
	 *
	 * The interactive mode uses this whenever the session changes or when the
	 * user toggles between interactive and autonomous execution. The policy is
	 * kept on the session because tool execution happens below the UI layer via
	 * Agent.beforeToolCall, and we need the guardrails to travel with the
	 * currently active session runtime.
	 */
	setToolSafetyPolicy(policy: ToolSafetyPolicy | undefined): void {
		this._toolSafety = policy;
	}

	get toolSafetyPolicy(): ToolSafetyPolicy | undefined {
		return this._toolSafety;
	}

	setToolPolicy(policy: TaskPolicy | undefined): void {
		this._toolOrchestrator = policy ? new ToolOrchestrator({ cwd: this.sessionManager.getCwd(), policy }) : undefined;
	}

	private async _getRequiredRequestAuth(model: Model<any>): Promise<{
		apiKey: string;
		headers?: Record<string, string>;
	}> {
		const result = await this._modelRegistry.getApiKeyAndHeaders(model);
		if (!result.ok) {
			throw new Error(result.error);
		}
		if (result.apiKey) {
			return { apiKey: result.apiKey, headers: result.headers };
		}

		const isOAuth = this._modelRegistry.isUsingOAuth(model);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}

		// Provider doesn't require authentication (e.g. local/LM Studio, Ollama)
		// Use a placeholder consistent with the provider layer's own handling
		return { apiKey: "not-needed", headers: result.headers };
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = async ({ assistantMessage, toolCall, args }) => {
			const batchBlock = this._evaluateControlledToolBatch(assistantMessage);
			if (batchBlock) return batchBlock;

			const runner = this._extensionRunner;
			if (!runner?.hasHandlers("tool_call")) {
				const safetyResult = await this._evaluateToolSafety(toolCall.name, args);
				return safetyResult;
			}

			await this._eventLoopCoordinator.wait();

			try {
				const extensionResult = await runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
				});
				if (extensionResult?.block) {
					return extensionResult;
				}
				return await this._evaluateToolSafety(toolCall.name, args);
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		};

		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			// Track structured tool calls (for XML fallback detection)
			this._xmlCoordinator.noteStructuredToolCall();
			this._toolOrchestrator?.noteToolResult({
				toolName: toolCall.name,
				args,
				result,
				isError,
			});
			this._recordWebResearchToolResult(toolCall.name, args, result, isError);
			const controlledStopDecision = this._toolOrchestrator?.getStopDecision();
			const controlledNextAction =
				!isError && !(controlledStopDecision?.shouldStop && controlledStopDecision.finalAnswerOnly)
					? this._toolOrchestrator?.getNextActionHint()
					: undefined;
			const controlledGuidanceText =
				!isError && controlledStopDecision?.shouldStop && controlledStopDecision.finalAnswerOnly
					? "\nControlled runtime: verification is complete. Do not call more tools. Provide the final summary now."
					: controlledNextAction
						? `\nControlled runtime: next required action: ${controlledNextAction}. Use exactly one tool call; do not call any other tool before this.`
						: undefined;
			const controlledGuidanceContent = controlledGuidanceText
				? [
						...(Array.isArray(result.content) ? result.content : []),
						{
							type: "text" as const,
							text: controlledGuidanceText,
						},
					]
				: undefined;

			// Track tool failures for resilience (always, regardless of extensions)
			if (isError) {
				// Check if this is a "not found" type error
				const contentText =
					typeof result.content === "string"
						? result.content
						: result.content?.map((c) => (c.type === "text" ? c.text : "")).join("") || "";

				if (
					contentText.toLowerCase().includes("not found") ||
					contentText.toLowerCase().includes("tool not found")
				) {
					this.recordToolFailure(toolCall.name);
				}
			} else {
				// Reset failure counter on success
				this.recordToolSuccess(toolCall.name);
			}

			const runner = this._extensionRunner;
			if (!runner?.hasHandlers("tool_result")) {
				return controlledGuidanceContent ? { content: controlledGuidanceContent } : undefined;
			}

			const hookResult = await runner.emitToolResult({
				type: "tool_result",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				input: args as Record<string, unknown>,
				content: result.content,
				details: isError ? undefined : result.details,
				isError,
			});

			if (!hookResult || isError) {
				return controlledGuidanceContent ? { content: controlledGuidanceContent } : undefined;
			}

			return {
				content: controlledGuidanceText
					? [
							...(hookResult.content ?? []),
							{
								type: "text" as const,
								text: controlledGuidanceText,
							},
						]
					: hookResult.content,
				details: hookResult.details,
			};
		};
	}

	private _evaluateControlledToolBatch(assistantMessage: AssistantMessage): { block: true; reason: string } | undefined {
		if (!this._toolOrchestrator) return undefined;
		const toolCalls = assistantMessage.content.filter((block) => block.type === "toolCall");
		if (toolCalls.length <= 1) return undefined;
		const turnKey = toolCalls.map((toolCall) => `${toolCall.id}:${toolCall.name}`).join("|");
		if (turnKey !== this._controlledToolTurnKey) {
			this._controlledToolTurnKey = turnKey;
			this._controlledToolCallsThisTurn = 0;
		}
		if (this._controlledToolCallsThisTurn > 0) {
			return {
				block: true,
				reason:
					"Controlled runtime: multiple tool calls in one assistant turn are blocked. Wait for the previous tool result and continue with exactly one next action.",
			};
		}
		this._controlledToolCallsThisTurn++;
		return undefined;
	}

	/**
	 * Evaluate the session's safety policy for a tool call.
	 *
	 * Returning a BeforeToolCallResult here lets us reuse the agent-core block
	 * path: blocked tools become normal error tool results in the transcript
	 * instead of throwing or tearing down the run.
	 */
	private async _evaluateToolSafety(toolName: string, args: unknown): Promise<{ block: true; reason: string } | undefined> {
		const orchestrationDecision = this._toolOrchestrator?.evaluate(toolName, args);
		if (orchestrationDecision && !orchestrationDecision.allow) {
			return {
				block: true,
				reason: orchestrationDecision.nextAction
					? `${orchestrationDecision.reason}\nNext allowed action: ${orchestrationDecision.nextAction}`
					: orchestrationDecision.reason,
			};
		}

		const webBudgetDecision = this._evaluateWebResearchBudget(toolName, args);
		if (webBudgetDecision) {
			return webBudgetDecision;
		}

		const policy = this._toolSafety;
		if (!policy) {
			return undefined;
		}

		const decision = evaluateToolSafety(toolName, args, policy);
		if (!decision.allow) {
			return {
				block: true,
				reason: decision.reason ?? `Tool ${toolName} was blocked by the active safety policy.`,
			};
		}

		if (!decision.approvalRequest) {
			return undefined;
		}

		const approvalHandler = policy.approvalHandler;
		if (!approvalHandler) {
			return {
				block: true,
				reason: `${decision.approvalRequest.summary} No interactive approval handler is available.`,
			};
		}

		const approved = await approvalHandler(decision.approvalRequest);
		if (approved) {
			return undefined;
		}

		return {
			block: true,
			reason: `User denied ${toolName} execution.`,
		};
	}

	private _evaluateWebResearchBudget(toolName: string, args: unknown): { block: true; reason: string } | undefined {
		if (this._webResearchBudgetDisabled) return undefined;
		const normalizedTool = toolName.toLowerCase();
		if (normalizedTool !== "websearch" && normalizedTool !== "webfetch") return undefined;

		const history = this._collectCurrentTurnWebResearchCalls();
		const runtimeState = this._webResearchRuntimeState;
		if (normalizedTool === "websearch") {
			const query = normalizeWebResearchValue(getStringArg(args, "query"));
			const duplicateQuery = query
				? [...history.webSearchQueries, ...runtimeState.searchQueries].find((entry) => isNearDuplicateWebSearch(entry, query))
				: undefined;
			if (duplicateQuery) {
				return {
					block: true,
					reason:
						"Web research budget: a duplicate or near-duplicate webSearch query already ran in the current user turn. Use prior results, fetch the strongest listed URL, or run a materially narrower query with new missing terms instead of repeating the same search.",
				};
			}
			const broaderAfterSpecific = query
				? [...history.webSearchQueries, ...runtimeState.searchQueries].find((entry) => isBroadWebResearchQueryAfterSpecific(entry, query))
				: undefined;
			if (broaderAfterSpecific) {
				return {
					block: true,
					reason:
						"Web research budget: a broader webSearch query would discard specificity from an earlier search in the current user turn. Use prior results or run a targeted follow-up query for the missing coverage slot instead.",
				};
			}
		}

		if (normalizedTool === "webfetch") {
			const parsedUrl = parseWebResearchUrl(getStringArg(args, "url"));
			const url = parsedUrl?.normalized;
			const sameUrlCount = url ? history.webFetchUrls.filter((entry) => entry === url).length : 0;
			const runtimeSameUrlCount = url ? runtimeState.fetches.filter((entry) => entry.url === url).length : 0;
			if (sameUrlCount > 0 || runtimeSameUrlCount > 0) {
				return {
					block: true,
					reason:
						"Web research budget: this URL has already been fetched in the current user turn. Reuse the previous fetch result instead of fetching it again.",
				};
			}
			if (parsedUrl?.host) {
				const placeholderPaths = runtimeState.placeholderHosts.get(parsedUrl.host) ?? [];
				const repeatedPlaceholderHost = placeholderPaths.some((path) => !areWebResearchPathsMateriallyDifferent(path, parsedUrl.path));
				if (repeatedPlaceholderHost) {
					return {
						block: true,
						reason:
							"Web research budget: this host already returned placeholder/interstitial content in the current user turn. Choose a different host or a materially different URL path instead of retrying the same blocked source.",
					};
				}
			}
			const requestedKind = parsedUrl ? this._inferWebFetchCoverageKindForUrl(parsedUrl.normalized) : undefined;
			if (
				(requestedKind === "current_events" || requestedKind === undefined)
				&& runtimeState.completedCoverageKinds.has("current_events")
			) {
				return {
					block: true,
					reason:
						"Web research budget: current-events coverage is already complete for this turn. Answer from the fetched evidence instead of fetching another article.",
				};
			}
			const docsComplete =
				(requestedKind === "docs" && runtimeState.authoritativeCompletedCoverageKinds.has("docs"))
				|| (requestedKind === "pricing" && runtimeState.authoritativeCompletedCoverageKinds.has("pricing"));
			if (docsComplete) {
				return {
					block: true,
					reason:
						"Web research budget: authoritative docs/pricing coverage is already complete for this turn. Answer from the existing authoritative fetch instead of fetching another docs page.",
				};
			}
		}

		return undefined;
	}

	private _collectCurrentTurnWebResearchCalls(): {
		webSearchQueries: string[];
		webFetchUrls: string[];
	} {
		const webSearchQueries: string[] = [];
		const webFetchUrls: string[] = [];
		const messages = this.agent.state.messages;
		let skippedCurrentAssistantMessage = false;
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index] as any;
			if (message?.role === "user") break;
			if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
			if (!skippedCurrentAssistantMessage) {
				skippedCurrentAssistantMessage = true;
				continue;
			}
			for (const item of message.content) {
				if (!item || item.type !== "toolCall") continue;
				const name = typeof item.name === "string" ? item.name.toLowerCase() : "";
				if (name === "websearch") {
					const query = normalizeWebResearchValue(getStringArg(item.arguments, "query"));
					if (query) webSearchQueries.push(query);
				} else if (name === "webfetch") {
					const url = normalizeWebResearchUrl(getStringArg(item.arguments, "url"));
					if (url) webFetchUrls.push(url);
				}
			}
		}
		return {
			webSearchQueries: webSearchQueries.reverse(),
			webFetchUrls: webFetchUrls.reverse(),
		};
	}

	private _inferWebFetchCoverageKindForUrl(url: string): WebResearchCoverageKind | undefined {
		const hintKind = extractWebResearchCoverageKind(getResearchUrlHint(url)?.coverageKind);
		if (hintKind) return hintKind;
		if (/pricing|billing|cost/i.test(url)) return "pricing";
		if (/changelog|release|releases|migration|upgrade/i.test(url)) return "release";
		if (/issues?|stackoverflow|error|bug/i.test(url)) return "error";
		if (/docs?|reference|api|manual|learn/i.test(url)) return "docs";
		return undefined;
	}

	private _recordWebResearchToolResult(toolName: string, args: unknown, result: unknown, isError: boolean): void {
		if (this._webResearchBudgetDisabled || isError) return;
		const normalizedTool = toolName.toLowerCase();
		if (normalizedTool !== "websearch" && normalizedTool !== "webfetch") return;

		if (normalizedTool === "websearch") {
			const query = normalizeWebResearchValue(getStringArg(args, "query"));
			if (query && !this._webResearchRuntimeState.searchQueries.includes(query)) {
				this._webResearchRuntimeState.searchQueries.push(query);
			}
			return;
		}

		const parsedUrl = parseWebResearchUrl(getStringArg(args, "url"));
		if (!parsedUrl) return;
		const details = result && typeof result === "object" ? (result as { details?: unknown }).details : undefined;
		const detailsRecord = details && typeof details === "object" ? details as Record<string, unknown> : {};
		const coverage = getWebResearchCoverageFromDetails(details);
		const coverageKind = coverage.kind ?? this._inferWebFetchCoverageKindForUrl(parsedUrl.normalized);
		const status = typeof detailsRecord.status === "string" ? detailsRecord.status : undefined;
		const authoritative = detailsRecord.authoritative === true;
		const fetchRecord: WebResearchRuntimeFetch = {
			url: parsedUrl.normalized,
			host: parsedUrl.host,
			path: parsedUrl.path,
			status,
			coverageKind,
			coverageComplete: coverage.complete,
			authoritative,
		};
		this._webResearchRuntimeState.fetches.push(fetchRecord);
		if (status === "placeholder" && parsedUrl.host) {
			const paths = this._webResearchRuntimeState.placeholderHosts.get(parsedUrl.host) ?? [];
			paths.push(parsedUrl.path);
			this._webResearchRuntimeState.placeholderHosts.set(parsedUrl.host, paths);
		}
		if (coverageKind && coverage.complete) {
			this._webResearchRuntimeState.completedCoverageKinds.add(coverageKind);
			if (authoritative) {
				this._webResearchRuntimeState.authoritativeCompletedCoverageKinds.add(coverageKind);
			}
		}
		if (coverageKind && coverage.missing.length > 0) {
			this._webResearchRuntimeState.missingCoverageByKind.set(coverageKind, coverage.missing);
		}
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		this._eventDispatcher.emit(event);
	}

	private _emitQueueUpdate(): void {
		this._eventDispatcher.emitQueueUpdate(this._steeringMessages, this._followUpMessages);
	}

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = (event: AgentEvent): void => {
		this._eventLoopCoordinator.handle(event);
	};

	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		await this._eventDispatcher.emitExtensionEvent(event);
	}

	/** Extract text content from a message */
	private _getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const content = message.content;
		if (typeof content === "string") return content;
		const textBlocks = content.filter((c) => c.type === "text");
		return textBlocks.map((c) => (c as TextContent).text).join("");
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		return this._eventDispatcher.subscribe(listener);
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	private _reconnectToAgent(): void {
		if (this._unsubscribeAgent) return; // Already connected
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {
		this._retryCoordinator.abort();
		this._compactionCoordinator.abort();
		this._treeCoordinator.abort();
		this._bashCoordinator.abort();
		this.agent.abort();
		this._disconnectFromAgent();
		this._eventDispatcher.clearListeners();
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Effective context window (custom override > LM Studio settings > model default) */
	get contextWindow(): number | undefined {
		if (!this.model) return undefined;
		return getEffectiveContextWindow(this.model, this._customContextWindow);
	}

	/** Set a custom context window override (in tokens). Pass undefined to use model default.
	 *  Also persists to settings for session reload persistence. */
	setCustomContextWindow(tokens: number | undefined): void {
		this._customContextWindow = tokens;
		// Persist to settings for session reload
		this.settingsManager.setContextWindow(tokens);
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this._modelCoordinator.thinkingLevel;
	}

	/** Whether agent is currently streaming a response */
	get isStreaming(): boolean {
		return this.agent.state.isStreaming;
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryCoordinator.currentAttempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this._toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.agent.state.tools = tools;

		// Rebuild base system prompt with new tool set
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return this._compactionCoordinator.isCompacting || this._treeCoordinator.isRunning;
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._modelCoordinator.scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._modelCoordinator.setScopedModels(scopedModels);
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _fallbackPromptSnippetFromDescription(text: string | undefined): string | undefined {
		const normalized = this._normalizePromptSnippet(text);
		if (!normalized) return undefined;
		return normalized.length > 140 ? `${normalized.slice(0, 137).trimEnd()}...` : normalized;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const definition = this._toolDefinitions.get(name)?.definition;
			const snippet =
				this._toolPromptSnippets.get(name) ?? this._fallbackPromptSnippetFromDescription(definition?.description);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt =
			loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		return buildSystemPrompt({
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
			modelProvider: this.model?.provider,
			contextWindow: this.contextWindow,
		});
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	/**
	 * Check for repeated tool failures and inject a corrective message if needed.
	 * Returns a custom message to inject, or undefined if no correction needed.
	 */
	private _checkToolFailures(): { message: CustomMessage | undefined; warnings: Array<{ toolName: string; failureCount: number; correctiveMessage: string }> } {
		return this._toolFailureCoordinator.preparePromptInjection(this.getActiveToolNames());
	}

	/**
	 * Record a tool failure for resilience tracking.
	 */
	recordToolFailure(toolName: string): void {
		this._toolFailureCoordinator.recordFailure(toolName);
	}

	/**
	 * Record a tool success and reset failure counter.
	 */
	recordToolSuccess(toolName: string): void {
		this._toolFailureCoordinator.recordSuccess(toolName);
	}

	/**
	 * Reset tool failure tracking (e.g., after user intervention).
	 */
	resetToolFailures(): void {
		this._toolFailureCoordinator.reset();
	}

	async prompt(text: string, options?: PromptOptions): Promise<void> {
		this._webResearchRuntimeState = createWebResearchRuntimeState();
		const promptOptions: AgentSessionPromptOptions | undefined = options;
		await this._promptCoordinator.prompt(text, promptOptions);
	}

	/**
	 * Trigger XML fallback processing outside the normal prompt lifecycle.
	 * Useful for single-shot/headless flows where a weak model may emit XML in a
	 * final assistant message before the outer prompt promise settles cleanly.
	 */
	async recoverXmlToolCallsNow(): Promise<void> {
		await this._eventLoopCoordinator.wait();
		await this._processXmlToolCalls();
	}

	/**
	 * Process XML tool calls from the last assistant response.
	 * Handles models (like Qwen3.5) that emit tool calls in XML format.
	 */
	private async _processXmlToolCalls(): Promise<void> {
		await this._xmlCoordinator.process();
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		if (!this._extensionRunner) return false;

		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this._extensionRunner?.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueSteer(expandedText, images);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueFollowUp(expandedText, images);
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		this._steeringMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		this._followUpMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.followUp({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		if (!this._extensionRunner) return;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			if (message.display === false) {
				// Keep only the most recent hidden runtime hint of a given type for the next turn.
				this._pendingNextTurnMessages = this._pendingNextTurnMessages.filter(
					(existing) => !(existing.display === false && existing.customType === message.customType),
				);
			}
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			await this.agent.prompt(appMessage);
		} else {
			if (message.display === false) {
				// Hidden runtime/control messages are ephemeral steering state; keep the newest one in live session state.
				this.agent.state.messages = this.agent.state.messages.filter(
					(existing) => !(existing.role === "custom" && existing.display === false && existing.customType === message.customType),
				);
			}
			this.agent.state.messages.push(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			this._emit({ type: "message_start", message: appMessage });
			this._emit({ type: "message_end", message: appMessage });
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
		await this.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		this._steeringMessages = [];
		this._followUpMessages = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		this.abortRetry();
		this.agent.abort();
		await this.agent.waitForIdle();
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured, saves to session and settings.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>): Promise<void> {
		await this._modelCoordinator.setModel(model);
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		return this._modelCoordinator.cycleModel(direction);
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves to session and settings only if the level actually changes.
	 */
	setThinkingLevel(level: ThinkingLevel): void {
		this._modelCoordinator.setThinkingLevel(level);
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		return this._modelCoordinator.cycleThinkingLevel();
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		return this._modelCoordinator.getAvailableThinkingLevels();
	}

	/**
	 * Check if current model supports xhigh thinking level.
	 */
	supportsXhighThinking(): boolean {
		return this._modelCoordinator.supportsXhighThinking();
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return this._modelCoordinator.supportsThinking();
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		return this._compactionCoordinator.compact(customInstructions);
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._compactionCoordinator.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._treeCoordinator.abort();
	}

	/**
	 * Check if compaction is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Two cases:
	 * 1. Overflow: LLM returned context overflow error, remove error message from agent state, compact, auto-retry
	 * 2. Threshold: Context over threshold, compact, NO auto-retry (user continues manually)
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 */
	private async _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<void> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled) return;

		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return;

		const contextWindow = this.contextWindow ?? 0;
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return;
		}

		if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
			if (this._compactionCoordinator.hasOverflowRecoveryAttempted) {
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
				});
				return;
			}

			this._compactionCoordinator.markOverflowRecoveryAttempted();
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			await this._runAutoCompaction("overflow", true);
			return;
		}

		let contextTokens: number;
		if (assistantMessage.stopReason === "error") {
			const messages = this.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			if (estimate.lastUsageIndex === null) return;
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				compactionEntry &&
				usageMsg.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
			) {
				return;
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = calculateContextTokens(assistantMessage.usage);
		}

		if (shouldCompact(contextTokens, contextWindow, settings)) {
			await this._runAutoCompaction("threshold", false);
		}
	}

	/**
	 * Internal: Run auto-compaction with events.
	 * Uses the 4-layer compaction strategy: micro-compact → snip → auto-compact → PTL retry.
	 */
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<void> {
		await this._compactionCoordinator.runAuto(reason, willRetry);
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		await this._extensionLifecycleCoordinator.bindExtensions(bindings);
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		this._extensionLifecycleCoordinator.applyBindings(runner);
	}

	private _refreshCurrentModelFromRegistry(): void {
		this._runtimeBootstrapCoordinator.refreshCurrentModelFromRegistry();
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		this._extensionCoreCoordinator = new AgentSessionExtensionCoreCoordinator({
			runner,
			modelRegistry: this._modelRegistry,
			getCommands,
			sendCustomMessage: (message, options) => this.sendCustomMessage(message, options),
			sendUserMessage: (content, options) => this.sendUserMessage(content, options),
			appendEntry: (customType, data) => {
				this.sessionManager.appendCustomEntry(customType, data);
			},
			setSessionName: (name) => {
				this.sessionManager.appendSessionInfo(name);
			},
			getSessionName: () => this.sessionManager.getSessionName(),
			setLabel: (entryId, label) => {
				this.sessionManager.appendLabelChange(entryId, label);
			},
			getActiveTools: () => this.getActiveToolNames(),
			getAllTools: () => this.getAllTools(),
			setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
			refreshTools: () => this._refreshToolRegistry(),
			setModel: (model) => this.setModel(model),
			getThinkingLevel: () => this.thinkingLevel,
			setThinkingLevel: (level) => this.setThinkingLevel(level),
			getModel: () => this.model,
			isIdle: () => !this.isStreaming,
			getSignal: () => this.agent.signal,
			abort: () => {
				void this.abort();
			},
			hasPendingMessages: () => this.pendingMessageCount > 0,
			shutdown: () => {
				this._extensionLifecycleCoordinator.shutdownHandler?.();
			},
			getContextUsage: () => this.getContextUsage(),
			compact: (options) => {
				void (async () => {
					try {
						const result = await this.compact(options?.customInstructions);
						options?.onComplete?.(result);
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						options?.onError?.(err);
					}
				})();
			},
			getSystemPrompt: () => this.systemPrompt,
			refreshCurrentModelFromRegistry: () => this._refreshCurrentModelFromRegistry(),
		});
		this._extensionCoreCoordinator.bind();
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		this._toolRegistryCoordinator.refresh(options);
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		this._runtimeBootstrapCoordinator.buildRuntime(options);
	}

	async reload(): Promise<void> {
		await this._runtimeBootstrapCoordinator.reload();

		const hasBindings =
			this._extensionLifecycleCoordinator.uiContext ||
			this._extensionLifecycleCoordinator.commandContextActions ||
			this._extensionLifecycleCoordinator.shutdownHandler ||
			this._extensionLifecycleCoordinator.errorListener;
		if (this._extensionRunner && hasBindings) {
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			await this._extensionLifecycleCoordinator.extendResourcesFromExtensions("reload");
		}
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		return this._retryCoordinator.isRetryableError(message);
	}

	/**
	 * Handle retryable errors with exponential backoff.
	 * @returns true if retry was initiated, false if max retries exceeded or disabled
	 */
	private async _handleRetryableError(message: AssistantMessage): Promise<boolean> {
		return this._retryCoordinator.handleRetryableError(message);
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryCoordinator.abort();
	}

	/**
	 * Wait for any in-progress retry to complete.
	 * Returns immediately if no retry is in progress.
	 */
	private async waitForRetry(): Promise<void> {
		await this._retryCoordinator.wait();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryCoordinator.isRetrying;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; operations?: BashOperations },
	): Promise<BashResult> {
		return this._bashCoordinator.execute(command, onChunk, options);
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		this._bashCoordinator.record(command, result, options);
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		this._bashCoordinator.abort();
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashCoordinator.isRunning;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._bashCoordinator.hasPendingMessages;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		this._bashCoordinator.flushPending();
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		return this._treeCoordinator.navigateTree(targetId, options);
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this._extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	private _extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
		}
		return "";
	}

	/**
	 * Get session statistics.
	 */
	getSessionStats(): SessionStats {
		return buildAgentSessionStats({
			state: this.state,
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			contextUsage: this.getContextUsage(),
		});
	}

	getContextUsage(): ContextUsage | undefined {
		return deriveAgentSessionContextUsage({
			contextWindow: this.contextWindow,
			messages: this.messages,
			sessionManager: this.sessionManager,
		});
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		return exportAgentSessionHtml({
			sessionManager: this.sessionManager,
			state: this.state,
			outputPath,
			themeName: this.settingsManager.getTheme() ?? "dark",
			getToolDefinition: (name) => this.getToolDefinition(name),
			cwd: this.sessionManager.getCwd(),
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		return exportAgentSessionJsonl({
			sessionManager: this.sessionManager,
			outputPath,
		});
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		return getLastAgentAssistantText(this.messages);
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner?.hasHandlers(eventType) ?? false;
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner | undefined {
		return this._extensionRunner;
	}
}
