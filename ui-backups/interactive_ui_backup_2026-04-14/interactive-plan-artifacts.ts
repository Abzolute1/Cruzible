import { randomUUID } from "node:crypto";
import type { SessionEntry } from "../../core/session-manager.js";

export const INTERACTIVE_PLAN_ARTIFACT_TYPE = "interactive_plan_artifact";
export const INTERACTIVE_PLAN_SELECTION_TYPE = "interactive_plan_selection";

export type InteractivePlanStatus =
	| "draft"
	| "clarifying"
	| "accepted"
	| "rejected"
	| "superseded"
	| "discarded"
	| "executing";

export type InteractivePlanStepExecutionStatus = "reviewed" | "blocked" | "completed" | "reopened";

export interface InteractivePlanStepExecutionRecord {
	stepIndex: number;
	step: string;
	status: InteractivePlanStepExecutionStatus;
	summary?: string;
	filesTouched: string[];
	verification: string[];
	remaining: string[];
	blockers: string[];
	recordedAt: string;
}

export interface InteractivePlanArtifact {
	version: 1;
	planId: string;
	revision: number;
	status: InteractivePlanStatus;
	goal: string;
	summary?: string;
	assumptions: string[];
	constraints: string[];
	steps: string[];
	risks: string[];
	verification: string[];
	openQuestions: string[];
	clarificationOptionSets?: string[][];
	clarificationAnswers?: string[];
	rawPlan: string;
	feedback?: string;
	rejectedReason?: string;
	completedStepIndexes?: number[];
	executionStepIndex?: number;
	executionStep?: string;
	stepExecutionRecords?: InteractivePlanStepExecutionRecord[];
	createdAt: string;
	updatedAt: string;
}

export interface InteractivePlanArtifactRef {
	planId: string;
	revision: number;
}

export interface InteractivePlanSelection {
	version: 1;
	planning?: InteractivePlanArtifactRef;
	accepted?: InteractivePlanArtifactRef;
	executing?: InteractivePlanArtifactRef;
	updatedAt: string;
}

const INTERACTIVE_PLAN_STATUSES = new Set<InteractivePlanStatus>([
	"draft",
	"clarifying",
	"accepted",
	"rejected",
	"superseded",
	"discarded",
	"executing",
]);

const PLAN_STATUS_TRANSITIONS: Record<InteractivePlanStatus, ReadonlySet<InteractivePlanStatus>> = {
	draft: new Set(["draft", "accepted", "rejected", "discarded", "superseded"]),
	clarifying: new Set(["clarifying", "draft", "rejected", "discarded", "superseded"]),
	accepted: new Set(["accepted", "executing", "rejected", "discarded", "superseded"]),
	rejected: new Set(["rejected", "discarded"]),
	superseded: new Set(["superseded", "discarded"]),
	discarded: new Set(["discarded"]),
	executing: new Set(["executing", "accepted", "rejected", "discarded"]),
};

export function getLatestInteractivePlanArtifact(entries: SessionEntry[]): InteractivePlanArtifact | undefined {
	return getInteractivePlanArtifacts(entries, 1)[0];
}

export function getInteractivePlanArtifacts(entries: SessionEntry[], limit?: number): InteractivePlanArtifact[] {
	const artifacts: InteractivePlanArtifact[] = [];
	const seenRevisions = new Set<string>();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== INTERACTIVE_PLAN_ARTIFACT_TYPE) continue;
		const artifact = parseInteractivePlanArtifact(entry.data);
		if (!artifact) continue;
		const revisionKey = `${artifact.planId}:${artifact.revision}`;
		if (seenRevisions.has(revisionKey)) continue;
		seenRevisions.add(revisionKey);
		artifacts.push(artifact);
		if (limit && artifacts.length >= limit) break;
	}
	return artifacts;
}

export function createInteractivePlanArtifactRef(artifact: InteractivePlanArtifact): InteractivePlanArtifactRef {
	return {
		planId: artifact.planId,
		revision: artifact.revision,
	};
}

export function isSameInteractivePlanArtifactRef(
	left: InteractivePlanArtifactRef | undefined,
	right: InteractivePlanArtifactRef | undefined,
): boolean {
	return left?.planId === right?.planId && left?.revision === right?.revision;
}

export function getLatestInteractivePlanSelection(entries: SessionEntry[]): InteractivePlanSelection | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== INTERACTIVE_PLAN_SELECTION_TYPE) continue;
		const selection = parseInteractivePlanSelection(entry.data);
		if (selection) return selection;
	}
	return undefined;
}

export function resolveInteractivePlanArtifactRef(
	entries: SessionEntry[],
	ref: InteractivePlanArtifactRef | undefined,
): InteractivePlanArtifact | undefined {
	if (!ref) return undefined;
	for (const artifact of getInteractivePlanArtifacts(entries)) {
		if (artifact.planId === ref.planId && artifact.revision === ref.revision) {
			return artifact;
		}
	}
	return undefined;
}

export function createInteractivePlanSelection(
	previous: InteractivePlanSelection | undefined,
	updates: Partial<Pick<InteractivePlanSelection, "planning" | "accepted" | "executing">>,
	now?: string,
): InteractivePlanSelection {
	return {
		version: 1,
		planning: Object.prototype.hasOwnProperty.call(updates, "planning") ? updates.planning : previous?.planning,
		accepted: Object.prototype.hasOwnProperty.call(updates, "accepted") ? updates.accepted : previous?.accepted,
		executing: Object.prototype.hasOwnProperty.call(updates, "executing") ? updates.executing : previous?.executing,
		updatedAt: now ?? new Date().toISOString(),
	};
}

export function canTransitionInteractivePlanArtifact(
	current: InteractivePlanStatus,
	next: InteractivePlanStatus,
): boolean {
	return PLAN_STATUS_TRANSITIONS[current].has(next);
}

export function extractInteractivePlanArtifact(options: {
	goal: string;
	assistantText: string;
	now?: string;
	previous?: InteractivePlanArtifact;
	feedback?: string;
}): InteractivePlanArtifact | undefined {
	const rawPlan = options.assistantText.trim();
	if (!rawPlan) return undefined;
	const normalizedGoal = normalizeInteractivePlanGoal(options.goal);

	const questionSection = findSection(rawPlan, ["questions", "open questions", "clarifying questions"]);
	const normalizedQuestions = normalizeClarifyingPromptItems(
		extractClarifyingPromptItems(questionSection, ["bullet", "numbered"]),
	);
	const fallbackQuestions = normalizedQuestions.length === 0 && questionSection ? buildFallbackClarifyingQuestions(options.goal) : [];
	const extractedQuestions = applyFallbackClarifyingOptions(
		options.goal,
		normalizedQuestions.length > 0 ? normalizedQuestions : fallbackQuestions,
	);
	const openQuestions = extractedQuestions.map((question) => question.prompt);
	const clarificationOptionSets = extractedQuestions.map((question) => question.options);
	const hasClarifyingHeading =
		/^(?:#{1,6}\s*)?(clarifying questions|questions|open questions)\b/im.test(rawPlan) ||
		/^(?:before i propose a plan|before i can propose a plan|i need (?:a few )?answers|clarifying questions?|questions?)\b/im.test(
			rawPlan,
		);
	const stepSection = findSection(rawPlan, ["plan", "steps", "execution plan"]);
	const steps = stepSection
		? extractPlanStepItems(stepSection)
		: hasClarifyingHeading
			? extractStepLabelItems(rawPlan)
			: [...extractNumberedItems(rawPlan), ...extractStepLabelItems(rawPlan)];
	const assumptions = extractBulletItems(findSection(rawPlan, ["assumptions"]));
	const constraints = extractBulletItems(findSection(rawPlan, ["constraints"]));
	const risks = extractBulletItems(findSection(rawPlan, ["risks", "risk"]));
	const verification = extractBulletItems(findSection(rawPlan, ["verification", "verify", "validation"]));
	const summary = extractPlanSummary(rawPlan);
	const stepQuestions = steps.filter(isClarifyingQuestionLike);
	const normalizedStepQuestions = normalizeClarifyingPromptItems(
		extractClarifyingPromptItems(stepSection ?? rawPlan, ["numbered", "step"]),
	);
	const fallbackStepQuestions =
		normalizedStepQuestions.length === 0 && stepQuestions.length > 0 ? buildFallbackClarifyingQuestions(options.goal) : [];
	const extractedStepQuestions = applyFallbackClarifyingOptions(
		options.goal,
		normalizedStepQuestions.length > 0 ? normalizedStepQuestions : fallbackStepQuestions,
	);
	const shouldReclassifyStepsAsQuestions =
		openQuestions.length === 0 &&
		steps.length > 0 &&
		stepQuestions.length === steps.length &&
		assumptions.length === 0 &&
		constraints.length === 0 &&
		risks.length === 0 &&
		verification.length === 0 &&
		(summary && /clarif|need (?:a few )?clarif|need (?:a few )?answers|need to know|before i can/i.test(summary) ||
			/clarif|need (?:a few )?clarif|need (?:a few )?answers|need to know|before i can/i.test(rawPlan));
	const effectiveOpenQuestions = shouldReclassifyStepsAsQuestions
		? extractedStepQuestions.map((question) => question.prompt)
		: openQuestions;
	const effectiveClarificationOptionSets = shouldReclassifyStepsAsQuestions
		? extractedStepQuestions.map((question) => question.options)
		: clarificationOptionSets;
	const effectiveSteps = shouldReclassifyStepsAsQuestions ? [] : steps;
	const shouldForceClarifyingForFoundationalChoices =
		effectiveSteps.length > 0 &&
		effectiveOpenQuestions.length > 0 &&
		!options.previous &&
		isGreenfieldGenericPlanningGoal(options.goal) &&
		hasMissingFoundationalPlanningChoices(effectiveOpenQuestions);
	const finalSteps = shouldForceClarifyingForFoundationalChoices ? [] : effectiveSteps;

	const hasPlanSignal =
		finalSteps.length >= 2 ||
		/headings?:/i.test(rawPlan) ||
		/^(?:#{1,6}\s*)?(plan|steps|execution plan)\b/im.test(rawPlan);
	const hasClarifyingSignal =
		effectiveOpenQuestions.length > 0 &&
		(hasClarifyingHeading || shouldReclassifyStepsAsQuestions || shouldForceClarifyingForFoundationalChoices);
	if ((!hasPlanSignal || finalSteps.length === 0) && !hasClarifyingSignal) return undefined;

	const now = options.now ?? new Date().toISOString();
	return {
		version: 1,
		planId: options.previous?.planId ?? createPlanId(),
		revision: (options.previous?.revision ?? 0) + 1,
		status: finalSteps.length > 0 ? "draft" : "clarifying",
		goal: normalizedGoal,
		summary,
		assumptions,
		constraints,
		steps: finalSteps,
		risks,
		verification,
		openQuestions: effectiveOpenQuestions,
		clarificationOptionSets: effectiveClarificationOptionSets,
		clarificationAnswers: options.previous?.clarificationAnswers,
		rawPlan,
		feedback: options.feedback?.trim() || undefined,
		createdAt: options.previous?.createdAt ?? now,
		updatedAt: now,
	};
}

export function buildFallbackInteractivePlanArtifact(options: {
	goal: string;
	now?: string;
	previous?: InteractivePlanArtifact;
	feedback?: string;
	rawPlan?: string;
}): InteractivePlanArtifact | undefined {
	if (options.previous) return undefined;
	if (!shouldStartWithFallbackPlanningInterview(options.goal)) return undefined;
	const fallbackQuestions = buildFallbackClarifyingQuestions(options.goal);
	if (fallbackQuestions.length === 0) return undefined;
	const now = options.now ?? new Date().toISOString();
	return {
		version: 1,
		planId: createPlanId(),
		revision: 1,
		status: "clarifying",
		goal: normalizeInteractivePlanGoal(options.goal),
		summary: "A few core implementation choices need to be fixed before a concrete plan can be drafted.",
		assumptions: [],
		constraints: [],
		steps: [],
		risks: [],
		verification: [],
		openQuestions: fallbackQuestions.map((question) => question.prompt),
		clarificationOptionSets: fallbackQuestions.map((question) => question.options),
		clarificationAnswers: undefined,
		rawPlan: options.rawPlan?.trim() || "",
		feedback: options.feedback?.trim() || undefined,
		createdAt: now,
		updatedAt: now,
	};
}

export function shouldStartWithFallbackPlanningInterview(goal: string): boolean {
	return isGreenfieldGenericPlanningGoal(goal) && hasGoalMissingFoundationalPlanningChoices(goal);
}

export function updateInteractivePlanArtifactStatus(
	artifact: InteractivePlanArtifact,
	status: InteractivePlanStatus,
	now?: string,
	overrides?: Partial<
		Pick<
			InteractivePlanArtifact,
			"rejectedReason" | "completedStepIndexes" | "executionStepIndex" | "executionStep" | "stepExecutionRecords"
		>
	> & Pick<InteractivePlanArtifact, "clarificationAnswers">,
): InteractivePlanArtifact {
	if (!canTransitionInteractivePlanArtifact(artifact.status, status)) {
		throw new Error(`Illegal interactive plan transition: ${artifact.status} -> ${status}`);
	}
	return {
		...artifact,
		status,
		...overrides,
		updatedAt: now ?? new Date().toISOString(),
	};
}

export function formatInteractivePlanArtifact(artifact: InteractivePlanArtifact): string {
	const lines: string[] = [];
	lines.push(`Plan ${artifact.revision} · ${artifact.status}`);
	lines.push(`Goal: ${artifact.goal}`);
	lines.push(`Progress: ${getCompletedStepCount(artifact)}/${artifact.steps.length} steps complete`);
	if (artifact.feedback) {
		lines.push(`Feedback: ${artifact.feedback}`);
	}
	if (artifact.rejectedReason) {
		lines.push(`Rejected: ${artifact.rejectedReason}`);
	}
	if (artifact.executionStep) {
		lines.push(`Execution Step: ${artifact.executionStep}`);
	}
	const latestExecutionReview = getLatestInteractivePlanStepExecutionRecord(artifact);
	if (latestExecutionReview) {
		lines.push(
			`Latest Review: step ${latestExecutionReview.stepIndex + 1} · ${latestExecutionReview.status}${
				latestExecutionReview.summary ? ` · ${latestExecutionReview.summary}` : ""
			}`,
		);
	}
	if (artifact.summary) {
		lines.push("");
		lines.push("Summary:");
		lines.push(artifact.summary);
	}
	appendSection(lines, "Steps", formatInteractivePlanSteps(artifact), true);
	if (artifact.status === "clarifying" && artifact.openQuestions.length > 0) {
		appendSection(lines, "Clarifying Questions", artifact.openQuestions);
		appendSection(lines, "Clarification Answers", formatInteractiveClarificationAnswers(artifact));
	} else {
		appendSection(lines, "Open Questions", artifact.openQuestions);
	}
	appendSection(lines, "Assumptions", artifact.assumptions);
	appendSection(lines, "Constraints", artifact.constraints);
	appendSection(lines, "Risks", artifact.risks);
	appendSection(lines, "Verification", artifact.verification);
	appendSection(lines, "Recent Execution Review", formatInteractivePlanExecutionReview(latestExecutionReview));
	return lines.join("\n");
}

export function formatInteractivePlanHistory(artifacts: InteractivePlanArtifact[]): string {
	if (artifacts.length === 0) return "No saved plan history yet.";

	const lines: string[] = ["Plan History"];
	for (const artifact of artifacts) {
		lines.push("");
		lines.push(`v${artifact.revision} · ${artifact.status} · ${artifact.steps.length} steps`);
		lines.push(`Goal: ${artifact.goal}`);
		lines.push(`Progress: ${getCompletedStepCount(artifact)}/${artifact.steps.length} complete`);
		if (artifact.feedback) {
			lines.push(`Feedback: ${artifact.feedback}`);
		}
		if (artifact.rejectedReason) {
			lines.push(`Rejected: ${artifact.rejectedReason}`);
		}
		if (artifact.executionStep) {
			lines.push(`Execution Step: ${artifact.executionStep}`);
		}
		const latestExecutionReview = getLatestInteractivePlanStepExecutionRecord(artifact);
		if (latestExecutionReview) {
			lines.push(`Latest Review: step ${latestExecutionReview.stepIndex + 1} · ${latestExecutionReview.status}`);
		}
		if (artifact.status === "clarifying" && artifact.openQuestions[0]) {
			lines.push(`Clarify: ${artifact.openQuestions[0]}`);
			lines.push(`Interview: ${getAnsweredClarificationCount(artifact)}/${artifact.openQuestions.length} answered`);
		}
		const nextStep = getNextInteractivePlanStep(artifact);
		if (nextStep) {
			lines.push(`Next: ${nextStep}`);
		}
		lines.push(`Updated: ${artifact.updatedAt}`);
	}
	return lines.join("\n");
}

export function buildPlanRevisionPrompt(artifact: InteractivePlanArtifact, feedback: string): string {
	const lines = [
		`Revise the saved execution plan for this goal: ${artifact.goal}`,
		"",
		"Revision requirements:",
		"- stay in planning mode and do not execute anything",
		"- preserve the good parts of the current plan",
		"- address the feedback directly",
		"- return a full revised plan, not just deltas",
		"- structure the answer with: Summary, Assumptions, Constraints, Steps, Risks, Verification",
		"",
		"Current saved plan:",
		artifact.rawPlan,
		"",
		"User feedback:",
		feedback.trim(),
	];
	return lines.join("\n");
}

export function buildPlanClarificationPrompt(artifact: InteractivePlanArtifact, answer: string): string {
	const interviewContext = formatInteractiveClarificationContext(artifact);
	const lines = [
		`Continue planning for this goal: ${artifact.goal}`,
		"",
		"Planning requirements:",
		"- stay in planning mode and do not execute anything",
		"- use the saved clarifying questions and the user's answers",
		"- return a full revised plan, not just notes",
		"- structure the answer with: Summary, Assumptions, Constraints, Steps, Risks, Verification",
		"",
		"Current planning state:",
		formatInteractivePlanArtifact(artifact),
		...(interviewContext ? ["", "Saved interview answers:", interviewContext] : []),
		"",
		"User clarification:",
		answer.trim(),
	];
	return lines.join("\n");
}

export function buildPlanExecutionPrompt(artifact: InteractivePlanArtifact): string {
	const nextStepIndex = getNextInteractivePlanStepIndex(artifact);
	const lines = [
		`Execute the accepted plan for this goal: ${artifact.goal}`,
		"",
		"Execution requirements:",
		"- do not restate the full plan unless needed",
		"- continue from the next incomplete step and make real progress",
		"- use tools as needed",
		"- verify work as you go",
		"- stop after the next meaningful slice if the task is not complete",
		"- finish with exact markdown headings: Execution Status, Execution Summary, Files Touched, Verification, Remaining, Blockers",
		"- under Execution Status, use exactly one of: reviewed, blocked, completed",
		"- under Files Touched, Verification, Remaining, and Blockers, use bullet lists",
		...(nextStepIndex === undefined ? [] : ["", `Next incomplete step: ${nextStepIndex + 1}. ${artifact.steps[nextStepIndex]}`]),
		"",
		"Accepted plan:",
		formatInteractivePlanArtifact(artifact),
	];
	return lines.join("\n");
}

export function buildPlanStepExecutionPrompt(artifact: InteractivePlanArtifact, stepIndex: number): string {
	const step = artifact.steps[stepIndex];
	const lines = [
		`Execute only step ${stepIndex + 1} of the accepted plan for this goal: ${artifact.goal}`,
		"",
		"Execution requirements:",
		"- focus only on the selected step",
		"- do not try to complete the whole plan in one pass",
		"- make real progress on this step",
		"- verify the result of this step before stopping",
		"- briefly note what remains for the later steps",
		"- treat any already-completed steps as done unless the work proves they must be reopened",
		"- finish with exact markdown headings: Execution Status, Execution Summary, Files Touched, Verification, Remaining, Blockers",
		"- under Execution Status, use exactly one of: reviewed, blocked, completed",
		"- under Files Touched, Verification, Remaining, and Blockers, use bullet lists",
		"",
		`Selected step: ${step}`,
		"",
		"Accepted plan:",
		formatInteractivePlanArtifact(artifact),
	];
	return lines.join("\n");
}

export function getCompletedStepIndexes(artifact: InteractivePlanArtifact): number[] {
	return normalizeCompletedStepIndexes(artifact.completedStepIndexes, artifact.steps.length);
}

export function getClarificationAnswers(artifact: InteractivePlanArtifact): string[] {
	return normalizeStringSlots(artifact.clarificationAnswers);
}

export function getAnsweredClarificationCount(artifact: InteractivePlanArtifact): number {
	return getClarificationAnswers(artifact).filter((answer) => answer.trim().length > 0).length;
}

export function setInteractivePlanClarificationAnswer(
	artifact: InteractivePlanArtifact,
	questionIndex: number,
	answer: string,
	now?: string,
): InteractivePlanArtifact {
	const answers = [...getClarificationAnswers(artifact)];
	for (let i = answers.length; i < artifact.openQuestions.length; i++) answers[i] = "";
	answers[questionIndex] = answer.trim();
	return updateInteractivePlanArtifactStatus(artifact, artifact.status, now, {
		clarificationAnswers: answers,
	});
}

export function getCompletedStepCount(artifact: InteractivePlanArtifact): number {
	return getCompletedStepIndexes(artifact).length;
}

export function getNextInteractivePlanStepIndex(artifact: InteractivePlanArtifact): number | undefined {
	const completed = new Set(getCompletedStepIndexes(artifact));
	for (let i = 0; i < artifact.steps.length; i++) {
		if (!completed.has(i)) return i;
	}
	return undefined;
}

export function getNextInteractivePlanStep(artifact: InteractivePlanArtifact): string | undefined {
	const nextStepIndex = getNextInteractivePlanStepIndex(artifact);
	return nextStepIndex === undefined ? undefined : artifact.steps[nextStepIndex];
}

export function getLatestInteractivePlanStepExecutionRecord(
	artifact: InteractivePlanArtifact,
	stepIndex?: number,
): InteractivePlanStepExecutionRecord | undefined {
	const records = normalizeStepExecutionRecords(artifact.stepExecutionRecords, artifact.steps);
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index]!;
		if (stepIndex === undefined || record.stepIndex === stepIndex) return record;
	}
	return undefined;
}

export function recordInteractivePlanStepExecutionReview(
	artifact: InteractivePlanArtifact,
	stepIndex: number,
	assistantText: string,
	now?: string,
): InteractivePlanArtifact {
	const record = parseInteractivePlanStepExecutionReview(assistantText, stepIndex, artifact.steps[stepIndex], now);
	if (!record) return artifact;
	const records = normalizeStepExecutionRecords(artifact.stepExecutionRecords, artifact.steps);
	return updateInteractivePlanArtifactStatus(artifact, artifact.status, now, {
		stepExecutionRecords: [...records, record],
	});
}

export function markInteractivePlanStepComplete(
	artifact: InteractivePlanArtifact,
	stepIndex: number,
	now?: string,
): InteractivePlanArtifact {
	if (artifact.status !== "accepted" && artifact.status !== "executing") {
		throw new Error(`Cannot mark steps complete from ${artifact.status} plan state.`);
	}
	const completed = new Set(getCompletedStepIndexes(artifact));
	completed.add(stepIndex);
	return updateInteractivePlanArtifactStatus(artifact, "accepted", now, {
		completedStepIndexes: Array.from(completed).sort((a, b) => a - b),
		executionStepIndex: undefined,
		executionStep: undefined,
		stepExecutionRecords: updatePlanExecutionRecordStatus(
			normalizeStepExecutionRecords(artifact.stepExecutionRecords, artifact.steps),
			stepIndex,
			"completed",
			artifact.steps[stepIndex],
			now,
		),
	});
}

export function reopenInteractivePlanStep(
	artifact: InteractivePlanArtifact,
	stepIndex: number,
	now?: string,
): InteractivePlanArtifact {
	if (artifact.status !== "accepted" && artifact.status !== "executing") {
		throw new Error(`Cannot reopen steps from ${artifact.status} plan state.`);
	}
	const completed = new Set(getCompletedStepIndexes(artifact));
	completed.delete(stepIndex);
	return updateInteractivePlanArtifactStatus(artifact, "accepted", now, {
		completedStepIndexes: Array.from(completed).sort((a, b) => a - b),
		executionStepIndex: undefined,
		executionStep: undefined,
		stepExecutionRecords: updatePlanExecutionRecordStatus(
			normalizeStepExecutionRecords(artifact.stepExecutionRecords, artifact.steps),
			stepIndex,
			"reopened",
			artifact.steps[stepIndex],
			now,
		),
	});
}

export function parseInteractivePlanStepExecutionReview(
	assistantText: string,
	stepIndex: number,
	step: string | undefined,
	now?: string,
): InteractivePlanStepExecutionRecord | undefined {
	const raw = assistantText.trim();
	if (!raw || !step) return undefined;
	const sections = parseExecutionReviewSections(raw);
	if (!sections) return undefined;
	const filesTouched = normalizeExecutionReviewItems(
		extractBulletItems(sections.filesTouched),
	);
	const verification = normalizeExecutionReviewItems(
		extractBulletItems(sections.verification),
	);
	const remaining = normalizeExecutionReviewItems(
		extractBulletItems(sections.remaining),
	);
	const blockers = normalizeExecutionReviewItems(
		extractBulletItems(sections.blockers),
	);
	const summary = normalizePlanItem(sections.summary);
	const status = extractInteractivePlanStepExecutionStatus(sections.status, blockers);
	if (!status) return undefined;
	if (!summary) return undefined;
	return {
		stepIndex,
		step,
		status,
		summary,
		filesTouched,
		verification,
		remaining,
		blockers,
		recordedAt: now ?? new Date().toISOString(),
	};
}

function normalizeExecutionReviewItems(items: string[]): string[] {
	return items.filter((item) => !/^(none|n\/a|no blockers|no remaining work|no files|no files touched)$/i.test(item.trim()));
}

function parseInteractivePlanArtifact(value: unknown): InteractivePlanArtifact | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<InteractivePlanArtifact>;
	if (candidate.version !== 1) return undefined;
	if (typeof candidate.planId !== "string" || typeof candidate.goal !== "string" || typeof candidate.rawPlan !== "string") {
		return undefined;
	}
	if (typeof candidate.revision !== "number" || typeof candidate.status !== "string") return undefined;
	if (!INTERACTIVE_PLAN_STATUSES.has(candidate.status as InteractivePlanStatus)) return undefined;
	const steps = normalizeStringArray(candidate.steps);
	const openQuestions = normalizeStringArray(candidate.openQuestions);
	const clarificationAnswers = normalizeStringSlots(candidate.clarificationAnswers);
	const normalized: InteractivePlanArtifact = {
		version: 1,
		planId: candidate.planId,
		revision: candidate.revision,
		status: candidate.status as InteractivePlanStatus,
		goal: candidate.goal,
		summary: typeof candidate.summary === "string" ? candidate.summary : undefined,
		assumptions: normalizeStringArray(candidate.assumptions),
		constraints: normalizeStringArray(candidate.constraints),
		steps,
		risks: normalizeStringArray(candidate.risks),
		verification: normalizeStringArray(candidate.verification),
		openQuestions,
		clarificationOptionSets: normalizeQuestionOptionSets(candidate.clarificationOptionSets),
		clarificationAnswers,
		rawPlan: candidate.rawPlan,
		feedback: typeof candidate.feedback === "string" ? candidate.feedback : undefined,
		rejectedReason: typeof candidate.rejectedReason === "string" ? candidate.rejectedReason : undefined,
		completedStepIndexes: normalizeCompletedStepIndexes(candidate.completedStepIndexes, steps.length),
		executionStepIndex: typeof candidate.executionStepIndex === "number" ? candidate.executionStepIndex : undefined,
		executionStep: typeof candidate.executionStep === "string" ? candidate.executionStep : undefined,
		stepExecutionRecords: normalizeStepExecutionRecords(candidate.stepExecutionRecords, steps),
		createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date().toISOString(),
		updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date().toISOString(),
	};
	return validateInteractivePlanArtifact(normalized) ? normalized : undefined;
}

function parseInteractivePlanSelection(value: unknown): InteractivePlanSelection | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<InteractivePlanSelection>;
	if (candidate.version !== 1) return undefined;
	const selection: InteractivePlanSelection = {
		version: 1,
		planning: normalizeInteractivePlanArtifactRef(candidate.planning),
		accepted: normalizeInteractivePlanArtifactRef(candidate.accepted),
		executing: normalizeInteractivePlanArtifactRef(candidate.executing),
		updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date().toISOString(),
	};
	return selection;
}

function normalizeInteractivePlanArtifactRef(value: unknown): InteractivePlanArtifactRef | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<InteractivePlanArtifactRef>;
	if (typeof candidate.planId !== "string") return undefined;
	if (typeof candidate.revision !== "number" || !Number.isInteger(candidate.revision) || candidate.revision <= 0) {
		return undefined;
	}
	return {
		planId: candidate.planId,
		revision: candidate.revision,
	};
}

function validateInteractivePlanArtifact(artifact: InteractivePlanArtifact): boolean {
	if (!INTERACTIVE_PLAN_STATUSES.has(artifact.status)) return false;
	if (artifact.revision <= 0 || !Number.isInteger(artifact.revision)) return false;
	if (artifact.status === "clarifying") {
		if (artifact.steps.length > 0) return false;
		if (artifact.openQuestions.length === 0) return false;
	}
	if (
		(artifact.status === "draft" || artifact.status === "accepted" || artifact.status === "executing") &&
		artifact.steps.length === 0
	) {
		return false;
	}
	if (artifact.status === "executing") {
		if (artifact.executionStepIndex === undefined) return false;
		if (!artifact.steps[artifact.executionStepIndex]) return false;
		if (artifact.executionStep !== artifact.steps[artifact.executionStepIndex]) return false;
	} else if (artifact.executionStepIndex !== undefined || artifact.executionStep !== undefined) {
		return false;
	}
	if (artifact.status === "accepted" && artifact.steps.length === 0) return false;
	if (
		artifact.clarificationAnswers &&
		artifact.openQuestions.length > 0 &&
		artifact.clarificationAnswers.length > artifact.openQuestions.length
	) {
		return false;
	}
	return true;
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function normalizeStringSlots(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => (typeof item === "string" ? item.trim() : ""));
}

function normalizeQuestionOptionSets(value: unknown): string[][] {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => normalizeStringArray(entry));
}

function normalizeStepExecutionRecords(
	value: unknown,
	steps: string[],
): InteractivePlanStepExecutionRecord[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((entry) => normalizeStepExecutionRecord(entry, steps))
		.filter((record): record is InteractivePlanStepExecutionRecord => Boolean(record));
}

function normalizeStepExecutionRecord(
	value: unknown,
	steps: string[],
): InteractivePlanStepExecutionRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<InteractivePlanStepExecutionRecord>;
	if (typeof candidate.stepIndex !== "number" || !Number.isInteger(candidate.stepIndex)) return undefined;
	if (candidate.stepIndex < 0 || candidate.stepIndex >= steps.length) return undefined;
	const step = typeof candidate.step === "string" && candidate.step.trim().length > 0 ? candidate.step.trim() : steps[candidate.stepIndex];
	if (!step) return undefined;
	const status = normalizePlanExecutionRecordStatus(candidate.status);
	if (!status) return undefined;
	return {
		stepIndex: candidate.stepIndex,
		step,
		status,
		summary: typeof candidate.summary === "string" && candidate.summary.trim().length > 0 ? candidate.summary.trim() : undefined,
		filesTouched: normalizeStringArray(candidate.filesTouched),
		verification: normalizeStringArray(candidate.verification),
		remaining: normalizeStringArray(candidate.remaining),
		blockers: normalizeStringArray(candidate.blockers),
		recordedAt: typeof candidate.recordedAt === "string" ? candidate.recordedAt : new Date().toISOString(),
	};
}

function normalizePlanExecutionRecordStatus(value: unknown): InteractivePlanStepExecutionStatus | undefined {
	return value === "reviewed" || value === "blocked" || value === "completed" || value === "reopened"
		? value
		: undefined;
}

function normalizeCompletedStepIndexes(value: unknown, stepCount: number): number[] {
	if (!Array.isArray(value)) return [];
	return Array.from(
		new Set(
			value.filter((item): item is number => typeof item === "number" && Number.isInteger(item) && item >= 0 && item < stepCount),
		),
	).sort((a, b) => a - b);
}

function updatePlanExecutionRecordStatus(
	records: InteractivePlanStepExecutionRecord[],
	stepIndex: number,
	status: InteractivePlanStepExecutionStatus,
	step: string | undefined,
	now?: string,
): InteractivePlanStepExecutionRecord[] {
	const updatedAt = now ?? new Date().toISOString();
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index]!;
		if (record.stepIndex !== stepIndex) continue;
		const updated = [...records];
		updated[index] = {
			...record,
			status,
			recordedAt: updatedAt,
		};
		return updated;
	}
	if (!step) return records;
	return [
		...records,
		{
			stepIndex,
			step,
			status,
			filesTouched: [],
			verification: [],
			remaining: [],
			blockers: [],
			recordedAt: updatedAt,
			summary:
				status === "completed"
					? "Marked complete from plan review."
					: status === "reopened"
						? "Reopened for more work."
						: undefined,
		},
	];
}

function extractInteractivePlanStepExecutionStatus(
	statusSection: string,
	blockers: string[],
): InteractivePlanStepExecutionStatus | undefined {
	const normalized = statusSection.replace(/\s+/g, " ").trim().toLowerCase();
	if (/\bblock(ed)?\b/.test(normalized)) return "blocked";
	if (/\bcomplete(d)?\b/.test(normalized)) return "completed";
	if (/\breview(ed)?\b|\bpartial\b|\bin progress\b/.test(normalized)) return "reviewed";
	return blockers.length > 0 ? "blocked" : undefined;
}

interface ParsedExecutionReviewSections {
	status: string;
	summary: string;
	filesTouched: string;
	verification: string;
	remaining: string;
	blockers: string;
}

function parseExecutionReviewSections(text: string): ParsedExecutionReviewSections | undefined {
	const status = findExecutionReviewSection(text, ["execution status"]);
	const summary = findExecutionReviewSection(text, ["execution summary", "step summary", "review summary"]);
	const filesTouched = findExecutionReviewSection(text, ["files touched", "touched files", "changed files", "files"]);
	const verification = findExecutionReviewSection(text, ["verification", "verified", "validation"]);
	const remaining = findExecutionReviewSection(text, ["remaining", "remaining work", "next", "follow-up"]);
	const blockers = findExecutionReviewSection(text, ["blockers", "blocked", "issues"]);
	if (!status || !summary || !filesTouched || !verification || !remaining || !blockers) {
		return undefined;
	}
	return { status, summary, filesTouched, verification, remaining, blockers };
}

function formatInteractivePlanExecutionReview(
	record: InteractivePlanStepExecutionRecord | undefined,
): string[] {
	if (!record) return [];
	const lines = [`Step ${record.stepIndex + 1} · ${record.status}`];
	if (record.summary) lines.push(record.summary);
	if (record.filesTouched.length > 0) {
		lines.push(`Files: ${record.filesTouched.join(", ")}`);
	}
	if (record.verification.length > 0) {
		lines.push(`Verification: ${record.verification.join("; ")}`);
	}
	if (record.remaining.length > 0) {
		lines.push(`Remaining: ${record.remaining.join("; ")}`);
	}
	if (record.blockers.length > 0) {
		lines.push(`Blockers: ${record.blockers.join("; ")}`);
	}
	return lines;
}

function createPlanId(): string {
	return `plan_${randomUUID()}`;
}

interface ParsedClarifyingPromptItem {
	head: string;
	continuations: string[];
}

interface NormalizedClarifyingQuestion {
	prompt: string;
	options: string[];
}

function buildFallbackClarifyingQuestions(goal: string): NormalizedClarifyingQuestion[] {
	const normalizedGoal = extractPlanningGoalSubject(goal);
	if (/\bgame\b/.test(normalizedGoal)) {
		return [
			{
				prompt: "Target language?",
				options: ["Python", "JavaScript/TypeScript", "C++", "Rust", "Other"],
			},
			{
				prompt: "Target interface/platform?",
				options: ["Terminal", "Desktop GUI", "Web browser", "Mobile"],
			},
			{
				prompt: "Feature scope?",
				options: ["Basic gameplay only", "Score + restart", "Polished visuals", "Extended mechanics"],
			},
		];
	}

	return [
		{ prompt: "Target language or runtime?", options: [] },
		{ prompt: "Target platform or interface?", options: [] },
		{ prompt: "Scope, constraints, or must-have features?", options: [] },
	];
}

function applyFallbackClarifyingOptions(
	goal: string,
	questions: NormalizedClarifyingQuestion[],
): NormalizedClarifyingQuestion[] {
	const fallbackQuestions = buildFallbackClarifyingQuestions(goal);
	return questions.map((question) => {
		if (question.options.length >= 2) return question;
		if (isBooleanClarifyingQuestion(question.prompt)) {
			return { ...question, options: ["Yes", "No"] };
		}
		const category = classifyClarifyingQuestionCategory(question.prompt);
		if (!category) return question;
		const fallback = fallbackQuestions.find(
			(candidate) =>
				candidate.options.length >= 2 && classifyClarifyingQuestionCategory(candidate.prompt) === category,
		);
		if (!fallback) return question;
		return { ...question, options: fallback.options };
	});
}

function isGreenfieldGenericPlanningGoal(goal: string): boolean {
	const normalizedGoal = normalizePlanningGoalText(goal);
	const subject = extractPlanningGoalSubject(goal);
	if (!normalizedGoal) return false;
	if (hasCodebasePlanningAnchors(subject)) return false;
	if (!/\b(plan|planning|build|create|make|implement|design|scaffold|start|enter|open|switch)\b/.test(normalizedGoal)) {
		return false;
	}
	return /\b(game|app|website|site|tool|api|cli|dashboard|bot|agent|project|snake)\b/.test(subject);
}

function hasGoalMissingFoundationalPlanningChoices(goal: string): boolean {
	const normalizedGoal = extractPlanningGoalSubject(goal);
	const hasLanguageChoice =
		/\b(python|typescript|javascript|js|ts|c\+\+|c#|java|kotlin|swift|rust|go|golang|ruby|php|html|css|react|vue|svelte|angular|pygame|tkinter|godot|unity)\b/.test(
			normalizedGoal,
		);
	const hasPlatformChoice =
		/\b(web|browser|terminal|cli|desktop|mobile|ios|android|canvas|electron|react native|pygame|tkinter|unity|godot)\b/.test(
			normalizedGoal,
		);
	return !hasLanguageChoice || !hasPlatformChoice;
}

function hasCodebasePlanningAnchors(text: string): boolean {
	return /\b(codebase|repo|repository|workspace|session|current implementation|existing implementation|current code|file|files|path|module|function|class|test|tests|refactor|bug|regression|migration|runtime|bootstrap|tsconfig|package\.json)\b/.test(
		text,
	);
}

function normalizePlanningGoalText(goal: string): string {
	return goal
		.trim()
		.toLowerCase()
		.replace(/\bplanmode\b/g, "plan mode")
		.replace(/\bplanningmode\b/g, "planning mode")
		.replace(/\s+/g, " ");
}

function normalizeInteractivePlanGoal(goal: string): string {
	const trimmedGoal = goal.trim();
	if (!trimmedGoal) return trimmedGoal;
	const normalizedText = normalizePlanningGoalText(trimmedGoal);
	const subject = extractPlanningGoalSubject(trimmedGoal);
	if (!subject || subject === normalizedText) {
		return trimmedGoal;
	}
	const subjectMatch = normalizedText.match(/(.+)$/);
	if (!subjectMatch) return trimmedGoal;
	const lowerTrimmed = trimmedGoal.toLowerCase().replace(/\bplanmode\b/g, "plan mode").replace(/\bplanningmode\b/g, "planning mode");
	const subjectStartIndex = lowerTrimmed.lastIndexOf(subject);
	if (subjectStartIndex < 0) return trimmedGoal;
	return trimmedGoal.slice(subjectStartIndex).replace(/^[\s,.:;!?-]+|[\s,.:;!?-]+$/g, "").trim();
}

function extractPlanningGoalSubject(goal: string): string {
	const normalizedGoal = normalizePlanningGoalText(goal);
	const subjectPatterns = [
		/\b(?:enter|open|start|use|switch to|go into)\s+(?:planning|plan)\s+mode\s+(?:for|to plan)\s+(.+)$/,
		/\b(?:let(?:'s| us)?\s+)?plan(?:\s+out)?\s+(.+)$/,
		/\b(?:help me\s+)?plan(?:\s+out)?\s+(.+)$/,
		/\b(?:build|create|make|implement|design|scaffold|start)\s+(.+)$/,
	];
	for (const pattern of subjectPatterns) {
		const match = normalizedGoal.match(pattern);
		const subject = match?.[1]?.trim();
		if (subject) return subject;
	}
	return normalizedGoal;
}

function hasMissingFoundationalPlanningChoices(openQuestions: string[]): boolean {
	const categories = new Set(
		openQuestions
			.map((question) => classifyClarifyingQuestionCategory(question))
			.filter((category): category is NonNullable<ReturnType<typeof classifyClarifyingQuestionCategory>> => Boolean(category)),
	);
	return categories.has("language") || categories.has("platform");
}

function classifyClarifyingQuestionCategory(prompt: string): "language" | "platform" | "scope" | undefined {
	const normalizedPrompt = prompt.replace(/[?:]+$/g, "").trim().toLowerCase();
	if (!normalizedPrompt) return undefined;
	if (/\b(language|runtime|stack|framework|library)\b/.test(normalizedPrompt)) return "language";
	if (/\b(platform|interface|ui|display|terminal|desktop|browser|web|mobile)\b/.test(normalizedPrompt)) {
		return "platform";
	}
	if (/\b(feature|features|scope|mechanics|gameplay)\b/.test(normalizedPrompt)) return "scope";
	return undefined;
}

function extractPlanSummary(text: string): string | undefined {
	const summarySection = findSection(text, ["summary"]);
	if (summarySection) return summarySection.replace(/\s+/g, " ").trim();
	const beforeFirstSection = text
		.split(/\n(?:(?:#{1,6}\s*)?(?:summary|plan|steps|assumptions|constraints|risks|verification|questions|open questions|clarifying questions)\b[:\s]*|\s*\d+[.)]\s+)/i)[0]
		?.trim();
	if (!beforeFirstSection) return undefined;
	return beforeFirstSection.replace(/\s+/g, " ").trim();
}

function findSection(text: string, names: string[]): string | undefined {
	return findNamedSection(text, names, ["plan", "steps", "assumptions", "constraints", "risks", "verification", "questions", "open questions", "clarifying questions"]);
}

function findExecutionReviewSection(text: string, names: string[]): string | undefined {
	return findNamedSection(text, names, [
		"execution status",
		"execution summary",
		"step summary",
		"review summary",
		"files touched",
		"touched files",
		"changed files",
		"files",
		"verification",
		"verified",
		"validation",
		"remaining",
		"remaining work",
		"next",
		"follow-up",
		"blockers",
		"blocked",
		"issues",
	]);
}

function findNamedSection(text: string, names: string[], allNames: string[]): string | undefined {
	const escapedNames = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	const escapedAllNames = allNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	const regex = new RegExp(
		`(?:^|\\n)(?:#{1,6}\\s*)?(?:${escapedNames})\\s*:?[ \\t]*\\n([\\s\\S]*?)(?=\\n(?:#{1,6}\\s*)?(?:${escapedAllNames})\\s*:?[ \\t]*\\n|$)`,
		"i",
	);
	const match = text.match(regex);
	return match?.[1]?.trim() || undefined;
}

function extractNumberedItems(text: string | undefined): string[] {
	if (!text) return [];
	const items: string[] = [];
	const regex = /^\s*\d+[.)]\s+(.+)$/gm;
	for (const match of text.matchAll(regex)) {
		const cleaned = normalizePlanItem(match[1]);
		if (cleaned) items.push(cleaned);
	}
	return items;
}

function extractClarifyingPromptItems(
	text: string | undefined,
	modes: Array<"bullet" | "numbered" | "step">,
): ParsedClarifyingPromptItem[] {
	if (!text) return [];
	const lines = text.split("\n");
	const items: ParsedClarifyingPromptItem[] = [];
	let current: ParsedClarifyingPromptItem | undefined;
	let currentIndent = 0;

	for (const rawLine of lines) {
		const line = rawLine.replace(/\t/g, "    ");
		const trimmed = line.trim();
		if (!trimmed) continue;

		const startMatch = line.match(/^(\s*)(?:(\d+[.)])|([-*])|(step\s+\d+\s*[:.)-]))\s+(.+)$/i);
		if (startMatch) {
			const kind = startMatch[2] ? "numbered" : startMatch[3] ? "bullet" : "step";
			if (modes.includes(kind)) {
				if (current) items.push(current);
				current = { head: startMatch[5]!.trim(), continuations: [] };
				currentIndent = startMatch[1]?.length ?? 0;
				continue;
			}
		}

		if (!current) continue;
		const indent = line.match(/^\s*/)?.[0].length ?? 0;
		if (indent > currentIndent || /^[([{]/.test(trimmed) || /^[-*]\s+/.test(trimmed) || /^or\b/i.test(trimmed)) {
			current.continuations.push(trimmed.replace(/^[-*]\s+/, ""));
		}
	}

	if (current) items.push(current);
	return items;
}

function extractStepLabelItems(text: string | undefined): string[] {
	if (!text) return [];
	const items: string[] = [];
	const regex = /^\s*step\s+\d+\s*[:.)-]\s+(.+)$/gim;
	for (const match of text.matchAll(regex)) {
		const cleaned = normalizePlanItem(match[1]);
		if (cleaned) items.push(cleaned);
	}
	return items;
}

function extractPlanStepItems(text: string | undefined): string[] {
	const numbered = extractNumberedItems(text);
	if (numbered.length > 0) return numbered;

	const stepLabels = extractStepLabelItems(text);
	if (stepLabels.length > 0) return stepLabels;

	return extractBulletItems(text);
}

function extractBulletItems(text: string | undefined): string[] {
	if (!text) return [];
	const items: string[] = [];
	const regex = /^\s*[-*]\s+(.+)$/gm;
	for (const match of text.matchAll(regex)) {
		const cleaned = normalizePlanItem(match[1]);
		if (cleaned) items.push(cleaned);
	}
	return items;
}

function normalizePlanItem(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const cleaned = value.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1").replace(/`([^`]+)`/g, "$1").trim();
	return cleaned.length > 0 ? cleaned : undefined;
}

function normalizeClarifyingPromptItems(items: ParsedClarifyingPromptItem[]): NormalizedClarifyingQuestion[] {
	return items
		.map(normalizeClarifyingPromptItem)
		.filter((item): item is NormalizedClarifyingQuestion => Boolean(item));
}

function normalizeClarifyingPromptItem(item: ParsedClarifyingPromptItem): NormalizedClarifyingQuestion | undefined {
	const head = normalizePlanItem(item.head);
	if (!head) return undefined;

	const continuationOptions = item.continuations.map((part) => normalizePlanItem(part)).filter((part): part is string => Boolean(part));
	const prompt = normalizeClarifyingQuestionPrompt(head, continuationOptions);
	if (!prompt) return undefined;
	const options = normalizeClarifyingQuestionOptions(head, continuationOptions);

	return { prompt, options };
}

function normalizeClarifyingQuestionPrompt(head: string, continuationOptions: string[]): string | undefined {
	let prompt = head.trim();

	const dashedSegments = prompt.split(/\s+-\s+/).map((segment) => segment.trim()).filter(Boolean);
	const dashedQuestionSegment = dashedSegments.find((segment) => /[?]$/.test(segment) || isLikelyQuestionPrompt(segment));
	if (dashedQuestionSegment) {
		prompt = dashedQuestionSegment;
	}

	const multiQuestionFragments = prompt
		.split(/\?\s+/)
		.map((fragment) => fragment.trim())
		.filter(Boolean);
	if (multiQuestionFragments.length >= 2) {
		prompt = `${multiQuestionFragments[0]!.replace(/\?+$/, "").trim()}?`;
	}

	const colonIndex = prompt.indexOf(":");
	if (colonIndex >= 0) {
		const beforeColon = prompt.slice(0, colonIndex).trim();
		const afterColon = prompt.slice(colonIndex + 1).trim();
		if (beforeColon && (afterColon.length > 0 || continuationOptions.length > 0)) {
			prompt = beforeColon;
		}
	}

	const trailingChoiceSection = [...extractTopLevelDelimitedSections(prompt)]
		.reverse()
		.find((section) => {
			const suffix = prompt.slice(section.end + 1).trim();
			return suffix.length === 0 || suffix === "?";
		});
	if (trailingChoiceSection && trailingChoiceSection.start > 0) {
		const suffix = prompt.slice(trailingChoiceSection.end + 1).trim();
		prompt = `${prompt.slice(0, trailingChoiceSection.start).trim()}${suffix === "?" ? "?" : ""}`.trim();
	}

	prompt = prompt.replace(/[:\s]+$/, "").trim();
	prompt = prompt.replace(/\s+/g, " ").trim();
	if (!prompt) return undefined;
	if (looksLikeStandaloneChoice(prompt)) return undefined;
	if (!/[?]$/.test(prompt) && isLikelyQuestionPrompt(prompt)) {
		prompt = `${prompt}?`;
	}
	return prompt;
}

function normalizeClarifyingQuestionOptions(head: string, continuationOptions: string[]): string[] {
	const options: string[] = [];
	const normalizedPrompt = normalizeClarifyingQuestionPrompt(head, continuationOptions);
	if (shouldPreferOpenEndedClarifyingAnswer(normalizedPrompt)) {
		return [];
	}
	const pushOptions = (values: string[]) => {
		for (const value of values) {
			const cleaned = unwrapSurroundingChoiceDelimiter(normalizePlanItem(value))
				.replace(/^or\s+/i, "")
				.replace(/^and\s+/i, "")
				.replace(/\betc\.?$/i, "")
				.trim();
			if (!cleaned) continue;
			if (looksLikeStandaloneChoice(cleaned) || /[?]$/.test(cleaned)) {
				options.push(cleaned.replace(/\?+$/, "").trim());
				continue;
			}
			options.push(cleaned);
		}
	};

	const colonIndex = head.indexOf(":");
	const multiQuestionFragments = head
		.split(/\?\s+/)
		.map((fragment) => fragment.trim())
		.filter(Boolean);
	const hasInterrogativeChoiceChain =
		multiQuestionFragments.length >= 3 || (multiQuestionFragments.length >= 2 && colonIndex >= 0);
	if (hasInterrogativeChoiceChain) {
		const firstFragment = multiQuestionFragments[0]!;
		if (colonIndex >= 0) {
			const firstOption = firstFragment.slice(firstFragment.indexOf(":") + 1).trim();
			if (firstOption) pushOptions([firstOption]);
		}
		pushOptions(multiQuestionFragments.slice(1));
	}

	if (colonIndex >= 0 && !hasInterrogativeChoiceChain) {
		const tail = head.slice(colonIndex + 1).trim();
		if (tail) {
			pushOptions(splitClarifyingChoiceText(tail));
		}
	}

	if (options.length === 0) {
		for (const section of extractTopLevelDelimitedSections(head)) {
			pushOptions(splitClarifyingChoiceText(section.content));
		}
	}

	if (options.length < 2) {
		pushOptions(continuationOptions.filter((option) => !/^e\.g\./i.test(option.trim())));
	}

	return options
		.filter((option) => !isLowQualityClarifyingOption(option, normalizedPrompt))
		.filter((option, index, array) => option.length > 0 && array.indexOf(option) === index)
		.slice(0, 8);
}

function splitClarifyingChoiceText(text: string): string[] {
	const normalized = text.replace(/\?+\s*$/, "").trim();
	if (!normalized) return [];
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
		if (char === "(" || char === "[") {
			parenDepth++;
			current += char;
			continue;
		}
		if (char === ")" || char === "]") {
			parenDepth = Math.max(0, parenDepth - 1);
			current += char;
			continue;
		}
		if (parenDepth === 0 && (char === "," || char === ";")) {
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
	return options;
}

function unwrapSurroundingChoiceDelimiter(value: string | undefined): string {
	const trimmed = value?.trim() ?? "";
	if (
		(trimmed.startsWith("(") && trimmed.endsWith(")")) ||
		(trimmed.startsWith("[") && trimmed.endsWith("]"))
	) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

function extractTopLevelDelimitedSections(text: string): Array<{ content: string; start: number; end: number }> {
	const sections: Array<{ content: string; start: number; end: number }> = [];
	const stack: Array<{ char: "(" | "["; index: number }> = [];
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (char === "(" || char === "[") {
			stack.push({ char, index });
			continue;
		}
		if ((char === ")" || char === "]") && stack.length > 0) {
			const last = stack[stack.length - 1]!;
			const matchesPair = (last.char === "(" && char === ")") || (last.char === "[" && char === "]");
			if (!matchesPair) continue;
			stack.pop();
			if (stack.length === 0) {
				sections.push({
					content: text.slice(last.index + 1, index),
					start: last.index,
					end: index,
				});
			}
		}
	}
	return sections;
}

function isLikelyQuestionPrompt(value: string): boolean {
	return /^(target|what|which|who|where|when|why|how|do|does|did|is|are|can|could|should|would|will|any|interface|type|platform|feature|features|key features|scope|language|runtime|framework|library|display|terminal|desktop|web|mobile|game loop|input|grid|speed|specific requirements|requirements|constraints)\b/i.test(
		value.trim(),
	);
}

function looksLikeStandaloneChoice(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed) return true;
	if (/[?:]/.test(trimmed)) return false;
	if (/^(target|what|which|who|where|when|why|how|do|does|did|is|are|can|could|should|would|will|any|interface|type|platform|feature|features|key features|scope|language|runtime|framework|library|display|specific requirements|requirements|constraints)\b/i.test(trimmed)) {
		return false;
	}
	return trimmed.split(/\s+/).length <= 6;
}

function isLowQualityClarifyingOption(option: string, prompt?: string): boolean {
	const normalizedOption = option.replace(/[?:]+$/g, "").trim().toLowerCase();
	const normalizedPrompt = prompt?.replace(/[?:]+$/g, "").trim().toLowerCase();
	if (!normalizedOption) return true;
	if (normalizedPrompt && normalizedOption === normalizedPrompt) return true;
	if (
		/^(?:\/|\.\.?\/|~\/)/.test(option.trim()) ||
		/(?:^|\s)(?:\/home\/|\/tmp\/|\/var\/|\/etc\/)/i.test(option)
	) {
		return true;
	}
	if (/^(?:e\.g\.|eg\.?|example:?)\s+/i.test(option)) {
		return true;
	}
	if (/:\s*$/.test(option)) {
		return true;
	}
	if (/^(for example|example|for instance|details|more details|more info|other|another)$/i.test(normalizedOption)) {
		return true;
	}
	return false;
}

function shouldPreferOpenEndedClarifyingAnswer(prompt?: string): boolean {
	const normalizedPrompt = prompt?.replace(/[?:]+$/g, "").trim().toLowerCase();
	if (!normalizedPrompt) return false;
	return /^(any )?(specific )?(requirements|constraints|notes|preferences|trade-?offs)$/.test(normalizedPrompt);
}

function isBooleanClarifyingQuestion(prompt?: string): boolean {
	const normalizedPrompt = prompt?.replace(/[?:]+$/g, "").trim().toLowerCase();
	if (!normalizedPrompt) return false;
	return /^(would|do|does|did|is|are|can|could|should|will)\b/.test(normalizedPrompt);
}

function isClarifyingQuestionLike(value: string): boolean {
	const trimmed = value.trim();
	if (/\?/.test(trimmed)) return true;
	if (/^(what|which|who|where|when|why|how|do|does|did|is|are|can|could|should|would|will|any)\b/i.test(trimmed)) {
		return true;
	}
	if (/^(target|interface|platform|feature|features|scope|language|runtime|framework|library)\b/i.test(value.trim())) {
		return true;
	}
	if (/:\s*.+(?:\?|,|\bor\b)/i.test(value)) return true;
	return false;
}

function appendSection(lines: string[], title: string, items: string[], numbered = false): void {
	if (items.length === 0) return;
	lines.push("");
	lines.push(`${title}:`);
	for (let i = 0; i < items.length; i++) {
		lines.push(numbered ? `${i + 1}. ${items[i]}` : `- ${items[i]}`);
	}
}

function formatInteractivePlanSteps(artifact: InteractivePlanArtifact): string[] {
	const completed = new Set(getCompletedStepIndexes(artifact));
	return artifact.steps.map((step, index) => {
		const state = completed.has(index) ? "done" : index === getNextInteractivePlanStepIndex(artifact) ? "next" : "pending";
		return `[${state}] ${step}`;
	});
}

function formatInteractiveClarificationAnswers(artifact: InteractivePlanArtifact): string[] {
	const answers = getClarificationAnswers(artifact);
	return artifact.openQuestions.flatMap((question, index) => {
		const answer = answers[index]?.trim();
		if (!answer) return [];
		return [`Q${index + 1}: ${question}`, `A${index + 1}: ${answer}`];
	});
}

function formatInteractiveClarificationContext(artifact: InteractivePlanArtifact): string {
	const answers = getClarificationAnswers(artifact);
	const lines = artifact.openQuestions.map((question, index) => {
		const answer = answers[index]?.trim();
		return [`Q${index + 1}: ${question}`, `A${index + 1}: ${answer || "(unanswered)"}`].join("\n");
	});
	return lines.join("\n\n");
}
