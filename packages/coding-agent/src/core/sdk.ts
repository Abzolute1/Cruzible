import { join } from "node:path";
import { Agent, type AgentMessage, type ThinkingLevel } from "@ag1/agent-core";
import type { Message, Model } from "@ag1/ai";
import { getAgentDir, getDocsPath } from "../config.js";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import {
	type ContextHygieneOptions,
	createContextHygieneCopy,
	createLiveProviderContext,
} from "./compaction/micro-compact.js";
import { createContextAuditLogger } from "./context-audit-log.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import type { ExtensionRunner, LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.js";
import { convertToLlm } from "./messages.js";
import { inferModelCapabilityProfile } from "./model-capability-profile.js";
import { ModelRegistry } from "./model-registry.js";
import { findInitialModel } from "./model-resolver.js";
import { createResilientStreamFn } from "./nvidia-stream-fallback.js";
import {
	cacheHitRatio,
	capturePrefixShape,
	comparePrefixShape,
	type PrefixChangeReason,
	type PrefixShape,
	type PrefixShapeUsage,
} from "./prefix-shape.js";
import type { ResourceLoader } from "./resource-loader.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import type { ToolSafetyPolicy } from "./safety-policy.js";
import { getDefaultSessionDir, SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import type { TaskPolicy } from "./task-policy.js";
import { time } from "./timings.js";
import {
	allTools,
	bashTool,
	codingTools,
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	editTool,
	findTool,
	grepTool,
	isTaskToolDisabled,
	lsTool,
	readOnlyTools,
	readTool,
	type Tool,
	type ToolName,
	withFileMutationQueue,
	writeTool,
} from "./tools/index.js";

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.ag1/agent */
	agentDir?: string;

	/** Auth storage for credentials. Default: AuthStorage.create(agentDir/auth.json) */
	authStorage?: AuthStorage;
	/** Model registry. Default: ModelRegistry.create(authStorage, agentDir/models.json) */
	modelRegistry?: ModelRegistry;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/** Built-in tools to use. Default: codingTools [read, bash, edit, write] */
	tools?: Tool[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;

	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
	/** Optional tool safety policy for the created session. */
	toolSafety?: ToolSafetyPolicy;
	/** Optional controlled-runtime tool policy for the created session. */
	toolPolicy?: TaskPolicy;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
}

// Re-exports

export * from "./agent-session-runtime.js";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.js";
export type { PromptTemplate } from "./prompt-templates.js";
export type { Skill } from "./skills.js";
export type { Tool } from "./tools/index.js";

export {
	// Pre-built tools (use process.cwd())
	readTool,
	bashTool,
	editTool,
	writeTool,
	grepTool,
	findTool,
	lsTool,
	codingTools,
	readOnlyTools,
	allTools as allBuiltInTools,
	withFileMutationQueue,
	// Tool factories (for custom cwd)
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

/** Hit-ratio drop (fraction points) vs the previous turn that triggers miss-reason attribution. */
const CACHE_HIT_RATIO_DROP_THRESHOLD = 0.2;

/** Usage of the most recent completed assistant turn, for cache-hit attribution. */
function findLastTurnUsage(messages: AgentMessage[]): PrefixShapeUsage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant" && "usage" in message && message.usage) {
			return { cacheReadTokens: message.usage.cacheRead, inputTokens: message.usage.input };
		}
	}
	return undefined;
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@ag1/ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: [readTool, bashTool],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getDefaultAgentDir();
	let resourceLoader = options.resourceLoader;

	// Use provided or create AuthStorage and ModelRegistry
	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const authStorage = options.authStorage ?? AuthStorage.create(authPath);
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, modelsPath);

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// Check if session has existing data to restore
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	let modelFallbackMessage: string | undefined;

	// If no model was requested, restore the model recorded in the session. Note this must
	// NOT depend on message count: workspace switching (autonomous isolation) re-creates
	// sessions that carry a model in their header with zero messages — without restoring
	// it, resolution silently falls back to pickPreferredAvailableModel (e.g. local) and
	// CLI/default model choices are lost across the switch.
	if (!model && existingSession.model) {
		const restoredModel = modelRegistry.find(existingSession.model.provider, existingSession.model.modelId);
		if (restoredModel && modelRegistry.hasConfiguredAuth(restoredModel)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
	}

	// If still no model, use findInitialModel (checks settings default, then provider defaults)
	if (!model) {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelRegistry,
		});
		if (result.error) {
			throw new Error(result.error);
		}
		model = result.model;
		if (!model) {
			modelFallbackMessage = `No models available. Use /login or set an API key environment variable. See ${join(getDocsPath(), "providers.md")}. Then use /model to select a model.`;
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	let thinkingLevel = options.thinkingLevel;

	// If session has data, restore thinking level from it
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// Fall back to settings default
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	if (!model || !model.reasoning) {
		thinkingLevel = "off";
	}

	const defaultActiveToolNames: string[] = [
		"read",
		"grep",
		"find",
		"ls",
		"bash",
		"edit",
		"write",
		"webSearch",
		"webFetch",
		"todo",
	];
	if (!isTaskToolDisabled()) {
		defaultActiveToolNames.push("task");
	}
	const initialActiveToolNames: string[] = options.tools
		? options.tools.map((t) => t.name).filter((n): n is ToolName => n in allTools)
		: defaultActiveToolNames;
	const modelCapabilityProfile = model ? inferModelCapabilityProfile(model) : undefined;
	const contextHygieneOptions: ContextHygieneOptions | undefined =
		modelCapabilityProfile?.recommendedCompactionPolicy === "local_small"
			? {
					keepTurns: 1,
					maxToolResultChars: 160,
					maxHiddenCustomChars: 100,
				}
			: modelCapabilityProfile?.toolCallReliability === "medium"
				? {
						keepTurns: 2,
						maxToolResultChars: 180,
						maxHiddenCustomChars: 140,
					}
				: undefined;
	const contextAuditMetadata = model
		? {
				model: {
					provider: model.provider,
					id: model.id,
					api: model.api,
					contextWindow: model.contextWindow,
				},
				modelCapabilityProfile,
			}
		: {};

	let agent: Agent;
	const contextAuditLogger = createContextAuditLogger({
		sessionId: sessionManager.getSessionId(),
		cwd,
	});
	// Prefix-shape attribution state: tracks the previous request's prefix shape and the
	// cache-hit ratio of the previous completed turn, so a meaningful ratio drop can be
	// attributed to the prefix change recorded when that turn's request was built.
	let prevPrefixShape: PrefixShape | undefined;
	let prevPrefixChangeReasons: PrefixChangeReason[] = [];
	let prevCacheHitRatio: number | undefined;

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const contextReadyMessages = createContextHygieneCopy(messages, contextHygieneOptions, undefined);
		const liveProviderMessages = createLiveProviderContext(contextReadyMessages);
		const converted = convertToLlm(liveProviderMessages);
		const prefixShape = capturePrefixShape(
			agent?.state.systemPrompt ?? "",
			agent?.state.tools ?? [],
			sessionManager.getBranch().reduce((count, entry) => (entry.type === "compaction" ? count + 1 : count), 0),
		);
		const turnUsage = findLastTurnUsage(messages);
		const currentCacheHitRatio = cacheHitRatio(turnUsage);
		const prefixChangeReasons = comparePrefixShape(prevPrefixShape, prefixShape, turnUsage).reasons;
		const missReasons =
			currentCacheHitRatio !== undefined &&
			prevCacheHitRatio !== undefined &&
			prevCacheHitRatio - currentCacheHitRatio > CACHE_HIT_RATIO_DROP_THRESHOLD
				? prevPrefixChangeReasons
				: [];
		prevPrefixShape = prefixShape;
		prevPrefixChangeReasons = prefixChangeReasons;
		if (currentCacheHitRatio !== undefined) {
			prevCacheHitRatio = currentCacheHitRatio;
		}
		const runtimeAuditMetadata = {
			...contextAuditMetadata,
			contextHygieneOptions,
			systemPromptChars: agent?.state.systemPrompt.length ?? 0,
			prefixShape: {
				prefixHash: prefixShape.prefixHash,
				cacheReadTokens: turnUsage?.cacheReadTokens ?? 0,
				inputTokens: turnUsage?.inputTokens ?? 0,
				cacheHitRatio: currentCacheHitRatio ?? null,
				missReasons,
			},
		};
		// Check setting dynamically so mid-session changes take effect
		if (!settingsManager.getBlockImages()) {
			contextAuditLogger.write(converted, {
				...runtimeAuditMetadata,
				sourceMessageCount: messages.length,
				contextReadyMessageCount: contextReadyMessages.length,
			});
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		const filtered = converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// Dedupe consecutive "Image reading is disabled." texts
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
		contextAuditLogger.write(filtered, {
			...runtimeAuditMetadata,
			sourceMessageCount: messages.length,
			contextReadyMessageCount: contextReadyMessages.length,
			blockImages: true,
		});
		return filtered;
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
		},
		convertToLlm: convertToLlmWithBlockImages,
		streamFn: createResilientStreamFn(modelRegistry),
		onPayload: async (payload, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getRetrySettings().maxDelayMs,
	});

	// Restore messages if session has existing data
	if (hasExistingSession) {
		agent.state.messages = existingSession.messages;
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// Save initial model and thinking level for new sessions so they can be restored on resume
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools: options.customTools,
		modelRegistry,
		initialActiveToolNames,
		extensionRunnerRef,
		sessionStartEvent: options.sessionStartEvent,
		toolSafety: options.toolSafety,
		toolPolicy: options.toolPolicy,
	});
	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
	};
}
