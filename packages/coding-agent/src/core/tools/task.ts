/**
 * `task` tool — delegate a self-contained subtask to an isolated subagent.
 *
 * The tool is a thin shell over core/subagent-runner.ts: it forwards progress
 * via onUpdate (rendered nested under the parent's tool call in the TUI),
 * records a usage roll-up entry into the parent session (honest token
 * accounting), and bubbles structured evidence up as synthesized tool outcomes
 * so the auton verification gate sees real commands — never prose claims.
 */

import type { AgentToolResult, ThinkingLevel } from "@ag1/agent-core";
import type { Model } from "@ag1/ai";
import { Text } from "@ag1/tui";
import { type Static, Type } from "@sinclair/typebox";
import type {
	ExtensionContext,
	ToolDefinition,
	ToolRenderContext,
	ToolRenderResultOptions,
} from "../extensions/types.js";
import type { ModelRegistry } from "../model-registry.js";
import type { ToolSafetyPolicy } from "../safety-policy.js";
import { createSubagentDebugRecorder } from "../subagent-debug-recorder.js";
import {
	DEFAULT_MAX_TURNS,
	DEFAULT_TIMEOUT_S,
	MAX_TURNS_CAP,
	runSubagent,
	type SubagentEvidence,
	type SubagentProgress,
	type SubagentResult,
	type SubagentState,
	type SubagentType,
	type SubagentUsage,
} from "../subagent-runner.js";

/** Session custom-entry type for per-task usage roll-ups (eval accounting + ledger). */
export const TASK_SESSION_ENTRY_TYPE = "ag1.subagent_task";

export interface TaskToolDeps {
	cwd: string;
	modelRegistry: ModelRegistry;
	getParentModel: () => Model<any> | undefined;
	getParentThinkingLevel?: () => ThinkingLevel | undefined;
	getSafetyPolicy?: () => ToolSafetyPolicy | undefined;
	getBashCommandPrefix?: () => string | undefined;
	/** Append a usage roll-up entry to the parent session record. */
	recordTaskEntry?: (data: Record<string, unknown>) => void;
	/** Bubble synthesized evidence outcomes into the parent's fact cache / verification gate. */
	recordToolOutcome?: (outcome: { tool: string; success: boolean; detail?: string }) => void;
}

const taskSchema = Type.Object({
	description: Type.String({ description: "3-5 word task label shown in the UI" }),
	type: Type.Union(
		[
			Type.Literal("explore"),
			Type.Literal("research"),
			Type.Literal("implement"),
			Type.Literal("verify"),
			Type.Literal("plan"),
		],
		{
			description:
				"Subagent profile: explore (read-only inspection, file:line evidence), research (explore + web, source URLs), implement (full tools, makes and verifies changes), verify (read-only + bash checks, reports commands + exit codes), plan (read-only, step-by-step plan)",
		},
	),
	prompt: Type.String({
		description:
			"Self-contained task brief. The subagent sees NOTHING else — no conversation, no context. Include file paths, goals, and constraints.",
	}),
	model: Type.Optional(
		Type.String({
			description:
				"Optional model override as provider/id. Default: routed by type (implement/plan use the current model; explore/research/verify may use a cheaper eligible model).",
		}),
	),
	maxTurns: Type.Optional(
		Type.Number({ description: `Max assistant turns (default ${DEFAULT_MAX_TURNS}, hard cap ${MAX_TURNS_CAP})` }),
	),
	timeout: Type.Optional(Type.Number({ description: `Wall-clock timeout in seconds (default ${DEFAULT_TIMEOUT_S})` })),
});

type TaskToolInput = Static<typeof taskSchema>;

export interface TaskToolDetails {
	description: string;
	type: SubagentType;
	model: string;
	state: SubagentState | "running";
	partial?: boolean;
	turns?: number;
	durationMs?: number;
	usage?: SubagentUsage;
	summary?: string;
	evidence?: SubagentEvidence[];
	error?: string;
	progress?: SubagentProgress;
	/** Debug log path relative to the Debug root, when subagent debug recording is active. */
	debugLog?: string;
}

const MAX_CONTENT_EVIDENCE_LINES = 10;
const MAX_SYNTHESIZED_OUTCOMES = 20;

function formatTokens(value: number): string {
	return value.toLocaleString("en-US");
}

function formatProgressLine(progress: SubagentProgress): string {
	return `turn ${progress.turn} · ${progress.toolCalls} tool calls · ~${formatTokens(progress.tokens)} tok · ${progress.elapsedS}s · ${progress.lastAction}`;
}

function formatEvidenceLine(entry: SubagentEvidence): string {
	switch (entry.kind) {
		case "bash":
			return `bash: \`${entry.command}\` → exit ${entry.exitCode === null ? "killed" : entry.exitCode}`;
		case "file":
			return `${entry.action}: ${entry.path}`;
		case "web":
			return `fetch: ${entry.url}`;
	}
}

/** What the parent model reads. Compact: state line, summary, capped evidence. */
export function formatTaskResultContent(result: SubagentResult): string {
	const header = `Task ${result.state}: ${result.description} [${result.type} · ${result.model} · ${result.turns} turns · ${Math.round(result.durationMs / 1000)}s · ${formatTokens(result.usage.totalTokens)} tok]`;
	const parts = [header];
	if (result.error) parts.push(`Note: ${result.error}`);
	if (result.partial) parts.push("Partial result — the task ended before completing.");
	parts.push("Summary:");
	parts.push(result.summary.trim().length > 0 ? result.summary : "(no output)");
	if (result.evidence.length > 0) {
		parts.push(`Evidence (${result.evidence.length}):`);
		for (const entry of result.evidence.slice(-MAX_CONTENT_EVIDENCE_LINES)) {
			parts.push(`- ${formatEvidenceLine(entry)}`);
		}
		if (result.evidence.length > MAX_CONTENT_EVIDENCE_LINES) {
			parts.push(`- … ${result.evidence.length - MAX_CONTENT_EVIDENCE_LINES} more`);
		}
	}
	return parts.join("\n");
}

/**
 * Bubble real subagent evidence into the parent's tool-outcome stream. Bash
 * evidence is recorded as `bash` outcomes (the gate applies the same
 * reliable-verification-command check as for parent-run bash); file evidence as
 * `write`/`edit` mutations. Only successes are recorded — matching the parent
 * flow, and keeping the gate strict.
 */
export function synthesizeEvidenceOutcomes(
	result: SubagentResult,
	record: (outcome: { tool: string; success: boolean; detail?: string }) => void,
): void {
	let recorded = 0;
	for (const entry of result.evidence) {
		if (recorded >= MAX_SYNTHESIZED_OUTCOMES) break;
		if (entry.kind === "bash" && entry.exitCode === 0) {
			record({ tool: "bash", success: true, detail: entry.command });
			recorded++;
		} else if (entry.kind === "file") {
			record({ tool: entry.action, success: true, detail: entry.path });
			recorded++;
		}
	}
}

function formatCount(value: number | undefined, suffix: string): string {
	return value === undefined ? "" : ` · ${formatTokens(value)}${suffix}`;
}

function renderTaskResult(
	result: { content: Array<{ type: string; text?: string }>; details?: TaskToolDetails },
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): Text {
	const details = result.details;
	if (!details) {
		const text = result.content.find((block) => block.type === "text")?.text ?? "";
		return new Text(
			theme.fg(
				"toolOutput",
				text
					.split("\n")
					.slice(0, options.expanded ? 12 : 3)
					.join("\n"),
			),
			0,
			0,
		);
	}

	if (options.isPartial && details.progress) {
		const progress = details.progress;
		return new Text(
			theme.fg("toolTitle", theme.bold(`${details.type} · ${progress.model}`)) +
				`\n${theme.fg("muted", formatProgressLine(progress))}`,
			0,
			0,
		);
	}

	const stateTone = details.state === "completed" ? "success" : details.state === "failed" ? "error" : "warning";
	let text = `${theme.fg("toolTitle", theme.bold(`${details.type} · ${details.model}`))} ${theme.fg(stateTone, details.state)}`;
	const stats = `turns ${details.turns ?? "?"} · ${Math.round((details.durationMs ?? 0) / 1000)}s${formatCount(details.usage?.totalTokens, " tok")}`;
	text += `\n${theme.fg("muted", stats)}`;
	if (details.error) {
		text += `\n${theme.fg("warning", details.error)}`;
	}
	if (details.summary) {
		const lines = details.summary.trim().split("\n");
		const shown = options.expanded ? lines.slice(0, 12) : lines.slice(0, 3);
		text += `\n${theme.fg("toolOutput", shown.join("\n"))}`;
		if (lines.length > shown.length) {
			text += `\n${theme.fg("muted", `… ${lines.length - shown.length} more lines`)}`;
		}
	}
	if (details.evidence && details.evidence.length > 0) {
		const shown = options.expanded ? details.evidence.slice(-6) : details.evidence.slice(-2);
		for (const entry of shown) {
			text += `\n${theme.fg("muted", formatEvidenceLine(entry))}`;
		}
	}
	return new Text(text, 0, 0);
}

export function createTaskToolDefinition(deps: TaskToolDeps): ToolDefinition<typeof taskSchema, TaskToolDetails> {
	return {
		name: "task",
		label: "task",
		description: `Delegate a self-contained subtask to an isolated subagent with its own context and tools; receive only its final result.

Use when a subtask would flood your context (multi-file exploration, log-heavy test runs) or benefits from isolation. The subagent sees ONLY your prompt — include everything it needs; it cannot ask questions or spawn subagents. Runs in the foreground; the result is the final summary plus capped evidence, never the transcript.`,
		parameters: taskSchema,
		promptSnippet: "Delegate a self-contained subtask to an isolated subagent (result-only return)",
		execute: async (
			toolCallId: string,
			params: TaskToolInput,
			signal: AbortSignal | undefined,
			onUpdate: ((partial: AgentToolResult<TaskToolDetails>) => void) | undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<TaskToolDetails>> => {
			// Debug recorder: mirrors the run into Debug/subagent_*/ so subagent
			// work is fully visible (session.md, timeline.json). No-op when the
			// debug dir cannot be created.
			const recorder = createSubagentDebugRecorder({
				cwd: deps.cwd,
				type: params.type,
				description: params.description,
				model: params.model ?? "auto",
				toolCallId,
			});

			const result = await runSubagent(
				deps,
				{
					description: params.description,
					type: params.type,
					prompt: params.prompt,
					model: params.model,
					maxTurns: params.maxTurns,
					timeout: params.timeout,
				},
				{
					signal,
					onEvent: recorder.handleEvent,
					onProgress: onUpdate
						? (progress) => {
								onUpdate({
									content: [{ type: "text" as const, text: formatProgressLine(progress) }],
									details: {
										description: params.description,
										type: params.type,
										model: progress.model,
										state: "running",
										progress,
									},
								});
							}
						: undefined,
				},
			);

			const debugLog = recorder.finish(result);

			// Observability: roll subagent usage into the parent session record so
			// token accounting (and the eval harness) sees the real total.
			// Journal writes must never fail the tool call — a session write-lock
			// timeout skips the entry instead of killing completed work.
			try {
				deps.recordTaskEntry?.({
					description: result.description,
					type: result.type,
					model: result.model,
					state: result.state,
					turns: result.turns,
					durationMs: result.durationMs,
					usage: {
						input: result.usage.input,
						output: result.usage.output,
						cacheRead: result.usage.cacheRead,
						cacheWrite: result.usage.cacheWrite,
						totalTokens: result.usage.totalTokens,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: result.usage.cost },
					},
					evidence: result.evidence,
					...(result.error ? { error: result.error } : {}),
					...(debugLog ? { debugLog: debugLog.logRef } : {}),
				});
			} catch {
				// Best effort only — see comment above.
			}

			if (deps.recordToolOutcome) {
				synthesizeEvidenceOutcomes(result, deps.recordToolOutcome);
			}

			return {
				content: [{ type: "text" as const, text: formatTaskResultContent(result) }],
				details: {
					description: result.description,
					type: result.type,
					model: result.model,
					state: result.state,
					partial: result.partial,
					turns: result.turns,
					durationMs: result.durationMs,
					usage: result.usage,
					summary: result.summary,
					evidence: result.evidence,
					...(result.error ? { error: result.error } : {}),
					...(debugLog ? { debugLog: debugLog.logRef } : {}),
				},
			};
		},
		renderResult: (
			result: AgentToolResult<TaskToolDetails>,
			options: ToolRenderResultOptions,
			theme: typeof import("../../modes/interactive/theme/theme.js").theme,
			_context: ToolRenderContext<any, TaskToolInput>,
		) =>
			renderTaskResult(
				result as { content: Array<{ type: string; text?: string }>; details?: TaskToolDetails },
				options,
				theme,
			),
	};
}
