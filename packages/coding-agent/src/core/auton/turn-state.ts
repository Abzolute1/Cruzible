import type { TurnAssessmentKind } from "./checkpoint-control.js";
import { parseFinalizationContract } from "./finalization-contract.js";
import type { VerificationCheckpointState } from "./verification-control.js";

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
const BUDGET_EXCEEDED_ERROR_PATTERNS = [/\b(?:cost|token|turn)\s+budget exceeded\b/i, /\bbudget limit reached\b/i];

export interface TurnOutcomeAssessmentOptions {
	lastTurnHadToolCalls: boolean;
	lastTurnFinishReason: string | undefined;
	lastAssistantText: string;
	verificationState: VerificationCheckpointState;
}

export function isBudgetExceededError(message: string): boolean {
	return BUDGET_EXCEEDED_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function assessTurnOutcome(options: TurnOutcomeAssessmentOptions): { kind: TurnAssessmentKind } {
	return {
		kind: shouldStopForCompletion(
			options.lastTurnHadToolCalls,
			options.lastTurnFinishReason,
			options.lastAssistantText,
			options.verificationState,
		),
	};
}

export function getLastAssistantText(messages: Array<{ role?: string; content?: unknown }>): string {
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

export function hasIncompleteContinuationSignal(text: string): boolean {
	return INCOMPLETE_PATTERNS.some((pattern) => pattern.test(text));
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
	const finalizationStatus = parseFinalizationContract(lastAssistantText);
	if (finalizationStatus === "continue") return "continue";
	if (finalizationStatus === "complete") {
		return verificationState.hasVerificationCheckpoint ? "complete" : "confirm_verification";
	}
	if (lastTurnHadToolCalls) {
		if (!hasExplicitCompletionSignal(lastAssistantText)) return "continue";
		return verificationState.hasVerificationCheckpoint ? "complete" : "confirm_verification";
	}
	if (!hasExplicitCompletionSignal(lastAssistantText)) return "confirm_completion";
	return verificationState.hasVerificationCheckpoint ? "complete" : "confirm_verification";
}

function hasExplicitCompletionSignal(text: string): boolean {
	if (!text) return false;
	if (hasIncompleteContinuationSignal(text)) return false;
	return EXPLICIT_COMPLETION_PATTERNS.some((pattern) => pattern.test(text));
}
