/**
 * XML tool call parser for model-agnostic tool execution.
 *
 * Handles models (like Qwen3.5) that emit tool calls in XML format instead of
 * the OpenAI structured tool call format. This makes the harness agnostic to
 * the model's native tool-calling syntax.
 *
 * False positive prevention:
 * 1. Only matches known active tool names (read, bash, edit, write, etc.)
 * 2. Requires valid parameter tags
 * 3. Strips content inside code blocks
 * 4. Only triggers when no structured tool calls were executed this turn
 * 5. Max 3 XML iterations per user prompt to prevent infinite loops
 */

export interface XmlToolCall {
	name: string;
	id: string;
	arguments: Record<string, string>;
	rawXml: string;
}

export type XmlFallbackSeverity = "normal" | "elevated" | "critical";

export interface XmlFallbackAnalysis {
	callCount: number;
	assistantTextLength: number;
	assistantStopReason?: string;
	iteration: number;
	severity: XmlFallbackSeverity;
	shouldInjectRecoveryPrompt: boolean;
	reasons: string[];
	continuationMode: "default" | "guided";
}

export function stripCodeBlocks(text: string): string {
	return text.replace(/```[\s\S]*?```/g, "");
}

export function parseXmlToolCalls(text: string, knownToolNames: string[]): XmlToolCall[] {
	const strippedText = stripCodeBlocks(text);
	const calls: XmlToolCall[] = [];
	let callIndex = 0;

	const escapedNames = knownToolNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

	if (escapedNames.length === 0) return [];

	const namePattern = escapedNames.join("|");

	// Format 1: Bare tool name — <read>...</read>, <bash>...</bash>
	const bareRegex = new RegExp(`<(${namePattern})(?:\\s[^>]*)?>([\\s\\S]*?)</\\1>`, "gi");

	let match: RegExpExecArray | null;
	while ((match = bareRegex.exec(strippedText)) !== null) {
		const toolName = match[1];
		const content = match[2];
		const rawXml = match[0];

		const args: Record<string, string> = {};

		// Support both <param name="x">value</param> and <x>value</x>
		const paramRegex = /<param\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/param>/gi;
		let paramMatch: RegExpExecArray | null;
		while ((paramMatch = paramRegex.exec(content)) !== null) {
			args[paramMatch[1]] = paramMatch[2].trim();
		}

		// If no param tags found, treat each direct child tag as an argument
		if (Object.keys(args).length === 0) {
			const tagRegex = /<([^>\s/]+)[^>]*>([\s\S]*?)<\/\1>/gi;
			let tagMatch: RegExpExecArray | null;
			while ((tagMatch = tagRegex.exec(content)) !== null) {
				if (tagMatch[1] !== toolName) {
					args[tagMatch[1]] = tagMatch[2].trim();
				}
			}
		}

		calls.push({
			name: toolName,
			id: `xml-call-${callIndex++}`,
			arguments: args,
			rawXml,
		});
	}

	return calls;
}

export function analyzeXmlFallbackTurn(options: {
	callCount: number;
	assistantTextLength: number;
	assistantStopReason?: string;
	iteration: number;
}): XmlFallbackAnalysis {
	const reasons: string[] = [];
	let severity: XmlFallbackSeverity = "normal";
	const finishReason = options.assistantStopReason?.toLowerCase();

	if (finishReason === "max_tokens" || finishReason === "length") {
		severity = "critical";
		reasons.push("truncated_turn");
	}
	if (options.assistantTextLength >= 12_000) {
		severity = "critical";
		reasons.push("very_long_output");
	} else if (options.assistantTextLength >= 4_000 && severity !== "critical") {
		severity = "elevated";
		reasons.push("long_output");
	}
	if (options.callCount > 1 && severity === "normal") {
		severity = "elevated";
	}
	if (options.callCount > 1) {
		reasons.push("multiple_xml_calls");
	}
	if (options.iteration >= 1 && severity === "normal") {
		severity = "elevated";
	}
	if (options.iteration >= 1) {
		reasons.push("repeated_xml_iteration");
	}

	const shouldInjectRecoveryPrompt = severity !== "normal";
	return {
		callCount: options.callCount,
		assistantTextLength: options.assistantTextLength,
		assistantStopReason: options.assistantStopReason,
		iteration: options.iteration,
		severity,
		shouldInjectRecoveryPrompt,
		reasons,
		continuationMode: shouldInjectRecoveryPrompt ? "guided" : "default",
	};
}

export function buildXmlFallbackRecoveryPrompt(analysis: XmlFallbackAnalysis): string | undefined {
	if (!analysis.shouldInjectRecoveryPrompt) return undefined;
	if (analysis.severity === "critical") {
		return [
			"XML fallback recovery mode:",
			"The previous assistant turn degraded into a long or truncated XML fallback.",
			"Continue only from the appended tool results.",
			"Keep the next response terse.",
			"If another tool is needed, emit exactly one tool call with minimal arguments.",
			"Do not restate prior analysis, and do not repeat large XML blocks.",
		].join(" ");
	}
	return [
		"XML fallback recovery mode:",
		"The previous assistant turn is drifting into XML fallback.",
		"Continue from the appended tool results only.",
		"Keep the next response concise.",
		"If another tool is needed, emit exactly one tool call.",
		"Do not repeat previous analysis or XML verbosely.",
	].join(" ");
}
