import type { ExtensionUIDialogOptions } from "../../core/extensions/index.js";
import type { SessionManager } from "../../core/session-manager.js";
import type { PlanWorkflowDialogOption } from "./components/plan-workflow-dialog.js";
import type { InteractiveBuiltinCommand } from "./interactive-command-parser.js";
import {
	getAnsweredClarificationCount,
	getClarificationAnswers,
	INTERACTIVE_PLAN_ARTIFACT_TYPE,
	type InteractivePlanArtifact,
	setInteractivePlanClarificationAnswer,
} from "./interactive-plan-artifacts.js";
import { buildInteractivePlanInterviewLines } from "./interactive-plan-review-ui.js";

export function createPlanWorkflowOption(id: string, label: string, hotkey?: string): PlanWorkflowDialogOption {
	return { id, label, hotkey };
}

export function formatPlanInterviewQuestionOption(artifact: InteractivePlanArtifact, index: number): string {
	const answer = getClarificationAnswers(artifact)[index]?.trim();
	const prefix = answer ? "[answered]" : "[open]";
	return `${prefix} Q${index + 1}. ${artifact.openQuestions[index]}`;
}

export function getNextOpenPlanInterviewQuestionIndex(artifact: InteractivePlanArtifact): number | undefined {
	const answers = getClarificationAnswers(artifact);
	for (let i = 0; i < artifact.openQuestions.length; i++) {
		if (!answers[i]?.trim()) return i;
	}
	return undefined;
}

export function splitPlanInterviewChoiceOptions(text: string): string[] {
	const normalized = text.replace(/\?+\s*$/, "").trim();
	if (!/[;,]|\bor\b/i.test(normalized)) {
		const questionFragments = normalized
			.split(/\?\s+/)
			.map((fragment) => fragment.trim())
			.filter(Boolean);
		if (questionFragments.length >= 2) {
			return questionFragments;
		}
	}
	const options: string[] = [];
	let current = "";
	let parenDepth = 0;
	for (let i = 0; i < normalized.length; i++) {
		const char = normalized[i]!;
		if (char === "(") {
			parenDepth++;
			current += char;
			continue;
		}
		if (char === ")") {
			parenDepth = Math.max(0, parenDepth - 1);
			current += char;
			continue;
		}
		if (parenDepth === 0 && char === ",") {
			if (current.trim()) options.push(current.trim());
			current = "";
			continue;
		}
		const remaining = normalized.slice(i).toLowerCase();
		if (parenDepth === 0 && (remaining.startsWith(" or ") || remaining.startsWith(", or "))) {
			if (current.trim()) options.push(current.trim());
			current = "";
			i += remaining.startsWith(", or ") ? 4 : 3;
			continue;
		}
		current += char;
	}
	if (current.trim()) options.push(current.trim());
	return options.map((option) => option.replace(/^(?:or|and)\s+/i, "").trim()).filter(Boolean);
}

export function getPlanInterviewChoiceOptions(question: string): string[] {
	const delimiterIndex = question.indexOf(":");
	const colonSource = delimiterIndex >= 0 ? question.slice(delimiterIndex + 1).trim() : "";
	const parenMatch = question.match(/\(([^()]+)\)/);
	const parenSource = parenMatch?.[1]?.trim() ?? "";
	const source =
		/[?,]|\bor\b/i.test(colonSource) && colonSource.length > 0
			? colonSource
			: /[?,]|\bor\b/i.test(parenSource)
				? parenSource
				: question.trim();
	const options = splitPlanInterviewChoiceOptions(source);
	return options
		.map((option) => option.replace(/\betc\.?$/i, "").trim())
		.filter((option) => option.length > 0 && option.toLowerCase() !== "etc")
		.filter((option, index, array) => array.indexOf(option) === index)
		.slice(0, 8);
}

export function getPlanInterviewQuestionChoiceOptions(
	artifact: InteractivePlanArtifact,
	questionIndex: number,
): string[] {
	const artifactOptions =
		artifact.clarificationOptionSets?.[questionIndex]?.filter((option) => option.trim().length > 0) ?? [];
	if (artifactOptions.length >= 2) return artifactOptions;
	const question = artifact.openQuestions[questionIndex]!;
	return getPlanInterviewChoiceOptions(question);
}

export function shouldUseMultilinePlanInterviewAnswer(question: string, existingAnswer?: string): boolean {
	if (existingAnswer?.includes("\n")) return true;
	if (question.length > 100) return true;
	return /\b(requirements?|constraints?|edge cases?|trade-?offs?|architecture|data flow|verification|success criteria|acceptance criteria|notes?)\b/i.test(
		question,
	);
}

export function buildPlanInterviewAnswerBundle(artifact: InteractivePlanArtifact): string {
	const answers = getClarificationAnswers(artifact);
	return artifact.openQuestions
		.map((question, index) => {
			const answer = answers[index]?.trim();
			return [`Q${index + 1}: ${question}`, `A${index + 1}: ${answer || "(unanswered)"}`].join("\n");
		})
		.join("\n\n");
}

export interface PlanInterviewFlowDeps {
	sessionManager: SessionManager;
	showPlanWorkflowDialog: (
		title: string,
		lines: string[],
		options: PlanWorkflowDialogOption[],
		dialogOptions?: { accent?: "accent" | "warning" | "success" },
	) => Promise<string | undefined>;
	showExtensionEditor: (title: string, prefill?: string) => Promise<string | undefined>;
	showExtensionInput: (
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions & { initialValue?: string },
	) => Promise<string | undefined>;
	updatePendingMessagesDisplay: () => void;
	updateModeDisplay: () => void;
	showStatus: (message: string) => void;
	answerClarifyingPlanArtifact: (artifact: InteractivePlanArtifact, answer: string) => Promise<void>;
	showPlanArtifactCard: (artifact: InteractivePlanArtifact, options?: { expanded?: boolean }) => void;
	handlePlanCommand: (command: Extract<InteractiveBuiltinCommand, { kind: "plan" }>) => Promise<void>;
}

export class PlanInterviewFlow {
	constructor(private readonly deps: PlanInterviewFlowDeps) {}

	async promptForPlanInterviewAnswer(
		artifact: InteractivePlanArtifact,
		questionIndex: number,
	): Promise<"cancel" | "overview" | "skip" | string> {
		const question = artifact.openQuestions[questionIndex]!;
		const existingAnswer = getClarificationAnswers(artifact)[questionIndex]?.trim();
		const choiceOptions = getPlanInterviewQuestionChoiceOptions(artifact, questionIndex);
		if (choiceOptions.length >= 2) {
			const dialogOptions = [
				...choiceOptions.map((option, index) => createPlanWorkflowOption(`choice:${index}`, option)),
				createPlanWorkflowOption("custom_answer", "Custom answer", "c"),
				createPlanWorkflowOption("show_interview_overview", "Show interview overview", "o"),
				createPlanWorkflowOption("skip_interview", "Skip interview and plan immediately", "k"),
			];
			const selection = await this.deps.showPlanWorkflowDialog(
				`Plan interview • Q${questionIndex + 1}`,
				[
					question,
					...(existingAnswer ? ["", `Current answer: ${existingAnswer}`] : []),
					"",
					"Pick the closest option, or choose Custom answer.",
				],
				dialogOptions,
				{ accent: "warning" },
			);
			if (!selection) return "cancel";
			if (selection === "show_interview_overview") return "overview";
			if (selection === "skip_interview") return "skip";
			if (selection.startsWith("choice:")) {
				const choiceIndex = Number.parseInt(selection.slice("choice:".length), 10);
				return choiceOptions[choiceIndex] ?? "cancel";
			}
		}

		const answer = shouldUseMultilinePlanInterviewAnswer(question, existingAnswer)
			? await this.deps.showExtensionEditor(`Plan interview • Q${questionIndex + 1}\n${question}`, existingAnswer)
			: await this.deps.showExtensionInput(`Plan interview • Q${questionIndex + 1}\n${question}`, "Answer", {
					initialValue: existingAnswer,
				});
		return answer?.trim() ? answer.trim() : "cancel";
	}

	async persistPlanInterviewAnswer(
		artifact: InteractivePlanArtifact,
		questionIndex: number,
		answer: string,
	): Promise<InteractivePlanArtifact> {
		const updatedArtifact = setInteractivePlanClarificationAnswer(artifact, questionIndex, answer);
		this.deps.sessionManager.appendCustomEntry(INTERACTIVE_PLAN_ARTIFACT_TYPE, updatedArtifact);
		this.deps.updatePendingMessagesDisplay();
		this.deps.updateModeDisplay();
		this.deps.showStatus(
			`Interview: ${getAnsweredClarificationCount(updatedArtifact)}/${artifact.openQuestions.length} answered.`,
		);
		return updatedArtifact;
	}

	async continuePlanInterview(
		artifact: InteractivePlanArtifact,
		options?: { skipRemaining?: boolean },
	): Promise<void> {
		const bundle = buildPlanInterviewAnswerBundle(artifact);
		const answer = options?.skipRemaining
			? [
					"The user chose to stop the interview and continue planning now.",
					"Use any answered questions below, and make cautious assumptions for anything still unanswered.",
					"Call out those assumptions explicitly in the plan.",
					"",
					bundle,
				].join("\n")
			: bundle;
		await this.deps.answerClarifyingPlanArtifact(artifact, answer);
	}

	async showPlanInterview(artifact: InteractivePlanArtifact): Promise<void> {
		let currentArtifact = artifact;
		for (;;) {
			const nextOpenQuestionIndex = getNextOpenPlanInterviewQuestionIndex(currentArtifact);
			if (nextOpenQuestionIndex !== undefined) {
				const directAnswer = await this.promptForPlanInterviewAnswer(currentArtifact, nextOpenQuestionIndex);
				if (directAnswer === "cancel") return;
				if (directAnswer === "skip") {
					await this.continuePlanInterview(currentArtifact, { skipRemaining: true });
					return;
				}
				if (directAnswer !== "overview") {
					currentArtifact = await this.persistPlanInterviewAnswer(
						currentArtifact,
						nextOpenQuestionIndex,
						directAnswer,
					);
					continue;
				}
			}

			const answered = getAnsweredClarificationCount(currentArtifact);
			const options = [
				...currentArtifact.openQuestions.map((_, index) =>
					createPlanWorkflowOption(`question:${index}`, formatPlanInterviewQuestionOption(currentArtifact, index)),
				),
				...(answered > 0
					? [
							createPlanWorkflowOption(
								"continue_planning_with_current_answers",
								"Continue planning with current answers",
								"p",
							),
						]
					: []),
				createPlanWorkflowOption("skip_interview", "Skip interview and plan immediately", "k"),
				createPlanWorkflowOption("show_revision", "Show revision", "s"),
				createPlanWorkflowOption("clear_revision", "Clear revision", "d"),
			];
			const selection = await this.deps.showPlanWorkflowDialog(
				`Plan interview v${currentArtifact.revision} • ${answered}/${currentArtifact.openQuestions.length} answered`,
				buildInteractivePlanInterviewLines(currentArtifact),
				options,
				{ accent: "warning" },
			);
			if (!selection) return;
			if (selection === "continue_planning_with_current_answers") {
				await this.continuePlanInterview(currentArtifact);
				return;
			}
			if (selection === "skip_interview") {
				await this.continuePlanInterview(currentArtifact, { skipRemaining: true });
				return;
			}
			if (selection === "show_revision") {
				this.deps.showPlanArtifactCard(currentArtifact, { expanded: true });
				continue;
			}
			if (selection === "clear_revision") {
				await this.deps.handlePlanCommand({ kind: "plan", action: "clear", revision: currentArtifact.revision });
				return;
			}

			const selectedIndex = selection.startsWith("question:")
				? Number.parseInt(selection.slice("question:".length), 10)
				: -1;
			if (!Number.isInteger(selectedIndex) || selectedIndex < 0) continue;
			const answer = await this.promptForPlanInterviewAnswer(currentArtifact, selectedIndex);
			if (answer === "cancel" || answer === "overview") continue;
			if (answer === "skip") {
				await this.continuePlanInterview(currentArtifact, { skipRemaining: true });
				return;
			}
			currentArtifact = await this.persistPlanInterviewAnswer(currentArtifact, selectedIndex, answer);
		}
	}
}
