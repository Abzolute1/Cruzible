import { readFileSync } from "node:fs";
import { migrateSessionEntries, parseSessionEntries } from "../packages/coding-agent/dist/core/session-manager.js";

const sessionPath = process.argv[2];
if (!sessionPath) {
	console.error("usage: scripts/probe-session-summary.mjs <session.jsonl>");
	process.exit(1);
}

const content = readFileSync(sessionPath, "utf8");
const entries = parseSessionEntries(content);
migrateSessionEntries(entries);

const sessionEntries = entries.filter((entry) => entry.type !== "session");
const toolSequence = [];
const assistantTexts = [];
const stallSignatures = new Set();
let cumulativeToolCalls = 0;
let toolCallsBeforeFinalAnswer = "";
let sawFinalAnswer = false;
let inputTokens = 0;
let outputTokens = 0;
let cacheReadTokens = 0;
let cacheWriteTokens = 0;
let totalCost = 0;
let errorKind = "";

for (const entry of sessionEntries) {
	if (entry.type !== "message") continue;
	const message = entry.message;

	if (message.role === "assistant") {
		let hasToolCall = false;
		let hasVisibleText = false;
		const usage = message.usage && typeof message.usage === "object" ? message.usage : undefined;
		if (usage) {
			inputTokens += Number(usage.input ?? 0);
			outputTokens += Number(usage.output ?? 0);
			cacheReadTokens += Number(usage.cacheRead ?? 0);
			cacheWriteTokens += Number(usage.cacheWrite ?? 0);
			totalCost += Number(usage.cost?.total ?? 0);
		}
		for (const block of message.content) {
			if (block.type === "toolCall") {
				toolSequence.push(block.name);
				cumulativeToolCalls++;
				hasToolCall = true;
			}
			if (block.type === "text" && typeof block.text === "string") {
				assistantTexts.push(block.text);
				if (block.text.trim().length > 0) hasVisibleText = true;
			}
		}
		if (hasVisibleText && !hasToolCall) {
			sawFinalAnswer = true;
			toolCallsBeforeFinalAnswer = String(cumulativeToolCalls);
		}
		if (message.stopReason === "error" || message.errorMessage) {
			if (/Connection error\./i.test(message.errorMessage ?? "")) {
				stallSignatures.add("connection_error");
				errorKind = "connection_error";
			} else {
				errorKind = errorKind || "assistant_error";
			}
		}
	}

	if (message.role === "toolResult") {
		const text = Array.isArray(message.content)
			? message.content
					.filter((block) => block.type === "text" && typeof block.text === "string")
					.map((block) => block.text)
					.join("\n")
			: "";
		if (/<tool_call>|<function=|<function-/.test(text)) stallSignatures.add("xml_tool_leak");
		if ((message.toolName === "webFetch" || message.toolName === "webSearch") && /just a moment|enable javascript|verify your browser/i.test(text)) {
			stallSignatures.add("placeholder_fetch");
		}
	}
}

for (const text of assistantTexts) {
	if (/Connection error\./i.test(text)) stallSignatures.add("connection_error");
	if (/<tool_call>|<function=|<function-/.test(text)) stallSignatures.add("xml_tool_leak");
	if (/Very short responses detected|model may be stuck/i.test(text)) stallSignatures.add("stuck_warning");
}

const toolCounts = new Map();
let maxConsecutiveSameTool = 0;
let currentRunTool = "";
let currentRunLength = 0;
for (const tool of toolSequence) {
	toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
	if (tool === currentRunTool) currentRunLength++;
	else {
		currentRunTool = tool;
		currentRunLength = 1;
	}
	maxConsecutiveSameTool = Math.max(maxConsecutiveSameTool, currentRunLength);
}

const repeatedTools = [...toolCounts.entries()]
	.filter(([, count]) => count >= 2)
	.map(([tool, count]) => `${tool}:${count}`)
	.join(",");

console.log(`first_tool=${toolSequence[0] ?? ""}`);
console.log(`tool_sequence=${toolSequence.join(" -> ")}`);
console.log(`tool_call_count=${toolSequence.length}`);
console.log(`tool_calls_before_final_answer=${toolCallsBeforeFinalAnswer}`);
console.log(`saw_final_answer=${sawFinalAnswer}`);
console.log(`repeated_tools=${repeatedTools}`);
console.log(`max_consecutive_same_tool=${maxConsecutiveSameTool}`);
console.log(`stall_signatures=${[...stallSignatures].join(",")}`);
console.log(`input_tokens=${inputTokens}`);
console.log(`output_tokens=${outputTokens}`);
console.log(`cache_read_tokens=${cacheReadTokens}`);
console.log(`cache_write_tokens=${cacheWriteTokens}`);
console.log(`total_tokens=${inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens}`);
console.log(`total_cost=${totalCost.toFixed(6)}`);
console.log(`error_kind=${errorKind}`);
