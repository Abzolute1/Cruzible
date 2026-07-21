import type { ExtensionUIDialogOptions } from "../../core/extensions/index.js";
import type { SessionManager } from "../../core/session-manager.js";
import type { PlanWorkflowDialogOption } from "./components/plan-workflow-dialog.js";
import type { InteractiveBuiltinCommand } from "./interactive-command-parser.js";
import {
	createInteractivePlanArtifactRef,
	getAnsweredClarificationCount,
	getClarificationAnswers,
	getCompletedStepCount,
	getNextInteractivePlanStep,
	getNextInteractivePlanStepIndex,
	INTERACTIVE_PLAN_ARTIFACT_TYPE,
	type InteractivePlanArtifact,
	type InteractivePlanSelection,
	updateInteractivePlanArtifactStatus,
} from "./interactive-plan-artifacts.js";
import { createPlanWorkflowOption } from "./interactive-plan-interview.js";
import { buildInteractiveExpandedPlanCardLines } from "./interactive-plan-review-ui.js";
import { getInteractiveAppKeyDisplay } from "./interactive-reference-actions.js";

export type PlanReviewActionId =
	| "show_revision"
	| "approve_plan"
	| "approve_and_clear"
	| "execute_full_plan"
	| "clear_context_for_implementation"
	| "execute_next_step"
	| "execute_selected_step"
	| "mark_step_complete"
	| "mark_executing_step_complete"
	| "reopen_completed_step"
	| "clear_revision"
	| "reject_revision"
	| "revise_plan"
	| "continue_planning"
	| "continue_interview";

type ShowPlanWorkflowDialogFn = (
	title: string,
	lines: string[],
	options: PlanWorkflowDialogOption[],
	dialogOptions?: { accent?: "accent" | "warning" | "success" },
) => Promise<string | undefined>;

export function formatPlanSelectorOption(artifact: InteractivePlanArtifact): string {
	const parts = [`v${artifact.revision}`, artifact.status];
	if (artifact.status === "clarifying") {
		parts.push(`interview ${getAnsweredClarificationCount(artifact)}/${artifact.openQuestions.length}`);
		parts.push(artifact.goal);
		const answers = getClarificationAnswers(artifact);
		const nextQuestionIndex = artifact.openQuestions.findIndex((_, index) => !answers[index]?.trim());
		const nextQuestion = artifact.openQuestions[nextQuestionIndex];
		if (nextQuestion) {
			parts.push(`next: ${nextQuestion}`);
		} else if (artifact.openQuestions[0]) {
			parts.push(`next: ${artifact.openQuestions[0]}`);
		}
		return parts.join(" • ");
	}
	if (artifact.steps.length > 0) {
		parts.push(`progress ${getCompletedStepCount(artifact)}/${artifact.steps.length}`);
	}
	parts.push(artifact.goal);
	const nextStep = getNextInteractivePlanStep(artifact);
	if (nextStep) {
		parts.push(`next: ${nextStep}`);
	}
	return parts.join(" • ");
}

export function getPlanReviewActions(artifact: InteractivePlanArtifact): PlanWorkflowDialogOption[] {
	const hasCompletedSteps = getCompletedStepCount(artifact) > 0;
	const hasRemainingSteps = getNextInteractivePlanStepIndex(artifact) !== undefined;
	switch (artifact.status) {
		case "clarifying": {
			const answered = getAnsweredClarificationCount(artifact);
			return [
				createPlanWorkflowOption("show_revision", "Show revision", "s"),
				createPlanWorkflowOption(
					"continue_interview",
					answered > 0 ? "Continue interview" : "Start interview",
					"i",
				),
				...(answered > 0 ? [createPlanWorkflowOption("continue_planning", "Continue planning", "p")] : []),
				createPlanWorkflowOption("reject_revision", "Reject revision", "x"),
				createPlanWorkflowOption("clear_revision", "Clear revision", "d"),
			];
		}
		case "draft":
			return [
				createPlanWorkflowOption("show_revision", "Show revision", "s"),
				createPlanWorkflowOption("approve_plan", "Approve plan", "a"),
				createPlanWorkflowOption("approve_and_clear", "Approve and clear context", "c"),
				createPlanWorkflowOption("revise_plan", "Revise plan", "r"),
				createPlanWorkflowOption("reject_revision", "Reject revision", "x"),
				createPlanWorkflowOption("clear_revision", "Clear revision", "d"),
			];
		case "accepted":
			return [
				createPlanWorkflowOption("show_revision", "Show revision", "s"),
				createPlanWorkflowOption("clear_context_for_implementation", "Clear context for implementation", "l"),
				...(hasRemainingSteps
					? [
							createPlanWorkflowOption("execute_full_plan", "Execute full plan", "e"),
							createPlanWorkflowOption("execute_next_step", "Execute next step", "n"),
							createPlanWorkflowOption("execute_selected_step", "Execute selected step", "t"),
							createPlanWorkflowOption("mark_step_complete", "Mark step complete", "m"),
						]
					: []),
				...(hasCompletedSteps
					? [createPlanWorkflowOption("reopen_completed_step", "Reopen completed step", "o")]
					: []),
				createPlanWorkflowOption("revise_plan", "Revise plan", "r"),
				createPlanWorkflowOption("reject_revision", "Reject revision", "x"),
				createPlanWorkflowOption("clear_revision", "Clear revision", "d"),
			];
		case "rejected":
			return [
				createPlanWorkflowOption("show_revision", "Show revision", "s"),
				createPlanWorkflowOption("revise_plan", "Revise plan", "r"),
			];
		case "superseded":
			return [createPlanWorkflowOption("show_revision", "Show revision", "s")];
		case "executing":
			return [
				createPlanWorkflowOption("show_revision", "Show revision", "s"),
				...(artifact.executionStepIndex !== undefined
					? [createPlanWorkflowOption("mark_executing_step_complete", "Mark executing step complete", "m")]
					: []),
				...(hasCompletedSteps
					? [createPlanWorkflowOption("reopen_completed_step", "Reopen completed step", "o")]
					: []),
				createPlanWorkflowOption("revise_plan", "Revise plan", "r"),
			];
		case "completed":
			return [
				createPlanWorkflowOption("show_revision", "Show revision", "s"),
				createPlanWorkflowOption("reopen_completed_step", "Reopen completed step", "o"),
				createPlanWorkflowOption("revise_plan", "Revise plan", "r"),
				createPlanWorkflowOption("clear_revision", "Clear revision", "d"),
			];
		case "discarded":
			return [createPlanWorkflowOption("show_revision", "Show revision", "s")];
	}
}

export interface AcceptPlanArtifactDeps {
	planningMode: boolean;
	sessionManager: SessionManager;
	appendPlanSelection: (updates: Partial<InteractivePlanSelection>) => void;
	setExecutionMode: (mode: "interactive" | "planning" | "autonomous") => void;
	updatePendingMessagesDisplay: () => void;
	updateModeDisplay: () => void;
	showPlanArtifactCard: (artifact: InteractivePlanArtifact, options?: { expanded?: boolean }) => void;
	showWarning: (message: string) => void;
	showStatus: (message: string) => void;
	ensurePreferredModeModel: (mode: "planning" | "execution") => Promise<void>;
	handleCompactCommand: (customInstructions?: string) => Promise<void>;
	offerAcceptedPlanHandoff: (artifact: InteractivePlanArtifact) => Promise<boolean>;
}

export async function acceptPlanArtifact(
	deps: AcceptPlanArtifactDeps,
	artifact: InteractivePlanArtifact,
	options?: { compactContext?: boolean },
): Promise<void> {
	const wasPlanningMode = deps.planningMode;
	const unansweredCount = artifact.openQuestions.length - getAnsweredClarificationCount(artifact);
	if (unansweredCount > 0) {
		deps.showWarning(
			`Accepting plan v${artifact.revision} with ${unansweredCount} unanswered clarifying question(s). Open decisions stay assumptions — call them out during execution.`,
		);
	}
	const acceptedArtifact = updateInteractivePlanArtifactStatus(artifact, "accepted");
	deps.sessionManager.appendCustomEntry(INTERACTIVE_PLAN_ARTIFACT_TYPE, acceptedArtifact);
	deps.appendPlanSelection({
		planning: undefined,
		accepted: createInteractivePlanArtifactRef(acceptedArtifact),
		executing: undefined,
	});
	deps.setExecutionMode("interactive");
	deps.updatePendingMessagesDisplay();
	deps.updateModeDisplay();
	deps.showPlanArtifactCard(acceptedArtifact);
	if (options?.compactContext) {
		await deps.ensurePreferredModeModel("execution");
		deps.showStatus(`Accepted plan v${artifact.revision}. Compacting session around the approved plan.`);
		await deps.handleCompactCommand(buildPlanCompactionInstructions(acceptedArtifact));
		deps.showStatus(
			`Accepted plan v${artifact.revision} and cleared context. Use /plan next, /plan step <n>, or ${getInteractiveAppKeyDisplay("app.plan.nextStep")} to continue.`,
		);
		return;
	}
	if (wasPlanningMode) {
		const handoffHandled = await deps.offerAcceptedPlanHandoff(acceptedArtifact);
		if (handoffHandled) return;
	}
	deps.showStatus(
		`Accepted plan v${artifact.revision}. Interactive mode ready. Use /plan next, /plan execute, or /plan review.`,
	);
}

export interface OfferAcceptedPlanHandoffDeps {
	showPlanWorkflowDialog: ShowPlanWorkflowDialogFn;
	executePlanArtifact: (artifact: InteractivePlanArtifact, stepIndex?: number) => Promise<void>;
}

export async function offerAcceptedPlanHandoff(
	deps: OfferAcceptedPlanHandoffDeps,
	artifact: InteractivePlanArtifact,
): Promise<boolean> {
	const nextStepIndex = getNextInteractivePlanStepIndex(artifact);
	const options = [
		...(nextStepIndex === undefined ? [] : [createPlanWorkflowOption("execute_next_step", "Execute next step", "n")]),
		...(nextStepIndex === undefined ? [] : [createPlanWorkflowOption("execute_full_plan", "Execute full plan", "e")]),
		createPlanWorkflowOption("stay_in_interactive_mode", "Stay in interactive mode", "i"),
	];
	const selection = await deps.showPlanWorkflowDialog(
		`Plan accepted • v${artifact.revision}`,
		[
			`Goal: ${artifact.goal}`,
			`Progress: ${getCompletedStepCount(artifact)}/${artifact.steps.length} complete`,
			...(nextStepIndex === undefined ? [] : [`Next: ${artifact.steps[nextStepIndex]}`]),
			"",
			"Choose what should happen now.",
		],
		options,
		{ accent: "success" },
	);
	if (!selection || selection === "stay_in_interactive_mode") return false;
	if (selection === "execute_next_step" && nextStepIndex !== undefined) {
		await deps.executePlanArtifact(artifact, nextStepIndex);
		return true;
	}
	if (selection === "execute_full_plan") {
		await deps.executePlanArtifact(artifact);
		return true;
	}
	return false;
}

export function buildPlanCompactionInstructions(artifact: InteractivePlanArtifact): string {
	return [
		`Compact the session around the approved plan for this goal: ${artifact.goal}`,
		"- preserve the current objective and the approved implementation plan",
		"- preserve completed step progress, the next incomplete step, and any explicit verification requirements",
		"- preserve critical user constraints and assumptions",
		"- remove planning chatter and exploratory discussion that is no longer needed",
		"- optimize the remaining context for immediate implementation of the approved plan",
	].join("\n");
}

export interface HandlePlanReviewActionDeps {
	handlePlanCommand: (command: Extract<InteractiveBuiltinCommand, { kind: "plan" }>) => Promise<void>;
	acceptPlanArtifact: (artifact: InteractivePlanArtifact, options?: { compactContext?: boolean }) => Promise<void>;
	setExecutionMode: (mode: "interactive" | "planning" | "autonomous") => void;
	handleCompactCommand: (customInstructions?: string) => Promise<void>;
	showStatus: (message: string) => void;
	showWarning: (message: string) => void;
	executePlanArtifact: (artifact: InteractivePlanArtifact, stepIndex?: number) => Promise<void>;
	showExtensionSelector: (
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	) => Promise<string | undefined>;
	getPlanStepSelectorOptions: (artifact: InteractivePlanArtifact, mode: "all" | "remaining" | "completed") => string[];
	markPlanStepComplete: (artifact: InteractivePlanArtifact, stepIndex: number) => Promise<void>;
	reopenPlanStep: (artifact: InteractivePlanArtifact, stepIndex: number) => Promise<void>;
	showExtensionInput: (
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions & { initialValue?: string },
	) => Promise<string | undefined>;
	rejectPlanArtifact: (artifact: InteractivePlanArtifact, reason: string) => Promise<void>;
	showExtensionEditor: (title: string, prefill?: string) => Promise<string | undefined>;
	revisePlanArtifact: (artifact: InteractivePlanArtifact, feedback: string) => Promise<void>;
	continuePlanInterview: (artifact: InteractivePlanArtifact, options?: { skipRemaining?: boolean }) => Promise<void>;
	showPlanInterview: (artifact: InteractivePlanArtifact) => Promise<void>;
}

export async function handlePlanReviewAction(
	deps: HandlePlanReviewActionDeps,
	artifact: InteractivePlanArtifact,
	action: PlanReviewActionId,
): Promise<void> {
	switch (action) {
		case "show_revision":
			await deps.handlePlanCommand({ kind: "plan", action: "show", revision: artifact.revision });
			return;
		case "approve_plan":
			await deps.acceptPlanArtifact(artifact);
			return;
		case "approve_and_clear":
			await deps.acceptPlanArtifact(artifact, { compactContext: true });
			return;
		case "execute_full_plan":
			await deps.handlePlanCommand({ kind: "plan", action: "execute", revision: artifact.revision });
			return;
		case "clear_context_for_implementation":
			deps.setExecutionMode("interactive");
			await deps.handleCompactCommand(buildPlanCompactionInstructions(artifact));
			deps.showStatus(
				`Cleared context around accepted plan v${artifact.revision}. Use /plan next or /plan step <n>.`,
			);
			return;
		case "execute_next_step":
			if (getNextInteractivePlanStepIndex(artifact) === undefined) {
				deps.showWarning(`Plan v${artifact.revision} has no remaining steps to execute.`);
				return;
			}
			await deps.executePlanArtifact(artifact, getNextInteractivePlanStepIndex(artifact));
			return;
		case "execute_selected_step": {
			const selectedStep = await deps.showExtensionSelector(
				`Select step from plan v${artifact.revision}`,
				deps.getPlanStepSelectorOptions(artifact, "remaining"),
			);
			if (!selectedStep) return;
			const selectedIndex = artifact.steps.findIndex((step, index) => `${index + 1}. ${step}` === selectedStep);
			if (selectedIndex >= 0) {
				await deps.executePlanArtifact(artifact, selectedIndex);
			}
			return;
		}
		case "mark_step_complete": {
			const selectedStep = await deps.showExtensionSelector(
				`Mark completed step from plan v${artifact.revision}`,
				deps.getPlanStepSelectorOptions(artifact, "remaining"),
			);
			if (!selectedStep) return;
			const selectedIndex = artifact.steps.findIndex((step, index) => `${index + 1}. ${step}` === selectedStep);
			if (selectedIndex >= 0) {
				await deps.markPlanStepComplete(artifact, selectedIndex);
			}
			return;
		}
		case "mark_executing_step_complete":
			if (artifact.executionStepIndex === undefined) {
				deps.showWarning(`Plan v${artifact.revision} has no active executing step.`);
				return;
			}
			await deps.markPlanStepComplete(artifact, artifact.executionStepIndex);
			return;
		case "reopen_completed_step": {
			const selectedStep = await deps.showExtensionSelector(
				`Reopen completed step from plan v${artifact.revision}`,
				deps.getPlanStepSelectorOptions(artifact, "completed"),
			);
			if (!selectedStep) return;
			const selectedIndex = artifact.steps.findIndex((step, index) => `${index + 1}. ${step}` === selectedStep);
			if (selectedIndex >= 0) {
				await deps.reopenPlanStep(artifact, selectedIndex);
			}
			return;
		}
		case "clear_revision":
			await deps.handlePlanCommand({ kind: "plan", action: "clear", revision: artifact.revision });
			return;
		case "reject_revision": {
			const reason = await deps.showExtensionInput(`Reject plan v${artifact.revision}`, "Reason (optional)");
			await deps.rejectPlanArtifact(artifact, reason ?? "");
			return;
		}
		case "revise_plan": {
			const feedback = await deps.showExtensionEditor(`Revise plan v${artifact.revision}`, artifact.feedback ?? "");
			if (!feedback?.trim()) return;
			await deps.revisePlanArtifact(artifact, feedback.trim());
			return;
		}
		case "continue_planning":
			await deps.continuePlanInterview(artifact);
			return;
		case "continue_interview": {
			await deps.showPlanInterview(artifact);
			return;
		}
	}
}

export interface ShowPlanReviewSelectorDeps {
	getPlanArtifacts: (limit?: number) => InteractivePlanArtifact[];
	showWarning: (message: string) => void;
	formatPlanSelectorOption: (artifact: InteractivePlanArtifact) => string;
	showExtensionSelector: (
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	) => Promise<string | undefined>;
	showPlanWorkflowDialog: ShowPlanWorkflowDialogFn;
	getPlanReviewActions: (artifact: InteractivePlanArtifact) => PlanWorkflowDialogOption[];
	handlePlanReviewAction: (artifact: InteractivePlanArtifact, action: PlanReviewActionId) => Promise<void>;
}

export async function showPlanReviewSelector(deps: ShowPlanReviewSelectorDeps): Promise<void> {
	const artifacts = deps.getPlanArtifacts(10);
	if (artifacts.length === 0) {
		deps.showWarning("No saved plan history yet. Enter planning mode and ask for a plan first.");
		return;
	}

	const labels = artifacts.map((artifact) => deps.formatPlanSelectorOption(artifact));
	// Identical labels are possible across plan threads (same revision number,
	// status, and goal snippet) — disambiguate so selection maps back by index.
	const labelCounts = new Map<string, number>();
	for (const label of labels) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
	const labelSeen = new Map<string, number>();
	const displayOptions = labels.map((label) => {
		if ((labelCounts.get(label) ?? 0) < 2) return label;
		const occurrence = (labelSeen.get(label) ?? 0) + 1;
		labelSeen.set(label, occurrence);
		return `${label} · #${occurrence}`;
	});

	const selectedRevision = await deps.showExtensionSelector("Select plan revision", displayOptions);
	if (!selectedRevision) return;

	const selectedIndex = displayOptions.indexOf(selectedRevision);
	if (selectedIndex < 0) return;
	const artifact = artifacts[selectedIndex];
	if (!artifact) return;

	const action = await deps.showPlanWorkflowDialog(
		`Plan v${artifact.revision} • ${artifact.status}`,
		buildInteractiveExpandedPlanCardLines(artifact),
		deps.getPlanReviewActions(artifact),
		{
			accent: artifact.status === "clarifying" ? "warning" : artifact.status === "accepted" ? "success" : "accent",
		},
	);
	if (!action) return;
	await deps.handlePlanReviewAction(artifact, action as PlanReviewActionId);
}

export interface ShowImmediatePlanActionSelectorDeps {
	showPlanInterview: (artifact: InteractivePlanArtifact) => Promise<void>;
	showPlanWorkflowDialog: ShowPlanWorkflowDialogFn;
	getPlanReviewActions: (artifact: InteractivePlanArtifact) => PlanWorkflowDialogOption[];
	handlePlanReviewAction: (artifact: InteractivePlanArtifact, action: PlanReviewActionId) => Promise<void>;
}

export async function showImmediatePlanActionSelector(
	deps: ShowImmediatePlanActionSelectorDeps,
	artifact: InteractivePlanArtifact,
): Promise<void> {
	if (artifact.status === "clarifying") {
		await deps.showPlanInterview(artifact);
		return;
	}
	const action = await deps.showPlanWorkflowDialog(
		`Approve plan v${artifact.revision}`,
		buildInteractiveExpandedPlanCardLines(artifact),
		deps.getPlanReviewActions(artifact),
		{ accent: "accent" },
	);
	if (!action) return;
	await deps.handlePlanReviewAction(artifact, action as PlanReviewActionId);
}
