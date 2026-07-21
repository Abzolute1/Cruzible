import type { TurnAssessmentKind } from "./checkpoint-control.js";
import {
	getWorkspaceFilesByPrefix,
	hasSufficientCodingVerificationEvidence,
	hasSufficientDirectAnswer,
	hasSufficientVisualEvidence,
	hasVerifiedSummaryAnswer,
	isResearchOnlyLedger,
	READ_TOOL_NAMES,
} from "./intent-assessment.js";
import {
	type AutonomousLedgerEvent,
	type AutonomousRunLedger,
	type AutonomousRunSnapshot,
	hasSufficientResearchEvidence,
	updateAutonomousRunLedger,
} from "./ledger.js";
import type { ToolOutcome } from "./nudges/types.js";
import { isMutatingOutcome, isVerificationOutcome } from "./verification-control.js";

export function promoteEvidenceBackedCompletion(
	assessment: TurnAssessmentKind,
	options: {
		currentLedger: AutonomousRunLedger;
		status?: AutonomousRunSnapshot["stopReason"];
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
		!options.visualVerificationRelevant &&
		hasSufficientCodingVerificationEvidence(projectedLedger, options.userMessage);
	// Sweet-talk guard: text that merely *claims* verification (hasVerifiedSummaryAnswer) or a
	// polished direct answer may only complete a run that never mutated the workspace. A run with
	// mutations must stop through a real verification checkpoint — the model's word is not evidence.
	// (When verificationSatisfied is already true the checkpoint holds, so the gate is moot.)
	const noMutations = isResearchOnlyLedger(projectedLedger);
	const hasVerifiedSummaryStopEvidence =
		!options.visualVerificationRelevant &&
		(options.verificationSatisfied || noMutations) &&
		hasVerifiedSummaryAnswer(options.lastAssistantText, options.userMessage, {
			verificationSatisfied: options.verificationSatisfied,
		});
	const hasDirectAnswerStopEvidence =
		projectedLedger.taskMode === "answer" &&
		(options.verificationSatisfied || noMutations) &&
		hasSufficientDirectAnswer(options.lastAssistantText, options.userMessage);

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

export function buildLedgerEvents(options: {
	status?: AutonomousRunSnapshot["stopReason"];
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
			.filter(
				(outcome) => outcome.success && outcome.tool.toLowerCase() === "read" && typeof outcome.file === "string",
			)
			.map((outcome) => outcome.file!),
		/^reference\//i,
	);
	const readSourceFiles = getWorkspaceFilesByPrefix(
		fileAccessHistory
			.filter(
				(outcome) => outcome.success && outcome.tool.toLowerCase() === "read" && typeof outcome.file === "string",
			)
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

	const withoutWorkspaceCd = normalized.replace(/^cd\s+(?:\/?(?:tmp|home)\/[^\s;&|]+\/workspace)\s*&&\s*/i, "");
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
