import type { AssistantMessage } from "@ag1/ai";
import { classifyRequestFailure } from "./request-failure.js";

export type TurnDegradationSeverity = "normal" | "elevated" | "critical";

export interface TurnHealthAnalysis {
	severity: TurnDegradationSeverity;
	stopReason?: string;
	outputTokens: number;
	textLength: number;
	reasons: string[];
	recoveryHint?: string;
}

const ELEVATED_OUTPUT_TOKENS = 8_000;
const CRITICAL_OUTPUT_TOKENS = 14_000;
const ELEVATED_TEXT_LENGTH = 24_000;
const CRITICAL_TEXT_LENGTH = 48_000;

export function analyzeAssistantTurnHealth(message: AssistantMessage): TurnHealthAnalysis {
	const outputTokens = message.usage?.output ?? 0;
	const textLength = extractAssistantText(message).length;
	const stopReason = typeof message.stopReason === "string" ? String(message.stopReason) : undefined;
	const reasons: string[] = [];
	let severity: TurnDegradationSeverity = "normal";
	const requestFailure = classifyRequestFailure(message);

	if (stopReason === "error") {
		if (requestFailure) {
			return {
				severity: "normal",
				stopReason,
				outputTokens,
				textLength,
				reasons: [],
				recoveryHint: undefined,
			};
		}
		severity = "critical";
		reasons.push("error_turn");
	} else if (stopReason === "aborted") {
		severity = "critical";
		reasons.push("aborted_turn");
	} else if (stopReason === "max_tokens" || stopReason === "length") {
		severity = "critical";
		reasons.push("truncated_turn");
	}

	if (outputTokens >= CRITICAL_OUTPUT_TOKENS) {
		severity = "critical";
		reasons.push("very_high_output_tokens");
	} else if (outputTokens >= ELEVATED_OUTPUT_TOKENS) {
		if (severity === "normal") severity = "elevated";
		reasons.push("high_output_tokens");
	}

	if (textLength >= CRITICAL_TEXT_LENGTH) {
		severity = "critical";
		reasons.push("very_long_output_text");
	} else if (textLength >= ELEVATED_TEXT_LENGTH) {
		if (severity === "normal") severity = "elevated";
		reasons.push("long_output_text");
	}

	return {
		severity,
		stopReason,
		outputTokens,
		textLength,
		reasons,
		recoveryHint: buildRecoveryHint(severity, reasons),
	};
}

function extractAssistantText(message: AssistantMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				block.type === "text" && typeof (block as any).text === "string",
		)
		.map((block) => block.text)
		.join("");
}

function buildRecoveryHint(severity: TurnDegradationSeverity, reasons: string[]): string | undefined {
	if (severity === "normal") return undefined;
	if (severity === "critical") {
		if (reasons.includes("truncated_turn")) {
			return "Continue from the last concrete point only, keep the next response short, and avoid repeating prior analysis.";
		}
		if (reasons.includes("error_turn") || reasons.includes("aborted_turn")) {
			return "Recover from the failed turn directly. Keep the next response concise and avoid replaying the full prior reasoning.";
		}
		return "The last turn degraded. Continue tersely from the latest concrete state and avoid repeating earlier analysis.";
	}
	return "The last turn is getting too verbose. Keep the next response concise and avoid rehashing earlier analysis.";
}
