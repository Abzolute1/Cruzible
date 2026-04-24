import type { ImageContent } from "@ag1/ai";
import type { AgentSessionEvent } from "../agent-session.js";
import type { AgentSessionRuntime } from "../agent-session-runtime.js";
import { SessionDebugLogger } from "../session-debug-logger.js";
import {
	hasAutonomousLocalReferenceContext,
	looksLikeAutonomousImplementationTask,
	looksLikeAutonomousLocalAnswerTask,
	looksLikeAutonomousPathLookupTask,
	looksLikeAutonomousResearchTask,
	looksLikeAutonomousVerifyOnlyTask,
} from "../task-intent.js";
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
import type { NudgeCooldownState, NudgeType, ToolOutcome } from "./nudges/types.js";

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
const MIN_PROACTIVE_COMPACTION_TOKENS = 8_000;
const MIN_PROACTIVE_COMPACTION_ITERATIONS = 4;
const TERMINAL_STOP_REASONS = new Set(["end_turn", "stop"]);
const TRUNCATED_STOP_REASONS = new Set(["max_tokens", "length"]);
const EXPLICIT_COMPLETION_PATTERNS = [
	/\b(task|work|implementation|fix|changes?)\s+(is\s+)?(complete|completed|done|finished)\b/i,
	/\b(successfully\s+)?(completed|finished|resolved|implemented)\b/i,
	/\b(fix(?:ed)?|change[sd]?|patch(?:ed)?)\b.*\b(verif(?:y|ied|ication)|tests?\s+pass(?:ed)?|verification\s+pass(?:ed)?)\b/i,
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
	/<tool_call>/i,
	/\b(let me|i(?:'ll| will)|going to)\s+(run|rerun|check|verify|read|inspect|edit|patch|update|fix|apply)\b/i,
	/\?\s*$/m,
];
const VERIFIED_SUMMARY_CHANGE_PATTERNS = [
	/\b(change[sd]?|fix(?:ed)?|update[sd]?|patch(?:ed)?|modif(?:y|ied)|preserv(?:e|ed)|implement(?:ed)?)\b/i,
	/\b(file|parser|function|module|config|banner|test)\b/i,
];
const VERIFIED_SUMMARY_VERIFICATION_PATTERNS = [/\b(verif(?:y|ied|ication)|test(?:s)?|passed|pass(?:ing)?|node --test|npm test|check(?:ed)?)\b/i];
const VERIFIED_SUMMARY_FILE_PATTERNS = [
	/`[^`\n]+\.[a-z0-9]+`/i,
	/\b(?:src|tests?|reference|docs|generated|cli)\/[^\s)`]+/i,
	/\b[a-z0-9_-]+\.(?:mjs|cjs|js|ts|tsx|jsx|json|md)\b/i,
];
const DIRECT_ANSWER_PAYLOAD_PATTERNS = [
	/`[^`\n]+`/,
	/\b(?:src|tests?|packages|scripts|docs?|reference)\/[^\s)`]+/i,
	/\bhttps?:\/\/\S+/i,
	/\b(?:defined|implemented|located|found|lives)\s+(?:in|at)\b/i,
	/\bthe\s+(?:file|directory|function|definition|path|difference|answer)\b/i,
	/\bit\s+(?:is|lives|sits)\b/i,
	/\bbecause\b/i,
];
const DIRECT_ANSWER_META_ONLY_PATTERNS = [
	/\b(i|we)\s+(?:inspected|checked|looked(?:\s+through)?|reviewed|investigated|analyzed)\b/i,
	/\bidentified\s+the\s+next\s+changes?\b/i,
	/\bnext\s+changes?\b/i,
	/\bnext\s+steps?\b/i,
	/\bready\s+for\s+the\s+next\s+step\b/i,
];
const VERIFICATION_COMMAND_PATTERNS = [
	/(?:^|[;&]\s*)node\b[^\n;&|]*\b(?:--test|test|check|verify|lint|build)\b/i,
	/(?:^|[;&]\s*)(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|lint|typecheck|build|check)|lint|typecheck|build|check)\b/i,
	/(?:^|[;&]\s*)npx\s+(?:vitest|jest|playwright|eslint|tsc)\b/i,
	/(?:^|[;&]\s*)(?:vitest|jest|pytest|cargo test|go test|playwright test|eslint|tsc|make\s+(?:test|lint|build|check))\b/i,
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
const EXTERNAL_RESEARCH_PATTERNS = [
	/\b(latest|current|today|recent|release|changelog|breaking changes?)\b/i,
	/\b(research|search online|web search|search the web|look up|external source|citation|source url)\b/i,
	/\b(compare|comparison|pricing|availability|compatibility)\b/i,
];
const DOCUMENTATION_RESEARCH_PATTERNS = [/\b(documentation|docs|api reference|reference|guide|manual|spec)\b/i];
const VERIFY_ONLY_TASK_PATTERNS = [/\b(verify|verification|check|validate|review|inspect|assess|audit|confirm)\b/i];
const IMPLEMENTATION_TASK_PATTERNS = [
	/\b(fix|debug|patch|repair|migrate|improve|update|change|modify|edit|implement|build|add|create|refactor|tighten|rewrite|replace)\b/i,
];
const SELF_CONTAINED_WORKSPACE_PATTERNS = [/\bself-contained benchmark workspace\b/i, /\bstay inside this workspace\b/i];
const LOCAL_VERIFICATION_COMMAND_PATTERNS = [/\bverification command\b/i, /\bintended verification command\b/i, /\bnode --test\b/i];
const SINGLE_FILE_PRECISION_PATTERNS = [/\bonly the implementation file should need to change\b/i, /\bdo not touch generated files\b/i];
const SELF_CONTAINED_SUMMARY_FILE_PATTERNS = [/\bsummary\.md\b/i, /\bnotes?\b/i, /\bdocs?\b/i, /\breport\b/i];

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
	const previousAutoCompactionEnabled = session.autoCompactionEnabled;
	if (previousAutoCompactionEnabled) {
		session.setAutoCompactionEnabled(false);
	}
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
						lastAssistantText,
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
			const bypassStopNudgeForVerifiedSummary = nudge.shouldStop
				&& shouldBypassStopNudgeForVerifiedSummary({
					ledger,
					userMessage,
					visualVerificationRelevant,
					researchRelevant,
				});
			const effectiveNudge = bypassStopNudgeForVerifiedSummary
				? {
						...nudge,
						shouldStop: false,
						shouldNudge: false,
						nudgeType: "none" as const,
					}
				: nudge;
			if (nudge.shouldStop && !bypassStopNudgeForVerifiedSummary) {
				process.stderr.write(`[Auton] Nudge engine says stop: ${nudge.stopReason}\n`);
				ledger = { ...ledger, status: "nudge" };
				stopReason = "nudge";
				break;
			}
			if (bypassStopNudgeForVerifiedSummary) {
				process.stderr.write(`[Auton] Bypassing stop nudge after verified completion evidence: ${nudge.stopReason}\n`);
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
			if (effectiveNudge.shouldNudge && effectiveNudge.nudgeType !== "none") {
				const nudgeMessage =
					buildSelfContainedWorkspaceNudgeMessage(effectiveNudge.nudgeType, promptLedger, userMessage) ??
					getNudgeMessage(effectiveNudge.nudgeType);
				continueMsg = appendLedgerContext(nudgeMessage, promptLedger);
				process.stderr.write(`[Auton] Nudge injected: ${effectiveNudge.nudgeType} — ${continueMsg.slice(0, 80)}...\n`);
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
				lastAssistantText: postTurnAssistantText,
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
				if (
					usage.tokens >= trigger &&
					usage.tokens >= MIN_PROACTIVE_COMPACTION_TOKENS &&
					iterations >= MIN_PROACTIVE_COMPACTION_ITERATIONS
				) {
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
		if (session.autoCompactionEnabled !== previousAutoCompactionEnabled) {
			session.setAutoCompactionEnabled(previousAutoCompactionEnabled);
		}
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
			const textContent = content
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
			if (textContent.length > 0) return textContent;
			const thinkingContent = content
				.filter((part): part is { type: "thinking"; thinking: string } => {
					return (
						typeof part === "object" &&
						part !== null &&
						"type" in part &&
						part.type === "thinking" &&
						"thinking" in part &&
						typeof part.thinking === "string"
					);
				})
				.map((part) => part.thinking)
				.join("\n")
				.trim();
			if (thinkingContent.length > 0) return thinkingContent;
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
		return isReliableVerificationBashCommand(detail);
	}
	return false;
}

function isReliableVerificationBashCommand(detail: string): boolean {
	const normalized = detail.replace(/\s+/g, " ").trim();
	if (!normalized) return false;
	if (/\|\s*(head|tail)\b/i.test(normalized) && !/\bset\s+-o\s+pipefail\b/i.test(normalized)) {
		return false;
	}
	return VERIFICATION_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
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

function getVerificationFailurePreview(outcome: ToolOutcome): string | undefined {
	const detail = outcome.detail?.trim();
	const metadata = outcome.metadata;
	const previewCandidates = [
		typeof metadata?.outputPreview === "string" ? metadata.outputPreview : undefined,
		typeof metadata?.summary === "string" ? metadata.summary : undefined,
		typeof metadata?.error === "string" ? metadata.error : undefined,
	];
	for (const candidate of previewCandidates) {
		const normalized = candidate?.trim();
		if (!normalized) continue;
		if (detail && normalized.toLowerCase() === detail.toLowerCase()) continue;
		return normalized.length <= 180 ? normalized : `${normalized.slice(0, 177)}...`;
	}
	return undefined;
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
	const selfContainedWorkspaceTask = isSelfContainedWorkspaceTask(userMessage);
	const singleFilePrecisionTask = isSingleFilePrecisionTask(userMessage);
	const localVerificationCommand = extractLocalVerificationCommand(userMessage);
	const misleadingSiblingTask = mentionsMisleadingSiblingWarning(userMessage);
	const namedReferencePath = extractNamedWorkspacePath(userMessage, /^(?:reference|docs?|guides?|manuals?|specs?)\//i);
	const latestReadSourceFile = getLatestReadWorkspaceFile(ledger, /^src\//i);
	const latestReadTestFile = getLatestReadWorkspaceFile(ledger, /^tests?\//i);
	const latestKnownSourceFile = getLatestKnownWorkspaceFile(ledger, /^src\//i);
	const latestKnownTestFile = getLatestKnownWorkspaceFile(ledger, /^tests?\//i);
	const latestReadReferenceFile = getLatestReadWorkspaceFile(ledger, /^reference\//i);
	const committedReferenceSourceFile = getCommittedReferenceSourceFile(ledger);
	const readSourceFiles = getWorkspaceFilesByPrefix(ledger.readFiles, /^src\//i);
	const readTestFiles = getWorkspaceFilesByPrefix(ledger.readFiles, /^tests?\//i);
	const taskRequiresTestUpdate = requiresTestUpdate(userMessage);
	const initialTestUpdateMissing = taskNeedsInitialTestUpdate(ledger, userMessage);
	const requestedTestCoverageRepair = getRequestedTestCoverageRepair(ledger, userMessage);
	const failedRepairTargetFile = getFailedRepairTargetFile(ledger);
	const failedRepairTargetAlreadyRead = failedRepairTargetFile ? ledger.readFiles.includes(failedRepairTargetFile) : false;
	const verifierScriptPath = extractWorkspaceVerifierScriptPath(localVerificationCommand);
	const verifierScriptUnread = verifierScriptPath ? !ledger.readFiles.includes(verifierScriptPath) : false;
	const selfContainedSummaryRule = getSelfContainedSummaryResponseRule(userMessage);
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
			return `You have enough visual verification evidence for the current UI slice. Summarize the verified rendered result${visualSurfaceHint}, note any residual risks, and stop.${visualInteractionHint}${visualRecipeHint}${visualViewportHint}${visualAcceptanceHint}${selfContainedSummaryRule}`;
		}
		if (hasEnoughImplementationEvidence) {
			return `You have enough verification evidence for the current implementation slice. Do not call any more tools. Summarize the verified result, note any residual risks, and stop.${sourceSummaryHint}${selfContainedSummaryRule}`;
		}
		if (selfContainedWorkspaceTask && !shouldUseVisual && !shouldResearchOnline) {
			const verifyItemActive = ledger.taskJournal.planItems.find((item) => item.key === "verify")?.status === "active";
			const implementItemActive = ledger.taskJournal.planItems.find((item) => item.key === "implement")?.status === "active";
			const inspectItemActive = ledger.taskJournal.planItems.find((item) => item.key === "inspect")?.status === "active";
			if (namedReferencePath && latestReadReferenceFile !== namedReferencePath) {
				return `The task already names the local reference \`${namedReferencePath}\`. Read that exact file now before any more ls, find, grep, or bash discovery. After that, read the single most likely implementation file under src/ directly. If the file stem is plausible but the exact extension is unknown, list src once and read the concrete file you find instead of guessing alternate extensions or using globs.`;
			}
			if (failedRepairTargetFile) {
				return failedRepairTargetAlreadyRead
					? `The previous edit on \`${failedRepairTargetFile}\` did not apply. Do not reread other files, do not restate the diagnosis, and do not run verification yet. Emit one valid edit tool call on \`${failedRepairTargetFile}\` now with at least one concrete replacement.${getStructuredEditCallHint()} After that successful edit, run ${getVerificationCommandClause(localVerificationCommand)}.${getVerificationMisuseWarning(localVerificationCommand)}${selfContainedSummaryRule}`
					: `The previous edit on \`${failedRepairTargetFile}\` did not apply. Read that same file now, then emit one valid edit tool call on \`${failedRepairTargetFile}\`. Do not inspect sibling/helper files or rerun discovery first.${getStructuredEditCallHint()} After the successful edit, run ${getVerificationCommandClause(localVerificationCommand)}.${getVerificationMisuseWarning(localVerificationCommand)}${selfContainedSummaryRule}`;
			}
			if (requestedTestCoverageRepair) {
				return `Verification already identified the remaining regression-test mismatch: ${requestedTestCoverageRepair.blocker}. Edit \`${requestedTestCoverageRepair.testFile}\` directly${requestedTestCoverageRepair.sourceFile ? ` using \`${requestedTestCoverageRepair.sourceFile}\` only as context` : ""}. Do not reread or rediscover files first. After that test edit, rerun ${getVerificationCommandClause(localVerificationCommand)}.${getVerificationMisuseWarning(localVerificationCommand)}${selfContainedSummaryRule}`;
			}
			if (latestReadReferenceFile && readSourceFiles.length === 0 && ledger.recentMutations.length === 0) {
				return `You already read the named local reference \`${latestReadReferenceFile}\`. Read the single most likely implementation file under src/ directly now. If the exact extension is unknown, list src once and read the concrete file you find instead of guessing alternate extensions or using globs. Do not do more ls, find, grep, or bash discovery first.`;
			}
			if (latestReadReferenceFile && committedReferenceSourceFile && ledger.recentMutations.length === 0) {
				const helperWarning =
					latestReadSourceFile && latestReadSourceFile !== committedReferenceSourceFile
						? ` Do not pivot to \`${latestReadSourceFile}\` or another helper file unless a failing test, import path, or caller explicitly proves that \`${committedReferenceSourceFile}\` delegates the fix there.`
						: " Do not pivot to another src dependency/helper file unless a failing test, import path, or caller explicitly proves that the first src file delegates the fix elsewhere.";
				return `You already read the named local reference \`${latestReadReferenceFile}\` and the first plausible implementation file \`${committedReferenceSourceFile}\`. Commit to that implementation file now.${helperWarning} Emit one valid edit on \`${committedReferenceSourceFile}\`, then run ${getVerificationCommandClause(localVerificationCommand)}.${getVerificationMisuseWarning(localVerificationCommand)}`;
			}
			if (latestReadReferenceFile && latestReadSourceFile && readSourceFiles.length === 1 && ledger.recentMutations.length === 0) {
				return `You already read the named local reference \`${latestReadReferenceFile}\` and the likely implementation file \`${latestReadSourceFile}\`. Commit to that implementation file now. Do not pivot to another src dependency/helper file unless a failing test, import path, or caller explicitly proves that the first src file delegates the fix elsewhere. Emit one valid edit on \`${latestReadSourceFile}\`, then run ${getVerificationCommandClause(localVerificationCommand)}.${getVerificationMisuseWarning(localVerificationCommand)}`;
			}
			if (initialTestUpdateMissing) {
				return `This task explicitly requires a regression test change, and no test file has been updated yet. Before any verification or final summary, patch ${latestKnownTestFile ? `\`${latestKnownTestFile}\`` : "the required test under tests/"} now so it covers the requested behavior. Use the existing src change as context and avoid more rediscovery. After the test edit, run ${getVerificationCommandClause(localVerificationCommand)}.${getVerificationMisuseWarning(localVerificationCommand)}`;
			}
			if (verifyItemActive) {
				return `Run ${getVerificationCommandClause(localVerificationCommand)} now. Do not do more discovery or reread files first.${getVerificationMisuseWarning(localVerificationCommand)} After it passes, give a short summary and stop.${selfContainedSummaryRule}`;
			}
			if (implementItemActive && ledger.recentMutations.length === 0) {
				if (singleFilePrecisionTask) {
					if (latestReadSourceFile) {
						return `This is a single-file precision patch. Only edit \`${latestReadSourceFile}\` and do not touch generated, reference, cli, or sibling paths. If a previous edit attempt failed, reread \`${latestReadSourceFile}\` once and then emit one minimal valid edit tool call on that same file now.${getStructuredEditCallHint()} After the edit, run ${getVerificationCommandClause(localVerificationCommand)}.${getVerificationMisuseWarning(localVerificationCommand)}`;
					}
					return `This is a single-file precision patch. Read the relevant test under tests/ and the likely implementation file under src/ first. Do not guess wildcard or glob paths like \`tests/*.test.js\`; if the exact filename is unknown, list the directory once and then read the concrete file you found. Do not inspect generated, reference, cli, or sibling paths unless the test or verifier explicitly points there. If you already listed the workspace root, your next tool call must be a direct read, not another \`ls\`. Then emit one valid edit tool call on the confirmed src file.${getStructuredEditCallHint()} After that, run ${getVerificationCommandClause(localVerificationCommand)}.${getVerificationMisuseWarning(localVerificationCommand)}`;
				}
				if (taskRequiresTestUpdate && verifierScriptPath && verifierScriptUnread) {
					return `This task uses a custom local verifier at \`${verifierScriptPath}\`. Read that verifier script once now so the patch and regression test match its exact expectations. Then patch the smallest required src/test change and run ${getVerificationCommandClause(localVerificationCommand)}.${getVerificationMisuseWarning(localVerificationCommand)}`;
				}
				if (latestReadTestFile && readSourceFiles.length === 0) {
					return `You already inspected \`${latestReadTestFile}\`. Derive the matching implementation path from that test and read the corresponding file under src/ directly now. Do not use ls, find, or bash discovery again. After that read, emit one valid edit tool call${taskRequiresTestUpdate ? " and only then update the matching test if the task requires it" : ""}, then run ${getVerificationCommandClause(localVerificationCommand)}.${getVerificationMisuseWarning(localVerificationCommand)}`;
				}
				if (latestKnownSourceFile && !latestReadSourceFile) {
					return `The concrete implementation target is already known as \`${latestKnownSourceFile}\`. Read that file now. Do not use ls, find, grep, or bash discovery again. After that read, emit one valid edit tool call${taskRequiresTestUpdate && latestKnownTestFile ? ` and then update \`${latestKnownTestFile}\` if the task requires the regression test` : ""}, then run ${getVerificationCommandClause(localVerificationCommand)}.${getVerificationMisuseWarning(localVerificationCommand)}`;
				}
				if (taskRequiresTestUpdate && latestReadSourceFile && latestKnownTestFile && !latestReadTestFile) {
					return `You already know the matching regression test file is \`${latestKnownTestFile}\`. Read it now so the required coverage matches \`${latestReadSourceFile}\`. Do not guess alternate test paths or rerun discovery first. After that read, patch the src/test pair directly and run ${getVerificationCommandClause(localVerificationCommand)}.${getVerificationMisuseWarning(localVerificationCommand)}`;
				}
				if (latestReadTestFile && latestReadSourceFile) {
					return `You already inspected \`${latestReadTestFile}\` and \`${latestReadSourceFile}\`. Stop discovery and patch the smallest required change now.${taskRequiresTestUpdate ? ` If the task also requires a regression test, update \`${latestReadTestFile}\` after the src change instead of rediscovering files.` : ""}${readSourceFiles.length > 1 ? ` You already read ${readSourceFiles.length} src files; do not open another one unless the latest src read explicitly delegates the fix.` : ""}${getStructuredEditCallHint()} After the edit${taskRequiresTestUpdate ? " sequence" : ""}, run ${getVerificationCommandClause(localVerificationCommand)}.${getVerificationMisuseWarning(localVerificationCommand)}`;
				}
				return `The target is narrow enough for a small local patch. Stay inside \`.\` and use relative workspace paths only.${misleadingSiblingTask ? " If similarly named files exist, do not patch a sibling file until the failing test, caller, import path, or reference output confirms the true implementation target." : ""} Emit one valid edit tool call now for the smallest required change instead of more narration or shell discovery.${getStructuredEditCallHint()} After the edit, run ${getVerificationCommandClause(localVerificationCommand)}.${getVerificationMisuseWarning(localVerificationCommand)}`;
			}
			if (inspectItemActive && ledger.recentMutations.length === 0) {
				if (singleFilePrecisionTask) {
					return `This is a single-file precision workspace task. Treat \`.\` as the workspace root and use relative paths only. Read the relevant test under tests/ and the most likely implementation file under src/ first.${latestReadTestFile ? ` You already inspected \`${latestReadTestFile}\`; use it to confirm the matching src file.` : ""} If you already listed the workspace root, your next tool call must be a direct read, not another \`ls\`. Do not inspect generated, reference, cli, or sibling directories unless the test or verifier explicitly points there. After those reads, patch only the confirmed src file.`;
				}
				if (latestKnownSourceFile && !latestReadSourceFile) {
					return `The concrete implementation target is already known as \`${latestKnownSourceFile}\`. Read that file now. Do not use ls, find, grep, or bash discovery again.`;
				}
				if (taskRequiresTestUpdate && latestKnownTestFile && !latestReadTestFile && latestReadSourceFile) {
					return `The matching regression test file is already known as \`${latestKnownTestFile}\`. Read it now so the required coverage matches \`${latestReadSourceFile}\`. Do not guess alternate test paths or rerun discovery first.`;
				}
				if (taskRequiresTestUpdate && verifierScriptPath && verifierScriptUnread) {
					return `This is a small self-contained workspace task. Read the custom verifier script at \`${verifierScriptPath}\` once first so you know the exact regression-test expectations. Then read the relevant test and matching src file directly. Do not use ls, find, or bash loops to rediscover files.`;
				}
				if (latestReadTestFile && readSourceFiles.length === 0) {
					return `This is a small self-contained workspace task. You already inspected \`${latestReadTestFile}\`. Use the import or failing assertion in that test to choose the matching src file directly. Do not use ls, find, or bash loops to rediscover files. Read the corresponding file under src/ now, then patch the smallest required change.`;
				}
				if (readTestFiles.length > 0 && readSourceFiles.length > 0) {
					return `This is a small self-contained workspace task. You already have a relevant test and src file in hand. Do not expand discovery unless the latest src read explicitly points to one more helper. Make the next read or edit directly useful to the patch, then verify.`;
				}
				return `This is a small self-contained workspace task. Treat \`.\` as the workspace root and use relative paths only; do not jump to /home/alex/AG1 or another repo root. Stop broad shell discovery after the top-level listing. If you already listed the workspace root, your next tool call must be one direct read; do not call \`ls\` on subdirectories first. Do not grep for descriptive phrases or use bash/find loops to rediscover obvious local files. Read the most likely implementation file, relevant test, named reference, or verifier script directly under src/, tests?/, reference/, or scripts/.${misleadingSiblingTask ? " If similarly named files exist, confirm the real implementation path from the failing test, caller, import path, or reference output before editing any of them." : ""}`;
			}
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
					? `Recent turns keep degrading. Narrow scope aggressively to the smallest verifiable slice, keep the next response terse, avoid repeating prior analysis, and execute only that slice. If the next step is a code change, emit one valid edit tool call now instead of describing the patch. Context: ${controlDirective.detail}`
					: `Recent turns are degrading. Narrow scope to the smallest verifiable slice, keep the next response terse, and execute only that slice. If the next step is a code change, emit one valid edit tool call now instead of describing the patch. Context: ${controlDirective.detail}`;
			}
			return state.narrowScopePromptCount > 1
				? `The run is still off track. Narrow scope aggressively to the smallest verifiable slice, state that narrowed target, complete only that slice, and verify it before doing anything else. If the next step is a code change, emit one valid edit tool call now instead of restating the patch in prose. Context: ${controlDirective.detail}`
				: `Repeated drift or failure means the current slice is too broad. Narrow scope to the smallest verifiable slice, state the narrowed target, execute it, and verify it before proceeding. If the next step is a code change, emit one valid edit tool call now instead of restating the patch in prose. Context: ${controlDirective.detail}`;
		}
		if (controlDirective.kind === "replan") {
			if (degradedTurnDirective) {
				return state.replanPromptCount > 1
					? `Recent turns keep degrading. Replan into 1-2 very small steps, keep the next response short, and execute only the first concrete step now. If that first step is a patch, emit one valid edit tool call immediately instead of more analysis. Context: ${controlDirective.detail}`
					: `Recent turns are degrading. Replan into 1-2 very small steps, keep the next response short, and execute only the first concrete step now. If that first step is a patch, emit one valid edit tool call immediately instead of more analysis. Context: ${controlDirective.detail}`;
			}
			return state.replanPromptCount > 1
				? `The run keeps drifting. Replan into 1-2 concrete steps, state the first step you will execute now, and then do it immediately. If the first step is a code change, emit one valid edit tool call instead of describing the patch. Context: ${controlDirective.detail}`
				: `The run has drifted repeatedly. Replan into 1-2 concrete steps, choose the first one, and execute it now. If the first step is a code change, emit one valid edit tool call instead of describing the patch. Context: ${controlDirective.detail}`;
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
				if (ledger.taskMode === "answer") {
					return state.completionPromptCount > 1
						? "Do not stop at a status update. Either provide the direct answer now and stop, or do one narrowly targeted read only if a specific evidence gap remains."
						: "If the current evidence already answers the question, provide the direct answer now and stop. Otherwise do one narrowly targeted read only.";
				}
				if (ledger.verificationSatisfied || hasEnoughImplementationEvidence) {
					return state.completionPromptCount > 1
						? `Verification is already satisfied. Do not call any more tools. Provide the final short verified summary now, mention any residual risks only if they are real, and stop.${sourceSummaryHint}`
						: `Verification is already satisfied. Do not call any more tools. Provide the final short verified summary now and stop.${sourceSummaryHint}`;
				}
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
					return `Continue by running verification on the latest changes before claiming completion.${selfContainedSummaryRule}`;
				}
				if (ledger.taskMode === "answer" && ledger.taskJournal.planItems.find((item) => item.key === "implement")?.status === "active") {
					return "Continue by using the inspected local evidence to answer directly. Do not widen into implementation, verification, or more broad discovery unless a specific evidence gap remains.";
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
						? `The latest UI slice is already verified. Summarize the rendered result${visualSurfaceHint}, note any residual risks, and stop.${visualInteractionHint}${visualRecipeHint}${visualViewportHint}${visualAcceptanceHint}${selfContainedSummaryRule}`
						: `The latest implementation slice is already verified. Summarize the verified result, note any residual risks, and stop.${sourceSummaryHint}${selfContainedSummaryRule}`;
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

function buildSelfContainedWorkspaceNudgeMessage(
	nudgeType: NudgeType,
	ledger: AutonomousRunLedger,
	userMessage: string,
): string | undefined {
	if (!isSelfContainedWorkspaceTask(userMessage)) return undefined;
	const localVerificationCommand = extractLocalVerificationCommand(userMessage);
	const initialTestUpdateMissing = taskNeedsInitialTestUpdate(ledger, userMessage);
	const latestKnownTestFile = getLatestKnownWorkspaceFile(ledger, /^tests?\//i);
	const requestedTestCoverageRepair = getRequestedTestCoverageRepair(ledger, userMessage);
	const selfContainedSummaryRule = getSelfContainedSummaryResponseRule(userMessage);
	if (requestedTestCoverageRepair) {
		return `Verification already identified the remaining regression-test mismatch: ${requestedTestCoverageRepair.blocker}. Edit \`${requestedTestCoverageRepair.testFile}\` directly${requestedTestCoverageRepair.sourceFile ? ` using \`${requestedTestCoverageRepair.sourceFile}\` only as context` : ""}. Do not reread or rediscover files first. After that test edit, rerun the intended verification command${localVerificationCommand ? ` (${localVerificationCommand})` : ""} and stop once it passes.${selfContainedSummaryRule}`;
	}
	if (initialTestUpdateMissing) {
		return `This task still requires a regression test update. Patch ${latestKnownTestFile ? `\`${latestKnownTestFile}\`` : "the required test under tests/"} now before any verification step. Use the existing src change as context, do not reread or rediscover files first, then run the intended verification command${localVerificationCommand ? ` (${localVerificationCommand})` : ""}.${selfContainedSummaryRule}`;
	}
	switch (nudgeType) {
		case "continue":
			if (ledger.taskJournal.planItems.find((item) => item.key === "verify")?.status === "active") {
				return `Run the intended local verification now${localVerificationCommand ? ` (${localVerificationCommand})` : ""}. Do not do more discovery or reread files first. After it passes, give a short summary and stop.${selfContainedSummaryRule}`;
			}
			return "Continue with the next direct workspace step only. Do not elaborate on findings. Read the most relevant local file, or emit one concrete edit or verification tool call now.";
		case "pivot":
			return "Change strategy inside the workspace. Stop broad shell discovery and do not narrate. Use the failing test, import path, caller, or reference file to pick the next local file directly, then patch or verify immediately.";
		case "break_loop":
			if (ledger.verificationSatisfied) {
				return `The current slice is already verified. Stop exploring, give the short verified summary now, and end the run.${selfContainedSummaryRule}`;
			}
			return undefined;
		default:
			return undefined;
	}
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
	const initialTestUpdateMissing = taskNeedsInitialTestUpdate(ledger, userMessage);
	const requestedTestCoverageRepair = getRequestedTestCoverageRepair(ledger, userMessage);
	const latestKnownSourceFile = getLatestKnownWorkspaceFile(ledger, /^src\//i);
	const latestKnownTestFile = getLatestKnownWorkspaceFile(ledger, /^tests?\//i);
	const latestReadSourceFile = getLatestReadWorkspaceFile(ledger, /^src\//i);
	const latestReadTestFile = getLatestReadWorkspaceFile(ledger, /^tests?\//i);
	const latestReadReferenceFile = getLatestReadWorkspaceFile(ledger, /^reference\//i);
	const committedReferenceSourceFile = getCommittedReferenceSourceFile(ledger);
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
	if (
		ledger.taskMode === "answer" &&
		!shouldUseVisual &&
		(ledger.readFiles.length > 0 || ledger.currentFocus || ledger.taskJournal.planItems.find((item) => item.key === "inspect")?.status === "completed")
	) {
		return {
			plannedNextStep: "Answer directly from the inspected evidence, note any important caveats, and stop.",
			stepRationale: "This task only needs a direct answer, so once the relevant local evidence is in hand the run should stop exploring and respond clearly.",
			expectedVerification: undefined,
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
	const inspectItem = ledger.taskJournal.planItems.find((item) => item.key === "inspect");
	if (requestedTestCoverageRepair) {
		return {
			plannedNextStep: `Edit ${requestedTestCoverageRepair.testFile} so it satisfies: ${requestedTestCoverageRepair.blocker}. Then rerun verification.`,
			stepRationale: "The verifier already identified the remaining regression-test mismatch, so the run should repair that known test file directly instead of rediscovering context.",
			expectedVerification: ledger.lastVerificationDetail ?? "The previously failing verification should pass after the test update",
		};
	}
	if (initialTestUpdateMissing) {
		const latestTestFile = getLatestKnownWorkspaceFile(ledger, /^tests?\//i) ?? "the matching test under tests/";
		return {
			plannedNextStep: `Update ${latestTestFile} with the requested regression coverage, then rerun verification.`,
			stepRationale: "The task explicitly asked for a test change, so source-only progress is not enough to move into verification or stopping.",
			expectedVerification: ledger.lastVerificationDetail ?? "Run the requested verification after the test update",
		};
	}
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
	if (inspectItem?.status === "active" && ledger.recentMutations.length === 0) {
		if (latestKnownSourceFile && !latestReadSourceFile) {
			return {
				plannedNextStep: `Read ${latestKnownSourceFile} now. Do not rediscover files first.`,
				stepRationale: "A concrete implementation target is already known from prior discovery, so the next step should inspect that file directly instead of broadening the search.",
				expectedVerification: "After the change, run the relevant test, lint, build, or verify command",
			};
		}
		if (taskNeedsInitialTestUpdate(ledger, userMessage) && latestKnownTestFile && !latestReadTestFile && latestReadSourceFile) {
			return {
				plannedNextStep: `Read ${latestKnownTestFile} now so the requested regression coverage matches ${latestReadSourceFile}. Do not rediscover files first.`,
				stepRationale: "The task requires a test update and the concrete test file is already known, so the next step should inspect that file directly instead of guessing alternate paths.",
				expectedVerification: ledger.lastVerificationDetail ?? "Run the requested verification after the test update",
			};
		}
	}
	const implementItem = ledger.taskJournal.planItems.find((item) => item.key === "implement");
	if (implementItem?.status === "active") {
		if (ledger.taskMode === "implementation" && ledger.recentMutations.length === 0) {
			if (committedReferenceSourceFile && latestReadReferenceFile) {
				return {
					plannedNextStep: `Patch ${committedReferenceSourceFile} now. Do not rediscover files first.`,
					stepRationale: "After reading the named local reference and the first plausible implementation file, the run should commit to that implementation target instead of drifting into helper files.",
					expectedVerification: ledger.lastVerificationDetail ?? "After the change, run the relevant test, lint, build, or verify command",
				};
			}
			if (latestKnownSourceFile && !latestReadSourceFile) {
				return {
					plannedNextStep: `Read ${latestKnownSourceFile} now, then patch it directly. Do not rediscover files first.`,
					stepRationale: "A concrete implementation target is already known from prior discovery, so the next step should inspect that file directly instead of repeating shell discovery.",
					expectedVerification: "After the change, run the relevant test, lint, build, or verify command",
				};
			}
			if (taskNeedsInitialTestUpdate(ledger, userMessage) && latestKnownTestFile && !latestReadTestFile) {
				return {
					plannedNextStep: `Read ${latestKnownTestFile} now so the required regression coverage matches the implementation, then patch it directly. Do not rediscover files first.`,
					stepRationale: "The task requires a test update and the concrete test file is already known, so the next step should go straight there instead of guessing alternate paths.",
					expectedVerification: ledger.lastVerificationDetail ?? "Run the requested verification after the test update",
				};
			}
			if (latestReadSourceFile) {
				return {
					plannedNextStep:
						taskNeedsInitialTestUpdate(ledger, userMessage) && latestKnownTestFile
							? `Patch ${latestReadSourceFile} now. Then update ${latestKnownTestFile} with the requested regression coverage before rerunning verification.`
							: `Patch ${latestReadSourceFile} now. Do not rediscover files first.`,
					stepRationale: "The run already has the relevant implementation context in hand, so the next step should be a direct code change rather than more inspection.",
					expectedVerification: "After the change, run the relevant test, lint, build, or verify command",
				};
			}
		}
		if (ledger.taskMode === "answer") {
			return {
				plannedNextStep: "Answer directly from the inspected evidence, and do not add more discovery unless a specific gap remains.",
				stepRationale: "The run already has enough local context to answer, so another exploration step would only add churn.",
				expectedVerification: undefined,
			};
		}
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
		if (ledger.taskMode === "answer") {
			return {
				plannedNextStep: "If the current evidence already answers the question, provide the direct answer now and stop. Otherwise do one narrowly targeted read only.",
				stepRationale: "Answer-only tasks should stop once they have enough evidence, not expand into open-ended autonomy.",
				expectedVerification: undefined,
			};
		}
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
	const localReferenceContext = hasAutonomousLocalReferenceContext(userMessage);
	const externalResearchRequest = EXTERNAL_RESEARCH_PATTERNS.some((pattern) => pattern.test(userMessage));
	const documentationResearchRequest =
		DOCUMENTATION_RESEARCH_PATTERNS.some((pattern) => pattern.test(userMessage)) && !localReferenceContext;
	const implementationRequest = IMPLEMENTATION_TASK_PATTERNS.some((pattern) => pattern.test(userMessage));
	if (implementationRequest && !externalResearchRequest && !documentationResearchRequest) return false;
	if (externalResearchRequest || documentationResearchRequest) return true;
	if (ledger.research && (ledger.research.searchQueries.length > 0 || ledger.research.fetchedUrls.length > 0)) return true;
	if (
		ledger.currentFocus &&
		/\b(docs|documentation|api|reference|research|source|latest|current)\b/i.test(ledger.currentFocus) &&
		!localReferenceContext
	) {
		return true;
	}
	if (
		ledger.residualRisks.some((risk) => /\b(source|citation|documentation|api|current|latest|release)\b/i.test(risk)) &&
		!localReferenceContext
	) {
		return true;
	}
	return false;
}

function extractNamedWorkspacePath(userMessage: string, prefixPattern: RegExp): string | undefined {
	for (const match of userMessage.matchAll(/`((?:\.\/)?[^`\n]+)`/g)) {
		const raw = match[1]?.trim();
		if (!raw) continue;
		const normalized = raw.replace(/^\.\//, "");
		if (prefixPattern.test(normalized)) return normalized;
	}
	for (const match of userMessage.matchAll(/\b((?:reference|docs?|guides?|manuals?|specs?|src|tests?|scripts)\/[^\s)`]+)/g)) {
		const raw = match[1]?.trim();
		if (!raw) continue;
		if (prefixPattern.test(raw)) return raw;
	}
	return undefined;
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
	if (!hasVerifiedImplementationReadyToSummarize(ledger, goal)) return false;
	const summarizeItem = ledger.taskJournal.planItems.find((item) => item.key === "summarize");
	if (summarizeItem?.status !== "active" && summarizeItem?.status !== "completed") return false;
	return true;
}

function hasVerifiedImplementationReadyToSummarize(ledger: AutonomousRunLedger, goal: string): boolean {
	if (!ledger.verificationSatisfied) return false;
	if (ledger.lastActionType !== "verification") return false;
	if (taskStillNeedsRequestedTestCoverage(ledger, goal)) return false;
	return (
		ledger.touchedFiles.length > 0 ||
		ledger.recentMutations.length > 0 ||
		ledger.verificationFailures.length > 0 ||
		isVerificationOnlyTask(goal)
	);
}

function hasVerifiedSummaryAnswer(
	text: string,
	goal: string,
	options: { verificationSatisfied?: boolean } = {},
): boolean {
	const normalized = text.trim();
	if (normalized.length < 40) return false;
	if (INCOMPLETE_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
	const mentionsChange = VERIFIED_SUMMARY_CHANGE_PATTERNS.some((pattern) => pattern.test(normalized));
	const mentionsVerification = VERIFIED_SUMMARY_VERIFICATION_PATTERNS.some((pattern) => pattern.test(normalized));
	if (!mentionsChange || !mentionsVerification) return false;
	const mentionsConcreteTarget = VERIFIED_SUMMARY_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
	return Boolean(options.verificationSatisfied) || isVerificationOnlyTask(goal) || mentionsConcreteTarget;
}

function hasSufficientDirectAnswer(text: string, goal: string): boolean {
	const normalized = text.trim();
	if (normalized.length < 35) return false;
	if (IMPLEMENTATION_TASK_PATTERNS.some((pattern) => pattern.test(goal))) return false;
	if (INCOMPLETE_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
	const hasPayload = DIRECT_ANSWER_PAYLOAD_PATTERNS.some((pattern) => pattern.test(normalized));
	if (!hasPayload) return false;
	const isMetaOnly = DIRECT_ANSWER_META_ONLY_PATTERNS.some((pattern) => pattern.test(normalized));
	if (!isMetaOnly) return true;
	return /(?:\b(?:src|tests?|packages|scripts|docs?|reference)\/[^\s)`]+|`[^`\n]+`|\bhttps?:\/\/\S+)/i.test(normalized);
}

function hasSufficientVisualEvidence(ledger: AutonomousRunLedger, goal: string): boolean {
	if (!ledger.verificationSatisfied) return false;
	if (ledger.lastActionType !== "verification") return false;
	if (!ledger.visualIteration?.enabled) return false;
	if (ledger.visualIteration.phase !== "verified") return false;
	if (ledger.visualAssessment?.latestJudgment !== "pass") return false;
	return ledger.touchedFiles.length > 0 || ledger.recentMutations.length > 0 || isVerificationOnlyTask(goal);
}

function shouldBypassStopNudgeForVerifiedSummary(options: {
	ledger: AutonomousRunLedger;
	userMessage: string;
	visualVerificationRelevant: boolean;
	researchRelevant: boolean;
}): boolean {
	const summarizeReady = options.ledger.taskJournal.planItems.find((item) => item.key === "summarize")?.status === "active";
	if (!summarizeReady) return false;
	if (options.visualVerificationRelevant) {
		return hasSufficientVisualEvidence(options.ledger, options.userMessage);
	}
	if (options.researchRelevant && isResearchOnlyLedger(options.ledger)) {
		return hasSufficientResearchEvidence(options.ledger.research);
	}
	return hasVerifiedImplementationReadyToSummarize(options.ledger, options.userMessage);
}

function plannedStepPrefersConcreteMutation(plannedStep: string): boolean {
	return plannedStep.includes("execute only that slice")
		|| plannedStep.includes("make the next concrete code change")
		|| plannedStep.includes("execute it immediately")
		|| plannedStep.includes("finish the current slice without exploring new scope");
}

function isSelfContainedWorkspaceTask(userMessage: string): boolean {
	const implementationRequest = IMPLEMENTATION_TASK_PATTERNS.some((pattern) => pattern.test(userMessage));
	return (
		implementationRequest &&
		SELF_CONTAINED_WORKSPACE_PATTERNS.some((pattern) => pattern.test(userMessage)) &&
		LOCAL_VERIFICATION_COMMAND_PATTERNS.some((pattern) => pattern.test(userMessage))
	);
}

function isSingleFilePrecisionTask(userMessage: string): boolean {
	return isSelfContainedWorkspaceTask(userMessage) && SINGLE_FILE_PRECISION_PATTERNS.every((pattern) => pattern.test(userMessage));
}

function requiresTestUpdate(userMessage: string): boolean {
	return /\b(add|update)\b[\s\S]{0,80}\b(regression\s+test|test)\b/i.test(userMessage);
}

function taskNeedsInitialTestUpdate(ledger: AutonomousRunLedger, userMessage: string): boolean {
	if (!requiresTestUpdate(userMessage)) return false;
	return ledger.touchedFiles.length > 0 && !ledger.touchedFiles.some((file) => /^tests?\//i.test(file));
}

function taskStillNeedsRequestedTestCoverage(ledger: AutonomousRunLedger, userMessage: string): boolean {
	return taskNeedsInitialTestUpdate(ledger, userMessage) || getRequestedTestCoverageRepair(ledger, userMessage) !== undefined;
}

function mentionsMisleadingSiblingWarning(userMessage: string): boolean {
	return /\b(misleading|similarly named)\b/i.test(userMessage);
}

function extractLocalVerificationCommand(userMessage: string): string | undefined {
	const fencedMatch = userMessage.match(/intended verification command is:\s*`([^`]+)`/i);
	if (fencedMatch?.[1]) return fencedMatch[1].trim();
	const plainMatch = userMessage.match(/verification command is:\s*([^\n]+)/i);
	if (plainMatch?.[1]) return plainMatch[1].trim();
	return undefined;
}

function extractWorkspaceVerifierScriptPath(localVerificationCommand: string | undefined): string | undefined {
	if (!localVerificationCommand) return undefined;
	const match = localVerificationCommand.match(/\b(scripts\/[^\s&;|`]+)/i);
	return match?.[1];
}

function getLatestReadWorkspaceFile(ledger: AutonomousRunLedger, prefixPattern: RegExp): string | undefined {
	for (let i = ledger.readFiles.length - 1; i >= 0; i--) {
		const candidate = ledger.readFiles[i];
		if (prefixPattern.test(candidate)) return candidate;
	}
	return undefined;
}

function getLatestTouchedWorkspaceFile(ledger: AutonomousRunLedger, prefixPattern: RegExp): string | undefined {
	for (let i = ledger.touchedFiles.length - 1; i >= 0; i--) {
		const candidate = ledger.touchedFiles[i];
		if (prefixPattern.test(candidate)) return candidate;
	}
	return undefined;
}

function getLatestKnownWorkspaceFile(ledger: AutonomousRunLedger, prefixPattern: RegExp): string | undefined {
	if (ledger.discoveryTargetFile && prefixPattern.test(ledger.discoveryTargetFile)) {
		return ledger.discoveryTargetFile;
	}
	const discoveredFiles = ledger.discoveredFiles ?? [];
	for (let i = discoveredFiles.length - 1; i >= 0; i--) {
		const candidate = discoveredFiles[i];
		if (prefixPattern.test(candidate)) return candidate;
	}
	return getLatestTouchedWorkspaceFile(ledger, prefixPattern) ?? getLatestReadWorkspaceFile(ledger, prefixPattern);
}

function getCommittedReferenceSourceFile(ledger: AutonomousRunLedger): string | undefined {
	const readFiles = ledger.readFiles ?? [];
	const firstReferenceIndex = readFiles.findIndex((file) => /^reference\//i.test(file));
	if (firstReferenceIndex < 0) return undefined;
	for (let i = firstReferenceIndex + 1; i < readFiles.length; i++) {
		const candidate = readFiles[i];
		if (/^src\//i.test(candidate)) return candidate;
	}
	return undefined;
}

function getFailedRepairTargetFile(ledger: AutonomousRunLedger): string | undefined {
	const candidates = [
		ledger.taskJournal.activeSubtask,
		ledger.currentFocus,
		ledger.taskJournal.nextAction,
		ledger.taskJournal.plannedNextStep,
	];
	for (const candidate of candidates) {
		if (!candidate || !/failed change|valid edit on the same target/i.test(candidate)) continue;
		const match = candidate.match(/\b((?:src|tests?|scripts|reference|cli|generated)\/[^\s`:)]+)/i);
		if (match?.[1]) return match[1];
	}
	return undefined;
}

function getWorkspaceFilesByPrefix(files: string[], prefixPattern: RegExp): string[] {
	const seen = new Set<string>();
	const matches: string[] = [];
	for (const file of files) {
		if (!prefixPattern.test(file) || seen.has(file)) continue;
		seen.add(file);
		matches.push(file);
	}
	return matches;
}

function extractLatestVerificationFailureCue(ledger: AutonomousRunLedger): string | undefined {
	const latestFailure = ledger.verificationFailures[ledger.verificationFailures.length - 1];
	if (!latestFailure) return undefined;
	const withoutPrefix = latestFailure.replace(/^failed verification:\s*/i, "").trim();
	if (withoutPrefix.length === 0) return undefined;
	const parts = withoutPrefix.split(/\s+—\s+/);
	const candidate = (parts.at(-1) ?? withoutPrefix).trim();
	return candidate.length > 0 ? candidate : undefined;
}

function getRequestedTestCoverageRepair(
	ledger: AutonomousRunLedger,
	userMessage: string,
): { blocker: string; testFile: string; sourceFile?: string } | undefined {
	if (!requiresTestUpdate(userMessage)) return undefined;
	const failureCue = extractLatestVerificationFailureCue(ledger);
	if (!failureCue) return undefined;
	if (!/\b(missing|expected|required|needs?)\b[\s\S]{0,80}\b(regression\s+test|test|coverage|case|assert(?:ion)?|snapshot|fixture)\b/i.test(failureCue)) {
		return undefined;
	}
	const testFile = getLatestKnownWorkspaceFile(ledger, /^tests?\//i);
	if (!testFile) return undefined;
	return {
		blocker: failureCue,
		testFile,
		sourceFile: getLatestKnownWorkspaceFile(ledger, /^src\//i),
	};
}

function getSelfContainedSummaryResponseRule(userMessage: string): string {
	if (!isSelfContainedWorkspaceTask(userMessage)) return "";
	if (SELF_CONTAINED_SUMMARY_FILE_PATTERNS.some((pattern) => pattern.test(userMessage))) return "";
	return " Return the short final summary as visible assistant text, not only in thinking/reasoning. Do not create or edit SUMMARY.md, notes, docs, markdown reports, or any other workspace file unless the task explicitly asks for a file change.";
}

function getVerificationCommandClause(localVerificationCommand: string | undefined): string {
	return localVerificationCommand
		? `the intended verification command exactly once, verbatim (\`${localVerificationCommand}\`)`
		: "the intended verification command once";
}

function getVerificationMisuseWarning(localVerificationCommand: string | undefined): string {
	return localVerificationCommand
		? " Do not rewrite it to a narrower path, append extra args, use previews, subsets, piped variants, or rerun it after the first passing result."
		: " Do not rerun it after the first passing result.";
}

function extractExpectedChangedPathsFromPrompt(userMessage: string): string[] {
	const match = userMessage.match(/^- expected changed paths:\s*([^\n]+)/im);
	if (!match?.[1]) return [];
	return match[1]
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function getStructuredEditCallHint(): string {
	return " Use one native `edit` tool call with `path` and an `edits` array containing at least one `{ oldText, newText }` replacement. Do not emit XML or prose instead of the structured edit arguments.";
}

function getExactVerificationOnceRule(localVerificationCommand: string | undefined, userMessage: string): string {
	const expectedChangedPaths = extractExpectedChangedPathsFromPrompt(userMessage);
	const requiresMultipleEdits = expectedChangedPaths.length > 1 || requiresTestUpdate(userMessage);
	const verificationPoint = requiresMultipleEdits
		? "After the required source/test mutations are complete"
		: "After the first successful mutation";
	return ` ${verificationPoint}, run ${getVerificationCommandClause(localVerificationCommand)}.${getVerificationMisuseWarning(localVerificationCommand)}`;
}

function buildInitialAutonomousPrompt(userMessage: string, researchToolsAvailable: boolean): string {
	if (isSelfContainedWorkspaceTask(userMessage)) {
		const misleadingSiblingGuidance = mentionsMisleadingSiblingWarning(userMessage)
			? " Treat similarly named files as traps: before editing, confirm the real implementation path from the failing test, caller, import path, or reference output. Do not patch a sibling file just because the filename stem matches."
			: "";
		const namedReferencePath = extractNamedWorkspacePath(userMessage, /^(?:reference|docs?|guides?|manuals?|specs?)\//i);
		const namedReferenceGuidance = namedReferencePath
			? ` The task already names the local reference \`${namedReferencePath}\`; read that exact file before any directory listing or other discovery. Then read the single most likely implementation file under \`src/\` directly. If the file stem is plausible but the exact extension is unknown, list the directory once and read the concrete file you find instead of guessing \`.js\`/\`.mjs\` or using globs.`
			: "";
		const singleFilePrecisionGuidance = isSingleFilePrecisionTask(userMessage)
			? " This is a single-file precision patch. Start by reading the relevant test under `tests/` and the likely implementation file under `src/`. Do not guess wildcard or glob paths like `tests/*.test.js`; if the exact filename is unknown, list the directory once and then read the concrete file you found. Do not inspect `generated/`, `reference/`, `cli/`, or sibling directories unless the test or verifier explicitly points there. Do not call `ls` more than once before the first read, and do not turn the top-level listing into more subdirectory `ls` calls. Once the correct `src/...` file is confirmed, patch only that file."
			: "";
		return `${userMessage}\n\nThis is a self-contained local patch/debug task. Stay inside the workspace and do not use webSearch/webFetch. Treat \`.\` as the workspace root and use relative workspace paths like \`src/...\`, \`tests/...\`, \`reference/...\`, or \`scripts/...\`; do not jump to /home/alex/AG1 or any repo root outside the fixture. After at most one top-level listing, stop shell-style file hunting. If you choose to list once, do it once only, and make your very next tool call a direct \`read\` of one relevant file instead of more \`ls\`. Do not list subdirectories like \`src/\`, \`tests/\`, \`test/\`, \`cli/\`, or \`reference/\` before that first read. Do not grep for descriptive phrases or use bash/find loops to rediscover obvious local files. Prefer one direct read of the most likely implementation file, relevant test, named reference, or verifier script under src/, tests?/, reference/, or scripts/.${namedReferenceGuidance}${misleadingSiblingGuidance}${singleFilePrecisionGuidance} Once the target file is clear, emit one concrete edit immediately instead of narrating the patch.${getExactVerificationOnceRule(extractLocalVerificationCommand(userMessage), userMessage)} Then give a short summary and stop.${getSelfContainedSummaryResponseRule(userMessage)}`;
	}
	if (looksLikeAutonomousVerifyOnlyTask(userMessage)) {
		return `${userMessage}\n\nThis is a local inspection or review task. Do not edit files unless the user explicitly asks for a fix. Start with one directly relevant file, test, or verifier artifact, gather concrete findings, then answer with those findings and stop.`;
	}
	if (looksLikeAutonomousLocalAnswerTask(userMessage)) {
		const answerFirstHint = looksLikeAutonomousPathLookupTask(userMessage)
			? " If the user only asked for the location or exact path, answer as soon as one decisive hit identifies it."
			: "";
		return `${userMessage}\n\nThis is an answer-only local workspace task. Stay in local tools and avoid web research. Externalize one focused discovery or read step first, then answer directly once the evidence is decisive.${answerFirstHint} Do not widen into implementation or extra verification unless the prompt explicitly requires changes.`;
	}
	if (!researchToolsAvailable) return userMessage;
	const localReferenceContext = hasAutonomousLocalReferenceContext(userMessage);
	const externalResearchRequest =
		EXTERNAL_RESEARCH_PATTERNS.some((pattern) => pattern.test(userMessage))
		|| (!localReferenceContext && looksLikeAutonomousResearchTask(userMessage));
	const documentationResearchRequest =
		DOCUMENTATION_RESEARCH_PATTERNS.some((pattern) => pattern.test(userMessage)) && !localReferenceContext;
	const implementationRequest = looksLikeAutonomousImplementationTask(userMessage);
	if (implementationRequest && !externalResearchRequest && !documentationResearchRequest) return userMessage;
	if (!externalResearchRequest && !documentationResearchRequest) return userMessage;
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
	lastAssistantText: string;
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
	const failedMutation = options.turnToolHistory.find((outcome) => isMutatingOutcome(outcome) && !outcome.success);
	const inspection = options.turnFileAccessHistory.find((outcome) => READ_TOOL_NAMES.has(outcome.tool.toLowerCase()) && outcome.success);
	const visualPhase = options.plannedLedger.visualIteration?.phase;
	const selfContainedWorkspaceTask = isSelfContainedWorkspaceTask(options.plannedLedger.goal);
	const hasReadTestFile = options.plannedLedger.readFiles.some((file) => /^tests?\//i.test(file));
	const readSourceFileCount = getWorkspaceFilesByPrefix(options.plannedLedger.readFiles, /^src\//i).length;

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
		const verificationFailurePreview = getVerificationFailurePreview(verificationAttempt);
		return {
			outcome: "failed",
			detail: verificationFailurePreview
				? `verification failed: ${verificationFailurePreview}`
				: `verification failed: ${verificationAttempt.detail ?? verificationAttempt.file ?? verificationAttempt.tool}`,
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
			outcome:
				implementItem?.status === "active" ||
				implementItem?.status === "completed" ||
				plannedStepPrefersConcreteMutation(plannedStep)
					? "on_track"
					: "drifted",
			detail: `mutation matched intent: ${mutation.detail ?? mutation.file ?? mutation.tool}`,
		};
	}
	if (failedMutation) {
		return {
			outcome: "failed",
			detail: `edit failed: ${failedMutation.detail ?? failedMutation.file ?? failedMutation.tool}`,
		};
	}
	if (inspection) {
		if (
			selfContainedWorkspaceTask &&
			implementItem?.status === "active" &&
			options.plannedLedger.recentMutations.length === 0 &&
			hasReadTestFile &&
			readSourceFileCount > 0
		) {
			return {
				outcome: "drifted",
				detail: `expected a concrete edit after local test+src inspection, but got another inspection: ${inspection.detail ?? inspection.file ?? inspection.tool}`,
			};
		}
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
		hasVerifiedSummaryAnswer(options.lastAssistantText, options.plannedLedger.goal, {
			verificationSatisfied: options.verificationState.hasVerificationCheckpoint,
		})
	) {
		return {
			outcome: "on_track",
			detail: "verified summary matched the intended completion step",
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
	const hasVerifiedSummaryStopEvidence =
		!options.visualVerificationRelevant &&
		hasVerifiedSummaryAnswer(options.lastAssistantText, options.userMessage, {
			verificationSatisfied: options.verificationSatisfied,
		});
	const hasDirectAnswerStopEvidence =
		projectedLedger.taskMode === "answer" && hasSufficientDirectAnswer(options.lastAssistantText, options.userMessage);

	if (assessment === "confirm_verification") {
		if (
			hasResearchStopEvidence ||
			hasVisualStopEvidence ||
			hasVerifiedSummaryStopEvidence ||
			hasDirectAnswerStopEvidence
		) {
			return "complete";
		}
		if (hasImplementationStopEvidence) {
			return "confirm_completion";
		}
		return assessment;
	}

	if (assessment !== "continue" && assessment !== "confirm_completion") return assessment;
	if (hasVisualStopEvidence || hasVerifiedSummaryStopEvidence || hasDirectAnswerStopEvidence) {
		return "complete";
	}
	if (hasImplementationStopEvidence) {
		return "confirm_completion";
	}
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
	const latestFailedMutation = findAnchoredFailedMutationOutcome(options.toolHistory, options.fileAccessHistory);
	const latestReadDetail = summarizeOutcomeForLedgerEvent(latestRead);
	if (latestReadDetail) {
		events.push({ type: "inspection_complete", detail: latestReadDetail });
	}
	const latestMutation = findLatestSuccessfulMutationOutcome(options.toolHistory);
	const latestMutationDetail = summarizeOutcomeForLedgerEvent(latestMutation);
	if (latestMutationDetail) {
		events.push({ type: "implementation_changed", detail: latestMutationDetail });
	}
	const latestFailedMutationDetail = summarizeOutcomeForLedgerEvent(latestFailedMutation);
	if (latestFailedMutationDetail) {
		events.push({ type: "mutation_repair_required", detail: latestFailedMutationDetail });
	}
	if (options.visualFailureDetail) {
		events.push({ type: "verification_failed", detail: options.visualFailureDetail });
	} else {
	const latestFailedVerification = findLatestFailedVerificationOutcome(options.toolHistory);
		if (latestFailedVerification?.detail) {
			events.push({
				type: "verification_failed",
				detail: normalizeLedgerEventDetail(latestFailedVerification.detail) ?? latestFailedVerification.detail,
			});
		} else if (latestMutation && !options.verificationSatisfied) {
			events.push({ type: "verification_required", detail: latestMutationDetail });
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

function findAnchoredFailedMutationOutcome(
	toolHistory: ToolOutcome[],
	fileAccessHistory: ToolOutcome[],
): ToolOutcome | undefined {
	const latestFailedMutation = findLatestFailedMutationOutcome(toolHistory);
	if (!latestFailedMutation) return undefined;
	if (findLatestSuccessfulMutationOutcome(toolHistory)) return latestFailedMutation;

	const readReferenceFiles = getWorkspaceFilesByPrefix(
		fileAccessHistory
			.filter((outcome) => outcome.success && outcome.tool.toLowerCase() === "read" && typeof outcome.file === "string")
			.map((outcome) => outcome.file!),
		/^reference\//i,
	);
	const readSourceFiles = getWorkspaceFilesByPrefix(
		fileAccessHistory
			.filter((outcome) => outcome.success && outcome.tool.toLowerCase() === "read" && typeof outcome.file === "string")
			.map((outcome) => outcome.file!),
		/^src\//i,
	);
	if (readReferenceFiles.length === 0 || readSourceFiles.length !== 1) return latestFailedMutation;

	const committedSourceFile = readSourceFiles[0];
	if (latestFailedMutation.file === committedSourceFile || latestFailedMutation.detail === committedSourceFile) {
		return latestFailedMutation;
	}

	return {
		...latestFailedMutation,
		file: committedSourceFile,
		detail: committedSourceFile,
	};
}

function summarizeOutcomeForLedgerEvent(outcome: ToolOutcome | undefined): string | undefined {
	if (!outcome) return undefined;
	if (isMutatingOutcome(outcome)) {
		return normalizeLedgerEventDetail(outcome.file) ?? normalizeLedgerEventDetail(outcome.detail);
	}
	return normalizeLedgerEventDetail(outcome.detail) ?? normalizeLedgerEventDetail(outcome.file);
}

function normalizeLedgerEventDetail(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const normalized = value.replace(/\\/g, "/").replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;

	const withoutWorkspaceCd = normalized.replace(
		/^cd\s+(?:\/?(?:tmp|home)\/[^\s;&|]+\/workspace)\s*&&\s*/i,
		"",
	);
	if (withoutWorkspaceCd !== normalized) return withoutWorkspaceCd;

	const relativePatterns = [
		/(?:^|\/)(src\/[^\s)`"'<>]+)/i,
		/(?:^|\/)(tests?\/[^\s)`"'<>]+)/i,
		/(?:^|\/)(reference\/[^\s)`"'<>]+)/i,
		/(?:^|\/)(scripts\/[^\s)`"'<>]+)/i,
		/(?:^|\/)(cli\/[^\s)`"'<>]+)/i,
		/(?:^|\/)(generated\/[^\s)`"'<>]+)/i,
	];
	for (const pattern of relativePatterns) {
		const match = normalized.match(pattern);
		if (match?.[1]) return match[1];
	}
	if (/(?:^|\/)SUMMARY\.md$/i.test(normalized)) return "SUMMARY.md";
	return normalized;
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

function findLatestFailedMutationOutcome(toolHistory: ToolOutcome[]): ToolOutcome | undefined {
	for (let i = toolHistory.length - 1; i >= 0; i--) {
		const outcome = toolHistory[i];
		if (!outcome.success && isMutatingOutcome(outcome)) {
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
