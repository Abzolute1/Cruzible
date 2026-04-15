import {
	getClarificationAnswers,
	getAnsweredClarificationCount,
	getCompletedStepCount,
	getCompletedStepIndexes,
	getLatestInteractivePlanStepExecutionRecord,
	getNextInteractivePlanStepIndex,
	getNextInteractivePlanStep,
	type InteractivePlanArtifact,
} from "./interactive-plan-artifacts.js";

export function summarizeInteractivePlanForModeLine(
	artifact: InteractivePlanArtifact | undefined,
	planningMode: boolean,
): string[] {
	if (!artifact || artifact.status === "discarded") return [];

	const summary = [`plan v${artifact.revision}`];
	switch (artifact.status) {
		case "draft":
			summary.push(`${getCompletedStepCount(artifact)}/${artifact.steps.length} complete`);
			summary.push(planningMode ? "ready for review" : "draft saved");
			break;
		case "clarifying":
			summary.push(`interview ${getAnsweredClarificationCount(artifact)}/${artifact.openQuestions.length}`);
			summary.push("awaiting clarification");
			break;
		case "accepted":
			summary.push(`${getCompletedStepCount(artifact)}/${artifact.steps.length} complete`);
			summary.push(planningMode ? "accepted" : "accepted plan ready");
			break;
		case "rejected":
			summary.push(`${getCompletedStepCount(artifact)}/${artifact.steps.length} complete`);
			summary.push("rejected");
			break;
		case "superseded":
			summary.push(`${getCompletedStepCount(artifact)}/${artifact.steps.length} complete`);
			summary.push("superseded");
			break;
		case "executing":
			summary.push(`${getCompletedStepCount(artifact)}/${artifact.steps.length} complete`);
			summary.push("executing");
			break;
	}
	const latestReview = getLatestInteractivePlanStepExecutionRecord(artifact);
	if (latestReview?.status === "blocked") {
		summary.push("blocked");
	}
	return summary;
}

export function buildInteractivePlanReviewLines(
	artifact: InteractivePlanArtifact | undefined,
): string[] {
	if (!artifact || artifact.status === "discarded") return [];

	const lines = [
		formatPlanReviewTitle(artifact),
		`Goal: ${artifact.goal}`,
		formatPlanProgressLine(artifact),
	];

	const nextStep = getNextInteractivePlanStep(artifact);
	const latestReview = getLatestInteractivePlanStepExecutionRecord(artifact);
	if (nextStep) {
		lines.push(`Next: ${nextStep}`);
	} else if (artifact.steps.length > 0) {
		lines.push("Next: all steps completed");
	}
	if (latestReview) {
		lines.push(`Latest Review: step ${latestReview.stepIndex + 1} • ${latestReview.status}`);
	}

	switch (artifact.status) {
		case "draft":
			lines.push("Actions: review • approve • approve + clear • revise");
			break;
		case "clarifying":
			if (getCurrentClarifyingQuestion(artifact)) {
				lines.push(`Current question: ${getCurrentClarifyingQuestion(artifact)}`);
			}
			lines.push("Actions: interview • continue planning • clear");
			break;
		case "accepted":
			lines.push("Actions: review • execute next • execute step • revise");
			break;
		case "rejected":
			if (artifact.rejectedReason) {
				lines.push(`Rejected: ${artifact.rejectedReason}`);
			}
			lines.push("Actions: show revision • revise");
			break;
		case "superseded":
			if (artifact.steps[0]) {
				lines.push(`Previous next step: ${artifact.steps[0]}`);
			}
			lines.push("Actions: newer revision available");
			break;
		case "executing":
			if (artifact.executionStep) {
				lines.push(`Executing: ${artifact.executionStep}`);
			}
			lines.push("Actions: review • mark done • reopen step");
			break;
	}

	return lines;
}

export function buildInteractivePlanCardLines(
	artifact: InteractivePlanArtifact,
): string[] {
	const lines = [
		`Plan v${artifact.revision} · ${artifact.status}`,
		`Goal: ${artifact.goal}`,
		formatPlanProgressLine(artifact),
	];

	const nextStep = getNextInteractivePlanStep(artifact);
	const latestReview = getLatestInteractivePlanStepExecutionRecord(artifact);
	if (artifact.executionStep) {
		lines.push(`Executing: ${artifact.executionStep}`);
	} else if (artifact.status === "clarifying" && getCurrentClarifyingQuestion(artifact)) {
		lines.push(`Current question: ${getCurrentClarifyingQuestion(artifact)}`);
	} else if (nextStep) {
		lines.push(`Next: ${nextStep}`);
	} else if (artifact.steps.length > 0) {
		lines.push("Next: all steps completed");
	}

	if (artifact.feedback) {
		lines.push(`Feedback: ${artifact.feedback}`);
	}
	if (artifact.rejectedReason) {
		lines.push(`Rejected: ${artifact.rejectedReason}`);
	}
	if (latestReview) {
		lines.push(`Latest Review: step ${latestReview.stepIndex + 1} • ${latestReview.status}`);
		if (latestReview.summary) {
			lines.push(`Review Summary: ${latestReview.summary}`);
		}
	}

	switch (artifact.status) {
		case "draft":
			lines.push("Actions: review, approve, approve + clear, revise");
			break;
		case "clarifying":
			lines.push("Actions: interview, continue planning, clear");
			break;
		case "accepted":
			lines.push("Actions: review, execute next, execute step, mark done");
			break;
		case "rejected":
			lines.push("Actions: show revision, revise");
			break;
		case "superseded":
			lines.push("Actions: plan history, show revision");
			break;
		case "executing":
			lines.push("Actions: review, mark done, reopen step, revise");
			break;
	}

	return lines;
}

export function buildInteractivePlanInterviewLines(
	artifact: InteractivePlanArtifact,
): string[] {
	const lines = [
		`Goal: ${artifact.goal}`,
		`Interview: ${getAnsweredClarificationCount(artifact)}/${artifact.openQuestions.length} answered`,
	];

	if (artifact.summary) {
		lines.push(`Summary: ${artifact.summary}`);
	}

	if (artifact.openQuestions.length > 0) {
		lines.push("");
		lines.push("Questions");
		const answers = getClarificationAnswers(artifact);
		for (let i = 0; i < artifact.openQuestions.length; i++) {
			const status = answers[i]?.trim() ? "[answered]" : "[open]";
			lines.push(`${status} Q${i + 1}. ${artifact.openQuestions[i]}`);
			const options = artifact.clarificationOptionSets?.[i]?.filter((option) => option.trim().length > 0) ?? [];
			if (!answers[i]?.trim() && options.length >= 2) {
				const preview = options.slice(0, 4).join(" • ");
				const suffix = options.length > 4 ? " • …" : "";
				lines.push(`  Choices: ${preview}${suffix}`);
			}
			if (answers[i]?.trim()) {
				lines.push(`  A${i + 1}. ${answers[i]!.trim()}`);
			}
		}
	}

	lines.push("");
	lines.push("Guidance");
	lines.push("Answer only the choices the codebase cannot infer.");
	lines.push("Continue planning once the key decisions are fixed.");
	return lines;
}

export function buildInteractiveExpandedPlanCardLines(
	artifact: InteractivePlanArtifact,
): string[] {
	const lines = [
		`Plan v${artifact.revision} · ${artifact.status}`,
		`Goal: ${artifact.goal}`,
		formatPlanProgressLine(artifact),
	];

	if (artifact.feedback) lines.push(`Feedback: ${artifact.feedback}`);
	if (artifact.rejectedReason) lines.push(`Rejected: ${artifact.rejectedReason}`);
	if (artifact.executionStep) lines.push(`Executing: ${artifact.executionStep}`);
	const latestReview = getLatestInteractivePlanStepExecutionRecord(artifact);
	if (latestReview) lines.push(`Latest Review: step ${latestReview.stepIndex + 1} • ${latestReview.status}`);
	if (artifact.summary) {
		lines.push("");
		lines.push("Summary");
		lines.push(artifact.summary);
	}

	appendSection(lines, "Steps", formatExpandedPlanSteps(artifact));
	if (artifact.status === "clarifying" && artifact.openQuestions.length > 0) {
		appendSection(lines, "Clarifying Questions", artifact.openQuestions);
		appendSection(lines, "Clarification Answers", formatClarificationAnswerLines(artifact));
	} else {
		appendSection(lines, "Open Questions", artifact.openQuestions);
	}
	appendSection(lines, "Assumptions", artifact.assumptions);
	appendSection(lines, "Constraints", artifact.constraints);
	appendSection(lines, "Risks", artifact.risks);
	appendSection(lines, "Verification", artifact.verification);
	appendSection(lines, "Latest Step Review", formatExecutionReviewLines(latestReview));

	lines.push("");
	switch (artifact.status) {
		case "draft":
			lines.push("Review Actions");
			lines.push("Approve, approve + clear, revise, or reject.");
			lines.push("Hotkeys: Alt+R review");
			break;
		case "clarifying":
			lines.push("Review Actions");
			lines.push("Continue the interview, answer only what the code cannot infer, then continue planning.");
			lines.push("Hotkeys: Alt+R review");
			break;
		case "accepted":
			lines.push("Execution Actions");
			lines.push("Execute the next step or promote a selected step into execution.");
			lines.push("Hotkeys: Alt+R review, Alt+N execute next step");
			break;
		case "executing":
			lines.push("Execution Actions");
			lines.push("Track step progress, mark the current step done, or reopen completed work.");
			lines.push("Hotkeys: Alt+R review, Alt+N execute next step");
			break;
		default:
			lines.push("Review Actions");
			lines.push("Use /plan history or /plan review to inspect other revisions.");
			break;
	}

	return lines;
}

function appendSection(lines: string[], title: string, items: string[]): void {
	if (items.length === 0) return;
	lines.push("");
	lines.push(title);
	for (const item of items) {
		lines.push(`- ${item}`);
	}
}

function formatPlanReviewTitle(artifact: InteractivePlanArtifact): string {
	if (artifact.status === "clarifying") {
		return `Plan Review: v${artifact.revision} • clarifying • interview ${getAnsweredClarificationCount(artifact)}/${artifact.openQuestions.length}`;
	}
	return `Plan Review: v${artifact.revision} • ${artifact.status} • ${artifact.steps.length} steps`;
}

function formatPlanProgressLine(artifact: InteractivePlanArtifact): string {
	if (artifact.status === "clarifying") {
		return `Interview: ${getAnsweredClarificationCount(artifact)}/${artifact.openQuestions.length} answered`;
	}
	return `Progress: ${getCompletedStepCount(artifact)}/${artifact.steps.length} complete`;
}

function getCurrentClarifyingQuestion(artifact: InteractivePlanArtifact): string | undefined {
	const answers = getClarificationAnswers(artifact);
	const nextOpenIndex = artifact.openQuestions.findIndex((_, index) => !answers[index]?.trim());
	if (nextOpenIndex >= 0) return artifact.openQuestions[nextOpenIndex];
	return artifact.openQuestions[0];
}

function formatExpandedPlanSteps(artifact: InteractivePlanArtifact): string[] {
	const completed = new Set(getCompletedStepIndexes(artifact));
	const nextStepIndex = getNextInteractivePlanStepIndex(artifact);
	return artifact.steps.map((step, index) => {
		if (artifact.executionStepIndex === index) {
			return `${index + 1}. [executing] ${step}`;
		}
		if (completed.has(index)) {
			return `${index + 1}. [done] ${step}`;
		}
		if (nextStepIndex === index) {
			return `${index + 1}. [next] ${step}`;
		}
		return `${index + 1}. ${step}`;
	});
}

function formatClarificationAnswerLines(artifact: InteractivePlanArtifact): string[] {
	const answers = getClarificationAnswers(artifact);
	return artifact.openQuestions.flatMap((question, index) => {
		const answer = answers[index]?.trim();
		if (!answer) return [];
		return [`Q${index + 1}. ${question}`, `A${index + 1}. ${answer}`];
	});
}

function formatExecutionReviewLines(
	record: ReturnType<typeof getLatestInteractivePlanStepExecutionRecord>,
): string[] {
	if (!record) return [];
	const lines = [`Step ${record.stepIndex + 1} · ${record.status}`];
	if (record.summary) lines.push(record.summary);
	for (const file of record.filesTouched) {
		lines.push(`file: ${file}`);
	}
	for (const item of record.verification) {
		lines.push(`verified: ${item}`);
	}
	for (const item of record.remaining) {
		lines.push(`remaining: ${item}`);
	}
	for (const item of record.blockers) {
		lines.push(`blocked: ${item}`);
	}
	return lines;
}
