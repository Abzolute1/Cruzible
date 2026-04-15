import type { ImageContent } from "@mariozechner/pi-ai";
import type { AgentSessionEvent } from "../agent-session.js";
import type { AgentSessionRuntime } from "../agent-session-runtime.js";
import { SessionDebugLogger } from "../session-debug-logger.js";
import { attachAutonHook, type BudgetStatus } from "./auton-hook.js";
import { getAutoCompactTrigger, selectCompactionPolicy } from "./compaction-policy.js";
import {
	applyAutonomousLedgerEvents,
	appendAutonomousRunSnapshotState,
	createAutonomousRunSnapshot,
	buildAutonomousCompactionInstructions,
	createAutonomousRunSnapshotFromState,
	createAutonomousRunLedger,
	formatAutonomousContinuationLedger,
	formatAutonomousPromptLedger,
	formatAutonomousRunLedger,
	hasSufficientResearchEvidence,
	updateAutonomousRunLedger,
	type AutonomousRunSnapshot,
	type AutonomousRunCheckpointPhase,
	type AutonomousLedgerEvent,
	type AutonomousRunLedger,
} from "./ledger.js";
import { evaluateNudgeWithCooldown, getNudgeMessage, type NudgeContext } from "./nudges/nudge-eval.js";
import { OutputTrendTracker } from "./nudges/output-trend.js";
import type { NudgeCooldownState, ToolOutcome } from "./nudges/types.js";

export interface AutonomousRunConfig {
	/** Maximum spend for a single autonomous run. 0 means unlimited. */
	maxCostUsd?: number;
	/** Maximum total tokens for a single autonomous run. 0 means unlimited. */
	maxTokens?: number;
	/** Maximum autonomous turns before the run stops. */
	maxTurns?: number;
	/** Reserved for future per-turn output caps. */
	maxOutputPerTurn?: number;
	/** Whether the nudge engine is active during autonomous runs. */
	enableNudges?: boolean;
	/** Whether to append the autonomous behavioral prompt during the run. */
	enableBehavioralPrompt?: boolean;
	/** Emit verbose autonomous diagnostics to stderr. */
	verbose?: boolean;
}

export interface AutonomousRunResult {
	iterations: number;
	stopReason: "budget" | "nudge" | "complete" | "error" | "max_iterations" | "unknown";
	budgetStatus: BudgetStatus;
	costSummary: string;
	checkpointState: AutonomousCheckpointState;
	ledger: AutonomousRunLedger;
}

export interface AutonomousRunOptions {
	runtimeHost: AgentSessionRuntime;
	userMessage: string;
	initialImages?: ImageContent[];
	config?: AutonomousRunConfig;
	resumeSnapshot?: AutonomousRunSnapshot;
	projectRoot: string;
	getToolCallHistory: () => ToolOutcome[];
	getFileAccessHistory: () => ToolOutcome[];
	onStatus?: (status: string) => void;
	onCheckpoint?: (snapshot: AutonomousRunSnapshot) => void;
	onError?: (message: string) => void;
}

export interface AutonomousCheckpointState {
	consecutiveNoToolTurns: number;
	completionPromptCount: number;
	verificationPromptCount: number;
	truncatedTurnCount: number;
	outputCapPromptCount: number;
	consecutiveIntentDriftCount: number;
	consecutiveIntentFailureCount: number;
	replanPromptCount: number;
	narrowScopePromptCount: number;
	budgetPressureLevel: BudgetPressureLevel;
	budgetTrimPromptCount: number;
	budgetSqueezePromptCount: number;
	lastAssessment: TurnAssessmentKind;
	verificationSatisfied: boolean;
	lastVerificationDetail?: string;
	consecutiveDegradedTurnCount?: number;
	consecutiveCriticalDegradedTurnCount?: number;
	lastDegradedTurnSeverity?: "elevated" | "critical";
	lastDegradedTurnReasons?: string[];
}

type TurnAssessmentKind =
	| "continue"
	| "confirm_completion"
	| "confirm_verification"
	| "truncated"
	| "complete"
	| "error";

type IntentAssessmentOutcome = "on_track" | "drifted" | "failed";
type BudgetPressureLevel = "normal" | "elevated" | "high" | "critical";

type IntentControlDirective =
	| { kind: "none" }
	| { kind: "recover"; detail: string }
	| { kind: "replan"; detail: string }
	| { kind: "narrow_scope"; detail: string }
	| { kind: "stop_blocked"; detail: string };

type BudgetControlDirective =
	| { kind: "none"; level: BudgetPressureLevel }
	| { kind: "trim"; level: BudgetPressureLevel; detail: string }
	| { kind: "squeeze"; level: BudgetPressureLevel; detail: string };

const MAX_AUTON_ITERATIONS = 200;
const TERMINAL_STOP_REASONS = new Set(["end_turn", "stop"]);
const TRUNCATED_STOP_REASONS = new Set(["max_tokens", "length"]);
const EXPLICIT_COMPLETION_PATTERNS = [
	/\b(task|work|implementation|fix|changes?)\s+(is\s+)?(complete|completed|done|finished)\b/i,
	/\b(successfully\s+)?(completed|finished|resolved|implemented)\b/i,
	/\bno\s+(further|more)\s+(changes|work|action)\s+(are\s+)?needed\b/i,
	/\bnothing\s+else\s+to\s+do\b/i,
	/\ball\s+requested\s+work\s+(is\s+)?done\b/i,
];
const INCOMPLETE_PATTERNS = [
	/\b(still|remaining|left to do|next step|next steps)\b/i,
	/\bneed(?:s)?\s+to\b/i,
	/\bshould\s+(now|next)\b/i,
	/\bcan\s+(continue|proceed)\b/i,
	/\bask(?:ing)?\s+for\s+confirmation\b/i,
	/\?\s*$/m,
];
const VERIFICATION_COMMAND_PATTERNS = [
	/\b(test|tests)\b/i,
	/\bvitest\b/i,
	/\bjest\b/i,
	/\bpytest\b/i,
	/\bcargo test\b/i,
	/\bgo test\b/i,
	/\bplaywright test\b/i,
	/\blint\b/i,
	/\beslint\b/i,
	/\btypecheck\b/i,
	/\btsc\b/i,
	/\bbuild\b/i,
	/\bcheck\b/i,
];
const READ_TOOL_NAMES = new Set(["read", "read_file"]);
const MUTATING_TOOL_NAMES = new Set(["edit", "write", "str_replace_editor", "notebook_edit"]);
const VERIFICATION_TOOL_NAMES = new Set(["verify"]);
const VISUAL_VERIFICATION_TOOL_NAMES = new Set(["screenshot_url", "interact_then_screenshot"]);
const RESEARCH_TOOL_NAMES = new Set(["webSearch", "webFetch"]);
const FRONTEND_TASK_PATTERNS = [
	/\b(frontend|ui|ux|layout|styling|style|css|tailwind|component|responsive|mobile|browser|page|visual|screenshot)\b/i,
	/\b(html|jsx|tsx|react|vue|svelte|next\.js|vite)\b/i,
];
const FRONTEND_FILE_PATTERNS = [/\.(css|scss|sass|less|html|tsx|jsx|vue|svelte)$/i];
const RESEARCH_TASK_PATTERNS = [
	/\b(latest|current|today|recent|release|version|changelog|breaking changes?)\b/i,
	/\b(documentation|docs|api reference|reference|guide|manual|spec)\b/i,
	/\b(research|search online|web search|search the web|look up|external source|citation|source url)\b/i,
	/\b(compare|comparison|pricing|availability|compatibility)\b/i,
];
const VERIFY_ONLY_TASK_PATTERNS = [/\b(verify|verification|check|validate|review|inspect|assess|audit|confirm)\b/i];
const IMPLEMENTATION_TASK_PATTERNS = [
	/\b(fix|improve|update|change|modify|edit|implement|build|add|create|refactor|tighten|rewrite|replace)\b/i,
];

const BUDGET_EXCEEDED_ERROR_PATTERNS = [/\b(?:cost|token|turn)\s+budget exceeded\b/i, /\bbudget limit reached\b/i];

export async function runAutonomousSession(options: AutonomousRunOptions): Promise<AutonomousRunResult> {
	const {
		runtimeHost,
		userMessage,
		initialImages,
		config = {},
		resumeSnapshot,
		projectRoot,
		getToolCallHistory,
		getFileAccessHistory,
		onStatus,
		onCheckpoint,
		onError,
	} = options;

	const session = runtimeHost.session;
	const debugLogger = new SessionDebugLogger({
		session,
		projectRoot,
	});
	debugLogger.start();

	const previousSystemPrompt = session.agent.state.systemPrompt;
	const modelId = session.model?.id ?? "unknown";
	const autonHook = attachAutonHook(runtimeHost, modelId, {
		maxCostUsd: config.maxCostUsd ?? 0,
		maxTokens: config.maxTokens ?? 0,
		maxTurns: config.maxTurns ?? 100,
		maxOutputPerTurn: config.maxOutputPerTurn ?? 0,
		enableNudges: config.enableNudges ?? true,
		enableBehavioralPrompt: config.enableBehavioralPrompt ?? true,
		verbose: config.verbose ?? false,
	});

	const trendTracker = new OutputTrendTracker();
	const nudgeCooldown: NudgeCooldownState = {
		lastNudgeType: null,
		lastNudgeTurn: 0,
		escalationLevel: 0,
	};

	let iterations = resumeSnapshot?.iterations ?? 0;
	let stopReason: AutonomousRunResult["stopReason"] = "unknown";
	let lastTurnHadToolCalls = false;
	let lastTurnFinishReason: string | undefined;
	let lastTurnOutputTokens = 0;
	let lastTurnDegradedEvent: Extract<AgentSessionEvent, { type: "degraded_turn" }> | undefined;
	let finalBudgetStatus = autonHook.getBudgetStatus();
	let finalCostSummary = autonHook.getCostSummary();
	let checkpointState: AutonomousCheckpointState = resumeSnapshot?.checkpointState ?? {
		consecutiveNoToolTurns: 0,
		completionPromptCount: 0,
		verificationPromptCount: 0,
		truncatedTurnCount: 0,
		outputCapPromptCount: 0,
		consecutiveIntentDriftCount: 0,
		consecutiveIntentFailureCount: 0,
		replanPromptCount: 0,
		narrowScopePromptCount: 0,
		budgetPressureLevel: "normal",
		budgetTrimPromptCount: 0,
		budgetSqueezePromptCount: 0,
		lastAssessment: "continue",
		verificationSatisfied: false,
		consecutiveDegradedTurnCount: 0,
		consecutiveCriticalDegradedTurnCount: 0,
	};
	let ledger = resumeSnapshot?.ledger ?? createAutonomousRunLedger(userMessage);
	const visualVerificationAvailable = sessionHasVisualVerificationTools(session);
	const researchToolsAvailable = sessionHasResearchTools(session);
	let initialTurnIntentPending = true;
	let consumedToolHistoryLength = 0;
	let consumedFileAccessHistoryLength = 0;
	const persistCheckpoint = (phase: AutonomousRunCheckpointPhase, statusOverride?: AutonomousRunResult["stopReason"]): void => {
		const snapshot = createAutonomousRunSnapshotFromState({
			phase,
			iterations,
			stopReason: statusOverride ?? stopReason,
			costSummary: autonHook.getCostSummary(),
			budgetStatus: autonHook.getBudgetStatus(),
			checkpointState,
			ledger,
		});
		appendAutonomousRunSnapshotState(session.sessionManager, snapshot);
		onCheckpoint?.(snapshot);
	};

	const loopUnsub = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "xml_tool_call" || event.type === "tool_execution_start") {
			lastTurnHadToolCalls = true;
		}
		if (event.type === "degraded_turn") {
			lastTurnDegradedEvent = event;
		}
		if (event.type === "message_end" || event.type === "agent_end") {
			const msgs = session.agent.state.messages;
			const lastMsg = msgs[msgs.length - 1] as any;
			if (lastMsg?.stopReason) {
				lastTurnFinishReason = lastMsg.stopReason;
			}
			if (lastMsg?.usage?.output) {
				lastTurnOutputTokens = lastMsg.usage.output;
				trendTracker.record(lastMsg.usage.output);
			}
		}
	});

	try {
		const nudgesEnabled = config.enableNudges ?? true;
		onStatus?.(resumeSnapshot ? "Autonomous mode resuming..." : "Autonomous mode starting...");
		persistCheckpoint("initial");
		await session.prompt(
			resumeSnapshot
				? buildResumeAutonomousPrompt(userMessage, researchToolsAvailable, resumeSnapshot)
				: buildInitialAutonomousPrompt(userMessage, researchToolsAvailable),
			{ images: initialImages },
		);

		while (iterations < MAX_AUTON_ITERATIONS) {
			const budget = autonHook.getBudgetStatus();
			if (!budget.costAuthoritative && (config.maxCostUsd ?? 0) > 0 && budget.costUsed >= (config.maxCostUsd ?? 0)) {
				process.stderr.write(
					`[Auton] Cost estimate crossed configured budget ($${budget.costUsed.toFixed(2)} used), but pricing is non-authoritative so execution continues.\n`,
				);
			}
			if (budget.exceeded.cost || budget.exceeded.tokens || budget.exceeded.turns) {
				const reasons: string[] = [];
				if (budget.exceeded.cost) reasons.push(`cost $${budget.costUsed.toFixed(2)}`);
				if (budget.exceeded.tokens) reasons.push(`${budget.tokensUsed.toLocaleString()} tokens`);
				if (budget.exceeded.turns) reasons.push(`${budget.turnsUsed} turns`);
				process.stderr.write(`[Auton] Budget limit reached: ${reasons.join(", ")}\n`);
				ledger = { ...ledger, status: "budget" };
				stopReason = "budget";
				persistCheckpoint("pre_turn", "budget");
				break;
			}
			const budgetPressure = getBudgetPressure(budget, config);
			checkpointState = {
				...checkpointState,
				budgetPressureLevel: budgetPressure.level,
			};

			const toolHistory = getToolCallHistory();
			const fileAccessHistory = getFileAccessHistory();
			const observedTurnToolCalls =
				lastTurnHadToolCalls ||
				toolHistory.length > consumedToolHistoryLength ||
				fileAccessHistory.length > consumedFileAccessHistoryLength;
			const lastAssistantText = getLastAssistantText(session.agent.state.messages);
			const visualVerificationRelevant = shouldUseVisualVerification(ledger, visualVerificationAvailable, userMessage);
			const researchRelevant = shouldUseResearch(ledger, researchToolsAvailable, userMessage);
			const verificationState = getVerificationCheckpointState(toolHistory, visualVerificationRelevant);
			const turnAssessment = promoteEvidenceBackedCompletion(
				assessTurnOutcome({
					lastTurnHadToolCalls: observedTurnToolCalls,
					lastTurnFinishReason,
					lastAssistantText,
					verificationState,
				}).kind,
				{
					currentLedger: ledger,
					status: undefined,
					lastAssistantText,
					toolHistory,
					fileAccessHistory,
					verificationSatisfied: verificationState.hasVerificationCheckpoint,
					lastVerificationDetail: verificationState.lastVerificationDetail,
					visualVerificationRelevant,
					researchRelevant,
					userMessage,
				},
			);
			const initialTurnIntentAssessment = initialTurnIntentPending
				? assessTurnIntent({
						plannedLedger: ledger,
						turnToolHistory: toolHistory,
						turnFileAccessHistory: fileAccessHistory,
						assessment: turnAssessment,
						verificationState,
					})
				: undefined;
			initialTurnIntentPending = false;
			checkpointState = updateCheckpointState(
				checkpointState,
				turnAssessment,
				observedTurnToolCalls,
				verificationState,
			);
			if (iterations === 0) {
				checkpointState = updateDegradedTurnCheckpointState(checkpointState, lastTurnDegradedEvent);
			}
			if (initialTurnIntentAssessment) {
				checkpointState = updateIntentCheckpointState(checkpointState, initialTurnIntentAssessment.outcome);
			}
			ledger = updateAutonomousRunLedger({
				current: ledger,
				lastAssistantText,
				toolHistory,
				fileAccessHistory,
				verificationSatisfied: verificationState.hasVerificationCheckpoint,
				lastVerificationDetail: verificationState.lastVerificationDetail,
				visualVerificationRelevant,
				explicitEvents: buildLedgerEvents({
					status: turnAssessment === "error" ? "error" : turnAssessment === "complete" ? "complete" : undefined,
					toolHistory,
					fileAccessHistory,
					verificationSatisfied: verificationState.hasVerificationCheckpoint,
					lastVerificationDetail: verificationState.lastVerificationDetail,
					visualFailureDetail: verificationState.visualFailureDetail,
					assessment: turnAssessment,
					visualVerificationRelevant,
				}).concat(
					initialTurnIntentAssessment
						? [
								{
									type: "intent_assessed" as const,
									outcome: initialTurnIntentAssessment.outcome,
									detail: initialTurnIntentAssessment.detail,
								},
							]
						: [],
				),
			});
			consumedToolHistoryLength = toolHistory.length;
			consumedFileAccessHistoryLength = fileAccessHistory.length;
			if (turnAssessment === "error") {
				process.stderr.write("[Auton] Turn ended with error and no tool calls — stopping\n");
				ledger = { ...ledger, status: "error" };
				stopReason = "error";
				break;
			}
			if (turnAssessment === "complete") {
				process.stderr.write("[Auton] Last turn completed with explicit completion signal — stopping\n");
				ledger = { ...ledger, status: "complete" };
				stopReason = "complete";
				break;
			}

			const nudge = nudgesEnabled
				? evaluateNudgeWithCooldown(
						buildAutonomousNudgeContext({
							turnIndex: iterations,
							toolCallHistory: getToolCallHistory(),
							fileAccessHistory: getFileAccessHistory(),
							trendTracker,
						}),
						nudgeCooldown,
					)
				: {
						shouldNudge: false,
						nudgeType: "none" as const,
						shouldStop: false,
					};
			if (nudge.shouldStop) {
				process.stderr.write(`[Auton] Nudge engine says stop: ${nudge.stopReason}\n`);
				ledger = { ...ledger, status: "nudge" };
				stopReason = "nudge";
				break;
			}

			const controlDirective = getIntentControlDirective(checkpointState, ledger);
			const budgetDirective = getBudgetControlDirective(budgetPressure, checkpointState, ledger);
			if (controlDirective.kind === "stop_blocked") {
				process.stderr.write(`[Auton] ${controlDirective.detail}\n`);
				onError?.(`Autonomous mode stopped: ${controlDirective.detail}`);
				ledger = applyAutonomousLedgerEvents(
					{ ...ledger, status: "error" },
					[{ type: "run_error", detail: controlDirective.detail }],
				);
				stopReason = "error";
				persistCheckpoint("pre_turn", "error");
				break;
			}
			checkpointState = noteIntentControlDirective(checkpointState, controlDirective);
			checkpointState = noteBudgetControlDirective(checkpointState, budgetDirective);

			const promptLedger = applyAutonomousLedgerEvents(ledger, [
				{
					type: "intent_set",
					...buildTurnIntent(
						ledger,
						turnAssessment,
						controlDirective,
						budgetDirective,
						visualVerificationAvailable,
						visualVerificationRelevant,
						researchToolsAvailable,
						researchRelevant,
						userMessage,
					),
				},
			]);

			let continueMsg: string;
			if (nudge.shouldNudge && nudge.nudgeType !== "none") {
				continueMsg = appendLedgerContext(getNudgeMessage(nudge.nudgeType), promptLedger);
				process.stderr.write(`[Auton] Nudge injected: ${nudge.nudgeType} — ${continueMsg.slice(0, 80)}...\n`);
			} else if (
				controlDirective.kind === "none" &&
				(config.maxOutputPerTurn ?? 0) > 0 &&
				lastTurnOutputTokens > (config.maxOutputPerTurn ?? 0)
			) {
				const nextOutputCapPromptCount = checkpointState.outputCapPromptCount + 1;
				checkpointState = {
					...checkpointState,
					outputCapPromptCount: nextOutputCapPromptCount,
				};
				continueMsg = appendLedgerContext(
					nextOutputCapPromptCount > 1
						? `Your last response was too verbose (${lastTurnOutputTokens} output tokens). Continue tersely. Prefer tool use over explanation, avoid repeating context, and keep the next response under ${(config.maxOutputPerTurn ?? 0).toLocaleString()} output tokens unless a final verified summary is required.`
						: `Your last response exceeded the output budget (${lastTurnOutputTokens} output tokens). Continue tersely and keep the next response under ${(config.maxOutputPerTurn ?? 0).toLocaleString()} output tokens.`,
					promptLedger,
				);
			} else {
				continueMsg = buildContinuationPrompt(
					turnAssessment,
					checkpointState,
					ledger,
					promptLedger,
					controlDirective,
					budgetDirective,
					visualVerificationAvailable,
					visualVerificationRelevant,
					researchToolsAvailable,
					researchRelevant,
					userMessage,
				);
			}
			ledger = promptLedger;
			persistCheckpoint("pre_turn");

			lastTurnHadToolCalls = false;
			lastTurnFinishReason = undefined;
			lastTurnDegradedEvent = undefined;
			const prePromptLedger = ledger;
			const prePromptToolHistoryLength = getToolCallHistory().length;
			const prePromptFileHistoryLength = getFileAccessHistory().length;

			await session.prompt(continueMsg);

			const postTurnToolHistory = getToolCallHistory();
			const postTurnFileAccessHistory = getFileAccessHistory();
			const turnToolHistory = postTurnToolHistory.slice(prePromptToolHistoryLength);
			const turnFileAccessHistory = postTurnFileAccessHistory.slice(prePromptFileHistoryLength);
			const postTurnAssistantText = getLastAssistantText(session.agent.state.messages);
			const postTurnVisualVerificationRelevant = shouldUseVisualVerification(
				ledger,
				visualVerificationAvailable,
				userMessage,
			);
			const postTurnVerificationState = getVerificationCheckpointState(
				postTurnToolHistory,
				postTurnVisualVerificationRelevant,
			);
			checkpointState = updateDegradedTurnCheckpointState(checkpointState, lastTurnDegradedEvent);
			const postTurnHadObservedToolCalls =
				lastTurnHadToolCalls || turnToolHistory.length > 0 || turnFileAccessHistory.length > 0;
			const postTurnAssessment = assessTurnOutcome({
				lastTurnHadToolCalls: postTurnHadObservedToolCalls,
				lastTurnFinishReason,
				lastAssistantText: postTurnAssistantText,
				verificationState: postTurnVerificationState,
			});
			const promotedPostTurnAssessment = promoteEvidenceBackedCompletion(postTurnAssessment.kind, {
				currentLedger: ledger,
				status: undefined,
				lastAssistantText: postTurnAssistantText,
				toolHistory: postTurnToolHistory,
				fileAccessHistory: postTurnFileAccessHistory,
				verificationSatisfied: postTurnVerificationState.hasVerificationCheckpoint,
				lastVerificationDetail: postTurnVerificationState.lastVerificationDetail,
				visualVerificationRelevant: postTurnVisualVerificationRelevant,
				researchRelevant,
				userMessage,
			});
			const intentAssessment = assessTurnIntent({
				plannedLedger: prePromptLedger,
				turnToolHistory,
				turnFileAccessHistory,
				assessment: promotedPostTurnAssessment,
				verificationState: postTurnVerificationState,
			});
			checkpointState = updateIntentCheckpointState(checkpointState, intentAssessment.outcome);
			if (promotedPostTurnAssessment === "error") {
				checkpointState = updateCheckpointState(
					checkpointState,
					promotedPostTurnAssessment,
					postTurnHadObservedToolCalls,
					postTurnVerificationState,
				);
				ledger = updateAutonomousRunLedger({
					current: ledger,
					status: "error",
					lastAssistantText: postTurnAssistantText,
					toolHistory: postTurnToolHistory,
					fileAccessHistory: postTurnFileAccessHistory,
					verificationSatisfied: postTurnVerificationState.hasVerificationCheckpoint,
					lastVerificationDetail: postTurnVerificationState.lastVerificationDetail,
					visualVerificationRelevant: postTurnVisualVerificationRelevant,
					explicitEvents: [
						...buildLedgerEvents({
							status: "error",
							toolHistory: postTurnToolHistory,
							fileAccessHistory: postTurnFileAccessHistory,
							verificationSatisfied: postTurnVerificationState.hasVerificationCheckpoint,
							lastVerificationDetail: postTurnVerificationState.lastVerificationDetail,
							visualFailureDetail: postTurnVerificationState.visualFailureDetail,
							assessment: promotedPostTurnAssessment,
							visualVerificationRelevant: postTurnVisualVerificationRelevant,
						}),
						{
							type: "intent_assessed",
							outcome: intentAssessment.outcome,
							detail: intentAssessment.detail,
						},
					],
				});
				persistCheckpoint("post_turn", "error");
				process.stderr.write("[Auton] Turn ended with error and no tool calls — stopping\n");
				stopReason = "error";
				break;
			}
			if (promotedPostTurnAssessment === "complete") {
				checkpointState = updateCheckpointState(
					checkpointState,
					promotedPostTurnAssessment,
					postTurnHadObservedToolCalls,
					postTurnVerificationState,
				);
				ledger = updateAutonomousRunLedger({
					current: ledger,
					status: "complete",
					lastAssistantText: postTurnAssistantText,
					toolHistory: postTurnToolHistory,
					fileAccessHistory: postTurnFileAccessHistory,
					verificationSatisfied: postTurnVerificationState.hasVerificationCheckpoint,
					lastVerificationDetail: postTurnVerificationState.lastVerificationDetail,
					visualVerificationRelevant: postTurnVisualVerificationRelevant,
					explicitEvents: [
						...buildLedgerEvents({
							status: "complete",
							toolHistory: postTurnToolHistory,
							fileAccessHistory: postTurnFileAccessHistory,
							verificationSatisfied: postTurnVerificationState.hasVerificationCheckpoint,
							lastVerificationDetail: postTurnVerificationState.lastVerificationDetail,
							visualFailureDetail: postTurnVerificationState.visualFailureDetail,
							assessment: promotedPostTurnAssessment,
							visualVerificationRelevant: postTurnVisualVerificationRelevant,
						}),
						{
							type: "intent_assessed",
							outcome: intentAssessment.outcome,
							detail: intentAssessment.detail,
						},
					],
				});
				persistCheckpoint("post_turn", "complete");
				process.stderr.write("[Auton] Last turn completed with explicit completion signal — stopping\n");
				stopReason = "complete";
				break;
			}
			ledger = updateAutonomousRunLedger({
				current: ledger,
				lastAssistantText: postTurnAssistantText,
				toolHistory: postTurnToolHistory,
				fileAccessHistory: postTurnFileAccessHistory,
				verificationSatisfied: postTurnVerificationState.hasVerificationCheckpoint,
				lastVerificationDetail: postTurnVerificationState.lastVerificationDetail,
				visualVerificationRelevant: postTurnVisualVerificationRelevant,
				explicitEvents: [
					...buildLedgerEvents({
						toolHistory: postTurnToolHistory,
						fileAccessHistory: postTurnFileAccessHistory,
						verificationSatisfied: postTurnVerificationState.hasVerificationCheckpoint,
						lastVerificationDetail: postTurnVerificationState.lastVerificationDetail,
						visualFailureDetail: postTurnVerificationState.visualFailureDetail,
						assessment: promotedPostTurnAssessment,
						visualVerificationRelevant: postTurnVisualVerificationRelevant,
					}),
					{
						type: "intent_assessed",
						outcome: intentAssessment.outcome,
						detail: intentAssessment.detail,
					},
				],
			});
			consumedToolHistoryLength = postTurnToolHistory.length;
			consumedFileAccessHistoryLength = postTurnFileAccessHistory.length;
			persistCheckpoint("post_turn");
			lastTurnDegradedEvent = undefined;

			const usage = session.getContextUsage();
			if (usage && usage.tokens !== null) {
				const contextWindow = session.contextWindow ?? 32768;
				const policy = selectCompactionPolicy(contextWindow);
				const trigger = getBudgetAdjustedCompactionTrigger(getAutoCompactTrigger(policy), checkpointState.budgetPressureLevel);
				if (usage.tokens >= trigger) {
					process.stderr.write(`[Auton] Proactive compaction: ${usage.tokens} tokens >= ${trigger} trigger\n`);
					await session.compact(buildAutonomousCompactionInstructions(ledger));
				}
			}

			iterations++;
		}

		if (iterations >= MAX_AUTON_ITERATIONS) {
			process.stderr.write(`[Auton] Emergency brake: ${MAX_AUTON_ITERATIONS} iterations reached\n`);
			ledger = { ...ledger, status: "max_iterations" };
			stopReason = "max_iterations";
			persistCheckpoint("post_turn", "max_iterations");
		}

		onStatus?.("Autonomous mode complete");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (isBudgetExceededError(message)) {
			process.stderr.write(`[Auton] ${message}\n`);
			ledger = { ...ledger, status: "budget" };
			stopReason = "budget";
			persistCheckpoint("post_turn", "budget");
		} else {
			onError?.(`Autonomous mode error: ${message}`);
			ledger = { ...ledger, status: "error" };
			stopReason = "error";
			persistCheckpoint("post_turn", "error");
		}
	} finally {
		loopUnsub();
		debugLogger.dispose();
		finalBudgetStatus = autonHook.getBudgetStatus();
		finalCostSummary = autonHook.getCostSummary();
		process.stderr.write(`\n[Auton] Autonomous run complete\n`);
		process.stderr.write(`[Auton] Turns: ${finalBudgetStatus.turnsUsed}\n`);
		process.stderr.write(`[Auton] ${finalCostSummary}\n`);
		autonHook.dispose();
		session.agent.state.systemPrompt = previousSystemPrompt;
	}

	const result: AutonomousRunResult = {
		iterations,
		stopReason,
		budgetStatus: finalBudgetStatus,
		costSummary: finalCostSummary,
		checkpointState,
		ledger: { ...ledger, status: stopReason === "unknown" ? ledger.status : stopReason },
	};
	const finalSnapshot = createAutonomousRunSnapshot(result);
	appendAutonomousRunSnapshotState(session.sessionManager, finalSnapshot);
	onCheckpoint?.(finalSnapshot);
	return result;
}

function isBudgetExceededError(message: string): boolean {
	return BUDGET_EXCEEDED_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function buildAutonomousNudgeContext(options: {
	turnIndex: number;
	toolCallHistory: ToolOutcome[];
	fileAccessHistory: ToolOutcome[];
	trendTracker: OutputTrendTracker;
}): NudgeContext {
	return {
		turnIndex: options.turnIndex,
		toolCallHistory: options.toolCallHistory,
		fileAccessHistory: options.fileAccessHistory,
		outputTrend: options.trendTracker.isDiminishing() ? "diminishing" : "stable",
		isContinuation: options.turnIndex > 0,
		trendTracker: options.trendTracker,
	};
}

function shouldStopForCompletion(
	lastTurnHadToolCalls: boolean,
	lastTurnFinishReason: string | undefined,
	lastAssistantText: string,
	verificationState: VerificationCheckpointState,
): TurnAssessmentKind {
	if (!lastTurnFinishReason) return "continue";
	if (lastTurnFinishReason === "error") return "error";
	if (TRUNCATED_STOP_REASONS.has(lastTurnFinishReason)) return "truncated";
	if (!TERMINAL_STOP_REASONS.has(lastTurnFinishReason)) return "continue";
	if (lastTurnHadToolCalls) {
		if (!hasExplicitCompletionSignal(lastAssistantText)) return "continue";
		return verificationState.hasVerificationCheckpoint ? "complete" : "confirm_verification";
	}
	if (!hasExplicitCompletionSignal(lastAssistantText)) return "confirm_completion";
	return verificationState.hasVerificationCheckpoint ? "complete" : "confirm_verification";
}

function assessTurnOutcome(options: {
	lastTurnHadToolCalls: boolean;
	lastTurnFinishReason: string | undefined;
	lastAssistantText: string;
	verificationState: VerificationCheckpointState;
}): { kind: TurnAssessmentKind } {
	return {
		kind: shouldStopForCompletion(
			options.lastTurnHadToolCalls,
			options.lastTurnFinishReason,
			options.lastAssistantText,
			options.verificationState,
		),
	};
}

function getLastAssistantText(messages: Array<{ role?: string; content?: unknown }>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((part): part is { type: "text"; text: string } => {
					return (
						typeof part === "object" &&
						part !== null &&
						"type" in part &&
						part.type === "text" &&
						"text" in part &&
						typeof part.text === "string"
					);
				})
				.map((part) => part.text)
				.join("\n")
				.trim();
		}
	}
	return "";
}

function hasExplicitCompletionSignal(text: string): boolean {
	if (!text) return false;
	if (INCOMPLETE_PATTERNS.some((pattern) => pattern.test(text))) return false;
	return EXPLICIT_COMPLETION_PATTERNS.some((pattern) => pattern.test(text));
}

function updateCheckpointState(
	current: AutonomousCheckpointState,
	assessment: TurnAssessmentKind,
	lastTurnHadToolCalls: boolean,
	verificationState: VerificationCheckpointState,
): AutonomousCheckpointState {
	return {
		...current,
		consecutiveNoToolTurns: lastTurnHadToolCalls ? 0 : current.consecutiveNoToolTurns + 1,
		completionPromptCount:
			assessment === "confirm_completion" ? current.completionPromptCount + 1 : current.completionPromptCount,
		verificationPromptCount:
			assessment === "confirm_verification"
				? current.verificationPromptCount + 1
				: current.verificationPromptCount,
		truncatedTurnCount: assessment === "truncated" ? current.truncatedTurnCount + 1 : current.truncatedTurnCount,
		lastAssessment: assessment,
		verificationSatisfied: verificationState.hasVerificationCheckpoint,
		lastVerificationDetail: verificationState.lastVerificationDetail,
	};
}

function updateDegradedTurnCheckpointState(
	current: AutonomousCheckpointState,
	degradedTurn: Extract<AgentSessionEvent, { type: "degraded_turn" }> | undefined,
): AutonomousCheckpointState {
	if (!degradedTurn || degradedTurn.severity === "normal") {
		return {
			...current,
			consecutiveDegradedTurnCount: 0,
			consecutiveCriticalDegradedTurnCount: 0,
			lastDegradedTurnSeverity: undefined,
			lastDegradedTurnReasons: undefined,
		};
	}

	return {
		...current,
		consecutiveDegradedTurnCount: (current.consecutiveDegradedTurnCount ?? 0) + 1,
		consecutiveCriticalDegradedTurnCount:
			degradedTurn.severity === "critical" ? (current.consecutiveCriticalDegradedTurnCount ?? 0) + 1 : 0,
		lastDegradedTurnSeverity: degradedTurn.severity,
		lastDegradedTurnReasons: degradedTurn.reasons,
	};
}

function updateIntentCheckpointState(
	current: AutonomousCheckpointState,
	outcome: IntentAssessmentOutcome,
): AutonomousCheckpointState {
	if (outcome === "on_track") {
		return {
			...current,
			consecutiveIntentDriftCount: 0,
			consecutiveIntentFailureCount: 0,
		};
	}
	if (outcome === "failed") {
		return {
			...current,
			consecutiveIntentFailureCount: current.consecutiveIntentFailureCount + 1,
			consecutiveIntentDriftCount: 0,
		};
	}
	return {
		...current,
		consecutiveIntentDriftCount: current.consecutiveIntentDriftCount + 1,
		consecutiveIntentFailureCount: 0,
	};
}

function noteIntentControlDirective(
	current: AutonomousCheckpointState,
	controlDirective: IntentControlDirective,
): AutonomousCheckpointState {
	if (controlDirective.kind === "replan") {
		return {
			...current,
			replanPromptCount: current.replanPromptCount + 1,
		};
	}
	if (controlDirective.kind === "narrow_scope") {
		return {
			...current,
			narrowScopePromptCount: current.narrowScopePromptCount + 1,
		};
	}
	return current;
}

function noteBudgetControlDirective(
	current: AutonomousCheckpointState,
	budgetDirective: BudgetControlDirective,
): AutonomousCheckpointState {
	if (budgetDirective.kind === "trim") {
		return {
			...current,
			budgetTrimPromptCount: current.budgetTrimPromptCount + 1,
		};
	}
	if (budgetDirective.kind === "squeeze") {
		return {
			...current,
			budgetSqueezePromptCount: current.budgetSqueezePromptCount + 1,
		};
	}
	return current;
}

interface VerificationCheckpointState {
	hasVerificationCheckpoint: boolean;
	lastVerificationDetail?: string;
	visualFailureDetail?: string;
	visualBlockingIssues: string[];
}

function getVerificationCheckpointState(
	toolHistory: ToolOutcome[],
	visualVerificationRelevant = false,
): VerificationCheckpointState {
	let lastMutationIndex = -1;
	let lastVerificationIndex = -1;
	let lastVerificationDetail: string | undefined;
	let lastVisualVerificationIndex = -1;
	let lastVisualVerificationDetail: string | undefined;
	let lastVisualBlockingIssues: string[] = [];

	for (let i = 0; i < toolHistory.length; i++) {
		const outcome = toolHistory[i];
		if (!outcome.success) continue;
		if (isMutatingOutcome(outcome)) {
			lastMutationIndex = i;
			continue;
		}
		if (isVerificationOutcome(outcome)) {
			lastVerificationIndex = i;
			lastVerificationDetail = outcome.detail;
			if (isVisualVerificationOutcome(outcome)) {
				lastVisualVerificationIndex = i;
				lastVisualVerificationDetail = outcome.detail;
				lastVisualBlockingIssues = getVisualVerificationBlockingIssues(outcome);
			}
		}
	}

	const hasVerificationAfterMutation = lastVerificationIndex > lastMutationIndex;
	if (visualVerificationRelevant) {
		const hasVisualVerificationAfterMutation = lastVisualVerificationIndex > lastMutationIndex;
		return {
			hasVerificationCheckpoint: hasVisualVerificationAfterMutation && lastVisualBlockingIssues.length === 0,
			lastVerificationDetail: lastVisualVerificationDetail ?? lastVerificationDetail,
			visualFailureDetail:
				hasVisualVerificationAfterMutation && lastVisualBlockingIssues.length > 0
					? summarizeVisualBlockingIssues(lastVisualBlockingIssues)
					: undefined,
			visualBlockingIssues: hasVisualVerificationAfterMutation ? lastVisualBlockingIssues : [],
		};
	}

	return {
		hasVerificationCheckpoint: hasVerificationAfterMutation,
		lastVerificationDetail,
		visualFailureDetail: undefined,
		visualBlockingIssues: [],
	};
}

function isMutatingOutcome(outcome: ToolOutcome): boolean {
	return MUTATING_TOOL_NAMES.has(outcome.tool.toLowerCase());
}

function isVerificationOutcome(outcome: ToolOutcome): boolean {
	const toolName = outcome.tool.toLowerCase();
	if (VERIFICATION_TOOL_NAMES.has(toolName)) return true;
	if (VISUAL_VERIFICATION_TOOL_NAMES.has(toolName)) return true;
	const detail = outcome.detail;
	if (toolName === "bash" && typeof detail === "string") {
		return VERIFICATION_COMMAND_PATTERNS.some((pattern) => pattern.test(detail));
	}
	return false;
}

function isVisualVerificationOutcome(outcome: ToolOutcome): boolean {
	return VISUAL_VERIFICATION_TOOL_NAMES.has(outcome.tool.toLowerCase());
}

function getVisualVerificationBlockingIssues(outcome: ToolOutcome): string[] {
	const metadata = outcome.metadata;
	if (!metadata || typeof metadata !== "object") return [];
	const issues: string[] = [];
	if (typeof metadata.error === "string" && metadata.error.trim().length > 0) {
		issues.push(`capture error: ${metadata.error.trim()}`);
	}
	if (Array.isArray(metadata.consoleErrors) && metadata.consoleErrors.length > 0) {
		const first = metadata.consoleErrors.find((value): value is string => typeof value === "string" && value.trim().length > 0);
		if (first) issues.push(`console errors: ${first.trim()}`);
	}
	if (Array.isArray(metadata.failedRequests) && metadata.failedRequests.length > 0) {
		const first = metadata.failedRequests.find((value): value is string => typeof value === "string" && value.trim().length > 0);
		if (first) issues.push(`failed requests: ${first.trim()}`);
	}
	return issues;
}

function summarizeVisualBlockingIssues(issues: string[]): string {
	return issues.join("; ");
}

function formatVisualActionRecipeForPrompt(
	steps: Array<{
		type: "click" | "fill" | "wait" | "navigate";
		selector?: string;
		targetHint?: string;
		valueHint?: string;
		ms?: number;
		url?: string;
		urlHint?: string;
	}>,
): string {
	return steps
		.map((step) => {
			switch (step.type) {
				case "click":
					return `click ${step.selector ?? step.targetHint ?? "the target control"}`;
				case "fill":
					return `fill ${step.selector ?? step.targetHint ?? "the input"} with ${step.valueHint ?? "representative input"}`;
				case "wait":
					return `wait ${step.ms ?? 500}ms`;
				case "navigate":
					return `navigate to ${step.url ?? step.urlHint ?? "the target page"}`;
			}
		})
		.join(" -> ");
}

function buildContinuationPrompt(
	assessment: TurnAssessmentKind,
	state: AutonomousCheckpointState,
	ledger: AutonomousRunLedger,
	promptLedger: AutonomousRunLedger = ledger,
	controlDirective: IntentControlDirective = { kind: "none" },
	budgetDirective: BudgetControlDirective = { kind: "none", level: "normal" },
	visualVerificationAvailable = false,
	visualVerificationRelevant = false,
	researchToolsAvailable = false,
	researchRelevant = false,
	userMessage = "",
): string {
	const shouldUseVisual = visualVerificationRelevant || shouldUseVisualVerification(ledger, visualVerificationAvailable, userMessage);
	const shouldResearchOnline = researchRelevant || shouldUseResearch(ledger, researchToolsAvailable, userMessage);
	const visualPhase = shouldUseVisual ? ledger.visualIteration?.phase ?? "baseline_capture" : undefined;
	const visualAssessment = shouldUseVisual ? ledger.visualAssessment : undefined;
	const visualTarget = shouldUseVisual ? ledger.visualTarget : undefined;
	const researchState = ledger.research;
	const shouldSearchFirst = shouldResearchOnline && (researchState?.searchQueries.length ?? 0) === 0;
	const shouldFetchResult = shouldResearchOnline && !shouldSearchFirst && (researchState?.fetchedUrls.length ?? 0) === 0;
	const shouldReuseSources = shouldResearchOnline && !shouldSearchFirst && !shouldFetchResult && hasReusableResearchSource(ledger);
	const hasEnoughResearchEvidence = shouldResearchOnline && hasSufficientResearchEvidence(ledger.research);
	const shouldSummarizeResearchNow = hasEnoughResearchEvidence && isResearchOnlyLedger(ledger);
	const hasEnoughVisualEvidence = shouldUseVisual && hasSufficientVisualEvidence(ledger, userMessage);
	const hasEnoughImplementationEvidence = !shouldUseVisual && hasSufficientCodingVerificationEvidence(ledger, userMessage);
	const preferredSourceHint =
		researchState?.preferredSourceUrls && researchState.preferredSourceUrls.length > 0
			? ` Prefer authoritative sources like ${researchState.preferredSourceUrls.slice(0, 2).join(" and ")}.`
			: " Prefer authoritative sources such as official docs, vendor docs, specs, or release notes over forums when possible.";
	const sourceSummaryHint =
		shouldResearchOnline && (researchState?.sourceUrls.length ?? 0) > 0
			? ` Include the supporting source URLs in your summary: ${researchState?.sourceUrls.slice(0, 3).join(", ")}.`
			: shouldResearchOnline
				? " Include the supporting source URLs in your summary."
				: "";
	const researchFindingHint = summarizeResearchFindingsForPrompt(ledger);
	const visualAcceptanceHint =
		visualTarget?.acceptanceCriteria && visualTarget.acceptanceCriteria.length > 0
			? ` Target acceptance: ${visualTarget.acceptanceCriteria.join("; ")}.`
			: "";
	const visualSurfaceHint = visualTarget?.surface ? ` for the ${visualTarget.surface}` : "";
	const visualViewportHint = visualTarget?.viewportHint ? ` Use ${visualTarget.viewportHint}.` : "";
	const visualInteractionHint = visualTarget?.interactionHint ? ` Before capture, ${visualTarget.interactionHint}.` : "";
	const visualRecipeHint =
		visualTarget?.actionRecipe && visualTarget.actionRecipe.length > 0
			? ` Recommended interaction recipe: ${formatVisualActionRecipeForPrompt(visualTarget.actionRecipe)}.`
			: "";
	const visualToolHint =
		visualTarget?.recommendedTool === "interact_then_screenshot"
			? "interact_then_screenshot"
			: "screenshot_url or interact_then_screenshot";
	const degradedTurnDirective = controlDirective.kind !== "none" && isDegradedTurnDirectiveDetail(controlDirective.detail);
	const prompt = (() => {
		if (shouldSearchFirst) {
			return `Use webSearch first to find the most relevant current or authoritative sources for this task. Then use webFetch on the best result before making concrete claims.${preferredSourceHint} Preserve the source URLs in your notes and final summary.`;
		}
		if (shouldFetchResult) {
			return `You already searched the web. Use webFetch now on the most relevant result URL, then continue with the task using that source.${preferredSourceHint} Preserve the fetched URL in your notes and final summary.`;
		}
		if (shouldSummarizeResearchNow) {
			return `You have enough source-backed evidence for this research task. Stop browsing, synthesize the answer from the saved sources you already have, cite the supporting URLs directly, and note any remaining uncertainty instead of doing more web calls.${researchFindingHint}${sourceSummaryHint}`;
		}
		if (hasEnoughVisualEvidence) {
			return `You have enough visual verification evidence for the current UI slice. Summarize the verified rendered result${visualSurfaceHint}, note any residual risks, and stop.${visualInteractionHint}${visualRecipeHint}${visualViewportHint}${visualAcceptanceHint}`;
		}
		if (hasEnoughImplementationEvidence) {
			return `You have enough verification evidence for the current implementation slice. Summarize the verified result, note any residual risks, and stop.${sourceSummaryHint}`;
		}
		if (shouldReuseSources) {
			return `You already have an authoritative source for this task. Reuse the fetched or preferred source you already have before doing any new web search or fetch.${researchFindingHint}${preferredSourceHint}${sourceSummaryHint}`;
		}
		if (budgetDirective.kind === "squeeze") {
			return state.budgetSqueezePromptCount > 1
				? `Budget is critically low. Stop expanding scope immediately. Verify the smallest completed slice now, summarize only that verified slice, and stop. If it cannot be verified, report the blocker succinctly. Context: ${budgetDirective.detail}`
				: `Budget is nearly exhausted. Stop expanding scope. Verify the smallest completed slice now, summarize only that verified slice, and stop. If it cannot be verified, report the blocker succinctly. Context: ${budgetDirective.detail}`;
		}
		if (budgetDirective.kind === "trim") {
			return state.budgetTrimPromptCount > 1
				? `Budget pressure remains high. Avoid exploration, keep output terse, finish the current slice, and verify it before any new scope. Context: ${budgetDirective.detail}`
				: `Budget pressure is rising. Avoid exploration, keep output terse, finish the current slice, and verify it before any new scope. Context: ${budgetDirective.detail}`;
		}
		if (controlDirective.kind === "narrow_scope") {
			if (degradedTurnDirective) {
				return state.narrowScopePromptCount > 1
					? `Recent turns keep degrading. Narrow scope aggressively to the smallest verifiable slice, keep the next response terse, avoid repeating prior analysis, and execute only that slice. Context: ${controlDirective.detail}`
					: `Recent turns are degrading. Narrow scope to the smallest verifiable slice, keep the next response terse, and execute only that slice. Context: ${controlDirective.detail}`;
			}
			return state.narrowScopePromptCount > 1
				? `The run is still off track. Narrow scope aggressively to the smallest verifiable slice, state that narrowed target, complete only that slice, and verify it before doing anything else. Context: ${controlDirective.detail}`
				: `Repeated drift or failure means the current slice is too broad. Narrow scope to the smallest verifiable slice, state the narrowed target, execute it, and verify it before proceeding. Context: ${controlDirective.detail}`;
		}
		if (controlDirective.kind === "replan") {
			if (degradedTurnDirective) {
				return state.replanPromptCount > 1
					? `Recent turns keep degrading. Replan into 1-2 very small steps, keep the next response short, and execute only the first concrete step now. Context: ${controlDirective.detail}`
					: `Recent turns are degrading. Replan into 1-2 very small steps, keep the next response short, and execute only the first concrete step now. Context: ${controlDirective.detail}`;
			}
			return state.replanPromptCount > 1
				? `The run keeps drifting. Replan into 1-2 concrete steps, state the first step you will execute now, and then do it immediately. Context: ${controlDirective.detail}`
				: `The run has drifted repeatedly. Replan into 1-2 concrete steps, choose the first one, and execute it now. Context: ${controlDirective.detail}`;
		}
		if (controlDirective.kind === "recover") {
			if (degradedTurnDirective) {
				return `The previous turn degraded. Resume from the last concrete point only, keep the next response terse, avoid repeating prior analysis, and prefer tool results over long narration. Context: ${controlDirective.detail}`;
			}
			return `Recover from the blocker before doing anything else. Resolve the failing step, rerun the relevant check, and only continue once the blocker is cleared. Context: ${controlDirective.detail}`;
		}
		switch (assessment) {
			case "truncated":
				return state.truncatedTurnCount > 1
					? "Your responses keep truncating. Continue from the exact point you stopped, avoid repeating yourself, and finish the task with concrete verification if possible."
					: "Your last response was truncated. Continue from where you left off, finish the task, and use tools if they are needed.";
			case "confirm_completion":
				return state.completionPromptCount > 1
					? `Do not stop at planning or vague status updates. Either continue making concrete progress with tools, or provide a final verified summary if the task is actually complete.${sourceSummaryHint}`
					: `If the task is complete, provide a final summary with concrete verification and any remaining risks.${sourceSummaryHint} If it is not complete, continue working and use tools as needed.`;
			case "confirm_verification":
				if (shouldUseVisual) {
					if (visualPhase === "baseline_capture") {
						return state.verificationPromptCount > 1
							? `Do not continue UI changes blind. Capture a baseline screenshot now with ${visualToolHint}${visualSurfaceHint}, then use it to guide the next patch.${visualInteractionHint}${visualRecipeHint}${visualViewportHint}${visualAcceptanceHint}`
							: `Capture a baseline screenshot of the current UI${visualSurfaceHint} with ${visualToolHint} before making further UI claims.${visualInteractionHint}${visualRecipeHint}${visualViewportHint}${visualAcceptanceHint}`;
					}
					if (visualAssessment?.latestJudgment === "fail") {
						return `The latest visual verification found blocking issues (${visualAssessment.blockingIssues[0] ?? visualAssessment.summary}). Fix those issues, then recapture the UI${visualSurfaceHint} with ${visualToolHint} before claiming completion.${visualInteractionHint}${visualRecipeHint}${visualViewportHint}${visualAcceptanceHint}`;
					}
					return state.verificationPromptCount > 1
						? `Do not claim the UI work is complete without visual verification. Use ${visualToolHint} now to verify the rendered UI${visualSurfaceHint}, then summarize the rendered result and any residual risks.${visualInteractionHint}${visualRecipeHint}${visualViewportHint}${visualAcceptanceHint}`
						: `You claimed the task is complete, but you did not provide visual verification. Use ${visualToolHint} to verify the rendered UI${visualSurfaceHint}, then summarize any remaining risks.${visualInteractionHint}${visualRecipeHint}${visualViewportHint}${visualAcceptanceHint}`;
				}
				return state.verificationPromptCount > 1
					? `Do not claim completion without verification. Run the relevant checks now, or state exactly why verification cannot be run and what residual risks remain.${sourceSummaryHint}`
					: `You claimed the task is complete, but you did not provide concrete verification. Run the relevant checks or explain why verification cannot be run, then summarize any remaining risks.${sourceSummaryHint}`;
			case "continue":
			default:
				if (shouldUseVisual && visualPhase === "baseline_capture") {
					return `Capture a baseline screenshot of the current UI${visualSurfaceHint} with ${visualToolHint} before making further UI changes.${visualInteractionHint}${visualRecipeHint}${visualViewportHint}${visualAcceptanceHint}`;
				}
				if (shouldUseVisual && visualPhase === "recapture") {
					return `Recapture the updated UI${visualSurfaceHint} now with ${visualToolHint}, assess the rendered result against the target, and only then claim completion.${visualInteractionHint}${visualRecipeHint}${visualViewportHint}${visualAcceptanceHint}`;
				}
				if (shouldUseVisual && visualAssessment?.latestJudgment === "fail") {
					return `Resolve the blocking visual issues (${visualAssessment.blockingIssues[0] ?? visualAssessment.summary}), then recapture the UI${visualSurfaceHint} with ${visualToolHint}.${visualInteractionHint}${visualRecipeHint}${visualViewportHint}${visualAcceptanceHint}`;
				}
				if (shouldUseVisual && ledger.taskJournal.planItems.find((item) => item.key === "verify")?.status === "active") {
					return `Continue by using ${visualToolHint} to verify the latest rendered UI before claiming completion.${visualInteractionHint}${visualRecipeHint}${visualViewportHint}`;
				}
				if (ledger.taskJournal.planItems.find((item) => item.key === "verify")?.status === "active") {
					return "Continue by running verification on the latest changes before claiming completion.";
				}
				if (ledger.taskJournal.intentStatus === "failed") {
					return ledger.taskJournal.lastIntentOutcome
						? `The previous step failed against the planned intent (${ledger.taskJournal.lastIntentOutcome}). Recover from that failure first, then continue with the next concrete action.`
						: "The previous step failed against the planned intent. Recover from that failure first, then continue with the next concrete action.";
				}
				if (ledger.taskJournal.intentStatus === "drifted") {
					return ledger.taskJournal.lastIntentOutcome
						? `The previous step drifted from the planned intent (${ledger.taskJournal.lastIntentOutcome}). Return to the planned next step unless there is a stronger concrete reason to change course.`
						: "The previous step drifted from the planned intent. Return to the planned next step unless there is a stronger concrete reason to change course.";
				}
				if (ledger.taskJournal.planItems.find((item) => item.key === "summarize")?.status === "active") {
					return shouldUseVisual
						? `The latest UI slice is already verified. Summarize the rendered result${visualSurfaceHint}, note any residual risks, and stop.${visualInteractionHint}${visualRecipeHint}${visualViewportHint}${visualAcceptanceHint}`
						: `The latest implementation slice is already verified. Summarize the verified result, note any residual risks, and stop.${sourceSummaryHint}`;
				}
				return "Continue working on the task. Proceed to the next step. Do not ask for confirmation — you are in autonomous mode.";
		}
	})();
	return appendLedgerContext(prompt, promptLedger);
}

function appendLedgerContext(
	prompt: string,
	ledger: AutonomousRunLedger,
	mode: "continuation" | "full" = "continuation",
): string {
	return `${prompt}\n\n${mode === "full" ? formatAutonomousPromptLedger(ledger) : formatAutonomousContinuationLedger(ledger)}`;
}

function buildTurnIntent(
	ledger: AutonomousRunLedger,
	assessment: TurnAssessmentKind,
	controlDirective: IntentControlDirective = { kind: "none" },
	budgetDirective: BudgetControlDirective = { kind: "none", level: "normal" },
	visualVerificationAvailable = false,
	visualVerificationRelevant = false,
	researchToolsAvailable = false,
	researchRelevant = false,
	userMessage = "",
): { plannedNextStep: string; stepRationale: string; expectedVerification?: string } {
	const shouldUseVisual = visualVerificationRelevant || shouldUseVisualVerification(ledger, visualVerificationAvailable, userMessage);
	const shouldResearchOnline = researchRelevant || shouldUseResearch(ledger, researchToolsAvailable, userMessage);
	const visualPhase = shouldUseVisual ? ledger.visualIteration?.phase ?? "baseline_capture" : undefined;
	const visualAssessment = shouldUseVisual ? ledger.visualAssessment : undefined;
	const visualTarget = shouldUseVisual ? ledger.visualTarget : undefined;
	const researchState = ledger.research;
	const shouldSearchFirst = shouldResearchOnline && (researchState?.searchQueries.length ?? 0) === 0;
	const shouldFetchResult = shouldResearchOnline && !shouldSearchFirst && (researchState?.fetchedUrls.length ?? 0) === 0;
	const shouldReuseSources = shouldResearchOnline && !shouldSearchFirst && !shouldFetchResult && hasReusableResearchSource(ledger);
	const hasEnoughResearchEvidence = shouldResearchOnline && hasSufficientResearchEvidence(ledger.research);
	const shouldSummarizeResearchNow = hasEnoughResearchEvidence && isResearchOnlyLedger(ledger);
	const hasEnoughVisualEvidence = shouldUseVisual && hasSufficientVisualEvidence(ledger, userMessage);
	const hasEnoughImplementationEvidence = !shouldUseVisual && hasSufficientCodingVerificationEvidence(ledger, userMessage);
	const visualSurface = visualTarget?.surface ? ` for the ${visualTarget.surface}` : "";
	const visualAcceptance = visualTarget?.acceptanceCriteria?.[0];
	const visualTool =
		visualTarget?.recommendedTool === "interact_then_screenshot"
			? "interact_then_screenshot"
			: "screenshot_url or interact_then_screenshot";
	const researchFindingHint = summarizeResearchFindingsForPrompt(ledger);
	const visualInteractionSuffix = visualTarget?.interactionHint ? ` ${visualTarget.interactionHint}.` : "";
	const degradedTurnDirective = controlDirective.kind !== "none" && isDegradedTurnDirectiveDetail(controlDirective.detail);
	if (budgetDirective.kind === "squeeze") {
		return {
			plannedNextStep: shouldUseVisual
				? `Use ${visualTool} to verify the smallest completed UI slice${visualSurface}, summarize only that verified slice, and stop.${visualInteractionSuffix}`
				: "Verify the smallest completed slice now, summarize only that verified slice, and stop.",
			stepRationale: "Budget is critically low, so the run must stop expanding scope and finish the cheapest verifiable slice.",
			expectedVerification:
				ledger.taskJournal.expectedVerification ??
				(shouldUseVisual ? "Use screenshot_url or interact_then_screenshot on the updated UI" : ledger.lastVerificationDetail),
		};
	}
	if (budgetDirective.kind === "trim") {
		return {
			plannedNextStep: "Finish the current slice without exploring new scope, then verify it immediately.",
			stepRationale: "Budget pressure is high, so the run should avoid exploration and close the current slice cheaply.",
			expectedVerification:
				ledger.taskJournal.expectedVerification ??
				(shouldUseVisual ? "Use screenshot_url or interact_then_screenshot on the updated UI" : ledger.lastVerificationDetail),
		};
	}
	if (controlDirective.kind === "narrow_scope") {
		if (degradedTurnDirective) {
			return {
				plannedNextStep: "Define the smallest verifiable step, execute only that step tersely, and verify it immediately.",
				stepRationale: "Recent degraded turns indicate the loop is getting too verbose or unstable, so it must shrink scope and stabilize.",
				expectedVerification: ledger.taskJournal.expectedVerification ?? ledger.lastVerificationDetail,
			};
		}
		return {
			plannedNextStep: "Define the smallest verifiable slice, execute only that slice, and verify it immediately.",
			stepRationale: "Repeated drift or failure indicates the current scope is too broad, so the run must shrink to a smaller verified target.",
			expectedVerification: ledger.taskJournal.expectedVerification ?? ledger.lastVerificationDetail,
		};
	}
	if (controlDirective.kind === "replan") {
		if (degradedTurnDirective) {
			return {
				plannedNextStep: "Replan into 1-2 very small steps, keep the response short, and execute the first step immediately.",
				stepRationale: "Recent degraded turns indicate the loop needs a shorter horizon and terser execution to stay stable.",
				expectedVerification: ledger.taskJournal.expectedVerification ?? ledger.lastVerificationDetail,
			};
		}
		return {
			plannedNextStep: "Replan into 1-2 concrete steps, pick the first step, and execute it immediately.",
			stepRationale: "Repeated drift indicates the current plan is not holding, so the run needs a tighter short-horizon plan.",
			expectedVerification: ledger.taskJournal.expectedVerification ?? ledger.lastVerificationDetail,
		};
	}
	if (controlDirective.kind === "recover") {
		if (degradedTurnDirective) {
			return {
				plannedNextStep: "Resume from the last concrete point, make only the next smallest step, and keep the response terse.",
				stepRationale: "The previous turn degraded, so the loop should stabilize before taking on more scope.",
				expectedVerification: ledger.taskJournal.expectedVerification ?? ledger.lastVerificationDetail,
			};
		}
		return {
			plannedNextStep: ledger.taskJournal.nextAction ?? "Resolve the current blocker and rerun the relevant verification.",
			stepRationale: "The previous step failed, so the run must recover from the blocker before moving forward.",
			expectedVerification: ledger.taskJournal.expectedVerification ?? ledger.lastVerificationDetail,
		};
	}
	if (shouldSearchFirst) {
		return {
			plannedNextStep: "Use webSearch to find the most relevant current or authoritative sources, then webFetch the best result before proceeding.",
			stepRationale: "This task depends on external or current information, so the run should ground itself in actual online sources before making claims.",
			expectedVerification: "Carry forward authoritative source URLs from webSearch and webFetch",
		};
	}
	if (shouldFetchResult) {
		return {
			plannedNextStep: "Use webFetch on the most relevant search result URL, extract the needed facts, and carry that source forward.",
			stepRationale: "The run already has candidate sources, so the next step is to read the best one instead of re-searching or guessing.",
			expectedVerification: "Carry forward the fetched authoritative URL and the key fact it supports",
		};
	}
	if (shouldSummarizeResearchNow) {
		return {
			plannedNextStep: `Summarize the source-backed answer from the saved research artifacts, cite the supporting URLs, and stop unless a concrete evidence gap remains.${researchFindingHint}`,
			stepRationale: "The run already has enough authoritative evidence, so further browsing would waste budget instead of improving the answer.",
			expectedVerification: `Cite supporting source URLs${ledger.research?.preferredSourceUrls.length ? ` such as ${ledger.research.preferredSourceUrls.slice(0, 2).join(", ")}` : ""}`,
		};
	}
	if (hasEnoughVisualEvidence) {
		return {
			plannedNextStep: `Summarize the verified rendered UI${visualSurface}, note any residual risks, and stop.${visualInteractionSuffix}`,
			stepRationale: "The latest visual checkpoint is already clean enough for this task slice, so more turns would only add cost.",
			expectedVerification: visualAcceptance ?? ledger.lastVerificationDetail ?? `Use ${visualTool} on the updated UI`,
		};
	}
	if (hasEnoughImplementationEvidence) {
		return {
			plannedNextStep: "Summarize the verified result, note any residual risks, and stop.",
			stepRationale: "The latest implementation slice is already backed by concrete verification, so more turns would only add cost.",
			expectedVerification: ledger.lastVerificationDetail ?? "A passing verification command after the latest mutation",
		};
	}
	if (shouldReuseSources) {
		return {
			plannedNextStep: `Reuse the authoritative source already fetched, extract the needed facts from it, and continue without another web search unless the source is insufficient.${researchFindingHint}`,
			stepRationale: "The run already has a good source in hand, so another search would waste tokens and turns.",
			expectedVerification: "Carry forward the reused authoritative URL and the key fact it supports",
		};
	}
	if (assessment === "truncated") {
		return {
			plannedNextStep: "Resume from the exact interrupted point and finish the current concrete step tersely.",
			stepRationale: "The previous response was truncated, so the immediate goal is to complete the interrupted work without repetition.",
			expectedVerification: ledger.taskJournal.expectedVerification,
		};
	}
	if (assessment === "confirm_verification") {
		if (shouldUseVisual && visualAssessment?.latestJudgment === "fail") {
			return {
				plannedNextStep: `Fix the blocking visual issues, then recapture the updated UI${visualSurface} before claiming completion.`,
				stepRationale: "The latest visual verification found concrete render/runtime issues, so the run must repair them before it can stop.",
				expectedVerification: visualAcceptance ?? "A fresh screenshot capture with no blocking console or network issues",
			};
		}
		return {
			plannedNextStep: shouldUseVisual && visualPhase === "baseline_capture"
				? `Capture a baseline screenshot of the current UI${visualSurface} before making further changes.`
				: shouldUseVisual
				? `Use ${visualTool} now on the updated UI${visualSurface}, then summarize the rendered result.${visualInteractionSuffix}`
				: "Run the relevant verification now and then summarize the result.",
			stepRationale: "The task cannot be treated as complete until the latest changes are verified.",
			expectedVerification:
				ledger.lastVerificationDetail ??
				(shouldUseVisual
					? visualAcceptance ?? "Use screenshot_url or interact_then_screenshot on the updated UI"
					: "A passing test, lint, build, or verify command after the latest change"),
		};
	}
	if (shouldUseVisual && visualPhase === "baseline_capture") {
		return {
			plannedNextStep: `Capture a baseline screenshot of the current UI${visualSurface} before making further changes.`,
			stepRationale: "UI work should start from an observed baseline so later patches can be judged against a real rendered state.",
			expectedVerification: visualAcceptance ?? `Use ${visualTool} on the current UI`,
		};
	}
	if (shouldUseVisual && visualPhase === "recapture") {
		return {
			plannedNextStep: `Recapture the updated UI${visualSurface} and assess the rendered result against the target before claiming completion.${visualInteractionSuffix}`,
			stepRationale: "Recent UI mutations invalidate the last visual checkpoint, so the run needs a fresh rendered capture.",
			expectedVerification: visualAcceptance ?? `Use ${visualTool} on the updated UI`,
		};
	}
	if (shouldUseVisual && visualAssessment?.latestJudgment === "fail") {
		return {
			plannedNextStep: `Fix the blocking visual issues, then recapture the UI${visualSurface} and reassess it.${visualInteractionSuffix}`,
			stepRationale: "The last visual checkpoint found concrete issues, so the run must repair them before it can finish.",
			expectedVerification: visualAcceptance ?? "A fresh screenshot capture with no blocking console or network issues",
		};
	}

	const verifyItem = ledger.taskJournal.planItems.find((item) => item.key === "verify");
	if (verifyItem?.status === "blocked") {
		const failedVerificationDetail = ledger.verificationFailures[ledger.verificationFailures.length - 1]?.replace(
			/^failed verification:\s*/i,
			"",
		);
		return {
			plannedNextStep: ledger.taskJournal.nextAction ?? "Resolve the verification blocker and rerun the relevant check.",
			stepRationale: "Verification is currently blocked, so the run should focus on unblocking and re-running checks.",
			expectedVerification:
				failedVerificationDetail ?? ledger.lastVerificationDetail ?? "The previously failing verification should pass",
		};
	}
	if (verifyItem?.status === "active") {
		return {
			plannedNextStep:
				ledger.taskJournal.nextAction ??
				(shouldUseVisual
					? `Use ${visualTool} on the latest rendered UI${visualSurface}.${visualInteractionSuffix}`
					: "Run verification on the latest changes."),
			stepRationale: "The implementation phase is done enough to justify verification before more changes.",
			expectedVerification:
				ledger.lastVerificationDetail ??
				(shouldUseVisual
					? visualAcceptance ?? `Use ${visualTool} on the updated UI`
					: "A passing verification command after the latest mutation"),
		};
	}
	const implementItem = ledger.taskJournal.planItems.find((item) => item.key === "implement");
	if (implementItem?.status === "active") {
		return {
			plannedNextStep: "Make the next concrete code change.",
			stepRationale: "The run has enough context to move from inspection into implementation.",
			expectedVerification: "After the change, run the relevant test, lint, build, or verify command",
		};
	}
	const summarizeItem = ledger.taskJournal.planItems.find((item) => item.key === "summarize");
	if (summarizeItem?.status === "active") {
		return {
			plannedNextStep:
				shouldResearchOnline && (ledger.research?.sourceUrls.length ?? 0) > 0
					? "Summarize the verified result, cite the supporting source URLs, and note any residual risks."
					: "Summarize the verified result and note any residual risks.",
			stepRationale:
				shouldResearchOnline && (ledger.research?.sourceUrls.length ?? 0) > 0
					? "Verification is satisfied, and the final report should cite the supporting sources clearly before stopping."
					: "Verification is satisfied, so the remaining work is reporting clearly and stopping.",
			expectedVerification:
				shouldResearchOnline && (ledger.research?.preferredSourceUrls.length ?? 0) > 0
					? `Cite source URLs such as ${ledger.research?.preferredSourceUrls.slice(0, 2).join(", ")}`
					: ledger.lastVerificationDetail,
		};
	}
	if (assessment === "confirm_completion") {
		return {
			plannedNextStep: "Either continue with concrete tool-driven work or provide a final verified summary.",
			stepRationale: "The last turn looked like a status update rather than confirmed task completion.",
			expectedVerification: ledger.taskJournal.expectedVerification ?? ledger.lastVerificationDetail,
		};
	}
	return {
		plannedNextStep: ledger.taskJournal.nextAction ?? "Continue with the next concrete step.",
		stepRationale: "The run should keep moving according to the current plan state rather than rehashing prior context.",
		expectedVerification: ledger.taskJournal.expectedVerification,
	};
}

function sessionHasVisualVerificationTools(session: unknown): boolean {
	if (!session || typeof session !== "object") return false;
	const maybeSession = session as { getToolDefinition?: (name: string) => unknown; getActiveToolNames?: () => string[] };
	if (typeof maybeSession.getToolDefinition === "function") {
		return (
			maybeSession.getToolDefinition("screenshot_url") !== undefined ||
			maybeSession.getToolDefinition("interact_then_screenshot") !== undefined
		);
	}
	if (typeof maybeSession.getActiveToolNames === "function") {
		const active = new Set(maybeSession.getActiveToolNames());
		return active.has("screenshot_url") || active.has("interact_then_screenshot");
	}
	return false;
}

function sessionHasResearchTools(session: unknown): boolean {
	if (!session || typeof session !== "object") return false;
	const maybeSession = session as { getToolDefinition?: (name: string) => unknown; getActiveToolNames?: () => string[] };
	if (typeof maybeSession.getToolDefinition === "function") {
		for (const toolName of RESEARCH_TOOL_NAMES) {
			if (maybeSession.getToolDefinition(toolName) !== undefined) return true;
		}
		return false;
	}
	if (typeof maybeSession.getActiveToolNames === "function") {
		const active = new Set(maybeSession.getActiveToolNames());
		for (const toolName of RESEARCH_TOOL_NAMES) {
			if (active.has(toolName)) return true;
		}
	}
	return false;
}

function shouldUseVisualVerification(
	ledger: AutonomousRunLedger,
	visualVerificationAvailable: boolean,
	userMessage: string,
): boolean {
	if (!visualVerificationAvailable) return false;
	if (FRONTEND_TASK_PATTERNS.some((pattern) => pattern.test(userMessage))) return true;
	if (ledger.residualRisks.some((risk) => /\bbrowser|ui|layout|visual|responsive|styling\b/i.test(risk))) return true;
	if (ledger.currentFocus && /\bui|layout|browser|visual|frontend|page|responsive\b/i.test(ledger.currentFocus)) return true;
	if (ledger.touchedFiles.some((file) => FRONTEND_FILE_PATTERNS.some((pattern) => pattern.test(file)))) return true;
	if (ledger.readFiles.some((file) => FRONTEND_FILE_PATTERNS.some((pattern) => pattern.test(file)))) return true;
	return false;
}

function shouldUseResearch(
	ledger: AutonomousRunLedger,
	researchToolsAvailable: boolean,
	userMessage: string,
): boolean {
	if (!researchToolsAvailable) return false;
	if (RESEARCH_TASK_PATTERNS.some((pattern) => pattern.test(userMessage))) return true;
	if (ledger.research && (ledger.research.searchQueries.length > 0 || ledger.research.fetchedUrls.length > 0)) return true;
	if (ledger.currentFocus && /\b(docs|documentation|api|reference|research|source|latest|current)\b/i.test(ledger.currentFocus)) {
		return true;
	}
	if (ledger.residualRisks.some((risk) => /\b(source|citation|documentation|api|current|latest|release)\b/i.test(risk))) {
		return true;
	}
	return false;
}

function hasReusableResearchSource(ledger: AutonomousRunLedger): boolean {
	return (ledger.research?.fetchedUrls.length ?? 0) > 0 || (ledger.research?.preferredSourceUrls.length ?? 0) > 0;
}

function summarizeResearchFindingsForPrompt(ledger: AutonomousRunLedger): string {
	const findings = ledger.research?.recentFindings ?? [];
	if (findings.length === 0) return "";

	const factLike = findings.filter((finding) => finding.includes(": ") && !finding.includes(" — http"));
	const selected = (factLike.length > 0 ? factLike : findings).slice(0, 2);
	return selected.length > 0 ? ` Reuse saved findings such as ${selected.join(" | ")}.` : "";
}

function isVerificationOnlyTask(goal: string): boolean {
	return (
		VERIFY_ONLY_TASK_PATTERNS.some((pattern) => pattern.test(goal)) &&
		!IMPLEMENTATION_TASK_PATTERNS.some((pattern) => pattern.test(goal))
	);
}

function hasSufficientCodingVerificationEvidence(ledger: AutonomousRunLedger, goal: string): boolean {
	if (!ledger.verificationSatisfied) return false;
	if (ledger.lastActionType !== "verification") return false;
	const summarizeItem = ledger.taskJournal.planItems.find((item) => item.key === "summarize");
	if (summarizeItem?.status !== "active" && summarizeItem?.status !== "completed") return false;
	return (
		ledger.touchedFiles.length > 0 ||
		ledger.recentMutations.length > 0 ||
		ledger.verificationFailures.length > 0 ||
		isVerificationOnlyTask(goal)
	);
}

function hasSufficientVisualEvidence(ledger: AutonomousRunLedger, goal: string): boolean {
	if (!ledger.verificationSatisfied) return false;
	if (ledger.lastActionType !== "verification") return false;
	if (!ledger.visualIteration?.enabled) return false;
	if (ledger.visualIteration.phase !== "verified") return false;
	if (ledger.visualAssessment?.latestJudgment !== "pass") return false;
	return ledger.touchedFiles.length > 0 || ledger.recentMutations.length > 0 || isVerificationOnlyTask(goal);
}

function buildInitialAutonomousPrompt(userMessage: string, researchToolsAvailable: boolean): string {
	if (!researchToolsAvailable) return userMessage;
	if (!RESEARCH_TASK_PATTERNS.some((pattern) => pattern.test(userMessage))) return userMessage;
	return `${userMessage}\n\nIf this requires current or external information, use webSearch first, then webFetch the most relevant URL, and keep the source URLs available in your notes.`;
}

function buildResumeAutonomousPrompt(
	userMessage: string,
	researchToolsAvailable: boolean,
	resumeSnapshot: AutonomousRunSnapshot,
): string {
	const basePrompt = buildInitialAutonomousPrompt(userMessage, researchToolsAvailable);
	const ledger = resumeSnapshot.ledger;
	const resumeInstruction =
		ledger.resume?.resumeInstruction ??
		ledger.taskJournal.plannedNextStep ??
		ledger.taskJournal.nextAction ??
		"Continue with the next concrete step.";
	const resumeReason =
		ledger.resume?.resumeReason ??
		ledger.taskJournal.stepRationale ??
		"Resume from the saved autonomous state instead of restarting from scratch.";
	const checkpoint = ledger.resume?.lastStableCheckpoint
		? `Last stable checkpoint: ${ledger.resume.lastStableCheckpoint}`
		: "Last stable checkpoint: none recorded yet";
	const resumeMode = ledger.resume?.mode ? `Resume mode: ${ledger.resume.mode}` : undefined;
	const lines = [
		"Resume the interrupted autonomous run from the saved control state.",
		`Original goal: ${ledger.goal}`,
		`Continuation request: ${basePrompt.trim()}`,
		...(resumeMode ? [resumeMode] : []),
		`Resume instruction: ${resumeInstruction}`,
		`Resume reason: ${resumeReason}`,
		checkpoint,
		"Do not restart from scratch or repeat already completed research or verification unless the saved state says it is still required.",
	];
	return appendLedgerContext(lines.join("\n"), ledger, "full");
}

function getBudgetPressure(
	status: BudgetStatus,
	config: AutonomousRunConfig,
): { level: BudgetPressureLevel; ratio: number } {
	const ratios: number[] = [];
	if (status.costAuthoritative && (config.maxCostUsd ?? 0) > 0) ratios.push(status.costUsed / (config.maxCostUsd ?? 1));
	if ((config.maxTokens ?? 0) > 0) ratios.push(status.tokensUsed / (config.maxTokens ?? 1));
	if ((config.maxTurns ?? 0) > 0) ratios.push(status.turnsUsed / (config.maxTurns ?? 1));
	const ratio = ratios.length > 0 ? Math.max(...ratios) : 0;

	if ((config.maxTurns ?? 0) > 0) {
		const remainingTurns = (config.maxTurns ?? 0) - status.turnsUsed;
		if (remainingTurns <= 1) return { level: "critical", ratio: Math.max(ratio, 0.95) };
		if (remainingTurns <= 2 && ratio < 0.8) return { level: "high", ratio: Math.max(ratio, 0.8) };
	}

	if (ratio >= 0.92) return { level: "critical", ratio };
	if (ratio >= 0.8) return { level: "high", ratio };
	if (ratio >= 0.6) return { level: "elevated", ratio };
	return { level: "normal", ratio };
}

function getBudgetControlDirective(
	budgetPressure: { level: BudgetPressureLevel; ratio: number },
	state: AutonomousCheckpointState,
	ledger: AutonomousRunLedger,
): BudgetControlDirective {
	const detail =
		ledger.taskJournal.expectedVerification ??
		ledger.taskJournal.plannedNextStep ??
		ledger.taskJournal.nextAction ??
		"finish the current slice with concrete verification";
	if (budgetPressure.level === "critical") {
		return { kind: "squeeze", level: budgetPressure.level, detail };
	}
	if (
		budgetPressure.level === "high" ||
		(budgetPressure.level === "elevated" &&
			(state.consecutiveIntentDriftCount > 0 || state.consecutiveIntentFailureCount > 0 || !ledger.verificationSatisfied))
	) {
		return { kind: "trim", level: budgetPressure.level, detail };
	}
	return { kind: "none", level: budgetPressure.level };
}

function getBudgetAdjustedCompactionTrigger(trigger: number, pressure: BudgetPressureLevel): number {
	if (pressure === "critical") return Math.floor(trigger * 0.65);
	if (pressure === "high") return Math.floor(trigger * 0.8);
	if (pressure === "elevated") return Math.floor(trigger * 0.9);
	return trigger;
}

function getIntentControlDirective(
	state: AutonomousCheckpointState,
	ledger: AutonomousRunLedger,
): IntentControlDirective {
	const degradedTurnCount = state.consecutiveDegradedTurnCount ?? 0;
	const criticalDegradedTurnCount = state.consecutiveCriticalDegradedTurnCount ?? 0;
	if (criticalDegradedTurnCount >= 3) {
		return {
			kind: "stop_blocked",
			detail: `Autonomous run stopped after ${criticalDegradedTurnCount} consecutive critically degraded turns: ${formatDegradedTurnDirectiveDetail(state)}`,
		};
	}
	if (criticalDegradedTurnCount >= 2) {
		return {
			kind: "narrow_scope",
			detail: formatDegradedTurnDirectiveDetail(state),
		};
	}
	if (degradedTurnCount >= 2) {
		return {
			kind: "replan",
			detail: formatDegradedTurnDirectiveDetail(state),
		};
	}
	if (degradedTurnCount >= 1) {
		return {
			kind: "recover",
			detail: formatDegradedTurnDirectiveDetail(state),
		};
	}
	const intentStatus = ledger.taskJournal.intentStatus;
	const detail = ledger.taskJournal.lastIntentOutcome ?? ledger.taskJournal.nextAction ?? "autonomous run went off track";
	if (intentStatus === "failed") {
		if (state.consecutiveIntentFailureCount >= 3) {
			return {
				kind: "stop_blocked",
				detail: `Autonomous run stopped after ${state.consecutiveIntentFailureCount} consecutive failed steps: ${detail}`,
			};
		}
		if (state.consecutiveIntentFailureCount >= 2) {
			return {
				kind: "narrow_scope",
				detail,
			};
		}
		return {
			kind: "recover",
			detail,
		};
	}
	if (intentStatus === "drifted") {
		if (state.consecutiveIntentDriftCount >= 4) {
			return {
				kind: "stop_blocked",
				detail: `Autonomous run stopped after ${state.consecutiveIntentDriftCount} consecutive drifted steps: ${detail}`,
			};
		}
		if (state.consecutiveIntentDriftCount >= 3) {
			return {
				kind: "narrow_scope",
				detail,
			};
		}
		if (state.consecutiveIntentDriftCount >= 2) {
			return {
				kind: "replan",
				detail,
			};
		}
	}
	return { kind: "none" };
}

function formatDegradedTurnDirectiveDetail(state: AutonomousCheckpointState): string {
	const severity = state.lastDegradedTurnSeverity ?? "elevated";
	const reasons = state.lastDegradedTurnReasons && state.lastDegradedTurnReasons.length > 0
		? `: ${state.lastDegradedTurnReasons.join(", ")}`
		: "";
	return `degraded turn ${severity}${reasons}`;
}

function isDegradedTurnDirectiveDetail(detail: string): boolean {
	return detail.startsWith("degraded turn ");
}

function assessTurnIntent(options: {
	plannedLedger: AutonomousRunLedger;
	turnToolHistory: ToolOutcome[];
	turnFileAccessHistory: ToolOutcome[];
	assessment: TurnAssessmentKind;
	verificationState: VerificationCheckpointState;
}): { outcome: "on_track" | "drifted" | "failed"; detail: string } {
	const verifyItem = options.plannedLedger.taskJournal.planItems.find((item) => item.key === "verify");
	const implementItem = options.plannedLedger.taskJournal.planItems.find((item) => item.key === "implement");
	const summarizeItem = options.plannedLedger.taskJournal.planItems.find((item) => item.key === "summarize");
	const inspectItem = options.plannedLedger.taskJournal.planItems.find((item) => item.key === "inspect");
	const plannedStep = options.plannedLedger.taskJournal.plannedNextStep?.toLowerCase() ?? "";
	const verificationAttempt = options.turnToolHistory.find((outcome) => isVerificationOutcome(outcome));
	const visualVerificationAttempt = options.turnToolHistory.find((outcome) => isVisualVerificationOutcome(outcome) && outcome.success);
	const webSearchAttempt = options.turnToolHistory.find((outcome) => outcome.tool.toLowerCase() === "websearch");
	const webFetchAttempt = options.turnToolHistory.find((outcome) => outcome.tool.toLowerCase() === "webfetch");
	const mutation = options.turnToolHistory.find((outcome) => isMutatingOutcome(outcome) && outcome.success);
	const inspection = options.turnFileAccessHistory.find((outcome) => READ_TOOL_NAMES.has(outcome.tool.toLowerCase()) && outcome.success);
	const visualPhase = options.plannedLedger.visualIteration?.phase;

	if (visualPhase === "baseline_capture") {
		if (visualVerificationAttempt) {
			return {
				outcome: "on_track",
				detail: `baseline visual capture matched intent: ${visualVerificationAttempt.detail ?? visualVerificationAttempt.file ?? visualVerificationAttempt.tool}`,
			};
		}
		if (mutation) {
			return {
				outcome: "drifted",
				detail: "expected a baseline visual capture before further UI changes",
			};
		}
	}
	if (visualPhase === "recapture") {
		if (visualVerificationAttempt) {
			const issues = getVisualVerificationBlockingIssues(visualVerificationAttempt);
			if (issues.length > 0) {
				return {
					outcome: "failed",
					detail: `visual verification found blocking issues: ${summarizeVisualBlockingIssues(issues)}`,
				};
			}
			return {
				outcome: "on_track",
				detail: `visual recapture matched intent: ${visualVerificationAttempt.detail ?? visualVerificationAttempt.file ?? visualVerificationAttempt.tool}`,
			};
		}
	}

	if (verificationAttempt) {
		if (verificationAttempt.success && isVisualVerificationOutcome(verificationAttempt)) {
			const issues = getVisualVerificationBlockingIssues(verificationAttempt);
			if (issues.length > 0) {
				return {
					outcome: "failed",
					detail: `visual verification found blocking issues: ${summarizeVisualBlockingIssues(issues)}`,
				};
			}
		}
		if (verificationAttempt.success) {
			return {
				outcome: "on_track",
				detail: `verification matched intent: ${verificationAttempt.detail ?? verificationAttempt.file ?? verificationAttempt.tool}`,
			};
		}
		return {
			outcome: "failed",
			detail: `verification failed: ${verificationAttempt.detail ?? verificationAttempt.file ?? verificationAttempt.tool}`,
		};
	}
	if (verifyItem?.status === "blocked") {
		return {
			outcome: "failed",
			detail: options.plannedLedger.taskJournal.blockedReasons[0] ?? "verification blocker was not resolved",
		};
	}
	if (verifyItem?.status === "active") {
		return {
			outcome: "drifted",
			detail: "expected verification work, but the turn did not run a verification step",
		};
	}
	if (plannedStep.includes("websearch")) {
		if (webSearchAttempt?.success) {
			return {
				outcome: "on_track",
				detail: `research search matched intent: ${webSearchAttempt.detail ?? webSearchAttempt.file ?? webSearchAttempt.tool}`,
			};
		}
		if (webFetchAttempt?.success) {
			return {
				outcome: "drifted",
				detail: "expected a webSearch step before fetching a source",
			};
		}
		if (webSearchAttempt && !webSearchAttempt.success) {
			return {
				outcome: "failed",
				detail: `research search failed: ${webSearchAttempt.detail ?? webSearchAttempt.file ?? webSearchAttempt.tool}`,
			};
		}
	}
	if (plannedStep.includes("webfetch")) {
		if (webFetchAttempt?.success) {
			return {
				outcome: "on_track",
				detail: `research fetch matched intent: ${webFetchAttempt.detail ?? webFetchAttempt.file ?? webFetchAttempt.tool}`,
			};
		}
		if (webFetchAttempt && !webFetchAttempt.success) {
			return {
				outcome: "failed",
				detail: `research fetch failed: ${webFetchAttempt.detail ?? webFetchAttempt.file ?? webFetchAttempt.tool}`,
			};
		}
		if (webSearchAttempt?.success) {
			return {
				outcome: "drifted",
				detail: "expected a webFetch step to read the chosen source",
			};
		}
	}
	if (
		hasReusableResearchSource(options.plannedLedger) &&
		!plannedStep.includes("websearch") &&
		!plannedStep.includes("webfetch") &&
		(webSearchAttempt?.success || webFetchAttempt?.success)
	) {
		return {
			outcome: "drifted",
			detail: "expected reuse of an existing authoritative source instead of another web research step",
		};
	}
	if (mutation) {
		return {
			outcome: implementItem?.status === "active" || implementItem?.status === "completed" ? "on_track" : "drifted",
			detail: `mutation matched intent: ${mutation.detail ?? mutation.file ?? mutation.tool}`,
		};
	}
	if (inspection) {
		return {
			outcome: inspectItem?.status === "active" || implementItem?.status === "active" ? "on_track" : "drifted",
			detail: `inspection matched intent: ${inspection.detail ?? inspection.file ?? inspection.tool}`,
		};
	}
	if (options.assessment === "complete" && (summarizeItem?.status === "active" || options.verificationState.hasVerificationCheckpoint)) {
		return {
			outcome: "on_track",
			detail: "completion matched the planned summarize step",
		};
	}
	if (
		options.assessment === "complete" &&
		plannedStep.includes("summarize the source-backed answer") &&
		hasSufficientResearchEvidence(options.plannedLedger.research)
	) {
		return {
			outcome: "on_track",
			detail: "completion matched the planned source-backed summarize step",
		};
	}
	return {
		outcome: "drifted",
		detail: options.plannedLedger.taskJournal.plannedNextStep
			? `turn drifted from intent: ${options.plannedLedger.taskJournal.plannedNextStep}`
			: "turn drifted from the expected next step",
	};
}

function promoteEvidenceBackedCompletion(
	assessment: TurnAssessmentKind,
	options: {
		currentLedger: AutonomousRunLedger;
		status?: AutonomousRunResult["stopReason"];
		lastAssistantText: string;
		toolHistory: ToolOutcome[];
		fileAccessHistory: ToolOutcome[];
		verificationSatisfied: boolean;
		lastVerificationDetail?: string;
		visualVerificationRelevant?: boolean;
		researchRelevant: boolean;
		userMessage: string;
	},
): TurnAssessmentKind {
	const projectedLedger = updateAutonomousRunLedger({
		current: options.currentLedger,
		status: options.status,
		lastAssistantText: options.lastAssistantText,
		toolHistory: options.toolHistory,
		fileAccessHistory: options.fileAccessHistory,
		verificationSatisfied: options.verificationSatisfied,
		lastVerificationDetail: options.lastVerificationDetail,
		visualVerificationRelevant: options.visualVerificationRelevant,
	});
	const hasResearchStopEvidence =
		options.researchRelevant &&
		isResearchOnlyLedger(projectedLedger) &&
		hasSufficientResearchEvidence(projectedLedger.research);
	const hasVisualStopEvidence =
		!!options.visualVerificationRelevant && hasSufficientVisualEvidence(projectedLedger, options.userMessage);
	const hasImplementationStopEvidence =
		!options.visualVerificationRelevant && hasSufficientCodingVerificationEvidence(projectedLedger, options.userMessage);

	if (assessment === "confirm_verification") {
		if (hasResearchStopEvidence || hasVisualStopEvidence || hasImplementationStopEvidence) {
			return "complete";
		}
		return assessment;
	}

	if (assessment !== "continue" && assessment !== "confirm_completion") return assessment;
	if (hasVisualStopEvidence || hasImplementationStopEvidence) return "complete";
	return assessment;
}

function isResearchOnlyLedger(ledger: AutonomousRunLedger): boolean {
	return ledger.touchedFiles.length === 0 && ledger.recentMutations.length === 0;
}

function buildLedgerEvents(options: {
	status?: AutonomousRunResult["stopReason"];
	toolHistory: ToolOutcome[];
	fileAccessHistory: ToolOutcome[];
	verificationSatisfied: boolean;
	lastVerificationDetail?: string;
	visualFailureDetail?: string;
	assessment: TurnAssessmentKind;
	visualVerificationRelevant?: boolean;
}): AutonomousLedgerEvent[] {
	const events: AutonomousLedgerEvent[] = [];
	const latestRead = findLatestSuccessfulReadOutcome(options.fileAccessHistory);
	if (latestRead?.detail || latestRead?.file) {
		events.push({ type: "inspection_complete", detail: latestRead.detail ?? latestRead.file });
	}
	const latestMutation = findLatestSuccessfulMutationOutcome(options.toolHistory);
	if (latestMutation?.detail || latestMutation?.file) {
		events.push({ type: "implementation_changed", detail: latestMutation.detail ?? latestMutation.file });
	}
	if (options.visualFailureDetail) {
		events.push({ type: "verification_failed", detail: options.visualFailureDetail });
	} else {
	const latestFailedVerification = findLatestFailedVerificationOutcome(options.toolHistory);
		if (latestFailedVerification?.detail) {
			events.push({ type: "verification_failed", detail: latestFailedVerification.detail });
		} else if (latestMutation && !options.verificationSatisfied) {
			events.push({ type: "verification_required", detail: latestMutation.detail ?? latestMutation.file });
		} else if (options.visualVerificationRelevant && !options.verificationSatisfied) {
			events.push({ type: "verification_required", detail: "visual verification pending" });
		}
	}
	if (options.verificationSatisfied) {
		events.push({ type: "verification_passed", detail: options.lastVerificationDetail });
		events.push({ type: "summarize_ready", detail: options.lastVerificationDetail });
	}
	if (options.assessment === "complete" || options.status === "complete") {
		events.push({ type: "completion_confirmed" });
	}
	if (options.status === "error" || options.assessment === "error") {
		events.push({ type: "run_error" });
	}
	if (options.status === "budget") {
		events.push({ type: "budget_exhausted" });
	}
	if (options.status === "nudge") {
		events.push({ type: "nudge_stop" });
	}
	return events;
}

function findLatestSuccessfulReadOutcome(fileAccessHistory: ToolOutcome[]): ToolOutcome | undefined {
	for (let i = fileAccessHistory.length - 1; i >= 0; i--) {
		const outcome = fileAccessHistory[i];
		if (outcome.success && READ_TOOL_NAMES.has(outcome.tool.toLowerCase())) {
			return outcome;
		}
	}
	return undefined;
}

function findLatestSuccessfulMutationOutcome(toolHistory: ToolOutcome[]): ToolOutcome | undefined {
	for (let i = toolHistory.length - 1; i >= 0; i--) {
		const outcome = toolHistory[i];
		if (outcome.success && isMutatingOutcome(outcome)) {
			return outcome;
		}
	}
	return undefined;
}

function findLatestFailedVerificationOutcome(toolHistory: ToolOutcome[]): ToolOutcome | undefined {
	for (let i = toolHistory.length - 1; i >= 0; i--) {
		const outcome = toolHistory[i];
		if (!outcome.success && isVerificationOutcome(outcome)) {
			return outcome;
		}
	}
	return undefined;
}
