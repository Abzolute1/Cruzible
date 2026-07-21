import type { AgentSessionEvent } from "../../core/agent-session.js";
import type { AutonomousRunSnapshot } from "../../core/auton/ledger.js";
import type { AutonomousRunResult } from "../../core/auton/runner.js";
import type { ActivatedAutonomousWorkspace, PreparedAutonomousWorkspace } from "../../core/auton/workspace.js";
import { classifyRequestFailure } from "../../core/request-failure.js";
import type { RuntimeHealthSnapshot, RuntimeStabilizationProfile } from "../../core/runtime-health.js";
import type { SessionDebugArtifacts } from "../../core/session-debug-logger.js";
import { theme } from "./theme/theme.js";

export type XmlFallbackEvent = Extract<AgentSessionEvent, { type: "xml_tool_call" }>;
export type DegradedTurnEvent = Extract<AgentSessionEvent, { type: "degraded_turn" }>;

export function getAutonomousEvidenceReadyKind(
	result: Pick<AutonomousRunResult, "ledger">,
): "research" | "code" | "visual" | undefined {
	const ledger = result.ledger;
	if (
		ledger.research?.evidence?.status === "sufficient" &&
		ledger.touchedFiles.length === 0 &&
		ledger.recentMutations.length === 0
	) {
		return "research";
	}
	if (
		ledger.visualAssessment?.latestJudgment === "pass" &&
		ledger.visualIteration?.phase === "verified" &&
		ledger.verificationSatisfied
	) {
		return "visual";
	}
	if (ledger.verificationSatisfied && ledger.lastActionType === "verification") {
		return "code";
	}
	return undefined;
}

export function formatRuntimeHealthIssue(event: XmlFallbackEvent | DegradedTurnEvent): string {
	const parts: string[] = [event.severity ?? "normal"];
	if ("outputTokens" in event && typeof event.outputTokens === "number" && event.outputTokens > 0) {
		parts.push(`output=${event.outputTokens}`);
	}
	if (
		"assistantTextLength" in event &&
		typeof event.assistantTextLength === "number" &&
		event.assistantTextLength > 0
	) {
		parts.push(`text=${event.assistantTextLength}`);
	}
	if ("textLength" in event && typeof event.textLength === "number" && event.textLength > 0) {
		parts.push(`text=${event.textLength}`);
	}
	if ("assistantStopReason" in event && event.assistantStopReason) {
		parts.push(`stop=${event.assistantStopReason}`);
	}
	if ("stopReason" in event && event.stopReason) {
		parts.push(`stop=${event.stopReason}`);
	}
	if ("toolName" in event && event.toolName) {
		parts.push(`tool=${event.toolName}`);
	}
	if (event.reasons && event.reasons.length > 0) {
		parts.push(`reasons=${event.reasons.join(",")}`);
	}
	if ("continuationMode" in event && event.continuationMode === "guided") {
		parts.push("guided");
	}
	if ("recoveryHint" in event && event.recoveryHint) {
		parts.push(event.recoveryHint);
	}
	return parts.join(" | ");
}

export function formatRuntimeHealthSummary(state: {
	xmlFallbackCount: number;
	degradedTurnCount: number;
	lastXmlFallbackEvent?: XmlFallbackEvent;
	lastDegradedTurnEvent?: DegradedTurnEvent;
}): string {
	if (
		state.xmlFallbackCount === 0 &&
		state.degradedTurnCount === 0 &&
		!state.lastXmlFallbackEvent &&
		!state.lastDegradedTurnEvent
	) {
		return "";
	}

	let info = `\n\n${theme.bold("Runtime Health")}\n`;
	info += `${theme.fg("dim", "XML Fallbacks:")} ${state.xmlFallbackCount}\n`;
	info += `${theme.fg("dim", "Degraded Turns:")} ${state.degradedTurnCount}\n`;
	if (state.lastDegradedTurnEvent) {
		info += `${theme.fg("dim", "Latest Degraded Turn:")} ${formatRuntimeHealthIssue(state.lastDegradedTurnEvent)}\n`;
	}
	if (state.lastXmlFallbackEvent) {
		info += `${theme.fg("dim", "Latest XML Fallback:")} ${formatRuntimeHealthIssue(state.lastXmlFallbackEvent)}\n`;
	}
	return info;
}

export function formatAutonomousResearchSummary(result: AutonomousRunResult, artifactCount: number): string {
	const research = result.ledger.research;
	if (!research) return "";

	let info = `\n${theme.bold("Autonomous Research")}\n`;
	if (research.evidence) {
		info += `${theme.fg("dim", "Evidence:")} ${research.evidence.status}\n`;
		info += `${theme.fg("dim", "Authoritative Sources:")} ${research.evidence.authoritativeSourceCount}\n`;
		info += `${theme.fg("dim", "Fetched Sources:")} ${research.evidence.fetchedSourceCount}\n`;
		info += `${theme.fg("dim", "Citations Ready:")} ${research.evidence.citedSourceCount}\n`;
		if (research.evidence.gaps.length > 0) {
			info += `${theme.fg("dim", "Evidence Gaps:")} ${research.evidence.gaps.join(" | ")}\n`;
		}
	}
	if (research.searchQueries.length > 0) {
		info += `${theme.fg("dim", "Queries:")} ${research.searchQueries.join(" | ")}\n`;
	}
	if (research.preferredSourceUrls.length > 0) {
		info += `${theme.fg("dim", "Preferred Sources:")} ${research.preferredSourceUrls.join(" | ")}\n`;
	}
	if (research.fetchedUrls.length > 0) {
		info += `${theme.fg("dim", "Fetched:")} ${research.fetchedUrls.join(" | ")}\n`;
	}
	if (research.sourceUrls.length > 0) {
		info += `${theme.fg("dim", "Cited URLs:")} ${research.sourceUrls.join(" | ")}\n`;
	}
	if (research.recentFindings.length > 0) {
		info += `${theme.fg("dim", "Findings:")} ${research.recentFindings.join(" | ")}\n`;
	}
	if (artifactCount > 0) {
		info += `${theme.fg("dim", "Saved Artifacts:")} ${artifactCount}\n`;
	}
	return info;
}

export function formatRuntimeHealthTimelineSummary(snapshots: RuntimeHealthSnapshot[]): string {
	if (snapshots.length === 0) return "";

	let info = `\n\n${theme.bold("Runtime Timeline")}\n`;
	for (const snapshot of snapshots) {
		const detail = snapshot.lastDegradedTurnEvent
			? formatRuntimeHealthIssue(snapshot.lastDegradedTurnEvent)
			: snapshot.lastXmlFallbackEvent
				? formatRuntimeHealthIssue(snapshot.lastXmlFallbackEvent)
				: `xml=${snapshot.xmlFallbackCount} degraded=${snapshot.degradedTurnCount}`;
		info += `${theme.fg("dim", "-")} ${snapshot.savedAt}${snapshot.modelId ? ` [${snapshot.modelId}]` : ""}: ${detail}\n`;
	}
	return info;
}

export function formatDebugArtifactsSummary(artifacts: SessionDebugArtifacts | undefined): string {
	if (!artifacts?.sessionDir) return "";

	let info = `\n\n${theme.bold("Debug Artifacts")}\n`;
	info += `${theme.fg("dim", "Session Dir:")} ${artifacts.sessionDir}\n`;
	if (artifacts.sessionMd) {
		info += `${theme.fg("dim", "Session Log:")} ${artifacts.sessionMd}\n`;
	}
	if (artifacts.sessionCompactMd) {
		info += `${theme.fg("dim", "Compact Log:")} ${artifacts.sessionCompactMd}\n`;
	}
	if (artifacts.timelineJson) {
		info += `${theme.fg("dim", "Timeline:")} ${artifacts.timelineJson}\n`;
	}
	return info;
}

export function formatRuntimeRecoverySummary(state: {
	lastDegradedTurnEvent?: DegradedTurnEvent;
	lastXmlFallbackEvent?: XmlFallbackEvent;
	lastAutonomousRunResult?: AutonomousRunResult;
	hasDebugArtifacts: boolean;
}): string {
	const actions: string[] = [];
	const degraded = state.lastDegradedTurnEvent;
	const xmlFallback = state.lastXmlFallbackEvent;
	const criticalDegradation =
		degraded?.severity === "critical" ||
		xmlFallback?.severity === "critical" ||
		(state.lastAutonomousRunResult?.checkpointState.consecutiveCriticalDegradedTurnCount ?? 0) > 0;

	if (!degraded && !xmlFallback && !criticalDegradation) return "";

	if (degraded) {
		actions.push("/compact to reduce transcript pressure before retrying");
		actions.push("retry with a narrower prompt that asks for the next smallest concrete step only");
	}
	if (xmlFallback) {
		actions.push("switch models if the current model keeps degrading into XML fallback");
		actions.push("/debug to capture the rendered state plus session artifact paths");
	}
	if (criticalDegradation) {
		actions.push("avoid long narrative replies and prefer tool-driven continuation");
	}
	if (state.hasDebugArtifacts) {
		actions.push("/session to inspect the live runtime-health and debug artifact paths");
	}
	if (actions.length === 0) return "";

	let info = `\n\n${theme.bold("Runtime Recovery")}\n`;
	for (const action of Array.from(new Set(actions))) {
		info += `${theme.fg("dim", "-")} ${action}\n`;
	}
	return info;
}

export function formatAutonomousStabilizationSummary(profile: RuntimeStabilizationProfile): string {
	if (profile.level === "none") return "";

	let info = `\n\n${theme.bold("Autonomous Stabilization")}\n`;
	info += `${theme.fg("dim", "Level:")} ${profile.level}\n`;
	if (profile.recommendedMaxOutputPerTurn) {
		info += `${theme.fg("dim", "Output Cap:")} ${profile.recommendedMaxOutputPerTurn.toLocaleString()}\n`;
	}
	if (profile.reasons.length > 0) {
		info += `${theme.fg("dim", "Reasons:")} ${profile.reasons.join(" | ")}\n`;
	}
	return info;
}

export function formatAutonomousControlSummary(result: AutonomousRunResult): string {
	const state = result.checkpointState;
	const ledger = result.ledger;
	const blockedStop = ledger.taskJournal.blockedReasons.find((reason) =>
		reason.startsWith("Autonomous run stopped after"),
	);
	const controlState = blockedStop
		? "blocked stop"
		: (state.consecutiveCriticalDegradedTurnCount ?? 0) > 0 || (state.consecutiveDegradedTurnCount ?? 0) > 0
			? "stabilizing degraded turn"
			: state.narrowScopePromptCount > 0
				? "scope narrowed"
				: state.replanPromptCount > 0
					? "replanned"
					: ledger.taskJournal.intentStatus === "failed"
						? "recovering blocker"
						: ledger.taskJournal.intentStatus === "drifted"
							? "drifted"
							: "on track";

	let info = `\n${theme.bold("Autonomous Control")}\n`;
	info += `${theme.fg("dim", "State:")} ${controlState}\n`;
	if (ledger.planner) {
		info += `${theme.fg("dim", "Planner Phase:")} ${ledger.planner.phase}\n`;
		info += `${theme.fg("dim", "Planner Lane:")} ${ledger.planner.lane}\n`;
		info += `${theme.fg("dim", "Plan Revision:")} ${ledger.planner.planRevision}\n`;
		info += `${theme.fg("dim", "Execution Attempts:")} ${ledger.planner.executionAttempts}\n`;
		info += `${theme.fg("dim", "Planner Handoff:")} ${ledger.planner.handoffSummary}\n`;
	}
	if (ledger.resume) {
		info += `${theme.fg("dim", "Resume Mode:")} ${ledger.resume.mode}\n`;
		info += `${theme.fg("dim", "Resume Instruction:")} ${ledger.resume.resumeInstruction}\n`;
		info += `${theme.fg("dim", "Resume Reason:")} ${ledger.resume.resumeReason}\n`;
		if (ledger.resume.lastStableCheckpoint) {
			info += `${theme.fg("dim", "Stable Checkpoint:")} ${ledger.resume.lastStableCheckpoint}\n`;
		}
	}
	if (ledger.taskJournal.intentStatus) {
		info += `${theme.fg("dim", "Intent Status:")} ${ledger.taskJournal.intentStatus}\n`;
	}
	if (ledger.taskJournal.lastIntentOutcome) {
		info += `${theme.fg("dim", "Intent Outcome:")} ${ledger.taskJournal.lastIntentOutcome}\n`;
	}
	const evidenceReady = getAutonomousEvidenceReadyKind(result);
	const verifier =
		state.lastVerificationDetail ??
		ledger.lastVerificationDetail ??
		ledger.taskJournal.expectedVerification ??
		"not recorded";
	const nextAllowedAction =
		ledger.taskJournal.plannedNextStep ?? ledger.taskJournal.nextAction ?? ledger.currentFocus ?? "not recorded";
	info += `${theme.fg("dim", "Evidence Ready:")} ${evidenceReady ? `yes (${evidenceReady})` : "no"}\n`;
	info += `${theme.fg("dim", "Budget Pressure:")} ${state.budgetPressureLevel}\n`;
	info += `${theme.fg("dim", "Verification:")} ${state.verificationSatisfied ? `satisfied (${verifier})` : `pending (${verifier})`}\n`;
	info += `${theme.fg("dim", "Next Allowed Action:")} ${nextAllowedAction}\n`;
	info += `${theme.fg("dim", "Intent Drift Count:")} ${state.consecutiveIntentDriftCount}\n`;
	info += `${theme.fg("dim", "Intent Failure Count:")} ${state.consecutiveIntentFailureCount}\n`;
	info += `${theme.fg("dim", "Replans Issued:")} ${state.replanPromptCount}\n`;
	info += `${theme.fg("dim", "Scope Narrows:")} ${state.narrowScopePromptCount}\n`;
	info += `${theme.fg("dim", "Degraded Turns:")} ${state.consecutiveDegradedTurnCount ?? 0}\n`;
	info += `${theme.fg("dim", "Critical Degraded Turns:")} ${state.consecutiveCriticalDegradedTurnCount ?? 0}\n`;
	if (state.lastDegradedTurnSeverity) {
		info += `${theme.fg("dim", "Latest Degraded Severity:")} ${state.lastDegradedTurnSeverity}\n`;
	}
	if (state.lastDegradedTurnReasons && state.lastDegradedTurnReasons.length > 0) {
		info += `${theme.fg("dim", "Latest Degraded Reasons:")} ${state.lastDegradedTurnReasons.join(" | ")}\n`;
	}
	if (blockedStop) {
		info += `${theme.fg("dim", "Blocked Stop:")} ${blockedStop}\n`;
	}
	return info;
}

export function formatVisualActionRecipeSummary(
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
	if (!steps || steps.length === 0) return undefined;
	return steps
		.map((step) => {
			switch (step.type) {
				case "click":
					return `click ${step.selector ?? step.targetHint ?? "the target control"}`;
				case "fill":
					return `fill ${step.selector ?? step.targetHint ?? "the input"}`;
				case "wait":
					return `wait ${step.ms ?? 500}ms`;
				case "navigate":
					return `navigate to ${step.url ?? step.urlHint ?? "the target page"}`;
			}
			// step.type is a closed union, so this is unreachable; it keeps the map callback total.
			return "";
		})
		.join(" -> ");
}

export function formatAutonomousVisualSummary(result: AutonomousRunResult): string {
	const visualTarget = result.ledger.visualTarget;
	const visualAssessment = result.ledger.visualAssessment;
	const visualIteration = result.ledger.visualIteration;
	if (!visualTarget && !visualAssessment && !visualIteration) return "";

	let info = `\n${theme.bold("Autonomous Visual")}\n`;
	if (visualTarget?.goalSummary) {
		info += `${theme.fg("dim", "Target:")} ${visualTarget.goalSummary}\n`;
	}
	if (visualTarget?.surface) {
		info += `${theme.fg("dim", "Surface:")} ${visualTarget.surface}\n`;
	}
	if (visualTarget?.viewportHint) {
		info += `${theme.fg("dim", "Viewport:")} ${visualTarget.viewportHint}\n`;
	}
	if (visualTarget?.interactionMode) {
		info += `${theme.fg("dim", "Interaction:")} ${visualTarget.interactionMode}\n`;
	}
	if (visualTarget?.recommendedTool) {
		info += `${theme.fg("dim", "Tool:")} ${visualTarget.recommendedTool}\n`;
	}
	if (visualTarget?.interactionHint) {
		info += `${theme.fg("dim", "Flow:")} ${visualTarget.interactionHint}\n`;
	}
	const recipeSummary = formatVisualActionRecipeSummary(visualTarget?.actionRecipe);
	if (recipeSummary) {
		info += `${theme.fg("dim", "Recipe:")} ${recipeSummary}\n`;
	}
	if (visualTarget && visualTarget.acceptanceCriteria.length > 0) {
		info += `${theme.fg("dim", "Acceptance:")} ${visualTarget.acceptanceCriteria.join(" | ")}\n`;
	}
	if (visualIteration?.enabled) {
		info += `${theme.fg("dim", "Phase:")} ${visualIteration.phase}\n`;
	}
	if (visualAssessment) {
		info += `${theme.fg("dim", "Assessment:")} ${visualAssessment.latestJudgment}\n`;
		info += `${theme.fg("dim", "Summary:")} ${visualAssessment.summary}\n`;
		if (visualAssessment.blockingIssues.length > 0) {
			info += `${theme.fg("dim", "Blockers:")} ${visualAssessment.blockingIssues.join(" | ")}\n`;
		}
	}
	return info;
}

export function getAutonomousRecoveryActions(
	result: AutonomousRunResult,
	workspace: PreparedAutonomousWorkspace | ActivatedAutonomousWorkspace | undefined,
): string[] {
	const actions: string[] = [];
	const blockedStop = result.ledger.taskJournal.blockedReasons.find((reason) =>
		reason.startsWith("Autonomous run stopped after"),
	);
	const shouldSuggestRecovery =
		result.stopReason === "error" ||
		blockedStop !== undefined ||
		result.checkpointState.narrowScopePromptCount > 0 ||
		result.checkpointState.replanPromptCount > 0;

	if (!shouldSuggestRecovery) return actions;

	actions.push("/session to inspect the latest autonomous control state");
	if (workspace) {
		actions.push("/workspace diff to inspect the preserved sandbox changes");
		actions.push("/workspace promote to apply the preserved sandbox changes when they are acceptable");
	}
	if (result.ledger.visualTarget?.recommendedTool) {
		const flow = result.ledger.visualTarget.interactionHint;
		const recipe = formatVisualActionRecipeSummary(result.ledger.visualTarget.actionRecipe);
		actions.push(
			flow
				? `rerun visual verification with ${result.ledger.visualTarget.recommendedTool} and the recorded flow: ${flow}`
				: `rerun visual verification with ${result.ledger.visualTarget.recommendedTool}`,
		);
		if (recipe) {
			actions.push(`follow the recorded visual recipe: ${recipe}`);
		}
	}
	if (result.ledger.taskJournal.expectedVerification) {
		actions.push(
			`rerun autonomy with a narrower prompt that ends by verifying with ${result.ledger.taskJournal.expectedVerification}`,
		);
	} else if (result.ledger.taskJournal.plannedNextStep) {
		actions.push(`rerun autonomy with a narrower prompt focused on: ${result.ledger.taskJournal.plannedNextStep}`);
	}
	return actions;
}

export function formatAutonomousRecoverySummary(
	result: AutonomousRunResult,
	workspace: PreparedAutonomousWorkspace | ActivatedAutonomousWorkspace | undefined,
): string {
	const actions = getAutonomousRecoveryActions(result, workspace);
	if (actions.length === 0) return "";
	let info = `\n${theme.bold("Autonomous Recovery")}\n`;
	for (const action of actions) {
		info += `${theme.fg("dim", "-")} ${action}\n`;
	}
	return info;
}

export function getAutonomousControlStateFromSnapshot(
	snapshot: Pick<AutonomousRunSnapshot, "checkpointState" | "ledger" | "phase" | "stopReason">,
): string {
	const state = snapshot.checkpointState;
	const ledger = snapshot.ledger;
	const blockedStop = ledger.taskJournal.blockedReasons.find((reason) =>
		reason.startsWith("Autonomous run stopped after"),
	);
	if (blockedStop || snapshot.stopReason === "error") return "blocked stop";
	if ((state.consecutiveCriticalDegradedTurnCount ?? 0) > 0 || (state.consecutiveDegradedTurnCount ?? 0) > 0) {
		return "stabilizing degraded turn";
	}
	if (
		ledger.taskJournal.plannedNextStep?.includes("webSearch") ||
		ledger.taskJournal.plannedNextStep?.includes("webFetch")
	) {
		return "researching sources";
	}
	if (ledger.planner?.phase === "summarizing" && ledger.research?.evidence?.status === "sufficient") {
		return "synthesizing evidence";
	}
	if (ledger.planner?.phase === "summarizing" && getAutonomousEvidenceReadyKind({ ledger })) {
		return "verified slice ready";
	}
	if (ledger.resume?.mode === "resume_verify") return "resuming verification";
	if (ledger.resume?.mode === "resume_repair") return "resuming repair";
	if (ledger.visualAssessment?.latestJudgment === "fail") return "visual blocker";
	if (ledger.visualIteration?.phase === "recapture") return "visual recapture";
	if (
		state.narrowScopePromptCount > 0 &&
		ledger.taskJournal.plannedNextStep?.startsWith("Define the smallest verifiable slice")
	) {
		return "scope narrowed";
	}
	if (
		state.replanPromptCount > 0 &&
		ledger.taskJournal.plannedNextStep?.startsWith("Replan into 1-2 concrete steps")
	) {
		return "replanned";
	}
	if (ledger.taskJournal.intentStatus === "failed") return "recovering blocker";
	if (ledger.taskJournal.intentStatus === "drifted") return "drifted";
	if (snapshot.phase === "final" && snapshot.stopReason === "complete") return "verified complete";
	return "working";
}

export function formatAutonomousCheckpointStatus(snapshot: AutonomousRunSnapshot): string {
	const controlState = getAutonomousControlStateFromSnapshot(snapshot);
	const flowDetail =
		snapshot.ledger.visualTarget?.interactionHint ??
		formatVisualActionRecipeSummary(snapshot.ledger.visualTarget?.actionRecipe);
	const detail =
		controlState === "blocked stop"
			? (snapshot.ledger.taskJournal.blockedReasons.find((reason) =>
					reason.startsWith("Autonomous run stopped after"),
				) ?? snapshot.ledger.taskJournal.lastIntentOutcome)
			: controlState === "stabilizing degraded turn"
				? (snapshot.checkpointState.lastDegradedTurnReasons?.[0] ??
					snapshot.ledger.taskJournal.plannedNextStep ??
					snapshot.ledger.taskJournal.lastIntentOutcome)
				: controlState === "visual blocker"
					? (snapshot.ledger.visualAssessment?.blockingIssues[0] ??
						flowDetail ??
						snapshot.ledger.visualAssessment?.summary)
					: controlState === "visual recapture"
						? snapshot.ledger.visualTarget?.surface
							? `recapturing ${snapshot.ledger.visualTarget.surface}${flowDetail ? ` after ${flowDetail}` : ""}`
							: (flowDetail ?? snapshot.ledger.taskJournal.plannedNextStep)
						: controlState === "researching sources"
							? (snapshot.ledger.research?.preferredSourceUrls[0] ??
								snapshot.ledger.research?.fetchedUrls[0] ??
								snapshot.ledger.research?.searchQueries[0] ??
								snapshot.ledger.taskJournal.plannedNextStep)
							: controlState === "verified slice ready"
								? (snapshot.ledger.taskJournal.plannedNextStep ??
									snapshot.ledger.lastVerificationDetail ??
									snapshot.ledger.visualAssessment?.summary)
								: controlState === "replanned" || controlState === "scope narrowed"
									? snapshot.ledger.taskJournal.plannedNextStep
									: (snapshot.ledger.taskJournal.lastIntentOutcome ??
										snapshot.ledger.taskJournal.plannedNextStep);
	return `Autonomous: ${controlState} | turn ${snapshot.iterations}${detail ? ` | ${detail}` : ""}`;
}

export function formatXmlFallbackWarning(event: XmlFallbackEvent): string | undefined {
	if (!event.severity || event.severity === "normal") return undefined;
	const parts = [`XML fallback ${event.severity}`];
	if (event.toolName) parts.push(`tool=${event.toolName}`);
	if (typeof event.callCount === "number" && event.callCount > 1) parts.push(`calls=${event.callCount}`);
	if (typeof event.assistantTextLength === "number") parts.push(`text=${event.assistantTextLength} chars`);
	if (event.assistantStopReason) parts.push(`stop=${event.assistantStopReason}`);
	if (event.continuationMode === "guided") parts.push("guided recovery enabled");
	if (event.reasons && event.reasons.length > 0) parts.push(`reasons=${event.reasons.join(",")}`);
	return parts.join(" | ");
}

export function formatDegradedTurnWarning(event: DegradedTurnEvent): string | undefined {
	if (!event.severity || event.severity === "normal") return undefined;
	const parts = [`Turn degraded ${event.severity}`];
	if (typeof event.outputTokens === "number" && event.outputTokens > 0) {
		parts.push(`output=${event.outputTokens}`);
	}
	if (typeof event.textLength === "number" && event.textLength > 0) {
		parts.push(`text=${event.textLength} chars`);
	}
	if (event.stopReason) {
		parts.push(`stop=${event.stopReason}`);
	}
	if (event.reasons && event.reasons.length > 0) {
		parts.push(`reasons=${event.reasons.join(",")}`);
	}
	if (event.recoveryHint) {
		parts.push(event.recoveryHint);
	}
	return parts.join(" | ");
}

export function formatRequestFailureWarning(message: { provider?: string; errorMessage?: string }): string | undefined {
	const failure = classifyRequestFailure(message);
	if (!failure) return undefined;
	return `${failure.message} | ${failure.recoveryHint}`;
}
