import type { SessionEntry } from "../session-manager.js";
import {
	hasAutonomousLocalReferenceContext,
	looksLikeAutonomousImplementationTask,
	looksLikeAutonomousLocalAnswerTask,
	looksLikeAutonomousResearchTask,
	looksLikeAutonomousVerifyOnlyTask,
} from "../task-intent.js";
import type { AutonomousCheckpointState, AutonomousRunResult } from "./runner.js";
import type { ToolOutcome } from "./nudges/types.js";

export interface AutonomousRunLedger {
	goal: string;
	taskMode?: AutonomousTaskMode;
	status: "running" | "complete" | "error" | "budget" | "nudge" | "max_iterations" | "unknown";
	turnsObserved: number;
	taskJournal: AutonomousTaskJournal;
	planner?: AutonomousPlannerState;
	resume?: AutonomousResumeState;
	research?: AutonomousResearchState;
	visualTarget?: AutonomousVisualTarget;
	visualIteration?: AutonomousVisualIteration;
	visualAssessment?: AutonomousVisualAssessment;
	currentFocus?: string;
	progressDetail?: string;
	lastActionType?: "mutation" | "verification" | "inspection" | "other";
	lastActionDetail?: string;
	touchedFiles: string[];
	readFiles: string[];
	recentMutations: string[];
	verificationAttempts: number;
	verificationSatisfied: boolean;
	lastVerificationDetail?: string;
	verificationFailures: string[];
	residualRisks: string[];
	discoveryTargetFile?: string;
	discoveredFiles: string[];
}

export type AutonomousTaskMode = "implementation" | "answer" | "research";

export interface AutonomousResearchState {
	searchQueries: string[];
	fetchedUrls: string[];
	sourceUrls: string[];
	preferredSourceUrls: string[];
	recentFindings: string[];
	evidence?: AutonomousResearchEvidence;
}

export interface AutonomousResearchEvidence {
	status: "insufficient" | "sufficient";
	authoritativeSourceCount: number;
	fetchedSourceCount: number;
	citedSourceCount: number;
	findingCount: number;
	citationReady: boolean;
	summaryReady: boolean;
	gaps: string[];
}

export interface AutonomousPlannerState {
	phase: "planning" | "executing" | "verifying" | "summarizing" | "blocked";
	lane: "research" | "visual" | "implementation" | "generic";
	planRevision: number;
	executionAttempts: number;
	handoffSummary: string;
}

export interface AutonomousResumeState {
	mode: "resume_research" | "resume_verify" | "resume_summarize" | "resume_repair" | "resume_execute";
	resumeInstruction: string;
	resumeReason: string;
	lastStableCheckpoint?: string;
}

export interface AutonomousVisualTarget {
	surface?: string;
	goalSummary: string;
	acceptanceCriteria: string[];
	viewportProfile?: "desktop" | "mobile" | "tablet";
	viewportHint?: string;
	interactionMode?: "static" | "interactive";
	interactionHint?: string;
	recommendedTool?: "screenshot_url" | "interact_then_screenshot";
	actionRecipe?: AutonomousVisualActionStep[];
}

export interface AutonomousVisualActionStep {
	type: "click" | "fill" | "wait" | "navigate";
	selector?: string;
	targetHint?: string;
	valueHint?: string;
	ms?: number;
	url?: string;
	urlHint?: string;
	source?: "recorded" | "inferred";
}

export interface AutonomousVisualIteration {
	enabled: boolean;
	phase: "baseline_capture" | "patch" | "recapture" | "verified";
	screenshotAttempts: number;
	lastScreenshotDetail?: string;
	observationSummary?: string;
	outstandingIssues: string[];
	recentArtifacts: AutonomousVisualArtifact[];
}

export interface AutonomousVisualArtifact {
	tool: "screenshot_url" | "interact_then_screenshot";
	status: "captured" | "failed";
	detail?: string;
	url?: string;
	title?: string;
	loadTimeMs?: number;
	actionRecipe?: AutonomousVisualActionStep[];
	consoleErrors: string[];
	failedRequests: string[];
	error?: string;
}

export interface AutonomousVisualAssessment {
	target?: string;
	latestJudgment: "pending" | "pass" | "fail";
	summary: string;
	blockingIssues: string[];
	lastEvaluatedDetail?: string;
	basis: "screenshot_metadata";
}

export interface AutonomousTaskJournal {
	activeSubtask?: string;
	nextAction?: string;
	plannedNextStep?: string;
	stepRationale?: string;
	expectedVerification?: string;
	intentStatus?: "pending" | "on_track" | "drifted" | "failed";
	lastIntentOutcome?: string;
	planItems: AutonomousPlanItem[];
	completedCheckpoints: string[];
	blockedReasons: string[];
}

export interface AutonomousPlanItem {
	key: "inspect" | "implement" | "verify" | "summarize";
	title: string;
	status: "pending" | "active" | "blocked" | "completed";
}

export type AutonomousLedgerEvent =
	| { type: "inspection_complete"; detail?: string }
	| { type: "implementation_changed"; detail?: string }
	| { type: "mutation_repair_required"; detail?: string }
	| { type: "verification_required"; detail?: string }
	| { type: "verification_failed"; detail?: string }
	| { type: "verification_passed"; detail?: string }
	| { type: "summarize_ready"; detail?: string }
	| { type: "intent_set"; plannedNextStep: string; stepRationale: string; expectedVerification?: string }
	| { type: "intent_assessed"; outcome: "on_track" | "drifted" | "failed"; detail?: string }
	| { type: "completion_confirmed" }
	| { type: "run_error"; detail?: string }
	| { type: "budget_exhausted" }
	| { type: "nudge_stop" };

export interface AutonomousRunSnapshot {
	version: 1;
	savedAt: string;
	phase: AutonomousRunCheckpointPhase;
	iterations: number;
	stopReason: AutonomousRunResult["stopReason"];
	costSummary: string;
	budgetStatus: AutonomousRunResult["budgetStatus"];
	checkpointState: AutonomousCheckpointState;
	ledger: AutonomousRunLedger;
}

export type AutonomousRunCheckpointPhase = "initial" | "pre_turn" | "post_turn" | "final";

export const AUTONOMOUS_RUN_SNAPSHOT_ENTRY_TYPE = "autonomous_run_snapshot";

export function createAutonomousRunLedger(goal: string): AutonomousRunLedger {
	const taskMode = classifyAutonomousTaskMode(goal);
	const initialPlan = createInitialPlanItemsForMode(taskMode);
	const initialTaskState = createInitialTaskState(taskMode);
	return {
		goal: normalizeSnippet(goal, 180) ?? goal,
		taskMode,
		status: "running",
		turnsObserved: 0,
		visualTarget: undefined,
		taskJournal: {
			activeSubtask: initialTaskState.activeSubtask,
			nextAction: initialTaskState.nextAction,
			plannedNextStep: initialTaskState.plannedNextStep,
			stepRationale: initialTaskState.stepRationale,
			expectedVerification: undefined,
			intentStatus: "pending",
			lastIntentOutcome: undefined,
			planItems: initialPlan,
			completedCheckpoints: [],
			blockedReasons: [],
		},
		touchedFiles: [],
		readFiles: [],
		recentMutations: [],
		verificationAttempts: 0,
		verificationSatisfied: false,
		verificationFailures: [],
		residualRisks: [],
		discoveredFiles: [],
		planner: {
			phase: "planning",
			lane: taskMode === "research" ? "research" : "generic",
			planRevision: 0,
			executionAttempts: 0,
			handoffSummary: initialTaskState.plannedNextStep,
		},
		resume: {
			mode: taskMode === "research" ? "resume_research" : "resume_execute",
			resumeInstruction: initialTaskState.plannedNextStep,
			resumeReason: initialTaskState.stepRationale,
			lastStableCheckpoint: undefined,
		},
	};
}

export function updateAutonomousRunLedger(options: {
	current: AutonomousRunLedger;
	status?: AutonomousRunLedger["status"];
	lastAssistantText: string;
	toolHistory: ToolOutcome[];
	fileAccessHistory: ToolOutcome[];
	verificationSatisfied: boolean;
	lastVerificationDetail?: string;
	visualVerificationRelevant?: boolean;
	explicitEvents?: AutonomousLedgerEvent[];
}): AutonomousRunLedger {
	const verificationOutcomes = options.toolHistory.filter((outcome) => isVerificationOutcome(outcome));
	const verificationAttempts = verificationOutcomes.length;
	const verificationFailures = uniqueTail(
		verificationOutcomes
			.filter((outcome) => !outcome.success)
			.map((outcome) => formatVerificationFailure(outcome))
			.filter((value): value is string => typeof value === "string" && value.length > 0),
		4,
	);
	const touchedFiles = uniqueTail(
		options.toolHistory
			.filter((outcome) => outcome.success && isMutatingOutcome(outcome) && outcome.file)
			.map((outcome) => normalizeWorkspaceReference(outcome.file, 140) ?? outcome.file!),
		12,
	);
	const readFiles = uniqueTail(
		options.fileAccessHistory
			.filter((outcome) => outcome.success && isReadOutcome(outcome) && outcome.file)
			.map((outcome) => normalizeWorkspaceReference(outcome.file, 140) ?? outcome.file!),
		12,
	);
	const recentMutations = uniqueTail(
		options.toolHistory
			.filter((outcome) => outcome.success && isMutatingOutcome(outcome))
			.map((outcome) => normalizeWorkspaceReference(outcome.detail, 120) ?? normalizeWorkspaceReference(outcome.file, 120))
			.filter((value): value is string => typeof value === "string" && value.length > 0),
		6,
	);
	const discoveryTargetFile = deriveDiscoveryTargetFile({
		current: options.current.discoveryTargetFile,
		toolHistory: options.toolHistory,
	});
	const discoveredFiles = uniqueTail(
		[
			...(options.current.discoveredFiles ?? []),
			...options.toolHistory
				.flatMap((outcome) => {
					if (!outcome.success) return [];
					const directFile = normalizeWorkspaceFilePath(outcome.file);
					const discoveryFile = getDiscoveryTargetFile(outcome);
					return [directFile, discoveryFile].filter((value): value is string => typeof value === "string");
				}),
		],
		12,
	);
	const latestAction = getLatestMeaningfulAction(options.toolHistory, options.fileAccessHistory);
	const progressDetail = latestAction?.detail ?? options.current.progressDetail;
	const currentFocus =
		latestAction?.focus ??
		extractFocusNote(options.lastAssistantText) ??
		options.current.currentFocus;
	const baseResidualRisks = uniqueTail(
		[
			...options.current.residualRisks,
			...verificationFailures,
			...extractRiskNotes(options.lastAssistantText),
		],
		4,
	);
	const completedCheckpoints = uniqueTail(
		[
			...options.current.taskJournal.completedCheckpoints,
			...(readFiles.length > 0 ? ["relevant files inspected"] : []),
			...(touchedFiles.length > 0 ? ["workspace changes applied"] : []),
			...(options.verificationSatisfied
				? [`verification passed${options.lastVerificationDetail ? `: ${options.lastVerificationDetail}` : ""}`]
				: []),
		],
		6,
	);
	const blockedReasons = uniqueTail(
		[
			...verificationFailures,
			...(options.status === "error" ? ["last autonomous turn ended in error"] : []),
			...(options.status === "budget" ? ["autonomous budget limit reached"] : []),
			...(options.status === "nudge" ? ["nudge engine stopped the run"] : []),
		],
		4,
	);
	const visualIteration = deriveVisualIteration({
		current: options.current.visualIteration,
		toolHistory: options.toolHistory,
		visualVerificationRelevant: options.visualVerificationRelevant ?? false,
		verificationSatisfied: options.verificationSatisfied,
		lastVerificationDetail: options.lastVerificationDetail,
	});
	const visualTarget = deriveVisualTarget({
		current: options.current.visualTarget,
		goal: options.current.goal,
		currentFocus,
		readFiles,
		touchedFiles,
		visualIteration,
		visualVerificationRelevant: options.visualVerificationRelevant ?? false,
	});
	const visualAssessment = deriveVisualAssessment({
		current: options.current.visualAssessment,
		visualIteration,
		target: visualTarget,
	});
	const research = deriveResearchState({
		current: options.current.research,
		toolHistory: options.toolHistory,
	});
	const planner = derivePlannerState({
		current: options.current.planner,
		taskMode: getAutonomousTaskMode(options.current),
		status: options.status ?? options.current.status,
		taskJournal: options.current.taskJournal,
		research,
		visualAssessment,
		verificationSatisfied: options.verificationSatisfied,
		verificationFailures,
	});
	const resume = deriveResumeState({
		current: options.current.resume,
		taskMode: getAutonomousTaskMode(options.current),
		taskJournal: options.current.taskJournal,
		planner,
		completedCheckpoints,
		blockedReasons,
		verificationSatisfied: options.verificationSatisfied,
	});
	const activeSubtask =
		deriveActiveSubtask({
			current: { ...options.current, visualAssessment },
			taskMode: getAutonomousTaskMode(options.current),
			status: options.status ?? options.current.status,
			currentFocus,
			latestAction,
			verificationSatisfied: options.verificationSatisfied,
		}) ?? options.current.taskJournal.activeSubtask;
	const nextAction =
		deriveNextAction({
			taskMode: getAutonomousTaskMode(options.current),
			status: options.status ?? options.current.status,
			latestActionType: latestAction?.type ?? options.current.lastActionType,
			verificationSatisfied: options.verificationSatisfied,
			blockedReasons,
			recentMutations,
			readFiles,
			visualAssessment,
		}) ?? options.current.taskJournal.nextAction;
	const planItems = derivePlanItems({
		taskMode: getAutonomousTaskMode(options.current),
		status: options.status ?? options.current.status,
		readFiles,
		touchedFiles,
		verificationSatisfied: options.verificationSatisfied,
		verificationFailures,
	});
	const residualRisks = uniqueTail(
		[...baseResidualRisks, ...(visualAssessment?.blockingIssues ?? []), ...(visualIteration?.outstandingIssues ?? [])],
		4,
	);

	const nextLedger: AutonomousRunLedger = {
		...options.current,
		status: options.status ?? options.current.status,
		turnsObserved: options.current.turnsObserved + 1,
		currentFocus,
		progressDetail,
		lastActionType: latestAction?.type ?? options.current.lastActionType,
		lastActionDetail: latestAction?.detail ?? options.current.lastActionDetail,
		touchedFiles,
		readFiles,
		recentMutations,
		research,
		planner,
		resume,
		visualTarget,
		visualIteration,
		visualAssessment,
		verificationAttempts,
		verificationSatisfied: options.verificationSatisfied,
		lastVerificationDetail: options.lastVerificationDetail,
		verificationFailures,
		residualRisks,
		discoveryTargetFile,
		discoveredFiles,
		taskJournal: {
			activeSubtask,
			nextAction,
			plannedNextStep: options.current.taskJournal.plannedNextStep,
			stepRationale: options.current.taskJournal.stepRationale,
			expectedVerification: options.current.taskJournal.expectedVerification,
			intentStatus: options.current.taskJournal.intentStatus,
			lastIntentOutcome: options.current.taskJournal.lastIntentOutcome,
			planItems,
			completedCheckpoints,
			blockedReasons,
		},
	};
	return applyAutonomousLedgerEvents(nextLedger, options.explicitEvents ?? []);
}

export function formatAutonomousRunLedger(ledger: AutonomousRunLedger): string {
	const lines = ["Run ledger:"];
	lines.push(`Goal: ${ledger.goal}`);
	if (ledger.taskJournal.activeSubtask) lines.push(`Active subtask: ${ledger.taskJournal.activeSubtask}`);
	if (ledger.taskJournal.nextAction) lines.push(`Next action: ${ledger.taskJournal.nextAction}`);
	if (ledger.taskJournal.plannedNextStep) lines.push(`Planned next step: ${ledger.taskJournal.plannedNextStep}`);
	if (ledger.taskJournal.stepRationale) lines.push(`Why: ${ledger.taskJournal.stepRationale}`);
	if (ledger.taskJournal.expectedVerification) lines.push(`Expected verification: ${ledger.taskJournal.expectedVerification}`);
	if (ledger.taskJournal.intentStatus) lines.push(`Intent status: ${ledger.taskJournal.intentStatus}`);
	if (ledger.taskJournal.lastIntentOutcome) lines.push(`Intent outcome: ${ledger.taskJournal.lastIntentOutcome}`);
	if (ledger.taskJournal.planItems.length > 0) {
		lines.push(`Plan: ${ledger.taskJournal.planItems.map((item) => `${item.title} [${item.status}]`).join(" | ")}`);
	}
	if (ledger.planner) {
		lines.push(
			`Planner: ${ledger.planner.phase} via ${ledger.planner.lane} (rev ${ledger.planner.planRevision}, attempts ${ledger.planner.executionAttempts})`,
		);
		lines.push(`Planner handoff: ${ledger.planner.handoffSummary}`);
	}
	if (ledger.resume) {
		lines.push(`Resume mode: ${ledger.resume.mode}`);
		lines.push(`Resume: ${ledger.resume.resumeInstruction}`);
		lines.push(`Resume why: ${ledger.resume.resumeReason}`);
		if (ledger.resume.lastStableCheckpoint) lines.push(`Stable checkpoint: ${ledger.resume.lastStableCheckpoint}`);
	}
	if (ledger.research) {
		if (ledger.research.searchQueries.length > 0) lines.push(`Research queries: ${summarizeList(ledger.research.searchQueries, 3)}`);
		if (ledger.research.fetchedUrls.length > 0) lines.push(`Fetched sources: ${summarizeList(ledger.research.fetchedUrls, 3)}`);
		if (ledger.research.sourceUrls.length > 0) lines.push(`Source URLs: ${summarizeList(ledger.research.sourceUrls, 3)}`);
		if (ledger.research.preferredSourceUrls.length > 0) {
			lines.push(`Preferred sources: ${summarizeList(ledger.research.preferredSourceUrls, 3)}`);
		}
		if (ledger.research.recentFindings.length > 0) lines.push(`Research findings: ${summarizeList(ledger.research.recentFindings, 3)}`);
		if (ledger.research.evidence) {
			lines.push(
				`Research evidence: ${ledger.research.evidence.status} (${ledger.research.evidence.authoritativeSourceCount} authoritative, ${ledger.research.evidence.fetchedSourceCount} fetched, ${ledger.research.evidence.citedSourceCount} cited)`,
			);
			if (ledger.research.evidence.gaps.length > 0) {
				lines.push(`Research gaps: ${summarizeList(ledger.research.evidence.gaps, 2)}`);
			}
		}
	}
	if (ledger.currentFocus) lines.push(`Focus: ${ledger.currentFocus}`);
	if (ledger.progressDetail) lines.push(`Progress: ${ledger.progressDetail}`);
	if (ledger.lastActionType && ledger.lastActionDetail) lines.push(`Last action: ${ledger.lastActionType} - ${ledger.lastActionDetail}`);
	if (ledger.visualIteration?.enabled) {
		lines.push(
			`Visual iteration: ${ledger.visualIteration.phase}${ledger.visualIteration.lastScreenshotDetail ? ` via ${ledger.visualIteration.lastScreenshotDetail}` : ""}`,
		);
		lines.push(`Screenshot attempts: ${ledger.visualIteration.screenshotAttempts}`);
		if (ledger.visualIteration.observationSummary) lines.push(`Visual observation: ${ledger.visualIteration.observationSummary}`);
		if (ledger.visualIteration.outstandingIssues.length > 0) {
			lines.push(`Visual issues: ${summarizeList(ledger.visualIteration.outstandingIssues, 3)}`);
		}
	}
	if (ledger.visualTarget) {
		lines.push(`Visual target: ${ledger.visualTarget.goalSummary}`);
		if (ledger.visualTarget.surface) lines.push(`Visual surface: ${ledger.visualTarget.surface}`);
		if (ledger.visualTarget.viewportHint) lines.push(`Visual viewport: ${ledger.visualTarget.viewportHint}`);
		if (ledger.visualTarget.interactionHint) lines.push(`Visual interaction: ${ledger.visualTarget.interactionHint}`);
		if (ledger.visualTarget.recommendedTool) lines.push(`Visual tool: ${ledger.visualTarget.recommendedTool}`);
		if (ledger.visualTarget.actionRecipe && ledger.visualTarget.actionRecipe.length > 0) {
			lines.push(`Visual recipe: ${formatVisualActionRecipe(ledger.visualTarget.actionRecipe)}`);
		}
		if (ledger.visualTarget.acceptanceCriteria.length > 0) {
			lines.push(`Visual acceptance: ${summarizeList(ledger.visualTarget.acceptanceCriteria, 3)}`);
		}
	}
	if (ledger.visualAssessment) {
		lines.push(`Visual assessment: ${ledger.visualAssessment.latestJudgment} - ${ledger.visualAssessment.summary}`);
		if (ledger.visualAssessment.blockingIssues.length > 0) {
			lines.push(`Visual blockers: ${summarizeList(ledger.visualAssessment.blockingIssues, 3)}`);
		}
	}
	if (ledger.taskJournal.completedCheckpoints.length > 0) {
		lines.push(`Completed checkpoints: ${summarizeList(ledger.taskJournal.completedCheckpoints, 3)}`);
	}
	if (ledger.touchedFiles.length > 0) lines.push(`Changed: ${summarizeList(ledger.touchedFiles, 4)}`);
	if (ledger.readFiles.length > 0) lines.push(`Read: ${summarizeList(ledger.readFiles, 4)}`);
	if (ledger.recentMutations.length > 0) lines.push(`Recent mutation: ${ledger.recentMutations[ledger.recentMutations.length - 1]}`);
	lines.push(
		ledger.verificationSatisfied
			? `Verification: satisfied${ledger.lastVerificationDetail ? ` via ${ledger.lastVerificationDetail}` : ""}`
			: "Verification: pending",
	);
	if (ledger.verificationAttempts > 0) lines.push(`Verification attempts: ${ledger.verificationAttempts}`);
	if (ledger.verificationFailures.length > 0) lines.push(`Verification failures: ${summarizeList(ledger.verificationFailures, 2)}`);
	if (ledger.taskJournal.blockedReasons.length > 0) lines.push(`Blockers: ${summarizeList(ledger.taskJournal.blockedReasons, 2)}`);
	if (ledger.residualRisks.length > 0) lines.push(`Risks: ${summarizeList(ledger.residualRisks, 2)}`);
	lines.push("Use this ledger as the current state. Continue from it without rehashing older transcript.");
	return lines.join("\n");
}

export function formatAutonomousPromptLedger(ledger: AutonomousRunLedger): string {
	const lines = ["Run ledger:"];
	lines.push(`Goal: ${ledger.goal}`);
	if (ledger.planner) {
		lines.push(`Planner: ${ledger.planner.phase} via ${ledger.planner.lane}`);
		lines.push(`Planner handoff: ${ledger.planner.handoffSummary}`);
	}
	if (ledger.resume) {
		lines.push(`Resume mode: ${ledger.resume.mode}`);
		lines.push(`Resume: ${ledger.resume.resumeInstruction}`);
		if (ledger.resume.lastStableCheckpoint) lines.push(`Stable checkpoint: ${ledger.resume.lastStableCheckpoint}`);
	}
	if (ledger.taskJournal.plannedNextStep) lines.push(`Planned next step: ${ledger.taskJournal.plannedNextStep}`);
	if (ledger.taskJournal.expectedVerification) lines.push(`Expected verification: ${ledger.taskJournal.expectedVerification}`);
	if (ledger.taskJournal.intentStatus) lines.push(`Intent status: ${ledger.taskJournal.intentStatus}`);
	if (ledger.taskJournal.lastIntentOutcome) lines.push(`Intent outcome: ${ledger.taskJournal.lastIntentOutcome}`);
	if (ledger.research?.evidence) {
		lines.push(
			`Research evidence: ${ledger.research.evidence.status} (${ledger.research.evidence.authoritativeSourceCount} authoritative, ${ledger.research.evidence.fetchedSourceCount} fetched, ${ledger.research.evidence.citedSourceCount} cited)`,
		);
		if (ledger.research.preferredSourceUrls.length > 0) {
			lines.push(`Preferred sources: ${summarizeList(ledger.research.preferredSourceUrls, 2)}`);
		}
		if (ledger.research.evidence.gaps.length > 0) {
			lines.push(`Research gaps: ${summarizeList(ledger.research.evidence.gaps, 2)}`);
		}
	}
	if (ledger.visualAssessment) {
		lines.push(`Visual assessment: ${ledger.visualAssessment.latestJudgment} - ${ledger.visualAssessment.summary}`);
	}
	if (ledger.visualTarget?.interactionHint) lines.push(`Visual interaction: ${ledger.visualTarget.interactionHint}`);
	if (ledger.visualTarget?.actionRecipe && ledger.visualTarget.actionRecipe.length > 0) {
		lines.push(`Visual recipe: ${formatVisualActionRecipe(ledger.visualTarget.actionRecipe)}`);
	}
	if (ledger.lastActionType && ledger.lastActionDetail) lines.push(`Last action: ${ledger.lastActionType} - ${ledger.lastActionDetail}`);
	if (ledger.recentMutations.length > 0) lines.push(`Recent mutation: ${ledger.recentMutations[ledger.recentMutations.length - 1]}`);
	if (ledger.verificationSatisfied) {
		lines.push(`Verification: satisfied${ledger.lastVerificationDetail ? ` via ${ledger.lastVerificationDetail}` : ""}`);
	} else if (ledger.verificationFailures.length > 0) {
		lines.push(`Verification failures: ${summarizeList(ledger.verificationFailures, 2)}`);
	}
	if (ledger.taskJournal.blockedReasons.length > 0) lines.push(`Blockers: ${summarizeList(ledger.taskJournal.blockedReasons, 2)}`);
	if (ledger.residualRisks.length > 0) lines.push(`Risks: ${summarizeList(ledger.residualRisks, 2)}`);
	lines.push("Continue from this state only. Do not restate older transcript.");
	return lines.join("\n");
}

export function formatAutonomousContinuationLedger(ledger: AutonomousRunLedger): string {
	const lines = ["Run ledger:"];
	lines.push(`Goal: ${ledger.goal}`);
	if (ledger.taskJournal.activeSubtask) lines.push(`Active subtask: ${ledger.taskJournal.activeSubtask}`);
	if (ledger.currentFocus) lines.push(`Focus: ${ledger.currentFocus}`);
	if (ledger.taskJournal.plannedNextStep) {
		lines.push(`Planned next step: ${ledger.taskJournal.plannedNextStep}`);
	} else if (ledger.taskJournal.nextAction) {
		lines.push(`Next action: ${ledger.taskJournal.nextAction}`);
	}
	if (ledger.taskJournal.stepRationale) lines.push(`Why: ${ledger.taskJournal.stepRationale}`);
	if (ledger.taskJournal.expectedVerification) lines.push(`Expected verification: ${ledger.taskJournal.expectedVerification}`);
	if (ledger.taskJournal.intentStatus && ledger.taskJournal.intentStatus !== "on_track") {
		lines.push(`Intent status: ${ledger.taskJournal.intentStatus}`);
	}
	if (ledger.taskJournal.lastIntentOutcome) lines.push(`Intent outcome: ${ledger.taskJournal.lastIntentOutcome}`);
	if (ledger.research?.evidence) {
		const researchSummary = [
			ledger.research.evidence.status,
			ledger.research.preferredSourceUrls[0] ? `source ${ledger.research.preferredSourceUrls[0]}` : undefined,
			ledger.research.evidence.gaps[0] ? `gap ${ledger.research.evidence.gaps[0]}` : undefined,
		]
			.filter((part): part is string => Boolean(part))
			.join(" | ");
		lines.push(`Research: ${researchSummary}`);
	}
	if (ledger.visualAssessment) {
		lines.push(`Visual assessment: ${ledger.visualAssessment.latestJudgment} - ${ledger.visualAssessment.summary}`);
	}
	if (ledger.visualTarget?.surface) lines.push(`Visual surface: ${ledger.visualTarget.surface}`);
	if (ledger.visualTarget?.interactionHint) lines.push(`Visual interaction: ${ledger.visualTarget.interactionHint}`);
	if (ledger.visualTarget?.actionRecipe && ledger.visualTarget.actionRecipe.length > 0) {
		lines.push(`Visual recipe: ${formatVisualActionRecipe(ledger.visualTarget.actionRecipe)}`);
	}
	if (ledger.lastActionType && ledger.lastActionDetail) {
		lines.push(`Last action: ${ledger.lastActionType} - ${ledger.lastActionDetail}`);
	} else if (ledger.recentMutations.length > 0) {
		lines.push(`Recent mutation: ${ledger.recentMutations[ledger.recentMutations.length - 1]}`);
	}
	if (ledger.verificationSatisfied) {
		lines.push(`Verification: satisfied${ledger.lastVerificationDetail ? ` via ${ledger.lastVerificationDetail}` : ""}`);
	} else if (ledger.verificationFailures.length > 0) {
		lines.push(`Verification failures: ${summarizeList(ledger.verificationFailures, 1)}`);
	} else {
		lines.push("Verification: pending");
	}
	if (ledger.taskJournal.blockedReasons.length > 0) lines.push(`Blockers: ${summarizeList(ledger.taskJournal.blockedReasons, 2)}`);
	if (ledger.residualRisks.length > 0) lines.push(`Risks: ${summarizeList(ledger.residualRisks, 2)}`);
	lines.push("Continue from this state only. Do not restate older transcript.");
	return lines.join("\n");
}

export function buildAutonomousCompactionInstructions(ledger: AutonomousRunLedger): string {
	return [
		"Preserve the autonomous run state precisely in the summary.",
		`Goal: ${ledger.goal}`,
		ledger.taskJournal.activeSubtask ? `Active subtask: ${ledger.taskJournal.activeSubtask}` : undefined,
		ledger.taskJournal.nextAction ? `Next action: ${ledger.taskJournal.nextAction}` : undefined,
		ledger.taskJournal.plannedNextStep ? `Planned next step: ${ledger.taskJournal.plannedNextStep}` : undefined,
		ledger.taskJournal.stepRationale ? `Why this step: ${ledger.taskJournal.stepRationale}` : undefined,
		ledger.taskJournal.expectedVerification ? `Expected verification: ${ledger.taskJournal.expectedVerification}` : undefined,
		ledger.taskJournal.intentStatus ? `Intent status: ${ledger.taskJournal.intentStatus}` : undefined,
		ledger.taskJournal.lastIntentOutcome ? `Intent outcome: ${ledger.taskJournal.lastIntentOutcome}` : undefined,
		ledger.taskJournal.planItems.length > 0
			? `Plan state: ${ledger.taskJournal.planItems.map((item) => `${item.title} [${item.status}]`).join(" | ")}`
			: undefined,
		ledger.planner
			? `Planner state: ${ledger.planner.phase} via ${ledger.planner.lane} (revision ${ledger.planner.planRevision}, attempts ${ledger.planner.executionAttempts})`
			: undefined,
		ledger.planner?.handoffSummary ? `Planner handoff: ${ledger.planner.handoffSummary}` : undefined,
		ledger.resume?.mode ? `Resume mode: ${ledger.resume.mode}` : undefined,
		ledger.resume?.resumeInstruction ? `Resume instruction: ${ledger.resume.resumeInstruction}` : undefined,
		ledger.resume?.resumeReason ? `Resume reason: ${ledger.resume.resumeReason}` : undefined,
		ledger.resume?.lastStableCheckpoint ? `Last stable checkpoint: ${ledger.resume.lastStableCheckpoint}` : undefined,
		ledger.research && ledger.research.searchQueries.length > 0
			? `Research queries: ${ledger.research.searchQueries.join(" | ")}`
			: undefined,
		ledger.research && ledger.research.fetchedUrls.length > 0
			? `Fetched sources: ${ledger.research.fetchedUrls.join(" | ")}`
			: undefined,
		ledger.research && ledger.research.sourceUrls.length > 0
			? `Source URLs: ${ledger.research.sourceUrls.join(" | ")}`
			: undefined,
		ledger.research && ledger.research.preferredSourceUrls.length > 0
			? `Preferred sources: ${ledger.research.preferredSourceUrls.join(" | ")}`
			: undefined,
		ledger.research && ledger.research.recentFindings.length > 0
			? `Research findings: ${ledger.research.recentFindings.join(" | ")}`
			: undefined,
		ledger.research?.evidence
			? `Research evidence: ${ledger.research.evidence.status} (${ledger.research.evidence.authoritativeSourceCount} authoritative, ${ledger.research.evidence.fetchedSourceCount} fetched, ${ledger.research.evidence.citedSourceCount} cited)`
			: undefined,
		ledger.research?.evidence && ledger.research.evidence.gaps.length > 0
			? `Research gaps: ${ledger.research.evidence.gaps.join(" | ")}`
			: undefined,
		ledger.currentFocus ? `Current focus: ${ledger.currentFocus}` : undefined,
		ledger.progressDetail ? `Latest concrete progress: ${ledger.progressDetail}` : undefined,
		ledger.lastActionType && ledger.lastActionDetail
			? `Last action: ${ledger.lastActionType} - ${ledger.lastActionDetail}`
			: undefined,
		ledger.visualIteration?.enabled
			? `Visual iteration: ${ledger.visualIteration.phase}${ledger.visualIteration.lastScreenshotDetail ? ` via ${ledger.visualIteration.lastScreenshotDetail}` : ""}`
			: undefined,
		ledger.visualIteration?.enabled ? `Screenshot attempts: ${ledger.visualIteration.screenshotAttempts}` : undefined,
		ledger.visualIteration?.observationSummary ? `Visual observation: ${ledger.visualIteration.observationSummary}` : undefined,
		ledger.visualIteration && ledger.visualIteration.outstandingIssues.length > 0
			? `Visual issues: ${ledger.visualIteration.outstandingIssues.join(" | ")}`
			: undefined,
		ledger.visualTarget ? `Visual target: ${ledger.visualTarget.goalSummary}` : undefined,
		ledger.visualTarget?.surface ? `Visual surface: ${ledger.visualTarget.surface}` : undefined,
		ledger.visualTarget?.viewportHint ? `Visual viewport: ${ledger.visualTarget.viewportHint}` : undefined,
		ledger.visualTarget?.interactionHint ? `Visual interaction: ${ledger.visualTarget.interactionHint}` : undefined,
		ledger.visualTarget?.recommendedTool ? `Visual tool: ${ledger.visualTarget.recommendedTool}` : undefined,
		ledger.visualTarget?.actionRecipe && ledger.visualTarget.actionRecipe.length > 0
			? `Visual recipe: ${formatVisualActionRecipe(ledger.visualTarget.actionRecipe)}`
			: undefined,
		ledger.visualTarget && ledger.visualTarget.acceptanceCriteria.length > 0
			? `Visual acceptance: ${ledger.visualTarget.acceptanceCriteria.join(" | ")}`
			: undefined,
		ledger.visualAssessment
			? `Visual assessment: ${ledger.visualAssessment.latestJudgment} - ${ledger.visualAssessment.summary}`
			: undefined,
		ledger.visualAssessment && ledger.visualAssessment.blockingIssues.length > 0
			? `Visual blockers: ${ledger.visualAssessment.blockingIssues.join(" | ")}`
			: undefined,
		ledger.taskJournal.completedCheckpoints.length > 0
			? `Completed checkpoints: ${ledger.taskJournal.completedCheckpoints.join(" | ")}`
			: undefined,
		ledger.touchedFiles.length > 0 ? `Changed files: ${ledger.touchedFiles.join(", ")}` : undefined,
		ledger.readFiles.length > 0 ? `Read files: ${ledger.readFiles.join(", ")}` : undefined,
		ledger.recentMutations.length > 0 ? `Recent mutations: ${ledger.recentMutations.join(" | ")}` : undefined,
		ledger.verificationAttempts > 0 ? `Verification attempts: ${ledger.verificationAttempts}` : undefined,
		ledger.verificationSatisfied
			? `Verification is currently satisfied${ledger.lastVerificationDetail ? ` via ${ledger.lastVerificationDetail}` : ""}.`
			: "Verification is still pending.",
		ledger.verificationFailures.length > 0
			? `Verification failures: ${ledger.verificationFailures.join(" | ")}`
			: undefined,
		ledger.taskJournal.blockedReasons.length > 0
			? `Blockers: ${ledger.taskJournal.blockedReasons.join(" | ")}`
			: undefined,
		ledger.residualRisks.length > 0 ? `Residual risks: ${ledger.residualRisks.join(" | ")}` : undefined,
		"Summarize concrete progress and remaining work. Avoid generic phrasing.",
	]
		.filter((line): line is string => typeof line === "string" && line.length > 0)
		.join("\n");
}

export function createAutonomousRunSnapshot(result: AutonomousRunResult): AutonomousRunSnapshot {
	return createAutonomousRunSnapshotFromState({
		phase: "final",
		iterations: result.iterations,
		stopReason: result.stopReason,
		costSummary: result.costSummary,
		budgetStatus: result.budgetStatus,
		checkpointState: result.checkpointState,
		ledger: result.ledger,
	});
}

export function createAutonomousRunSnapshotFromState(state: {
	phase: AutonomousRunCheckpointPhase;
	iterations: number;
	stopReason: AutonomousRunResult["stopReason"];
	costSummary: string;
	budgetStatus: AutonomousRunResult["budgetStatus"];
	checkpointState: AutonomousCheckpointState;
	ledger: AutonomousRunLedger;
}): AutonomousRunSnapshot {
	return {
		version: 1,
		savedAt: new Date().toISOString(),
		phase: state.phase,
		iterations: state.iterations,
		stopReason: state.stopReason,
		costSummary: state.costSummary,
		budgetStatus: state.budgetStatus,
		checkpointState: state.checkpointState,
		ledger: state.ledger,
	};
}

export function appendAutonomousRunSnapshot(
	sessionManager: { appendCustomEntry: (customType: string, data?: unknown) => string },
	result: AutonomousRunResult,
): void {
	appendAutonomousRunSnapshotState(
		sessionManager,
		createAutonomousRunSnapshot(result),
	);
}

export function appendAutonomousRunSnapshotState(
	sessionManager: { appendCustomEntry: (customType: string, data?: unknown) => string },
	snapshot: AutonomousRunSnapshot,
): void {
	sessionManager.appendCustomEntry(AUTONOMOUS_RUN_SNAPSHOT_ENTRY_TYPE, snapshot);
}

export function applyAutonomousLedgerEvents(
	current: AutonomousRunLedger,
	events: AutonomousLedgerEvent[],
): AutonomousRunLedger {
	let next = current;
	for (const event of events) {
		next = applyAutonomousLedgerEvent(next, event);
	}
	return syncLedgerFocusWithTaskJournal(next);
}

function syncLedgerFocusWithTaskJournal(ledger: AutonomousRunLedger): AutonomousRunLedger {
	const repairTargetMatch = ledger.taskJournal.activeSubtask?.match(/^Repair the failed change attempt: (.+)$/);
	if (!repairTargetMatch?.[1]) return ledger;
	return {
		...ledger,
		currentFocus: `Repair the failed change target: ${repairTargetMatch[1]}`,
		progressDetail: repairTargetMatch[1],
	};
}

export function getLatestAutonomousRunSnapshot(entries: SessionEntry[]): AutonomousRunSnapshot | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== AUTONOMOUS_RUN_SNAPSHOT_ENTRY_TYPE) continue;
		const snapshot = entry.data;
		if (isAutonomousRunSnapshot(snapshot)) return snapshot;
	}
	return undefined;
}

function extractFocusNote(text: string): string | undefined {
	if (!text || hasExplicitCompletionLikeSignal(text)) return undefined;
	const sentence = firstUsefulSentence(text);
	if (!sentence) return undefined;
	return normalizeSnippet(sentence, 160);
}

function extractRiskNotes(text: string): string[] {
	if (!text) return [];
	return text
		.split(/[\n.!?]+/)
		.map((part) => normalizeSnippet(part, 140))
		.filter((part): part is string => typeof part === "string" && RISK_PATTERNS.some((pattern) => pattern.test(part)))
		.slice(0, 2);
}

function firstUsefulSentence(text: string): string | undefined {
	const candidates = text
		.split(/[\n.!?]+/)
		.map((part) => part.trim())
		.filter((part) => part.length >= 16);
	return candidates.find((part) => !GENERIC_STATUS_PATTERNS.some((pattern) => pattern.test(part)));
}

function summarizeList(values: string[], limit: number): string {
	if (values.length <= limit) return values.join(", ");
	return `${values.slice(0, limit).join(", ")} (+${values.length - limit} more)`;
}

function uniqueTail(values: string[], limit: number): string[] {
	const seen = new Set<string>();
	const deduped: string[] = [];
	for (let i = values.length - 1; i >= 0; i--) {
		const value = values[i];
		if (!value || seen.has(value)) continue;
		seen.add(value);
		deduped.push(value);
		if (deduped.length >= limit) break;
	}
	return deduped.reverse();
}

function normalizeSnippet(value: string | undefined, maxLength: number): string | undefined {
	if (!value) return undefined;
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function getLatestMeaningfulAction(
	toolHistory: ToolOutcome[],
	fileAccessHistory: ToolOutcome[],
):
	| {
			type: "mutation" | "verification" | "inspection" | "other";
			detail: string;
			focus: string;
	  }
	| undefined {
	const combined = [...toolHistory];
	for (const outcome of [...combined].reverse()) {
		const detail = describeOutcome(outcome);
		if (!detail) continue;
		if (isVerificationOutcome(outcome)) {
			return {
				type: "verification",
				detail,
				focus: outcome.success ? `Running verification: ${detail}` : `Address verification failure: ${detail}`,
			};
		}
		if (isMutatingOutcome(outcome) && !outcome.success) {
			return {
				type: "mutation",
				detail,
				focus: `Repair the failed change target: ${detail}`,
			};
		}
		if (isMutatingOutcome(outcome) && outcome.success) {
			return {
				type: "mutation",
				detail,
				focus: `Continue from recent code changes: ${detail}`,
			};
		}
		if (isReadOutcome(outcome) && outcome.success) {
			return {
				type: "inspection",
				detail,
				focus: `Use the inspected context: ${detail}`,
			};
		}
		if (outcome.success) {
			const discoveryTarget = getDiscoveryTargetFile(outcome);
			return {
				type: "other",
				detail: discoveryTarget ?? detail,
				focus: `Continue from the latest tool step: ${discoveryTarget ?? detail}`,
			};
		}
	}
	for (const outcome of [...fileAccessHistory].reverse()) {
		const detail = describeOutcome(outcome);
		if (!detail) continue;
		return {
			type: "inspection",
			detail,
			focus: `Use the inspected context: ${detail}`,
		};
	}
	return undefined;
}

function describeOutcome(outcome: ToolOutcome): string | undefined {
	if (isMutatingOutcome(outcome)) {
		return normalizeWorkspaceReference(outcome.file, 140) ?? normalizeWorkspaceReference(outcome.detail, 140);
	}
	return normalizeWorkspaceReference(outcome.detail, 140) ?? normalizeWorkspaceReference(outcome.file, 140);
}

function normalizeWorkspaceReference(value: string | undefined, maxLength: number): string | undefined {
	if (!value) return undefined;
	const normalized = value.replace(/\\/g, "/").replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;

	const withoutWorkspaceCd = normalized.replace(
		/^cd\s+(?:\/?(?:tmp|home)\/[^\s;&|]+\/workspace)\s*&&\s*/i,
		"",
	);
	if (withoutWorkspaceCd !== normalized) {
		return normalizeSnippet(withoutWorkspaceCd, maxLength);
	}

	const workspaceRelative = extractWorkspaceRelativePath(normalized);
	if (workspaceRelative) {
		return normalizeSnippet(workspaceRelative, maxLength);
	}

	return normalizeSnippet(normalized, maxLength);
}

function extractWorkspaceRelativePath(value: string): string | undefined {
	const patterns = [
		/(?:^|\/)(src\/[^\s)`"'<>]+)/i,
		/(?:^|\/)(tests?\/[^\s)`"'<>]+)/i,
		/(?:^|\/)(reference\/[^\s)`"'<>]+)/i,
		/(?:^|\/)(scripts\/[^\s)`"'<>]+)/i,
		/(?:^|\/)(cli\/[^\s)`"'<>]+)/i,
		/(?:^|\/)(generated\/[^\s)`"'<>]+)/i,
	];
	for (const pattern of patterns) {
		const match = value.match(pattern);
		if (match?.[1]) return match[1];
	}
	if (/(?:^|\/)SUMMARY\.md$/i.test(value)) return "SUMMARY.md";
	return undefined;
}

function deriveDiscoveryTargetFile(options: {
	current?: string;
	toolHistory: ToolOutcome[];
}): string | undefined {
	for (const outcome of [...options.toolHistory].reverse()) {
		if (!outcome.success) continue;
		const directFile = normalizeWorkspaceFilePath(outcome.file);
		if (directFile) return choosePreferredDiscoveryTarget(options.current, directFile, outcome);
		const discoveryFile = getDiscoveryTargetFile(outcome);
		if (discoveryFile) return choosePreferredDiscoveryTarget(options.current, discoveryFile, outcome);
	}
	return options.current;
}

function choosePreferredDiscoveryTarget(
	current: string | undefined,
	next: string,
	outcome: ToolOutcome,
): string {
	if (!current || current === next) return next;
	if (!/^(?:src|tests?)\//i.test(current)) return next;
	if (/^(?:src|tests?)\//i.test(next)) return next;
	if (isReadOutcome(outcome) || outcome.tool.toLowerCase() === "ls" || outcome.tool.toLowerCase() === "find") {
		return current;
	}
	return next;
}

function getDiscoveryTargetFile(outcome: ToolOutcome): string | undefined {
	const toolName = outcome.tool.toLowerCase();
	if (toolName === "find") {
		const firstMatch = normalizeWorkspaceFilePath(readMetadataString(outcome.metadata, "firstMatchPath"));
		if (firstMatch) return firstMatch;
	}
	if (toolName === "ls") {
		const directoryPath = readMetadataString(outcome.metadata, "directoryPath");
		const entryCount = readMetadataNumber(outcome.metadata, "entryCount");
		const entries = Array.isArray(outcome.metadata?.entriesSample)
			? outcome.metadata.entriesSample.filter((value): value is string => typeof value === "string")
			: [];
		if (entryCount === 1 && entries.length >= 1) {
			const entry = entries[0]?.replace(/\/$/, "");
			if (entry) {
				const joined = directoryPath && directoryPath !== "." ? `${directoryPath}/${entry}` : entry;
				return normalizeWorkspaceFilePath(joined);
			}
		}
	}
	return undefined;
}

function normalizeWorkspaceFilePath(value: string | undefined): string | undefined {
	const normalized = normalizeWorkspaceReference(value, 140);
	if (!normalized) return undefined;
	if (normalized.endsWith("/")) return undefined;
	if (!/^(?:src|tests?|reference|scripts|cli|generated)\//i.test(normalized) && normalized !== "SUMMARY.md") {
		return undefined;
	}
	return normalized;
}

function readMetadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
	return typeof metadata?.[key] === "string" ? (metadata[key] as string) : undefined;
}

function readMetadataNumber(metadata: Record<string, unknown> | undefined, key: string): number | undefined {
	return typeof metadata?.[key] === "number" ? (metadata[key] as number) : undefined;
}

function deriveResearchState(options: {
	current?: AutonomousResearchState;
	toolHistory: ToolOutcome[];
}): AutonomousResearchState | undefined {
	const searchQueries = [...(options.current?.searchQueries ?? [])];
	const fetchedUrls = [...(options.current?.fetchedUrls ?? [])];
	const sourceUrls = [...(options.current?.sourceUrls ?? [])];
	const preferredSourceUrls = [...(options.current?.preferredSourceUrls ?? [])];
	const recentFindings = [...(options.current?.recentFindings ?? [])];

	for (const outcome of options.toolHistory) {
		if (!outcome.success) continue;
		const toolName = outcome.tool.toLowerCase();
		if (toolName === "websearch") {
			const metadata = parseResearchSearchMetadata(outcome.metadata);
			const query = normalizeSnippet(metadata?.query ?? outcome.detail, 140);
			if (query) searchQueries.push(query);
			for (const result of metadata?.results ?? []) {
				if (result.url) sourceUrls.push(result.url);
				if (result.url && isLikelyAuthoritativeSource(result.url)) preferredSourceUrls.push(result.url);
				const finding = normalizeSnippet(
					result.title && result.url ? `${result.title} — ${result.url}` : result.title ?? result.url,
					180,
				);
				if (finding) recentFindings.push(finding);
			}
		}
		if (toolName === "webfetch") {
			const metadata = parseResearchFetchMetadata(outcome.metadata);
			const url = metadata?.url ?? extractUrlFromDetail(outcome.detail);
			if (url) {
				fetchedUrls.push(url);
				sourceUrls.push(url);
				if (isLikelyAuthoritativeSource(url)) preferredSourceUrls.push(url);
			}
			const finding = normalizeSnippet(
				metadata?.title && url ? `Fetched ${metadata.title} — ${url}` : metadata?.title ?? url,
				180,
			);
			if (finding) recentFindings.push(finding);
			for (const fact of metadata?.facts ?? []) {
				const factFinding = normalizeSnippet(metadata?.title ? `${metadata.title}: ${fact}` : fact, 180);
				if (factFinding) recentFindings.push(factFinding);
			}
		}
	}

	if (
		searchQueries.length === 0 &&
		fetchedUrls.length === 0 &&
		sourceUrls.length === 0 &&
		preferredSourceUrls.length === 0 &&
		recentFindings.length === 0
	) {
		return undefined;
	}

	return {
		searchQueries: uniqueTail(searchQueries, 6),
		fetchedUrls: uniqueTail(fetchedUrls, 6),
		sourceUrls: uniqueTail(sourceUrls, 8),
		preferredSourceUrls: rankPreferredResearchSources([...preferredSourceUrls, ...sourceUrls]).slice(0, 5),
		recentFindings: uniqueTail(recentFindings, 6),
		evidence: deriveResearchEvidence({
			fetchedUrls,
			sourceUrls,
			preferredSourceUrls,
			recentFindings,
		}),
	};
}

export function hasSufficientResearchEvidence(research: AutonomousResearchState | undefined): boolean {
	return research?.evidence?.status === "sufficient" && research.evidence.summaryReady;
}

function deriveResearchEvidence(options: {
	fetchedUrls: string[];
	sourceUrls: string[];
	preferredSourceUrls: string[];
	recentFindings: string[];
}): AutonomousResearchEvidence {
	const authoritativeSourceCount = rankPreferredResearchSources(options.preferredSourceUrls).length;
	const fetchedSourceCount = uniqueTail(options.fetchedUrls, 8).length;
	const citedSourceCount = uniqueTail(options.sourceUrls, 8).length;
	const findingCount = uniqueTail(options.recentFindings, 8).length;
	const citationReady = citedSourceCount > 0;
	const gaps: string[] = [];

	if (authoritativeSourceCount === 0) gaps.push("no authoritative source captured yet");
	if (fetchedSourceCount === 0) gaps.push("no fetched source has been read yet");
	if (!citationReady) gaps.push("no source URL is ready to cite");
	if (findingCount === 0) gaps.push("no concrete source-backed finding has been recorded yet");

	const status =
		authoritativeSourceCount >= 1 && fetchedSourceCount >= 1 && citationReady && findingCount >= 1
			? "sufficient"
			: "insufficient";

	return {
		status,
		authoritativeSourceCount,
		fetchedSourceCount,
		citedSourceCount,
		findingCount,
		citationReady,
		summaryReady: status === "sufficient",
		gaps: uniqueTail(gaps, 4),
	};
}

function rankPreferredResearchSources(urls: string[]): string[] {
	return uniqueTail(urls, 16)
		.map((url) => ({ url, score: scoreResearchSource(url) }))
		.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
		.map((entry) => entry.url);
}

function scoreResearchSource(url: string): number {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase();
		const path = parsed.pathname.toLowerCase();
		let score = 0;
		if (host.startsWith("docs.") || host.startsWith("developer.") || host.startsWith("api.") || host.startsWith("learn.")) {
			score += 5;
		}
		if (/(^|\.)(readthedocs\.io|mozilla\.org|react\.dev|nodejs\.org|python\.org|golang\.org|rust-lang\.org)$/.test(host)) {
			score += 5;
		}
		if (/(docs|doc|reference|manual|guide|api|spec|specification|changelog|release)/.test(path)) {
			score += 3;
		}
		if (/(stackoverflow\.com|reddit\.com|medium\.com|dev\.to|hashnode\.com|youtube\.com|x\.com|twitter\.com)/.test(host)) {
			score -= 4;
		}
		if (/(duckduckgo\.com|google\.com|bing\.com)/.test(host)) {
			score -= 6;
		}
		return score;
	} catch {
		return -10;
	}
}

function isLikelyAuthoritativeSource(url: string): boolean {
	return scoreResearchSource(url) >= 3;
}

function parseResearchSearchMetadata(
	metadata: Record<string, unknown> | undefined,
):
	| {
			query?: string;
			results?: Array<{ title?: string; url?: string }>;
	  }
	| undefined {
	if (!metadata) return undefined;
	const results = Array.isArray(metadata.results)
		? metadata.results.flatMap((result) => {
				if (!result || typeof result !== "object") return [];
				const candidate = result as Record<string, unknown>;
				return [
					{
						title: typeof candidate.title === "string" ? candidate.title : undefined,
						url: typeof candidate.url === "string" ? candidate.url : undefined,
					},
				];
			})
		: undefined;
	return {
		query: typeof metadata.query === "string" ? metadata.query : undefined,
		results,
	};
}

function parseResearchFetchMetadata(
	metadata: Record<string, unknown> | undefined,
): { url?: string; title?: string; facts?: string[] } | undefined {
	if (!metadata) return undefined;
	return {
		url: typeof metadata.url === "string" ? metadata.url : undefined,
		title: typeof metadata.title === "string" ? metadata.title : undefined,
		facts: Array.isArray(metadata.facts)
			? metadata.facts.filter((value): value is string => typeof value === "string").slice(0, 4)
			: undefined,
	};
}

function deriveVisualIteration(options: {
	current?: AutonomousVisualIteration;
	toolHistory: ToolOutcome[];
	visualVerificationRelevant: boolean;
	verificationSatisfied: boolean;
	lastVerificationDetail?: string;
}): AutonomousVisualIteration | undefined {
	if (!options.visualVerificationRelevant && !options.current?.enabled) return undefined;

	const visualArtifacts = collectVisualArtifacts(options.toolHistory);
	let lastMutationIndex = -1;
	let lastScreenshotIndex = -1;
	let lastScreenshotDetail = options.current?.lastScreenshotDetail;
	let screenshotAttempts = 0;

	for (let i = 0; i < options.toolHistory.length; i++) {
		const outcome = options.toolHistory[i];
		if (outcome.success && isMutatingOutcome(outcome)) {
			lastMutationIndex = i;
		}
		if (isVisualVerificationOutcome(outcome)) {
			screenshotAttempts += 1;
			if (outcome.success) {
				lastScreenshotIndex = i;
				lastScreenshotDetail = normalizeSnippet(outcome.detail, 180) ?? normalizeSnippet(outcome.file, 180);
			}
		}
	}

	let phase: AutonomousVisualIteration["phase"] = "baseline_capture";
	if (lastScreenshotIndex >= 0 && options.verificationSatisfied) {
		phase = "verified";
	} else if (lastMutationIndex > lastScreenshotIndex) {
		phase = "recapture";
	} else if (lastScreenshotIndex >= 0) {
		phase = "patch";
	}

	return {
		enabled: true,
		phase,
		screenshotAttempts,
		lastScreenshotDetail: lastScreenshotDetail ?? options.lastVerificationDetail,
		observationSummary: buildVisualObservationSummary(visualArtifacts, phase),
		outstandingIssues: uniqueTail(visualArtifacts.flatMap((artifact) => getVisualArtifactIssues(artifact)), 4),
		recentArtifacts: visualArtifacts.slice(-3),
	};
}

function collectVisualArtifacts(toolHistory: ToolOutcome[]): AutonomousVisualArtifact[] {
	const artifacts: AutonomousVisualArtifact[] = [];
	for (const outcome of toolHistory) {
		if (!isVisualVerificationOutcome(outcome)) continue;
		const metadata = parseVisualMetadata(outcome.metadata);
		artifacts.push({
			tool: normalizeVisualToolName(outcome.tool),
			status: outcome.success ? "captured" : "failed",
			detail: normalizeSnippet(outcome.detail, 180),
			url: metadata?.url ?? extractUrlFromDetail(outcome.detail),
			title: metadata?.title,
			loadTimeMs: metadata?.loadTimeMs,
			actionRecipe: metadata?.actions,
			consoleErrors: metadata?.consoleErrors ?? [],
			failedRequests: metadata?.failedRequests ?? [],
			error: metadata?.error,
		});
	}
	return artifacts;
}

function parseVisualMetadata(metadata: Record<string, unknown> | undefined):
	| {
			url?: string;
			title?: string;
			loadTimeMs?: number;
			actions?: AutonomousVisualActionStep[];
			consoleErrors?: string[];
			failedRequests?: string[];
			error?: string;
	  }
	| undefined {
	if (!metadata) return undefined;
	const consoleErrors = Array.isArray(metadata.consoleErrors)
		? metadata.consoleErrors.filter((value): value is string => typeof value === "string")
		: [];
	const failedRequests = Array.isArray(metadata.failedRequests)
		? metadata.failedRequests.filter((value): value is string => typeof value === "string")
		: [];
	const actions = Array.isArray(metadata.actions) ? parseVisualActionRecipeFromMetadata(metadata.actions) : undefined;
	return {
		url: typeof metadata.url === "string" ? metadata.url : undefined,
		title: typeof metadata.title === "string" ? metadata.title : undefined,
		loadTimeMs: typeof metadata.loadTimeMs === "number" ? metadata.loadTimeMs : undefined,
		actions,
		consoleErrors,
		failedRequests,
		error: typeof metadata.error === "string" ? metadata.error : undefined,
	};
}

function parseVisualActionRecipeFromMetadata(actions: unknown[]): AutonomousVisualActionStep[] | undefined {
	const parsed: AutonomousVisualActionStep[] = [];
	for (const action of actions) {
		if (!action || typeof action !== "object") continue;
		const candidate = action as Record<string, unknown>;
		const type = candidate.type;
		if (type !== "click" && type !== "fill" && type !== "wait" && type !== "navigate") continue;
		parsed.push({
			type,
			selector: typeof candidate.selector === "string" ? candidate.selector : undefined,
			targetHint: typeof candidate.selector === "string" ? candidate.selector : undefined,
			valueHint: type === "fill" && typeof candidate.value === "string" ? "recorded input" : undefined,
			ms: typeof candidate.ms === "number" ? candidate.ms : undefined,
			url: typeof candidate.url === "string" ? candidate.url : undefined,
			urlHint: typeof candidate.url === "string" ? candidate.url : undefined,
			source: "recorded",
		});
	}
	return parsed.length > 0 ? parsed : undefined;
}

function buildVisualObservationSummary(
	artifacts: AutonomousVisualArtifact[],
	phase: AutonomousVisualIteration["phase"],
): string | undefined {
	const latest = artifacts[artifacts.length - 1];
	if (!latest) return undefined;
	const target = latest.title ?? latest.url ?? latest.detail;
	if (latest.status === "failed") {
		return normalizeSnippet(`visual capture failed${latest.error ? `: ${latest.error}` : ""}`, 180);
	}
	const issues = getVisualArtifactIssues(latest);
	if (issues.length > 0) {
		return normalizeSnippet(
			`${phase === "verified" ? "verified capture" : "latest capture"} for ${target ?? "UI"} with issues: ${issues.join("; ")}`,
			180,
		);
	}
	return normalizeSnippet(
		`${phase === "verified" ? "verified capture" : "latest capture"} for ${target ?? "UI"} with no console or network issues`,
		180,
	);
}

function getVisualArtifactIssues(artifact: AutonomousVisualArtifact): string[] {
	const issues: string[] = [];
	if (artifact.error) issues.push(`capture error: ${artifact.error}`);
	if (artifact.consoleErrors.length > 0) issues.push(`console errors: ${artifact.consoleErrors[0]}`);
	if (artifact.failedRequests.length > 0) issues.push(`failed requests: ${artifact.failedRequests[0]}`);
	return issues.map((value) => normalizeSnippet(value, 180) ?? value);
}

function extractUrlFromDetail(detail: string | undefined): string | undefined {
	if (!detail) return undefined;
	const match = detail.match(/https?:\/\/\S+/i);
	return match?.[0];
}

function normalizeVisualToolName(tool: string): AutonomousVisualArtifact["tool"] {
	return tool.toLowerCase() === "interact_then_screenshot" ? "interact_then_screenshot" : "screenshot_url";
}

function deriveVisualTarget(options: {
	current?: AutonomousVisualTarget;
	goal: string;
	currentFocus?: string;
	readFiles: string[];
	touchedFiles: string[];
	visualIteration?: AutonomousVisualIteration;
	visualVerificationRelevant: boolean;
}): AutonomousVisualTarget | undefined {
	if (!options.visualVerificationRelevant && !options.current) return undefined;
	const fileCandidates = [...options.touchedFiles, ...options.readFiles];
	const inferredSurface =
		inferSurfaceFromGoal(options.goal) ??
		inferSurfaceFromFocus(options.currentFocus) ??
		inferSurfaceFromFiles(fileCandidates) ??
		options.current?.surface;
	const viewportProfile = inferViewportProfile(options.goal) ?? options.current?.viewportProfile;
	const viewportHint = formatViewportHint(viewportProfile) ?? options.current?.viewportHint;
	const recordedRecipe = getLatestRecordedVisualActionRecipe(options.visualIteration) ?? options.current?.actionRecipe;
	const interactionHint =
		describeVisualRecipe(recordedRecipe) ??
		inferInteractionHint(options.goal, inferredSurface) ??
		options.current?.interactionHint;
	const interactionMode = interactionHint || recordedRecipe ? "interactive" : (options.current?.interactionMode ?? "static");
	const recommendedTool =
		interactionMode === "interactive"
			? "interact_then_screenshot"
			: (options.current?.recommendedTool ?? "screenshot_url");
	const actionRecipe = recordedRecipe ?? inferVisualActionRecipe(options.goal, inferredSurface, interactionMode);
	const goalSummary =
		normalizeSnippet(options.goal, 180) ??
		options.current?.goalSummary ??
		"Improve the targeted UI surface";
	const acceptanceCriteria = uniqueTail(
		[
			...buildVisualAcceptanceCriteria(options.goal, inferredSurface, viewportProfile, interactionHint),
			...(options.current?.acceptanceCriteria ?? []),
		],
		4,
	);
	return {
		surface: inferredSurface,
		goalSummary,
		acceptanceCriteria,
		viewportProfile,
		viewportHint,
		interactionMode,
		interactionHint,
		recommendedTool,
		actionRecipe,
	};
}

function getLatestRecordedVisualActionRecipe(
	visualIteration: AutonomousVisualIteration | undefined,
): AutonomousVisualActionStep[] | undefined {
	if (!visualIteration) return undefined;
	for (let i = visualIteration.recentArtifacts.length - 1; i >= 0; i--) {
		const artifact = visualIteration.recentArtifacts[i];
		if (artifact?.status === "captured" && artifact.tool === "interact_then_screenshot" && artifact.actionRecipe?.length) {
			return artifact.actionRecipe;
		}
	}
	return undefined;
}

function describeVisualRecipe(recipe: AutonomousVisualActionStep[] | undefined): string | undefined {
	if (!recipe || recipe.length === 0) return undefined;
	const firstStep = recipe[0];
	switch (firstStep.type) {
		case "click":
			return `follow the recorded interaction flow by clicking ${firstStep.selector ?? firstStep.targetHint ?? "the target control"} before capture`;
		case "fill":
			return `follow the recorded interaction flow by filling ${firstStep.selector ?? firstStep.targetHint ?? "the target input"} before capture`;
		case "navigate":
			return `follow the recorded interaction flow by navigating to ${firstStep.url ?? firstStep.urlHint ?? "the target page"} before capture`;
		case "wait":
			return `follow the recorded interaction flow before capture`;
	}
}

function buildVisualAcceptanceCriteria(
	goal: string,
	surface?: string,
	viewportProfile?: AutonomousVisualTarget["viewportProfile"],
	interactionHint?: string,
): string[] {
	const criteria = ["render without console or network issues"];
	if (/\b(responsive|mobile|tablet|desktop|viewport)\b/i.test(goal) || viewportProfile) {
		criteria.push(
			viewportProfile
				? `look correct at the intended ${viewportProfile} viewport and breakpoint`
				: "look correct at the intended viewport and breakpoint",
		);
	}
	if (/\b(layout|spacing|align|position|grid|hero|header|sidebar|dashboard|landing)\b/i.test(goal)) {
		criteria.push(`the ${surface ?? "target UI"} layout should reflect the requested visual change`);
	}
	if (/\b(style|styling|theme|color|typography|font|button|card)\b/i.test(goal)) {
		criteria.push(`the ${surface ?? "target UI"} styling should match the requested appearance`);
	}
	if (/\b(form|login|signup|checkout|modal|dialog|menu|nav)\b/i.test(goal)) {
		criteria.push(`the ${surface ?? "target UI"} should render the intended interactive state`);
	}
	if (interactionHint) {
		criteria.push(`the capture should reflect the intended state after ${interactionHint.replace(/^open |^perform |^fill /i, "")}`);
	}
	return uniqueTail(criteria, 4);
}

function inferViewportProfile(goal: string): AutonomousVisualTarget["viewportProfile"] | undefined {
	if (/\bmobile\b/i.test(goal)) return "mobile";
	if (/\btablet\b/i.test(goal)) return "tablet";
	if (/\bdesktop\b/i.test(goal)) return "desktop";
	if (/\bresponsive\b/i.test(goal)) return "mobile";
	return undefined;
}

function formatViewportHint(
	viewportProfile: AutonomousVisualTarget["viewportProfile"] | undefined,
): string | undefined {
	switch (viewportProfile) {
		case "mobile":
			return "mobile viewport (for example 390x844)";
		case "tablet":
			return "tablet viewport (for example 768x1024)";
		case "desktop":
			return "desktop viewport (for example 1280x900)";
		default:
			return undefined;
	}
}

function inferInteractionHint(goal: string, surface?: string): string | undefined {
	if (/\b(login|sign in|signin|auth|authenticated|logged in)\b/i.test(goal)) {
		return `perform the login/auth flow before capturing the ${surface ?? "target UI"}`;
	}
	if (/\b(modal|dialog|popup)\b/i.test(goal)) {
		return `open the modal/dialog before capturing the ${surface ?? "target UI"}`;
	}
	if (/\b(drawer|cart drawer|side panel)\b/i.test(goal)) {
		return `open the drawer before capturing the ${surface ?? "target UI"}`;
	}
	if (/\b(menu|dropdown|popover|tooltip)\b/i.test(goal)) {
		return `open the menu/popover state before capturing the ${surface ?? "target UI"}`;
	}
	if (/\b(checkout|cart|basket)\b/i.test(goal)) {
		return `reach the cart/checkout state before capturing the ${surface ?? "target UI"}`;
	}
	if (/\b(form|submit|submitted|success state|error state|validation)\b/i.test(goal)) {
		return `fill and submit the form state before capturing the ${surface ?? "target UI"}`;
	}
	return undefined;
}

function inferVisualActionRecipe(
	goal: string,
	surface: string | undefined,
	interactionMode: AutonomousVisualTarget["interactionMode"],
): AutonomousVisualActionStep[] | undefined {
	if (interactionMode !== "interactive") return undefined;
	if (/\b(drawer|cart drawer|side panel)\b/i.test(goal)) {
		return [
			{ type: "click", targetHint: `the control that opens the ${surface ?? "drawer"}`, source: "inferred" },
			{ type: "wait", ms: 500, source: "inferred" },
		];
	}
	if (/\b(modal|dialog|popup)\b/i.test(goal)) {
		return [
			{ type: "click", targetHint: `the trigger that opens the ${surface ?? "modal/dialog"}`, source: "inferred" },
			{ type: "wait", ms: 300, source: "inferred" },
		];
	}
	if (/\b(menu|dropdown|popover|tooltip)\b/i.test(goal)) {
		return [
			{ type: "click", targetHint: `the trigger that opens the ${surface ?? "menu/popover"}`, source: "inferred" },
			{ type: "wait", ms: 200, source: "inferred" },
		];
	}
	if (/\b(login|sign in|signin|auth|authenticated|logged in)\b/i.test(goal)) {
		return [
			{ type: "fill", targetHint: "the username/email field", valueHint: "valid account email or username", source: "inferred" },
			{ type: "fill", targetHint: "the password field", valueHint: "valid account password", source: "inferred" },
			{ type: "click", targetHint: "the submit/sign-in button", source: "inferred" },
			{ type: "wait", ms: 1000, source: "inferred" },
		];
	}
	if (/\b(checkout|cart|basket)\b/i.test(goal)) {
		return [
			{ type: "click", targetHint: "the control that opens the cart or checkout state", source: "inferred" },
			{ type: "wait", ms: 500, source: "inferred" },
		];
	}
	if (/\b(form|submit|submitted|success state|error state|validation)\b/i.test(goal)) {
		return [
			{
				type: "fill",
				targetHint: `the key input fields for the ${surface ?? "form"}`,
				valueHint: "representative valid input",
				source: "inferred",
			},
			{ type: "click", targetHint: "the submit button", source: "inferred" },
			{ type: "wait", ms: 800, source: "inferred" },
		];
	}
	return undefined;
}

function formatVisualActionRecipe(steps: AutonomousVisualActionStep[]): string {
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

function inferSurfaceFromGoal(goal: string): string | undefined {
	const patterns = [
		/\b(landing page|dashboard|homepage|home page|login page|signup page|settings page|profile page|checkout page)\b/i,
		/\b(hero|header|footer|sidebar|modal|dialog|navbar|navigation|form|card|button|table|chart)\b/i,
	];
	for (const pattern of patterns) {
		const match = goal.match(pattern);
		if (match?.[1]) return normalizeSnippet(match[1], 80);
	}
	return undefined;
}

function inferSurfaceFromFocus(focus: string | undefined): string | undefined {
	if (!focus) return undefined;
	const match = focus.match(/\b(ui|layout|page|screen|component|dashboard|landing page|homepage|modal|dialog|form|header|sidebar)\b/i);
	return match?.[0] ? normalizeSnippet(match[0], 80) : undefined;
}

function inferSurfaceFromFiles(files: string[]): string | undefined {
	for (const file of files) {
		const match = file.match(/\/?([^/]+)\.(tsx|jsx|vue|svelte|html|css|scss|sass|less)$/i);
		if (!match?.[1]) continue;
		const surface = match[1]
			.replace(/[-_]+/g, " ")
			.replace(/\b(app|page|index|component|view|screen)\b/gi, "")
			.replace(/\s+/g, " ")
			.trim();
		if (surface.length > 0) return normalizeSnippet(surface, 80);
	}
	return undefined;
}

function deriveVisualAssessment(options: {
	current?: AutonomousVisualAssessment;
	visualIteration?: AutonomousVisualIteration;
	target?: AutonomousVisualTarget;
}): AutonomousVisualAssessment | undefined {
	const visualIteration = options.visualIteration;
	if (!visualIteration?.enabled) return undefined;
	const latestArtifact = visualIteration.recentArtifacts[visualIteration.recentArtifacts.length - 1];
	const target =
		latestArtifact?.title ??
		latestArtifact?.url ??
		latestArtifact?.detail ??
		options.target?.surface ??
		options.target?.goalSummary;
	const blockingIssues =
		visualIteration.phase === "baseline_capture" || visualIteration.phase === "patch"
			? []
			: latestArtifact
				? getVisualArtifactIssues(latestArtifact)
				: visualIteration.outstandingIssues;
	if (visualIteration.phase === "verified" && blockingIssues.length === 0) {
		return {
			target,
			latestJudgment: "pass",
			summary:
				visualIteration.observationSummary ??
				normalizeSnippet(`latest visual verification for ${target ?? "UI"} passed without console or network issues`, 180) ??
				"latest visual verification passed",
			blockingIssues: [],
			lastEvaluatedDetail: visualIteration.lastScreenshotDetail,
			basis: "screenshot_metadata",
		};
	}
	if (blockingIssues.length > 0) {
		return {
			target,
			latestJudgment: "fail",
			summary:
				normalizeSnippet(`latest visual verification for ${target ?? "UI"} found blocking issues: ${blockingIssues.join("; ")}`, 180) ??
				"latest visual verification found blocking issues",
			blockingIssues,
			lastEvaluatedDetail: visualIteration.lastScreenshotDetail,
			basis: "screenshot_metadata",
		};
	}
	return {
		target,
		latestJudgment: "pending",
		summary:
			visualIteration.observationSummary ??
			normalizeSnippet(`visual verification is still pending for ${target ?? "UI"}`, 180) ??
			"visual verification is still pending",
		blockingIssues: [],
		lastEvaluatedDetail: visualIteration.lastScreenshotDetail,
		basis: "screenshot_metadata",
	};
}

function deriveActiveSubtask(options: {
	current: AutonomousRunLedger;
	taskMode: AutonomousTaskMode;
	status: AutonomousRunLedger["status"];
	currentFocus?: string;
	latestAction?: { type: "mutation" | "verification" | "inspection" | "other"; detail: string; focus: string };
	verificationSatisfied: boolean;
}): string | undefined {
	if (options.status === "complete") return "Finalize and report verified completion";
	if (options.status === "error") return "Recover from the latest autonomous error";
	if (options.status === "budget") return "Budget exhausted before completion";
	if (options.current.visualAssessment?.latestJudgment === "fail") {
		return `Resolve visual verification issues: ${options.current.visualAssessment.blockingIssues[0] ?? options.current.visualAssessment.summary}`;
	}
	if (options.latestAction?.type === "verification" && !options.verificationSatisfied) {
		return `Resolve verification failure: ${options.latestAction.detail}`;
	}
	if (options.latestAction?.type === "mutation") {
		return `Validate the recent change: ${options.latestAction.detail}`;
	}
	if (options.latestAction?.type === "inspection") {
		if (options.taskMode === "answer") {
			return detailWithPrefix(options.latestAction.detail, "Use the inspected context to answer directly");
		}
		return `Turn inspected context into a concrete change: ${options.latestAction.detail}`;
	}
	return options.currentFocus ?? options.current.taskJournal.activeSubtask;
}

function deriveNextAction(options: {
	taskMode: AutonomousTaskMode;
	status: AutonomousRunLedger["status"];
	latestActionType?: "mutation" | "verification" | "inspection" | "other";
	verificationSatisfied: boolean;
	blockedReasons: string[];
	recentMutations: string[];
	readFiles: string[];
	visualAssessment?: AutonomousVisualAssessment;
}): string | undefined {
	if (options.status === "complete") return "Stop and present the verified result";
	if (options.visualAssessment?.latestJudgment === "fail") {
		return `Resolve visual issue: ${options.visualAssessment.blockingIssues[0] ?? options.visualAssessment.summary}`;
	}
	if (options.blockedReasons.length > 0) return `Resolve blocker: ${options.blockedReasons[0]}`;
	if (options.taskMode === "answer") {
		if (options.latestActionType === "inspection" || options.readFiles.length > 0) {
			return "Answer directly from the inspected evidence and stop";
		}
		if (options.latestActionType === "verification" && options.verificationSatisfied) {
			return "Summarize the confirmed answer and stop";
		}
		return "Inspect one directly relevant file or path, then answer and stop";
	}
	if (!options.verificationSatisfied && options.recentMutations.length > 0) return "Run verification on the latest changes";
	if (options.latestActionType === "inspection") return "Make the next concrete code change";
	if (options.latestActionType === "verification" && options.verificationSatisfied) return "Summarize the verified result and any residual risks";
	if (options.latestActionType === "mutation") return "Verify the recent implementation change";
	if (options.readFiles.length > 0) return "Use the inspected files to make a concrete implementation step";
	return "Continue with the next concrete step";
}

function derivePlannerState(options: {
	current?: AutonomousPlannerState;
	taskMode: AutonomousTaskMode;
	status: AutonomousRunLedger["status"];
	taskJournal: AutonomousTaskJournal;
	research?: AutonomousResearchState;
	visualAssessment?: AutonomousVisualAssessment;
	verificationSatisfied: boolean;
	verificationFailures: string[];
}): AutonomousPlannerState {
	const previous = options.current;
	const phase =
		options.status === "error" || options.taskJournal.blockedReasons.length > 0 || options.verificationFailures.length > 0
			? "blocked"
			: options.status === "complete" || getPlanStatus(options.taskJournal.planItems, "summarize") === "active"
				? "summarizing"
				: getPlanStatus(options.taskJournal.planItems, "verify") === "active" || options.verificationSatisfied
					? "verifying"
					: getPlanStatus(options.taskJournal.planItems, "implement") === "active" || getPlanStatus(options.taskJournal.planItems, "implement") === "completed"
						? "executing"
						: "planning";
	const lane =
		options.research && options.research.searchQueries.length + options.research.fetchedUrls.length > 0
			? "research"
			: options.visualAssessment
				? "visual"
				: options.taskMode === "answer"
					? "generic"
				: getPlanStatus(options.taskJournal.planItems, "implement") !== "pending"
					? "implementation"
					: "generic";
	const shouldBumpRevision =
		previous &&
		(previous.phase !== phase || previous.lane !== lane || previous.handoffSummary !== buildPlannerHandoffSummary(options.taskJournal, options.research));
	return {
		phase,
		lane,
		planRevision: shouldBumpRevision ? previous.planRevision + 1 : (previous?.planRevision ?? 0),
		executionAttempts:
			phase === "executing" || phase === "verifying"
				? Math.max(previous?.executionAttempts ?? 0, options.taskJournal.completedCheckpoints.length)
				: (previous?.executionAttempts ?? 0),
		handoffSummary: buildPlannerHandoffSummary(options.taskJournal, options.research),
	};
}

function buildPlannerHandoffSummary(
	taskJournal: AutonomousTaskJournal,
	research: AutonomousResearchState | undefined,
): string {
	if (taskJournal.plannedNextStep && taskJournal.stepRationale) {
		return `${taskJournal.plannedNextStep} Why: ${taskJournal.stepRationale}`;
	}
	if (hasSufficientResearchEvidence(research)) {
		return "Research evidence is sufficient. Stop browsing and synthesize the answer from the saved sources.";
	}
	return taskJournal.nextAction ?? taskJournal.activeSubtask ?? "Continue with the next concrete step.";
}

function deriveResumeState(options: {
	current?: AutonomousResumeState;
	taskMode: AutonomousTaskMode;
	taskJournal: AutonomousTaskJournal;
	planner: AutonomousPlannerState;
	completedCheckpoints: string[];
	blockedReasons: string[];
	verificationSatisfied: boolean;
}): AutonomousResumeState {
	const mode = deriveResumeMode(options);
	return {
		mode,
		resumeInstruction:
			options.taskJournal.plannedNextStep ??
			options.taskJournal.nextAction ??
			options.current?.resumeInstruction ??
			"Continue with the next concrete step.",
		resumeReason:
			options.blockedReasons[0] ??
			options.taskJournal.stepRationale ??
			(options.verificationSatisfied
				? "Verification is already satisfied, so the run can summarize and stop."
				: `Planner is currently in ${options.planner.phase} mode.`),
		lastStableCheckpoint:
			options.completedCheckpoints[options.completedCheckpoints.length - 1] ?? options.current?.lastStableCheckpoint,
	};
}

function deriveResumeMode(options: {
	taskMode: AutonomousTaskMode;
	taskJournal: AutonomousTaskJournal;
	planner: AutonomousPlannerState;
	blockedReasons: string[];
	verificationSatisfied: boolean;
}): AutonomousResumeState["mode"] {
	if (options.blockedReasons.length > 0 || options.taskJournal.intentStatus === "failed") return "resume_repair";
	if (options.verificationSatisfied || options.planner.phase === "summarizing") return "resume_summarize";
	if (options.planner.phase === "verifying" || getPlanStatus(options.taskJournal.planItems, "verify") === "active") {
		return "resume_verify";
	}
	if (options.taskMode === "research" || options.planner.lane === "research") return "resume_research";
	return "resume_execute";
}

function applyAutonomousLedgerEvent(
	current: AutonomousRunLedger,
	event: AutonomousLedgerEvent,
): AutonomousRunLedger {
	const journal = cloneTaskJournal(current.taskJournal);
	const taskMode = getAutonomousTaskMode(current);
	const detail = normalizeSnippet("detail" in event ? event.detail : undefined, 160);
	switch (event.type) {
		case "inspection_complete":
			setPlanStatus(journal.planItems, "inspect", "completed");
			if (getPlanStatus(journal.planItems, "implement") === "pending") {
				setPlanStatus(journal.planItems, "implement", "active");
			}
			if (taskMode === "answer") {
				journal.activeSubtask = detailWithPrefix(detail, "Use the inspected context to answer directly");
				journal.nextAction = "Answer directly from the inspected evidence and stop";
				journal.plannedNextStep = "Answer directly from the inspected evidence and stop.";
				journal.stepRationale = "The task is answer-only, so once the relevant local evidence is inspected the run should answer instead of widening into implementation.";
			} else {
				journal.activeSubtask = detail
					? `Turn inspected context into a concrete change: ${detail}`
					: "Turn inspected context into a concrete change";
				journal.nextAction = "Make the next concrete code change";
			}
			journal.completedCheckpoints = uniqueTail(
				[...journal.completedCheckpoints, "relevant files inspected"],
				6,
			);
			break;
		case "implementation_changed":
			setPlanStatus(journal.planItems, "inspect", "completed");
			setPlanStatus(journal.planItems, "implement", "completed");
			if (getPlanStatus(journal.planItems, "verify") !== "completed") {
				setPlanStatus(journal.planItems, "verify", "active");
			}
			journal.activeSubtask = detail ? `Validate the recent change: ${detail}` : "Validate the recent change";
			journal.nextAction = "Run verification on the latest changes";
			journal.completedCheckpoints = uniqueTail(
				[...journal.completedCheckpoints, "workspace changes applied"],
				6,
			);
			break;
		case "mutation_repair_required":
			setPlanStatus(journal.planItems, "inspect", "completed");
			if (getPlanStatus(journal.planItems, "implement") !== "completed") {
				setPlanStatus(journal.planItems, "implement", "active");
			}
			if (getPlanStatus(journal.planItems, "verify") !== "completed") {
				setPlanStatus(journal.planItems, "verify", "pending");
			}
			journal.activeSubtask = detail
				? `Repair the failed change attempt: ${detail}`
				: "Repair the failed change attempt";
			journal.nextAction = detail
				? `Retry one valid edit on the same target: ${detail}`
				: "Retry one valid edit on the same target";
			journal.plannedNextStep = journal.nextAction;
			journal.stepRationale = "The previous edit did not apply, so recover on the same target instead of widening scope.";
			break;
		case "verification_required":
			if (getPlanStatus(journal.planItems, "verify") !== "completed") {
				setPlanStatus(journal.planItems, "verify", "active");
			}
			journal.activeSubtask = detail ? `Verify the latest change: ${detail}` : "Verify the latest changes";
			journal.nextAction = "Run verification on the latest changes";
			break;
		case "verification_failed": {
			setPlanStatus(journal.planItems, "verify", "blocked");
			const blocker = detail ? `failed verification: ${detail}` : "failed verification";
			journal.blockedReasons = uniqueTail([...journal.blockedReasons, blocker], 4);
			journal.activeSubtask = detail ? `Resolve verification failure: ${detail}` : "Resolve verification failure";
			journal.nextAction = detail ? `Resolve blocker: ${blocker}` : "Resolve blocker and rerun verification";
			journal.plannedNextStep = journal.nextAction;
			journal.stepRationale = "Verification failed, so the run must repair the issue before it can safely finish.";
			journal.expectedVerification = detail;
			break;
		}
		case "verification_passed":
			setPlanStatus(journal.planItems, "verify", "completed");
			setPlanStatus(journal.planItems, "summarize", "active");
			journal.blockedReasons = journal.blockedReasons.filter((reason) => !reason.startsWith("failed verification"));
			journal.activeSubtask = "Finalize and report verified completion";
			journal.nextAction = "Stop and present the verified result";
			journal.plannedNextStep = "Summarize the verified result and note any residual risks.";
			journal.stepRationale = "Verification is satisfied, so the remaining work is reporting clearly and stopping.";
			journal.expectedVerification = detail;
			if (detail) {
				journal.completedCheckpoints = uniqueTail(
					[...journal.completedCheckpoints, `verification passed: ${detail}`],
					6,
				);
			}
			break;
		case "summarize_ready":
			setPlanStatus(journal.planItems, "summarize", "active");
			journal.activeSubtask = "Finalize and report verified completion";
			journal.nextAction = "Stop and present the verified result";
			journal.plannedNextStep = "Summarize the verified result and note any residual risks.";
			journal.stepRationale = "Verification is satisfied, so the remaining work is reporting clearly and stopping.";
			journal.expectedVerification = detail;
			break;
		case "intent_set":
			journal.plannedNextStep = normalizeSnippet(event.plannedNextStep, 180);
			journal.stepRationale = normalizeSnippet(event.stepRationale, 180);
			journal.expectedVerification = normalizeSnippet(event.expectedVerification, 180);
			journal.intentStatus = "pending";
			journal.lastIntentOutcome = undefined;
			break;
		case "intent_assessed":
			journal.intentStatus = event.outcome;
			journal.lastIntentOutcome = normalizeSnippet(event.detail, 180);
			break;
		case "completion_confirmed":
			setPlanStatus(journal.planItems, "summarize", "completed");
			journal.activeSubtask =
				taskMode === "answer" ? "Finalize and present the answer clearly" : "Finalize and report verified completion";
			journal.nextAction =
				taskMode === "answer" ? "Stop after presenting the direct answer" : "Stop and present the verified result";
			journal.plannedNextStep =
				taskMode === "answer"
					? "Present the direct answer clearly, note any important caveats, and stop."
					: "Summarize the verified result and note any residual risks.";
			journal.stepRationale =
				taskMode === "answer"
					? "The task already has enough evidence for a direct answer, so the remaining work is to present it clearly and stop."
					: "Verification is satisfied, so the remaining work is reporting clearly and stopping.";
			break;
		case "run_error":
			journal.blockedReasons = uniqueTail(
				[...journal.blockedReasons, detail ?? "last autonomous turn ended in error"],
				4,
			);
			journal.activeSubtask = "Recover from the latest autonomous error";
			journal.nextAction = "Resolve blocker and continue";
			break;
		case "budget_exhausted":
			journal.blockedReasons = uniqueTail(
				[...journal.blockedReasons, "autonomous budget limit reached"],
				4,
			);
			journal.nextAction = "Resume with a larger budget or a smaller task slice";
			break;
		case "nudge_stop":
			journal.blockedReasons = uniqueTail(
				[...journal.blockedReasons, "nudge engine stopped the run"],
				4,
			);
			journal.nextAction = "Review the stalled run before resuming";
			break;
	}
	return {
		...current,
		taskJournal: journal,
	};
}

function cloneTaskJournal(journal: AutonomousTaskJournal): AutonomousTaskJournal {
	return {
		activeSubtask: journal.activeSubtask,
		nextAction: journal.nextAction,
		plannedNextStep: journal.plannedNextStep,
		stepRationale: journal.stepRationale,
		expectedVerification: journal.expectedVerification,
		intentStatus: journal.intentStatus,
		lastIntentOutcome: journal.lastIntentOutcome,
		planItems: journal.planItems.map((item) => ({ ...item })),
		completedCheckpoints: [...journal.completedCheckpoints],
		blockedReasons: [...journal.blockedReasons],
	};
}

function getPlanStatus(planItems: AutonomousPlanItem[], key: AutonomousPlanItem["key"]): AutonomousPlanItem["status"] {
	return planItems.find((item) => item.key === key)?.status ?? "pending";
}

function setPlanStatus(
	planItems: AutonomousPlanItem[],
	key: AutonomousPlanItem["key"],
	status: AutonomousPlanItem["status"],
): void {
	const target = planItems.find((item) => item.key === key);
	if (target) {
		target.status = status;
	}
}

function derivePlanItems(options: {
	taskMode: AutonomousTaskMode;
	status: AutonomousRunLedger["status"];
	readFiles: string[];
	touchedFiles: string[];
	verificationSatisfied: boolean;
	verificationFailures: string[];
}): AutonomousPlanItem[] {
	const inspected = options.readFiles.length > 0 || options.touchedFiles.length > 0;
	const implemented = options.touchedFiles.length > 0;
	const hasVerifyFailure = options.verificationFailures.length > 0 && !options.verificationSatisfied;
	if (options.taskMode === "answer") {
		return [
			{
				key: "inspect",
				title: "Inspect relevant evidence",
				status: inspected ? "completed" : "active",
			},
			{
				key: "implement",
				title: "Compose direct answer",
				status: options.status === "complete" ? "completed" : inspected ? "active" : "pending",
			},
			{
				key: "verify",
				title: "Confirm supporting evidence",
				status: hasVerifyFailure ? "blocked" : "completed",
			},
			{
				key: "summarize",
				title: "Deliver final answer",
				status: options.status === "complete" ? "completed" : inspected ? "active" : "pending",
			},
		];
	}

	return [
		{
			key: "inspect",
			title: "Inspect relevant files",
			status: inspected ? "completed" : "active",
		},
		{
			key: "implement",
			title: "Apply workspace changes",
			status: implemented ? "completed" : inspected ? "active" : "pending",
		},
		{
			key: "verify",
			title: "Verify latest changes",
			status: options.verificationSatisfied
				? "completed"
				: hasVerifyFailure
					? "blocked"
					: implemented
						? "active"
						: "pending",
		},
		{
			key: "summarize",
			title: "Summarize verified result",
			status:
				options.status === "complete"
					? "completed"
					: options.verificationSatisfied
						? "active"
						: "pending",
		},
	];
}

function createInitialPlanItemsForMode(taskMode: AutonomousTaskMode): AutonomousPlanItem[] {
	if (taskMode === "answer") {
		return [
			{ key: "inspect", title: "Inspect relevant evidence", status: "active" },
			{ key: "implement", title: "Compose direct answer", status: "pending" },
			{ key: "verify", title: "Confirm supporting evidence", status: "completed" },
			{ key: "summarize", title: "Deliver final answer", status: "pending" },
		];
	}
	return [
		{ key: "inspect", title: "Inspect relevant files", status: "active" },
		{ key: "implement", title: "Apply workspace changes", status: "pending" },
		{ key: "verify", title: "Verify latest changes", status: "pending" },
		{ key: "summarize", title: "Summarize verified result", status: "pending" },
	];
}

function classifyAutonomousTaskMode(goal: string): AutonomousTaskMode {
	if (hasAutonomousLocalReferenceContext(goal) && looksLikeAutonomousImplementationTask(goal)) return "implementation";
	if (looksLikeAutonomousResearchTask(goal)) return "research";
	if (looksLikeAutonomousVerifyOnlyTask(goal) || looksLikeAutonomousLocalAnswerTask(goal)) return "answer";
	if (looksLikeAutonomousImplementationTask(goal)) return "implementation";
	return "answer";
}

function createInitialTaskState(taskMode: AutonomousTaskMode): {
	activeSubtask: string;
	nextAction: string;
	plannedNextStep: string;
	stepRationale: string;
} {
	if (taskMode === "research") {
		return {
			activeSubtask: "Inspect the task and gather the first authoritative source",
			nextAction: "Search for the most relevant authoritative source first",
			plannedNextStep: "Search for the most relevant authoritative source first.",
			stepRationale: "The task depends on external evidence, so the run should ground itself before answering.",
		};
	}
	if (taskMode === "answer") {
		return {
			activeSubtask: "Inspect the task and gather only the minimum evidence needed to answer",
			nextAction: "Take one focused inspection step, then answer directly and stop",
			plannedNextStep: "Take one focused inspection step, then answer directly and stop.",
			stepRationale: "This is an answer-first task, so the run should avoid widening into implementation or extra verification once the needed evidence is in hand.",
		};
	}
	return {
		activeSubtask: "Inspect the task and make the first concrete change",
		nextAction: "Inspect the relevant files and choose the first concrete implementation step",
		plannedNextStep: "Inspect the relevant files and choose the first concrete implementation step",
		stepRationale: "The run needs concrete context before changing code.",
	};
}

function detailWithPrefix(detail: string | undefined, prefix: string): string {
	return detail ? `${prefix}: ${detail}` : prefix;
}

function getAutonomousTaskMode(ledger: Pick<AutonomousRunLedger, "taskMode" | "goal">): AutonomousTaskMode {
	return ledger.taskMode ?? classifyAutonomousTaskMode(ledger.goal);
}

function formatVerificationFailure(outcome: ToolOutcome): string | undefined {
	const detail = describeOutcome(outcome);
	const preview = extractVerificationFailurePreview(outcome.metadata);
	if (!detail && !preview) return undefined;
	if (!detail) return `failed verification: ${preview}`;
	if (!preview) return `failed verification: ${detail}`;
	const normalizedDetail = detail.trim().toLowerCase();
	const normalizedPreview = preview.trim().toLowerCase();
	if (normalizedPreview === normalizedDetail || normalizedPreview.includes(normalizedDetail)) {
		return `failed verification: ${preview}`;
	}
	return `failed verification: ${detail} — ${preview}`;
}

function extractVerificationFailurePreview(metadata: Record<string, unknown> | undefined): string | undefined {
	if (!metadata) return undefined;
	const previewCandidates = [metadata.outputPreview, metadata.summary, metadata.error];
	for (const candidate of previewCandidates) {
		if (typeof candidate === "string") {
			const normalized = normalizeSnippet(candidate, 180);
			if (normalized) return normalized;
		}
	}
	return undefined;
}

function isAutonomousRunSnapshot(value: unknown): value is AutonomousRunSnapshot {
	if (typeof value !== "object" || value === null) return false;
	const snapshot = value as Partial<AutonomousRunSnapshot>;
	return (
		snapshot.version === 1 &&
		typeof snapshot.savedAt === "string" &&
		typeof snapshot.phase === "string" &&
		typeof snapshot.stopReason === "string" &&
		typeof snapshot.costSummary === "string" &&
		typeof snapshot.iterations === "number" &&
		typeof snapshot.ledger === "object" &&
		snapshot.ledger !== null &&
		typeof snapshot.ledger.goal === "string"
	);
}

function isMutatingOutcome(outcome: ToolOutcome): boolean {
	return MUTATING_TOOL_NAMES.has(outcome.tool.toLowerCase());
}

function isReadOutcome(outcome: ToolOutcome): boolean {
	return READ_TOOL_NAMES.has(outcome.tool.toLowerCase());
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

function hasExplicitCompletionLikeSignal(text: string): boolean {
	return COMPLETION_PATTERNS.some((pattern) => pattern.test(text));
}

const MUTATING_TOOL_NAMES = new Set(["edit", "write", "str_replace_editor", "notebook_edit"]);
const READ_TOOL_NAMES = new Set(["read", "read_file"]);
const VERIFICATION_TOOL_NAMES = new Set(["verify"]);
const VISUAL_VERIFICATION_TOOL_NAMES = new Set(["screenshot_url", "interact_then_screenshot"]);
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
const COMPLETION_PATTERNS = [
	/\b(task|work|implementation|fix|changes?)\s+(is\s+)?(complete|completed|done|finished)\b/i,
	/\bno\s+(further|more)\s+(changes|work|action)\s+(are\s+)?needed\b/i,
	/\bnothing\s+else\s+to\s+do\b/i,
];
const GENERIC_STATUS_PATTERNS = [
	/\b(task|work)\s+(complete|completed|done|finished)\b/i,
	/\bverified\b/i,
	/\bno\s+further\b/i,
];
const RISK_PATTERNS = [
	/\brisk\b/i,
	/\bremaining\b/i,
	/\bunable\b/i,
	/\bcannot\b/i,
	/\bcan't\b/i,
	/\bcould not\b/i,
	/\bnot verified\b/i,
	/\bnot run\b/i,
	/\bblocked\b/i,
];
