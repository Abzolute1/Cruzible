import { type Container, Spacer, Text, type TUI } from "@ag1/tui";
import type { SessionManager } from "../../core/session-manager.js";
import type { InteractiveBuiltinCommand } from "./interactive-command-parser.js";
import {
	buildPlanRevisionPrompt,
	formatInteractivePlanHistory,
	INTERACTIVE_PLAN_ARTIFACT_TYPE,
	type InteractivePlanArtifact,
	updateInteractivePlanArtifactStatus,
} from "./interactive-plan-artifacts.js";
import type { RunPlanningPromptFn, ShowPlanArtifactCardFn } from "./interactive-plan-execution.js";

export interface HandlePlanCommandDeps {
	resolvePlanArtifact: (
		revision: number | undefined,
		defaultTarget?: "current" | "planning" | "execution",
	) => { artifact: InteractivePlanArtifact | undefined; ambiguousRevision?: number };
	getSessionActivityState: () => { isStreaming?: boolean; isCompacting?: boolean } | undefined;
	showWarning: (message: string) => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	togglePlanningMode: () => void;
	chatContainer: Container;
	ui: TUI;
	formatPlanRouteSummaryLines: () => string[];
	handlePlanModelRouteCommand: (mode: "planning" | "execution" | "verifier", modelRef?: string) => Promise<void>;
	showPlanReviewSelector: () => Promise<void>;
	showPlanInterview: (artifact: InteractivePlanArtifact) => Promise<void>;
	answerClarifyingPlanArtifact: (artifact: InteractivePlanArtifact, answer: string) => Promise<void>;
	showPlanArtifactCard: ShowPlanArtifactCardFn;
	getPlanArtifacts: (limit?: number) => InteractivePlanArtifact[];
	acceptPlanArtifact: (artifact: InteractivePlanArtifact, options?: { compactContext?: boolean }) => Promise<void>;
	rejectPlanArtifact: (artifact: InteractivePlanArtifact, reason: string) => Promise<void>;
	sessionManager: SessionManager;
	clearPlanSelectionForArtifact: (artifact: InteractivePlanArtifact) => void;
	updatePendingMessagesDisplay: () => void;
	updateModeDisplay: () => void;
	setExecutionMode: (mode: "interactive" | "planning" | "autonomous") => void;
	runPlanningPrompt: RunPlanningPromptFn;
	markPlanStepComplete: (artifact: InteractivePlanArtifact, stepIndex: number) => Promise<void>;
	reopenPlanStep: (artifact: InteractivePlanArtifact, stepIndex: number) => Promise<void>;
	executeNextPlanStep: (revision?: number) => Promise<void>;
	executePlanArtifact: (artifact: InteractivePlanArtifact, stepIndex?: number) => Promise<void>;
}

export async function handlePlanCommand(
	deps: HandlePlanCommandDeps,
	command: Extract<InteractiveBuiltinCommand, { kind: "plan" }>,
): Promise<void> {
	try {
		const maybeSession = deps.getSessionActivityState();
		const planMutationActions = new Set<Extract<InteractiveBuiltinCommand, { kind: "plan" }>["action"]>([
			"accept",
			"reject",
			"clear",
			"revise",
			"done",
			"reopen",
			"next",
			"step",
			"execute",
			"answer",
		]);
		if (planMutationActions.has(command.action) && (maybeSession?.isStreaming || maybeSession?.isCompacting)) {
			deps.showWarning("Wait for the current agent turn to finish before changing plan state.");
			return;
		}
		const resolvePlanArtifact = (
			revision: number | undefined,
			defaultTarget: "current" | "planning" | "execution" = "current",
		): InteractivePlanArtifact | undefined => {
			const resolved = deps.resolvePlanArtifact(revision, defaultTarget);
			if (resolved.ambiguousRevision !== undefined) {
				deps.showWarning(
					`Plan revision ${resolved.ambiguousRevision} matches multiple plan threads. Open /plan review and pick the exact plan instead.`,
				);
				return undefined;
			}
			return resolved.artifact;
		};
		switch (command.action) {
			case "toggle":
				deps.togglePlanningMode();
				return;
			case "routes":
				deps.chatContainer.addChild(new Spacer(1));
				deps.chatContainer.addChild(new Text(deps.formatPlanRouteSummaryLines().join("\n"), 1, 0));
				deps.ui.requestRender();
				return;
			case "planner-model":
				await deps.handlePlanModelRouteCommand("planning", command.modelRef);
				return;
			case "executor-model":
				await deps.handlePlanModelRouteCommand("execution", command.modelRef);
				return;
			case "verifier-model":
				await deps.handlePlanModelRouteCommand("verifier", command.modelRef);
				return;
			case "review":
				await deps.showPlanReviewSelector();
				return;
			case "interview": {
				const artifact = resolvePlanArtifact(command.revision, "planning");
				if (!artifact) {
					deps.showWarning(
						command.revision === undefined
							? "No saved clarifying plan artifact yet."
							: `No saved plan artifact for revision ${command.revision}.`,
					);
					return;
				}
				if (artifact.status !== "clarifying") {
					deps.showWarning(
						command.revision === undefined
							? "The latest saved plan is not awaiting clarification."
							: `Plan revision ${artifact.revision} is not awaiting clarification.`,
					);
					return;
				}
				await deps.showPlanInterview(artifact);
				return;
			}
			case "answer": {
				const artifact = resolvePlanArtifact(command.revision, "planning");
				if (!artifact) {
					deps.showWarning(
						command.revision === undefined
							? "No saved clarifying plan artifact yet."
							: `No saved plan artifact for revision ${command.revision}.`,
					);
					return;
				}
				if (artifact.status !== "clarifying") {
					deps.showWarning(
						command.revision === undefined
							? "The latest saved plan is not awaiting clarification."
							: `Plan revision ${artifact.revision} is not awaiting clarification.`,
					);
					return;
				}
				if (!command.feedback) {
					await deps.showPlanInterview(artifact);
					return;
				}
				await deps.answerClarifyingPlanArtifact(artifact, command.feedback);
				return;
			}
			case "show": {
				const artifact = resolvePlanArtifact(command.revision);
				if (!artifact) {
					deps.showWarning(
						command.revision === undefined
							? "No saved plan artifact yet. Enter planning mode and ask for a plan first."
							: `No saved plan artifact for revision ${command.revision}.`,
					);
					return;
				}
				deps.showPlanArtifactCard(artifact, { expanded: true });
				return;
			}
			case "history": {
				const artifacts = deps.getPlanArtifacts(5);
				if (artifacts.length === 0) {
					deps.showWarning("No saved plan history yet. Enter planning mode and ask for a plan first.");
					return;
				}
				deps.chatContainer.addChild(new Spacer(1));
				deps.chatContainer.addChild(new Text(formatInteractivePlanHistory(artifacts), 1, 0));
				deps.ui.requestRender();
				return;
			}
			case "accept": {
				const artifact = resolvePlanArtifact(command.revision, "planning");
				if (!artifact) {
					deps.showWarning(
						command.revision === undefined
							? "No saved plan artifact to accept."
							: `No saved plan artifact for revision ${command.revision}.`,
					);
					return;
				}
				if (artifact.status === "accepted") {
					deps.showStatus(`Plan v${artifact.revision} is already accepted.`);
					return;
				}
				if (artifact.status === "clarifying") {
					deps.showWarning(
						command.revision === undefined
							? "Answer the clarifying questions first with /plan interview before accepting the plan."
							: `Plan revision ${artifact.revision} is still awaiting clarification. Open the interview first.`,
					);
					return;
				}
				if (artifact.status !== "draft") {
					deps.showWarning(
						command.revision === undefined
							? `Only draft plans can be accepted. The current plan is ${artifact.status}.`
							: `Plan revision ${artifact.revision} cannot be accepted from ${artifact.status}.`,
					);
					return;
				}
				await deps.acceptPlanArtifact(artifact);
				return;
			}
			case "reject": {
				const artifact = resolvePlanArtifact(command.revision);
				if (!artifact) {
					deps.showWarning(
						command.revision === undefined
							? "No saved plan artifact to reject."
							: `No saved plan artifact for revision ${command.revision}.`,
					);
					return;
				}
				await deps.rejectPlanArtifact(artifact, "");
				return;
			}
			case "clear": {
				const artifact = resolvePlanArtifact(command.revision);
				if (!artifact) {
					deps.showWarning(
						command.revision === undefined
							? "No saved plan artifact to clear."
							: `No saved plan artifact for revision ${command.revision}.`,
					);
					return;
				}
				const discardedArtifact = updateInteractivePlanArtifactStatus(artifact, "discarded");
				deps.sessionManager.appendCustomEntry(INTERACTIVE_PLAN_ARTIFACT_TYPE, discardedArtifact);
				deps.clearPlanSelectionForArtifact(artifact);
				deps.updatePendingMessagesDisplay();
				deps.updateModeDisplay();
				deps.showPlanArtifactCard(discardedArtifact);
				deps.showStatus(`Cleared plan v${artifact.revision}.`);
				return;
			}
			case "revise": {
				const artifact = resolvePlanArtifact(command.revision);
				if (!artifact) {
					deps.showWarning(
						command.revision === undefined
							? "No saved plan artifact to revise."
							: `No saved plan artifact for revision ${command.revision}.`,
					);
					return;
				}
				if (!command.feedback) {
					deps.showWarning("Usage: /plan revise [revision] <what to change>");
					return;
				}
				deps.setExecutionMode("planning");
				await deps.runPlanningPrompt(`Revise plan v${artifact.revision} for: ${artifact.goal}`, {
					goal: artifact.goal,
					previousArtifact: artifact,
					feedback: command.feedback,
					hiddenPromptAddendum: buildPlanRevisionPrompt(artifact, command.feedback),
				});
				return;
			}
			case "done": {
				const artifact = resolvePlanArtifact(command.revision, "execution");
				if (!artifact) {
					deps.showWarning(
						command.revision === undefined
							? "No saved plan artifact to update."
							: `No saved plan artifact for revision ${command.revision}.`,
					);
					return;
				}
				if (command.stepIndex === undefined || !artifact.steps[command.stepIndex]) {
					deps.showWarning("Usage: /plan done [revision] <step-number>");
					return;
				}
				if (artifact.status !== "accepted" && artifact.status !== "executing") {
					deps.showWarning(`Plan v${artifact.revision} cannot mark steps complete from ${artifact.status}.`);
					return;
				}
				await deps.markPlanStepComplete(artifact, command.stepIndex);
				return;
			}
			case "reopen": {
				const artifact = resolvePlanArtifact(command.revision, "execution");
				if (!artifact) {
					deps.showWarning(
						command.revision === undefined
							? "No saved plan artifact to update."
							: `No saved plan artifact for revision ${command.revision}.`,
					);
					return;
				}
				if (command.stepIndex === undefined || !artifact.steps[command.stepIndex]) {
					deps.showWarning("Usage: /plan reopen [revision] <step-number>");
					return;
				}
				if (artifact.status !== "accepted" && artifact.status !== "executing" && artifact.status !== "completed") {
					deps.showWarning(`Plan v${artifact.revision} cannot reopen steps from ${artifact.status}.`);
					return;
				}
				await deps.reopenPlanStep(artifact, command.stepIndex);
				return;
			}
			case "next":
				await deps.executeNextPlanStep(command.revision);
				return;
			case "step": {
				const artifact = resolvePlanArtifact(command.revision, "execution");
				if (!artifact) {
					deps.showWarning(
						command.revision === undefined
							? "No accepted plan artifact to execute."
							: `No saved plan artifact for revision ${command.revision}.`,
					);
					return;
				}
				if (artifact.status !== "accepted" && artifact.status !== "executing") {
					deps.showWarning(
						command.revision === undefined
							? "Accept the latest plan first with /plan accept before executing a step."
							: `Accept plan revision ${artifact.revision} first with /plan accept ${artifact.revision} before executing a step.`,
					);
					return;
				}
				if (command.stepIndex === undefined || !artifact.steps[command.stepIndex]) {
					deps.showWarning("Usage: /plan step [revision] <step-number>");
					return;
				}
				await deps.executePlanArtifact(artifact, command.stepIndex);
				return;
			}
			case "execute": {
				const artifact = resolvePlanArtifact(command.revision, "execution");
				if (!artifact) {
					deps.showWarning(
						command.revision === undefined
							? "No accepted plan artifact to execute."
							: `No saved plan artifact for revision ${command.revision}.`,
					);
					return;
				}
				if (artifact.status !== "accepted") {
					deps.showWarning(
						command.revision === undefined
							? "Accept the latest plan first with /plan accept before executing it."
							: `Accept plan revision ${artifact.revision} first with /plan accept ${artifact.revision} before executing it.`,
					);
					return;
				}
				await deps.executePlanArtifact(artifact);
				return;
			}
		}
	} catch (error) {
		deps.showError(error instanceof Error ? error.message : String(error));
	}
}
