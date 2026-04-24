#!/usr/bin/env node

import { readFileSync } from "node:fs";

const exportPath = process.argv[2];
if (!exportPath) {
	console.error("usage: scripts/opencode-export-summary.mjs <opencode-export.json>");
	process.exit(1);
}

const root = JSON.parse(readFileSync(exportPath, "utf8"));
const KNOWN_TOOLS = new Set([
	"bash",
	"read",
	"glob",
	"grep",
	"edit",
	"write",
	"task",
	"webfetch",
	"websearch",
	"todowrite",
	"codesearch",
	"skill",
	"question",
	"invalid",
]);

const state = {
	toolSequence: [],
	assistantTexts: [],
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalCost: 0,
	sessionIds: new Set(),
};

function maybeCollectUsage(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const input = Number(value.input ?? value.inputTokens ?? 0);
	const output = Number(value.output ?? value.outputTokens ?? 0);
	const cacheRead = Number(value.cacheRead ?? value.cacheReadTokens ?? 0);
	const cacheWrite = Number(value.cacheWrite ?? value.cacheWriteTokens ?? 0);
	const hasUsage =
		Number.isFinite(input) &&
		Number.isFinite(output) &&
		(input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0);
	if (!hasUsage) return;
	state.inputTokens += input;
	state.outputTokens += output;
	state.cacheReadTokens += cacheRead;
	state.cacheWriteTokens += cacheWrite;
	state.totalCost += Number(value.cost?.total ?? value.totalCost ?? 0);
}

function detectToolName(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "";
	const nameCandidates = [value.name, value.tool, value.toolName, value.tool_name];
	const name = nameCandidates.find((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
	if (!name) return "";
	if (KNOWN_TOOLS.has(name.toLowerCase())) return name;
	if (typeof value.arguments === "object" || typeof value.input === "object" || typeof value.args === "object") {
		return name;
	}
	return "";
}

function walk(value, parent = undefined) {
	if (Array.isArray(value)) {
		for (const item of value) walk(item, parent);
		return;
	}
	if (!value || typeof value !== "object") return;

	if (typeof value.sessionID === "string" && value.sessionID.startsWith("ses_")) state.sessionIds.add(value.sessionID);
	if (typeof value.id === "string" && value.id.startsWith("ses_")) state.sessionIds.add(value.id);

	maybeCollectUsage(value.usage);
	maybeCollectUsage(value);

	if (typeof value.role === "string" && value.role === "assistant") {
		const blocks = Array.isArray(value.content)
			? value.content
			: Array.isArray(value.parts)
				? value.parts
				: [];
		for (const block of blocks) {
			const type = typeof block?.type === "string" ? block.type : "";
			const toolName = detectToolName(block);
			if (toolName && (type.toLowerCase().includes("tool") || type === "")) {
				state.toolSequence.push(toolName);
			}
			if (type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
				state.assistantTexts.push(block.text);
			}
			walk(block, value);
		}
	}

	const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
	const directToolName = detectToolName(value);
	if (
		directToolName &&
		type.includes("tool") &&
		!(parent && typeof parent.role === "string" && parent.role === "assistant")
	) {
		state.toolSequence.push(directToolName);
	}
	if (type === "text" && typeof value.text === "string" && value.text.trim().length > 0) {
		state.assistantTexts.push(value.text);
	}

	for (const child of Object.values(value)) walk(child, value);
}

walk(root);

let cumulativeToolCalls = 0;
let toolCallsBeforeFinalAnswer = "";
let sawFinalAnswer = false;
for (const text of state.assistantTexts) {
	if (toolCallsBeforeFinalAnswer) break;
	if (text.trim().length > 0) {
		sawFinalAnswer = true;
		toolCallsBeforeFinalAnswer = String(cumulativeToolCalls);
	}
}
if (state.toolSequence.length > 0 && sawFinalAnswer) {
	cumulativeToolCalls = state.toolSequence.length;
	toolCallsBeforeFinalAnswer = String(cumulativeToolCalls);
}

const toolCounts = new Map();
let maxConsecutiveSameTool = 0;
let currentRunTool = "";
let currentRunLength = 0;
for (const tool of state.toolSequence) {
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

console.log(`session_ids=${[...state.sessionIds].join(",")}`);
console.log(`first_tool=${state.toolSequence[0] ?? ""}`);
console.log(`tool_sequence=${state.toolSequence.join(" -> ")}`);
console.log(`tool_call_count=${state.toolSequence.length}`);
console.log(`tool_calls_before_final_answer=${toolCallsBeforeFinalAnswer}`);
console.log(`saw_final_answer=${sawFinalAnswer}`);
console.log(`repeated_tools=${repeatedTools}`);
console.log(`max_consecutive_same_tool=${maxConsecutiveSameTool}`);
console.log(`input_tokens=${state.inputTokens}`);
console.log(`output_tokens=${state.outputTokens}`);
console.log(`cache_read_tokens=${state.cacheReadTokens}`);
console.log(`cache_write_tokens=${state.cacheWriteTokens}`);
console.log(`total_tokens=${state.inputTokens + state.outputTokens + state.cacheReadTokens + state.cacheWriteTokens}`);
console.log(`total_cost=${state.totalCost.toFixed(6)}`);
