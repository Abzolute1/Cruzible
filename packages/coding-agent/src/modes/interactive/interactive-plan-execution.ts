import type { ImageContent } from "@ag1/ai";
import { type Container, Spacer, type TUI } from "@ag1/tui";
import type { AgentSession } from "../../core/agent-session.js";
import type { RuntimeStabilizationProfile } from "../../core/runtime-health.js";
import type { SessionManager } from "../../core/session-manager.js";
import { PlanReviewCardComponent } from "./components/plan-review-card.js";
import { buildPlanningGuidanceMessage } from "./interactive-autonomous-stabilization.js";
import {
	buildFallbackInteractivePlanArtifact,
	buildInteractivePlanArtifactFromSubmission,
	buildPlanClarificationPrompt,
	buildPlanExecutionPrompt,
	buildPlanRevisionPrompt,
	buildPlanStepExecutionPrompt,
	createInteractivePlanArtifactRef,
	extractInteractivePlanArtifact,
	getCompletedStepIndexes,
	getLatestInteractivePlanStepExecutionRecord,
	getNextInteractivePlanStepIndex,
	INTERACTIVE_PLAN_ARTIFACT_TYPE,
	type InteractivePlanArtifact,
	type InteractivePlanSelection,
	markInteractivePlanStepComplete,
	recordInteractivePlanStepExecutionReview,
	reopenInteractivePlanStep,
	type SubmitPlanSubmission,
	updateInteractivePlanArtifactStatus,
} from "./interactive-plan-artifacts.js";

/** Tools hidden from the model during planning turns (mutations are blocked at dispatch too). */
const PLANNING_HIDDEN_TOOLS = new Set(["write", "edit", "notebook_edit"]);
/** Planning-only tool, activated for planning turns and deactivated afterwards. */
export const SUBMIT_PLAN_TOOL_NAME = "submit_plan";

export type ShowPlanArtifactCardFn = (artifact: InteractivePlanArtifact, options?: { expanded?: boolean }) => void;

export interface RunPlanningPromptOptions {
	goal?: string;
	previousArtifact?: InteractivePlanArtifact;
	feedback?: string;
	images?: ImageContent[];
	hiddenPromptAddendum?: string;
}

export type RunPlanningPromptFn = (promptBody: string, options?: RunPlanningPromptOptions) => Promise<void>;

export interface ShowPlanArtifactCardDeps {
	chatContainer: Container;
	ui: TUI;
}

export function showPlanArtifactCard(
	deps: ShowPlanArtifactCardDeps,
	artifact: InteractivePlanArtifact,
	options?: { expanded?: boolean },
): void {
	deps.chatContainer.addChild(new Spacer(1));
	deps.chatContainer.addChild(new PlanReviewCardComponent(artifact, options));
	deps.ui.requestRender();
}

export interface PlanningRerunDeps {
	setExecutionMode: (mode: "interactive" | "planning" | "autonomous") => void;
	runPlanningPrompt: RunPlanningPromptFn;
}

export async function revisePlanArtifact(
	deps: PlanningRerunDeps,
	artifact: InteractivePlanArtifact,
	feedback: string,
): Promise<void> {
	deps.setExecutionMode("planning");
	await deps.runPlanningPrompt(`Revise plan v${artifact.revision} for: ${artifact.goal}`, {
		goal: artifact.goal,
		previousArtifact: artifact,
		feedback,
		hiddenPromptAddendum: buildPlanRevisionPrompt(artifact, feedback),
	});
}

export interface RejectPlanArtifactDeps {
	sessionManager: SessionManager;
	clearPlanSelectionForArtifact: (artifact: InteractivePlanArtifact) => void;
	updatePendingMessagesDisplay: () => void;
	updateModeDisplay: () => void;
	showPlanArtifactCard: ShowPlanArtifactCardFn;
	showStatus: (message: string) => void;
}

export async function rejectPlanArtifact(
	deps: RejectPlanArtifactDeps,
	artifact: InteractivePlanArtifact,
	reason: string,
): Promise<void> {
	const rejectedArtifact = updateInteractivePlanArtifactStatus(artifact, "rejected", undefined, {
		rejectedReason: reason.trim() || undefined,
	});
	deps.sessionManager.appendCustomEntry(INTERACTIVE_PLAN_ARTIFACT_TYPE, rejectedArtifact);
	deps.clearPlanSelectionForArtifact(artifact);
	deps.updatePendingMessagesDisplay();
	deps.updateModeDisplay();
	deps.showPlanArtifactCard(rejectedArtifact);
	deps.showStatus(`Rejected plan v${artifact.revision}.`);
}

export async function answerClarifyingPlanArtifact(
	deps: PlanningRerunDeps,
	artifact: InteractivePlanArtifact,
	answer: string,
): Promise<void> {
	deps.setExecutionMode("planning");
	await deps.runPlanningPrompt(`Continue planning with the saved clarification answers for: ${artifact.goal}`, {
		goal: artifact.goal,
		previousArtifact: artifact,
		hiddenPromptAddendum: buildPlanClarificationPrompt(artifact, answer),
	});
}

export interface ExecutePlanArtifactDeps {
	sessionManager: SessionManager;
	getLatestPlanSelection: () => InteractivePlanSelection | undefined;
	appendPlanSelection: (updates: Partial<InteractivePlanSelection>) => void;
	setExecutionMode: (mode: "interactive" | "planning" | "autonomous") => void;
	ensurePreferredModeModel: (mode: "planning" | "execution") => Promise<void>;
	clearPendingRuntimePromptAddendum: () => void;
	updatePendingMessagesDisplay: () => void;
	updateModeDisplay: () => void;
	showPlanArtifactCard: ShowPlanArtifactCardFn;
	session: AgentSession;
	buildInteractiveUserMessage: (userMessage: string) => string;
	persistPlanExecutionReview: (artifact: InteractivePlanArtifact, stepIndex: number) => void;
	showWarning: (message: string) => void;
}

export async function executePlanArtifact(
	deps: ExecutePlanArtifactDeps,
	artifact: InteractivePlanArtifact,
	stepIndex?: number,
): Promise<void> {
	const activeStepIndex = stepIndex ?? getNextInteractivePlanStepIndex(artifact);
	if (activeStepIndex === undefined || !artifact.steps[activeStepIndex]) {
		deps.showWarning(`Plan v${artifact.revision} has no remaining steps to execute.`);
		return;
	}
	const executingArtifact = updateInteractivePlanArtifactStatus(artifact, "executing", undefined, {
		completedStepIndexes: getCompletedStepIndexes(artifact),
		executionStepIndex: activeStepIndex,
		executionStep: artifact.steps[activeStepIndex],
	});
	deps.sessionManager.appendCustomEntry(INTERACTIVE_PLAN_ARTIFACT_TYPE, executingArtifact);
	const latestSelection = deps.getLatestPlanSelection();
	deps.appendPlanSelection({
		planning: undefined,
		accepted: artifact.status === "accepted" ? createInteractivePlanArtifactRef(artifact) : latestSelection?.accepted,
		executing: createInteractivePlanArtifactRef(executingArtifact),
	});
	deps.setExecutionMode("interactive");
	await deps.ensurePreferredModeModel("execution");
	deps.clearPendingRuntimePromptAddendum();
	deps.updatePendingMessagesDisplay();
	deps.updateModeDisplay();
	deps.showPlanArtifactCard(executingArtifact);
	await deps.session.prompt(
		deps.buildInteractiveUserMessage(
			stepIndex === undefined
				? buildPlanExecutionPrompt(executingArtifact)
				: buildPlanStepExecutionPrompt(executingArtifact, stepIndex),
		),
	);
	deps.persistPlanExecutionReview(executingArtifact, activeStepIndex);
}

export interface PersistPlanExecutionReviewDeps {
	session: AgentSession;
	sessionManager: SessionManager;
	updatePendingMessagesDisplay: () => void;
	updateModeDisplay: () => void;
	showPlanArtifactCard: ShowPlanArtifactCardFn;
	showStatus: (message: string) => void;
	showWarning: (message: string) => void;
}

export function persistPlanExecutionReview(
	deps: PersistPlanExecutionReviewDeps,
	artifact: InteractivePlanArtifact,
	stepIndex: number,
): void {
	const assistantText = deps.session.getLastAssistantText()?.trim();
	if (!assistantText) return;
	const reviewedArtifact = recordInteractivePlanStepExecutionReview(artifact, stepIndex, assistantText);
	if (reviewedArtifact === artifact) {
		deps.showWarning(
			"Execution output did not include a valid structured review. Expected at least the headings: Execution Status, Execution Summary.",
		);
		return;
	}
	const latestReview = getLatestInteractivePlanStepExecutionRecord(reviewedArtifact, stepIndex);
	if (!latestReview) return;
	deps.sessionManager.appendCustomEntry(INTERACTIVE_PLAN_ARTIFACT_TYPE, reviewedArtifact);
	deps.updatePendingMessagesDisplay();
	deps.updateModeDisplay();
	deps.showPlanArtifactCard(reviewedArtifact);
	deps.showStatus(
		reviewedArtifact.status === "completed"
			? `Plan v${artifact.revision} is fully complete — all ${reviewedArtifact.steps.length} steps done.`
			: `Recorded review for step ${stepIndex + 1} of plan v${artifact.revision}: ${latestReview.status}.`,
	);
}

export function getPlanStepSelectorOptions(
	artifact: InteractivePlanArtifact,
	mode: "all" | "remaining" | "completed",
): string[] {
	const completed = new Set(getCompletedStepIndexes(artifact));
	return artifact.steps
		.map((step, index) => ({ step, index }))
		.filter(({ index }) => {
			if (mode === "all") return true;
			if (mode === "remaining") return !completed.has(index);
			return completed.has(index);
		})
		.map(({ step, index }) => `${index + 1}. ${step}`);
}

export interface PlanStepMutationDeps {
	sessionManager: SessionManager;
	appendPlanSelection: (updates: Partial<InteractivePlanSelection>) => void;
	updatePendingMessagesDisplay: () => void;
	updateModeDisplay: () => void;
	showPlanArtifactCard: ShowPlanArtifactCardFn;
	showStatus: (message: string) => void;
	showWarning: (message: string) => void;
}

export async function markPlanStepComplete(
	deps: PlanStepMutationDeps,
	artifact: InteractivePlanArtifact,
	stepIndex: number,
): Promise<void> {
	if (!artifact.steps[stepIndex]) {
		deps.showWarning(`Plan v${artifact.revision} has no step ${stepIndex + 1}.`);
		return;
	}
	const updatedArtifact = markInteractivePlanStepComplete(artifact, stepIndex);
	deps.sessionManager.appendCustomEntry(INTERACTIVE_PLAN_ARTIFACT_TYPE, updatedArtifact);
	deps.appendPlanSelection({
		accepted: createInteractivePlanArtifactRef(updatedArtifact),
		executing: undefined,
	});
	deps.updatePendingMessagesDisplay();
	deps.updateModeDisplay();
	deps.showPlanArtifactCard(updatedArtifact);
	deps.showStatus(
		updatedArtifact.status === "completed"
			? `Plan v${artifact.revision} is fully complete — all ${updatedArtifact.steps.length} steps done.`
			: `Marked step ${stepIndex + 1} complete for plan v${artifact.revision}.`,
	);
}

export async function reopenPlanStep(
	deps: PlanStepMutationDeps,
	artifact: InteractivePlanArtifact,
	stepIndex: number,
): Promise<void> {
	if (!artifact.steps[stepIndex]) {
		deps.showWarning(`Plan v${artifact.revision} has no step ${stepIndex + 1}.`);
		return;
	}
	const updatedArtifact = reopenInteractivePlanStep(artifact, stepIndex);
	deps.sessionManager.appendCustomEntry(INTERACTIVE_PLAN_ARTIFACT_TYPE, updatedArtifact);
	deps.appendPlanSelection({
		accepted: createInteractivePlanArtifactRef(updatedArtifact),
		executing: undefined,
	});
	deps.updatePendingMessagesDisplay();
	deps.updateModeDisplay();
	deps.showPlanArtifactCard(updatedArtifact);
	deps.showStatus(`Reopened step ${stepIndex + 1} for plan v${artifact.revision}.`);
}

export interface PersistLatestPlanArtifactOptions {
	goal: string;
	previousArtifact?: InteractivePlanArtifact;
	feedback?: string;
}

export interface PersistLatestPlanArtifactDeps {
	getLastSubmitPlanPayload: () => SubmitPlanSubmission | undefined;
	setLastSubmitPlanPayload: (value: SubmitPlanSubmission | undefined) => void;
	session: AgentSession;
	sessionManager: SessionManager;
	appendPlanSelection: (updates: Partial<InteractivePlanSelection>) => void;
	showPlanArtifactCard: ShowPlanArtifactCardFn;
}

export function persistLatestPlanArtifact(
	deps: PersistLatestPlanArtifactDeps,
	options: PersistLatestPlanArtifactOptions,
): InteractivePlanArtifact | undefined {
	// Structured submit_plan payload takes precedence over markdown extraction
	const submission = deps.getLastSubmitPlanPayload();
	deps.setLastSubmitPlanPayload(undefined);
	const assistantText = deps.session.getLastAssistantText();
	const artifact =
		(submission
			? buildInteractivePlanArtifactFromSubmission({
					goal: options.goal,
					submission,
					previous: options.previousArtifact,
					feedback: options.feedback,
				})
			: undefined) ??
		(assistantText
			? (extractInteractivePlanArtifact({
					goal: options.goal,
					assistantText,
					previous: options.previousArtifact,
					feedback: options.feedback,
				}) ??
				buildFallbackInteractivePlanArtifact({
					goal: options.goal,
					previous: options.previousArtifact,
					feedback: options.feedback,
					rawPlan: assistantText,
				}))
			: undefined);
	if (!artifact) return undefined;
	if (options.previousArtifact && ["draft", "clarifying"].includes(options.previousArtifact.status)) {
		deps.sessionManager.appendCustomEntry(
			INTERACTIVE_PLAN_ARTIFACT_TYPE,
			updateInteractivePlanArtifactStatus(options.previousArtifact, "superseded"),
		);
	}
	deps.sessionManager.appendCustomEntry(INTERACTIVE_PLAN_ARTIFACT_TYPE, artifact);
	deps.appendPlanSelection({
		planning: createInteractivePlanArtifactRef(artifact),
	});
	if (artifact.status !== "clarifying") {
		deps.showPlanArtifactCard(artifact, { expanded: true });
	}
	return artifact;
}

export interface RunPlanningPromptDeps {
	receiver: unknown;
	ensurePreferredModeModel: (mode: "planning" | "execution") => Promise<void>;
	clearPendingRuntimePromptAddendum: () => void;
	setLastSubmitPlanPayload: (value: SubmitPlanSubmission | undefined) => void;
	setPlanningReadOnlyToolsAllowed: (allowed: boolean) => void;
	shouldAllowPlanningInspection: (
		promptBody: string,
		options?: {
			goal?: string;
			previousArtifact?: InteractivePlanArtifact;
			feedback?: string;
		},
	) => boolean;
	applySafetyPolicy: () => void;
	setSuppressPlanningAssistantTranscript: (value: boolean) => void;
	session: AgentSession;
	buildPlanningUserMessage: (userMessage: string) => string;
	persistLatestPlanArtifact: (options: PersistLatestPlanArtifactOptions) => InteractivePlanArtifact | undefined;
	updatePendingMessagesDisplay: () => void;
	updateModeDisplay: () => void;
	showStatus: (message: string) => void;
	showImmediatePlanActionSelector: (artifact: InteractivePlanArtifact) => Promise<void>;
	appendPlanSelection: (updates: Partial<InteractivePlanSelection>) => void;
}

export async function runPlanningPrompt(
	deps: RunPlanningPromptDeps,
	promptBody: string,
	options?: RunPlanningPromptOptions,
): Promise<void> {
	const planningProfileProvider = deps.receiver as unknown as {
		getPlanningStabilizationProfile?: () => RuntimeStabilizationProfile;
	};
	const stabilizationProfile =
		typeof planningProfileProvider.getPlanningStabilizationProfile === "function"
			? planningProfileProvider.getPlanningStabilizationProfile()
			: {
					level: "none" as const,
					reasons: [],
					forceBehavioralPrompt: false,
					forceNudges: false,
				};
	await deps.ensurePreferredModeModel("planning");
	deps.clearPendingRuntimePromptAddendum();
	deps.setLastSubmitPlanPayload(undefined);
	deps.setPlanningReadOnlyToolsAllowed(deps.shouldAllowPlanningInspection(promptBody, options));
	deps.applySafetyPolicy();
	deps.setSuppressPlanningAssistantTranscript(true);
	// Hide mutating tools from the planner entirely — the tool contract is
	// enforced at the model boundary, not just at dispatch. submit_plan is
	// only visible during planning turns.
	const previousToolNames = deps.session.getActiveToolNames();
	const planningToolNames = [
		...previousToolNames.filter((name) => !PLANNING_HIDDEN_TOOLS.has(name) && name !== SUBMIT_PLAN_TOOL_NAME),
		SUBMIT_PLAN_TOOL_NAME,
	];
	deps.session.setActiveToolsByName(planningToolNames);
	try {
		const planningGuidance = buildPlanningGuidanceMessage(stabilizationProfile);
		const systemPromptAddendum = options?.hiddenPromptAddendum
			? `${planningGuidance}\n\nHidden planning context:\n${options.hiddenPromptAddendum}`
			: planningGuidance;
		await deps.session.prompt(deps.buildPlanningUserMessage(promptBody), {
			images: options?.images,
			systemPromptAddendum,
		});
	} finally {
		deps.setSuppressPlanningAssistantTranscript(false);
		deps.setPlanningReadOnlyToolsAllowed(true);
		deps.applySafetyPolicy();
		deps.session.setActiveToolsByName(previousToolNames);
	}
	const artifact = deps.persistLatestPlanArtifact({
		goal: options?.goal ?? promptBody,
		previousArtifact: options?.previousArtifact,
		feedback: options?.feedback,
	});
	deps.updatePendingMessagesDisplay();
	deps.updateModeDisplay();
	if (artifact) {
		if (artifact.status === "clarifying") {
			deps.showStatus(`Planning is awaiting clarification for v${artifact.revision}. Interview opened.`);
		} else {
			deps.showStatus(`Saved plan v${artifact.revision} (${artifact.steps.length} steps). Review opened.`);
		}
		await deps.showImmediatePlanActionSelector(artifact);
	} else {
		deps.appendPlanSelection({ planning: undefined });
		deps.updatePendingMessagesDisplay();
		deps.updateModeDisplay();
		deps.showStatus("Planning response captured. No structured plan artifact was detected yet.");
	}
}

export interface ExecuteNextPlanStepDeps {
	resolvePlanArtifact: (
		revision: number | undefined,
		defaultTarget?: "current" | "planning" | "execution",
	) => { artifact: InteractivePlanArtifact | undefined; ambiguousRevision?: number };
	showWarning: (message: string) => void;
	executePlanArtifact: (artifact: InteractivePlanArtifact, stepIndex?: number) => Promise<void>;
}

export async function executeNextPlanStep(deps: ExecuteNextPlanStepDeps, revision?: number): Promise<void> {
	const resolved = deps.resolvePlanArtifact(revision, "execution");
	if (resolved.ambiguousRevision !== undefined) {
		deps.showWarning(
			`Plan revision ${resolved.ambiguousRevision} matches multiple plan threads. Open /plan review and pick the exact plan instead.`,
		);
		return;
	}
	const artifact = resolved.artifact;
	if (!artifact) {
		deps.showWarning(
			revision === undefined
				? "No accepted plan artifact to execute."
				: `No saved plan artifact for revision ${revision}.`,
		);
		return;
	}
	if (artifact.status !== "accepted" && artifact.status !== "executing") {
		deps.showWarning(
			revision === undefined
				? "Accept the latest plan first with /plan accept before executing the next step."
				: `Accept plan revision ${artifact.revision} first with /plan accept ${artifact.revision} before executing the next step.`,
		);
		return;
	}
	const nextStepIndex = getNextInteractivePlanStepIndex(artifact);
	if (nextStepIndex === undefined) {
		deps.showWarning(`Plan v${artifact.revision} has no remaining steps to execute.`);
		return;
	}
	await deps.executePlanArtifact(artifact, nextStepIndex);
}
