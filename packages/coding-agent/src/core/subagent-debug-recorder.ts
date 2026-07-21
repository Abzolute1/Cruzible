/**
 * Subagent Debug Recorder — makes `task` tool runs fully visible.
 *
 * A parent session only sees a subagent's final summary. This recorder mirrors
 * the parent SessionDebugLogger's artifact style (session.md /
 * session.compact.md / timeline.json) for a single subagent run, writing to
 * `<projectRoot or cwd>/Debug/subagent_<datetime>_<type>_<model>/`.
 *
 * Standalone by design: it does not touch the parent logger's files, so
 * concurrent subagents never conflict. If the debug directory cannot be
 * created (same failure mode that disables the parent logger), the recorder
 * becomes a no-op and `finish()` returns undefined.
 *
 * Pure Node fs, plain text only — no TUI/theme imports, no ANSI.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentEvent, AgentMessage } from "@ag1/agent-core";
import {
	formatCost,
	formatDurationMs,
	formatTokens,
	formatToolResultContent,
	modelToFolderName,
	redactSecrets,
	sanitizeNamePart,
	summarizeToolArgs,
	toSessionDateTimeStr,
	toUtcTimestamp,
	truncate,
} from "./debug-formatters.js";
import type { SubagentResult } from "./subagent-runner.js";

// ============================================================================
// Public API
// ============================================================================

export interface SubagentDebugRecorderOptions {
	cwd: string;
	projectRoot?: string;
	type: string;
	description: string;
	/** Model ref ("provider/id") or "auto" when routing decides later. */
	model: string;
	/** The parent's tool-call id for this `task` invocation, if known. */
	toolCallId?: string;
}

export interface SubagentDebugLogRef {
	/** Absolute path to the subagent debug directory. */
	logDir: string;
	/** Path relative to the Debug root, e.g. `subagent_2026-07-19_13-22-10_implement_qwen35-9b`. */
	logRef: string;
}

export interface SubagentDebugRecorder {
	/** Feed every AgentEvent from the subagent run. Never throws. */
	handleEvent(event: AgentEvent): void;
	/** Write the outcome section and flush. Idempotent. Undefined when disabled. */
	finish(result: SubagentResult): SubagentDebugLogRef | undefined;
}

interface TimelineEntry {
	type: string;
	ts: number;
	[key: string]: unknown;
}

const MAX_SUMMARY_PREVIEW_CHARS = 300;
const MAX_TEXT_PREVIEW_CHARS = 400;
const MAX_RESULT_PREVIEW_CHARS = 300;

// ============================================================================
// Formatting helpers
// ============================================================================

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function toUtcTimeStr(timestamp: number): string {
	const d = new Date(timestamp);
	const hour = String(d.getUTCHours()).padStart(2, "0");
	const min = String(d.getUTCMinutes()).padStart(2, "0");
	const sec = String(d.getUTCSeconds()).padStart(2, "0");
	return `${hour}:${min}:${sec} UTC`;
}

function sanitizeModelRef(model: string): string {
	const slash = model.indexOf("/");
	if (slash > 0 && slash < model.length - 1) {
		return modelToFolderName(model.slice(0, slash), model.slice(slash + 1));
	}
	return sanitizeNamePart(model);
}

/** One-line tool label, e.g. `read src/a.ts` / `bash npm test`. */
function toolLabel(toolName: string, args: unknown): string {
	const record = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const clamp = (value: string, max = 60) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
	switch (toolName) {
		case "bash":
			return typeof record.command === "string" ? `bash ${clamp(record.command)}` : "bash";
		case "read":
		case "write":
		case "edit":
		case "ls": {
			const p =
				typeof record.path === "string"
					? record.path
					: typeof record.file_path === "string"
						? record.file_path
						: "";
			return p ? `${toolName} ${clamp(p)}` : toolName;
		}
		case "grep":
			return typeof record.pattern === "string" ? `grep ${clamp(record.pattern)}` : "grep";
		case "find":
			return typeof record.pattern === "string" ? `find ${clamp(record.pattern)}` : "find";
		case "webFetch":
			return typeof record.url === "string" ? `webFetch ${clamp(record.url)}` : "webFetch";
		case "webSearch":
			return typeof record.query === "string" ? `webSearch ${clamp(record.query)}` : "webSearch";
		default:
			return `${toolName} ${summarizeToolArgs(record, 60)}`;
	}
}

function extractText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null)
		.map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
		.join("\n");
}

function resultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((block: any) => block && block.type === "text" && typeof block.text === "string")
			.map((block: any) => block.text as string)
			.join("\n");
	}
	return "";
}

function parseBashExitCode(text: string, isError: boolean): number | null {
	const match = text.match(/Command exited with code (\d+)/);
	if (match) return Number(match[1]);
	if (isError || /killed|terminated|aborted/i.test(text)) return null;
	return 0;
}

// ============================================================================
// Recorder factory
// ============================================================================

export function createSubagentDebugRecorder(options: SubagentDebugRecorderOptions): SubagentDebugRecorder {
	const startedAt = Date.now();
	const debugRoot = path.join(options.projectRoot ?? options.cwd, "Debug");

	let enabled = false;
	let finished = false;
	let logDir = "";
	let logRef = "";
	let sessionMdPath = "";
	let compactMdPath = "";
	let timelinePath = "";

	const timeline: TimelineEntry[] = [];

	// Per-run tracking
	let turnCounter = 0;
	let turnStartTs = startedAt;
	let toolCallsInTurn = 0;
	let totalInput = 0;
	let totalOutput = 0;
	let totalCost = 0;
	const pendingTools = new Map<string, { toolName: string; args: unknown; startTs: number }>();
	const turnToolLabels: string[] = [];

	const safeWrite = (fn: () => void): void => {
		if (!enabled) return;
		try {
			fn();
		} catch {
			// Mirror the parent logger: a write failure disables debug logging
			// rather than ever disturbing the subagent run.
			enabled = false;
		}
	};

	const appendSession = (text: string): void => safeWrite(() => fs.appendFileSync(sessionMdPath, text, "utf8"));
	const appendCompact = (text: string): void => safeWrite(() => fs.appendFileSync(compactMdPath, text, "utf8"));

	const pushTimeline = (entry: TimelineEntry): void => {
		timeline.push(entry);
		// Rewrite the whole array like the parent logger, but throttle: streaming
		// message_update deltas are buffered in memory and hit disk at the next
		// non-update event or finish().
		if (entry.type !== "message" || entry.phase !== "update") {
			safeWrite(() => fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 2), "utf8"));
		}
	};

	// --- Initialize the debug directory (mirrors the parent logger's start) ---
	try {
		const baseName = `subagent_${toSessionDateTimeStr(startedAt)}_${sanitizeNamePart(options.type)}_${sanitizeModelRef(options.model)}`;
		let dir = path.join(debugRoot, baseName);
		let counter = 1;
		while (fs.existsSync(dir)) {
			counter++;
			dir = path.join(debugRoot, `${baseName}-${counter}`);
		}
		fs.mkdirSync(dir, { recursive: true });

		logDir = dir;
		logRef = path.relative(debugRoot, dir);
		sessionMdPath = path.join(dir, "session.md");
		compactMdPath = path.join(dir, "session.compact.md");
		timelinePath = path.join(dir, "timeline.json");
		enabled = true;

		const header = `# Subagent Log

| Field | Value |
|-------|-------|
| Type | ${options.type} |
| Description | ${options.description} |
| Model | ${options.model} |
| Started | ${toUtcTimestamp(startedAt)} |
${options.toolCallId ? `| Parent Tool Call | ${options.toolCallId} |\n` : ""}
---

`;
		fs.writeFileSync(sessionMdPath, header, "utf8");

		const compactHeader = `# Subagent Compact — ${toSessionDateTimeStr(startedAt)} | ${options.type} | ${options.model}

Turn | Tools | Input ↓ | Output ↑ | Cost | Duration
-----|-------|---------|----------|------|--------
`;
		fs.writeFileSync(compactMdPath, compactHeader, "utf8");
		fs.writeFileSync(timelinePath, "[]", "utf8");

		pushTimeline({
			type: "run_start",
			ts: startedAt,
			subagentType: options.type,
			description: options.description,
			model: options.model,
			...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
		});
	} catch {
		enabled = false;
	}

	const handleAssistantMessageEnd = (message: AgentMessage): void => {
		const usage = (message as { usage?: { input?: number; output?: number; cost?: { total?: number } } }).usage;
		if (usage) {
			totalInput += usage.input ?? 0;
			totalOutput += usage.output ?? 0;
			totalCost += usage.cost?.total ?? 0;
		}
		const text = extractText(message);
		if (text.trim().length > 0) {
			appendSession(
				`**Assistant:** ${truncate(redactSecrets(text), MAX_TEXT_PREVIEW_CHARS).replace(/\n/g, "\\n")}\n\n`,
			);
		}
		const errorMessage = (message as { errorMessage?: string }).errorMessage;
		if (errorMessage) {
			appendSession(`**Error:** ${truncate(redactSecrets(errorMessage), MAX_TEXT_PREVIEW_CHARS)}\n\n`);
		}
	};

	const handleEvent = (event: AgentEvent): void => {
		if (!enabled || finished) return;
		try {
			switch (event.type) {
				case "agent_start":
					pushTimeline({ type: "agent", phase: "start", ts: Date.now() });
					break;
				case "agent_end":
					pushTimeline({ type: "agent", phase: "end", ts: Date.now(), messageCount: event.messages.length });
					break;
				case "turn_start":
					turnCounter++;
					turnStartTs = Date.now();
					toolCallsInTurn = 0;
					turnToolLabels.length = 0;
					appendSession(`\n## Turn ${turnCounter} — ${toUtcTimeStr(turnStartTs)}\n\n`);
					pushTimeline({ type: "turn", phase: "start", ts: turnStartTs, turn: turnCounter });
					break;
				case "turn_end": {
					const role = event.message.role;
					const durationMs = Date.now() - turnStartTs;
					appendSession(
						`_Turn ${turnCounter} done · ${toolCallsInTurn} tool call${toolCallsInTurn === 1 ? "" : "s"} · ${formatDurationMs(durationMs)}_\n`,
					);
					const toolsStr = turnToolLabels.length > 0 ? truncate(turnToolLabels.join(" "), 40) : "—";
					appendCompact(
						`${String(turnCounter).padStart(4)} | ${toolsStr} | ${formatTokens(totalInput)} | ${formatTokens(totalOutput)} | ${formatCost(totalCost)} | ${formatDurationMs(durationMs)}\n`,
					);
					pushTimeline({
						type: "turn",
						phase: "end",
						ts: Date.now(),
						turn: turnCounter,
						role,
						toolResults: event.toolResults.length,
						durationMs,
					});
					break;
				}
				case "message_start":
					pushTimeline({ type: "message", phase: "start", ts: Date.now(), role: event.message.role });
					break;
				case "message_update":
					pushTimeline({
						type: "message",
						phase: "update",
						ts: Date.now(),
						role: event.message.role,
						delta: event.assistantMessageEvent?.type,
					});
					break;
				case "message_end": {
					const message = event.message;
					pushTimeline({
						type: "message",
						phase: "end",
						ts: Date.now(),
						role: message.role,
						...(message.role === "assistant"
							? { usage: (message as { usage?: unknown }).usage, textLength: extractText(message).length }
							: {}),
					});
					if (message.role === "assistant") {
						handleAssistantMessageEnd(message);
					} else if (message.role === "user") {
						const text = extractText(message);
						if (text.trim().length > 0) {
							appendSession(
								`**Input:** "${truncate(redactSecrets(text), MAX_TEXT_PREVIEW_CHARS).replace(/\n/g, "\\n")}"\n\n`,
							);
						}
					}
					break;
				}
				case "tool_execution_start":
					toolCallsInTurn++;
					pendingTools.set(event.toolCallId, { toolName: event.toolName, args: event.args, startTs: Date.now() });
					pushTimeline({
						type: "tool_call",
						ts: Date.now(),
						toolCallId: event.toolCallId,
						tool: event.toolName,
						args: summarizeToolArgs(
							(event.args && typeof event.args === "object" ? event.args : {}) as Record<string, unknown>,
							200,
						),
					});
					break;
				case "tool_execution_update":
					pushTimeline({
						type: "tool_call",
						phase: "update",
						ts: Date.now(),
						toolCallId: event.toolCallId,
						tool: event.toolName,
					});
					break;
				case "tool_execution_end": {
					const pending = pendingTools.get(event.toolCallId);
					pendingTools.delete(event.toolCallId);
					const durationMs = pending ? Date.now() - pending.startTs : 0;
					const args = pending?.args;
					const content = (event.result as { content?: unknown } | undefined)?.content;
					const text = resultText(content);
					const bytes = Buffer.byteLength(text, "utf8");
					const label = toolLabel(event.toolName, args);
					const mark = event.isError ? "✗" : "✓";

					let detail: string;
					if (event.isError) {
						const exitCode = event.toolName === "bash" ? parseBashExitCode(text, true) : null;
						detail = exitCode !== null && exitCode !== 0 ? `exit ${exitCode}` : "error";
					} else {
						detail = formatBytes(bytes);
					}
					appendSession(`  ${mark} ${label} · ${durationMs}ms · ${detail}\n`);
					turnToolLabels.push(`${event.toolName}${mark}`);

					const preview = formatToolResultContent(content, event.isError);
					if (preview.trim().length > 0) {
						const oneLine = truncate(redactSecrets(preview), MAX_RESULT_PREVIEW_CHARS).replace(/\n/g, "\\n");
						appendSession(`    → ${oneLine}\n`);
					}

					pushTimeline({
						type: "tool_result",
						ts: Date.now(),
						toolCallId: event.toolCallId,
						tool: event.toolName,
						isError: event.isError,
						durationMs,
						bytes,
					});
					break;
				}
				default:
					pushTimeline({ type: "event", ts: Date.now(), eventType: (event as { type: string }).type });
					break;
			}
		} catch {
			// The recorder observes the run; it must never disturb it.
		}
	};

	const finish = (result: SubagentResult): SubagentDebugLogRef | undefined => {
		if (!enabled) return undefined;
		if (finished) return { logDir, logRef };
		finished = true;

		const durationStr = `${formatDurationMs(result.durationMs)} (${result.durationMs}ms)`;
		const summaryPreview = truncate(redactSecrets(result.summary), MAX_SUMMARY_PREVIEW_CHARS);

		appendSession(
			`
## Outcome

| Metric | Value |
|--------|-------|
| State | ${result.state} |
| Turns | ${result.turns} |
| Tokens | ${formatTokens(result.usage.totalTokens)} total (${formatTokens(result.usage.input)} in / ${formatTokens(result.usage.output)} out) |
| Cost | ${formatCost(result.usage.cost)} |
| Duration | ${durationStr} |
${result.error ? `| Abort reason | ${result.error} |\n` : ""}| Evidence | ${result.evidence.length} entr${result.evidence.length === 1 ? "y" : "ies"} |

**Summary:** ${summaryPreview.length > 0 ? summaryPreview : "(no output)"}
`,
		);

		appendCompact(
			`
---

## Outcome

| Metric | Value |
|--------|-------|
| State | ${result.state} |
| Turns | ${result.turns} |
| Total input tokens | ${totalInput.toLocaleString()} |
| Total output tokens | ${totalOutput.toLocaleString()} |
| Total cost | ${formatCost(totalCost)} |
| Duration | ${formatDurationMs(result.durationMs)} |
`,
		);

		pushTimeline({
			type: "outcome",
			ts: Date.now(),
			state: result.state,
			turns: result.turns,
			durationMs: result.durationMs,
			totalTokens: result.usage.totalTokens,
			cost: result.usage.cost,
			evidenceCount: result.evidence.length,
			...(result.error ? { error: result.error } : {}),
		});
		// Final flush — covers buffered message_update entries too.
		safeWrite(() => fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 2), "utf8"));

		if (!enabled) return undefined;
		return { logDir, logRef };
	};

	return { handleEvent, finish };
}
