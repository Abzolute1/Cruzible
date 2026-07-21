/**
 * Subagent runner — builds an isolated `Agent` per delegated task, enforces
 * bounds, and returns a structured result-only summary to the parent.
 *
 * Design contract (docs/subagent-proposal.md):
 * - Isolation: fresh Agent + ephemeral in-memory transcript. The parent never
 *   pays for the subagent's transcript — only for the returned summary.
 * - Read-only profiles get their tool sets BY CONSTRUCTION (registry
 *   restriction, not prompt text), and never see the `task` tool (hard
 *   no-recursion).
 * - Efficiency comes from isolation, never from dumbing down: implement/plan
 *   run the parent driver model; explore/research/verify may route cheaper.
 * - Bounds (turns, wall timeout, token budget, loop detection) exist to stop
 *   loops, not to ration real work — defaults are generous.
 */

import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	type StreamFn,
	type ThinkingLevel,
} from "@ag1/agent-core";
import type { Model } from "@ag1/ai";
import {
	type ContextHygieneOptions,
	createContextHygieneCopy,
	createLiveProviderContext,
} from "./compaction/micro-compact.js";
import { convertToLlm } from "./messages.js";
import { inferModelCapabilityProfile } from "./model-capability-profile.js";
import type { ModelRegistry } from "./model-registry.js";
import { selectCheapModelForTask } from "./model-routing.js";
import { createResilientStreamFn } from "./nvidia-stream-fallback.js";
import { evaluateToolSafety, type ToolSafetyPolicy } from "./safety-policy.js";
import { acquireSubagentSlot } from "./subagent-scheduler.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { type BashToolOptions, createBashTool } from "./tools/bash.js";
import { createEditTool } from "./tools/edit.js";
import { createFindTool } from "./tools/find.js";
import { createGrepTool } from "./tools/grep.js";
import { createLsTool } from "./tools/ls.js";
import { createReadTool } from "./tools/read.js";
import { createWebFetchTool } from "./tools/webfetch.js";
import { createWebSearchTool } from "./tools/websearch.js";
import { createWriteTool } from "./tools/write.js";

export type SubagentType = "explore" | "research" | "implement" | "verify" | "plan";

export const SUBAGENT_TYPES: readonly SubagentType[] = ["explore", "research", "implement", "verify", "plan"];

export interface SubagentRunnerDeps {
	cwd: string;
	modelRegistry: ModelRegistry;
	/** Parent driver model (implement/plan default; routing baseline for cheap profiles). */
	getParentModel: () => Model<any> | undefined;
	getParentThinkingLevel?: () => ThinkingLevel | undefined;
	/** Active safety policy — applied identically below the subagent boundary. */
	getSafetyPolicy?: () => ToolSafetyPolicy | undefined;
	/** Shell command prefix from settings, forwarded to subagent bash tools. */
	getBashCommandPrefix?: () => string | undefined;
	/** Test seam: override the stream function factory. Default: resilient production stream. */
	streamFnFactory?: (registry: ModelRegistry) => StreamFn;
}

export interface SubagentRunRequest {
	description: string;
	type: SubagentType;
	prompt: string;
	/** Explicit "provider/id" override. Default: routed by profile. */
	model?: string;
	maxTurns?: number;
	/** Wall-clock timeout in seconds. */
	timeout?: number;
	/** Internal token budget (not model-exposed). Default: DEFAULT_TOKEN_BUDGET. */
	tokenBudget?: number;
}

export type SubagentState = "completed" | "failed" | "timeout" | "budget";

export type SubagentEvidence =
	| { kind: "bash"; command: string; exitCode: number | null }
	| { kind: "file"; action: "write" | "edit"; path: string }
	| { kind: "web"; url: string };

export interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export interface SubagentProgress {
	turn: number;
	toolCalls: number;
	tokens: number;
	elapsedS: number;
	lastAction: string;
	model: string;
}

export interface SubagentResult {
	state: SubagentState;
	type: SubagentType;
	description: string;
	/** "provider/id" of the model that actually ran. */
	model: string;
	summary: string;
	/** True when the run ended early (timeout/budget/failure) but partial output exists. */
	partial: boolean;
	evidence: SubagentEvidence[];
	usage: SubagentUsage;
	turns: number;
	durationMs: number;
	error?: string;
}

export const DEFAULT_MAX_TURNS = 12;
export const MAX_TURNS_CAP = 25;
export const DEFAULT_TIMEOUT_S = 300;
export const DEFAULT_TOKEN_BUDGET = 200_000;
const MAX_SUMMARY_CHARS = 6_000;
const MAX_EVIDENCE_ENTRIES = 20;
const LOOP_SIGNATURE_REPEAT = 3;
const PROGRESS_THROTTLE_MS = 250;

// ============================================================================
// Profile tool sets (structural restriction — the registry, not the prompt)
// ============================================================================

/**
 * Read-only bash allowlist for explore/plan profiles. Enforcement lives here in
 * the tool wrapper (not the prompt), so a model cannot talk its way past it.
 * Rejection is safe: the model gets a clear message and falls back to the
 * structured read/grep/find/ls tools.
 */
const READ_ONLY_BASH_BINARIES = new Set([
	"cat",
	"head",
	"tail",
	"wc",
	"file",
	"stat",
	"pwd",
	"echo",
	"printf",
	"ls",
	"find",
	"rg",
	"grep",
	"jq",
	"sort",
	"uniq",
	"diff",
	"du",
	"df",
	"env",
	"which",
	"uname",
	"date",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"tree",
	"tr",
	"cut",
	"comm",
	"column",
	"nl",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"log",
	"show",
	"diff",
	"status",
	"blame",
	"grep",
	"ls-files",
	"ls-tree",
	"rev-parse",
	"branch",
	"tag",
	"describe",
	"shortlog",
	"cat-file",
]);

export function validateReadOnlyBashCommand(command: string): { ok: true } | { ok: false; reason: string } {
	const reject = (reason: string) => ({
		ok: false as const,
		reason: `Read-only bash (this subagent profile cannot mutate): ${reason}. Use the read/grep/find/ls tools instead, or report back that a mutating command is needed.`,
	});
	if (/`/.test(command) || /\$\(/.test(command)) return reject("command substitution is not allowed");
	// `2>/dev/null` is ubiquitous and harmless; every other redirection writes.
	const stripped = command.replace(/2>\s*\/dev\/null/g, "");
	if (/>/.test(stripped)) return reject("output redirection is not allowed");
	const segments = stripped
		.split(/&&|\|\||[;|]/)
		.map((segment) => segment.trim())
		.filter(Boolean);
	for (const segment of segments) {
		const tokens = segment.split(/\s+/);
		const binary = (tokens[0] ?? "").replace(/^.*\//, "");
		if (!binary) continue;
		if (binary.includes("=")) return reject("environment assignments are not allowed");
		if (binary === "git") {
			const subcommand = (tokens[1] ?? "").replace(/^-/, "");
			if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
				return reject(`git ${tokens[1] ?? ""} is not a read-only subcommand`);
			}
			continue;
		}
		if (!READ_ONLY_BASH_BINARIES.has(binary)) return reject(`'${binary}' is not in the read-only command allowlist`);
	}
	return { ok: true };
}

function createReadOnlyBashTool(cwd: string, options?: BashToolOptions): AgentTool<any> {
	const base = createBashTool(cwd, options);
	return {
		...base,
		execute: async (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
			const command = typeof params?.command === "string" ? params.command : "";
			const verdict = validateReadOnlyBashCommand(command);
			if (!verdict.ok) {
				return { content: [{ type: "text" as const, text: verdict.reason }], details: {} };
			}
			return base.execute(toolCallId, params, signal, onUpdate);
		},
	};
}

/** Profile tool sets by construction. Subagents never get `task` (no recursion). */
export function buildSubagentTools(
	type: SubagentType,
	cwd: string,
	options?: { bash?: BashToolOptions },
): AgentTool<any>[] {
	const read = createReadTool(cwd);
	const grep = createGrepTool(cwd);
	const find = createFindTool(cwd);
	const ls = createLsTool(cwd);
	switch (type) {
		case "explore":
			return [read, grep, find, ls, createReadOnlyBashTool(cwd, options?.bash)];
		case "research":
			return [
				read,
				grep,
				find,
				ls,
				createReadOnlyBashTool(cwd, options?.bash),
				createWebSearchTool({ cwd }),
				createWebFetchTool({ cwd }),
			];
		case "verify":
			return [read, grep, find, ls, createBashTool(cwd, options?.bash)];
		case "implement":
			return [
				read,
				grep,
				find,
				ls,
				createBashTool(cwd, options?.bash),
				createEditTool(cwd),
				createWriteTool(cwd),
				createWebSearchTool({ cwd }),
				createWebFetchTool({ cwd }),
			];
		case "plan":
			return [read, grep, find, ls, createReadOnlyBashTool(cwd, options?.bash)];
	}
}

// ============================================================================
// Profile system prompts
// ============================================================================

const SUBAGENT_PREAMBLE =
	"A parent agent delegated a self-contained task to you. It sees ONLY your final message — never your tool calls or transcript — so your final message must contain everything it needs.";

const PROFILE_PROMPTS: Record<SubagentType, string> = {
	explore: `You are an exploration subagent inside the AG1 coding harness. ${SUBAGENT_PREAMBLE}
You inspect the workspace and answer with evidence. You have read-only tools (no edits or writes; bash is restricted to read-only commands).
Rules:
- Gather evidence with the tools, then answer concisely.
- Cite file:line for every code-derived claim.
- Final message: the complete, self-contained answer. If you could not determine something, say so plainly.`,
	research: `You are a research subagent inside the AG1 coding harness. ${SUBAGENT_PREAMBLE}
You answer questions using the workspace and the web. You have read-only tools plus webSearch/webFetch.
Rules:
- For online questions: webSearch for candidate sources, webFetch the strongest URLs.
- Cite source URLs for every web-derived claim and file:line for every code-derived claim.
- Final message: the complete, self-contained answer.`,
	implement: `You are an implementation subagent inside the AG1 coding harness. ${SUBAGENT_PREAMBLE}
You make code changes and verify them. You have the full tool set.
Rules:
- Stay scoped to the task. Do not refactor surrounding code.
- Verify the change (run the tests/build/checks that prove it) before finishing.
- Final message: what changed (file paths), how it was verified (commands + exit codes), anything left undone.`,
	verify: `You are a verification subagent inside the AG1 coding harness. ${SUBAGENT_PREAMBLE}
You run verifications and report exactly what happened. You have read-only tools plus full bash for tests/builds/commands.
Rules:
- Run the checks the task describes. Report each command, its exit code, and a short output summary.
- Do not modify files to make checks pass — a failure is a finding; report it.
- Final message: commands + exit codes + verdict (pass/fail) + relevant output excerpts.`,
	plan: `You are a planning subagent inside the AG1 coding harness. ${SUBAGENT_PREAMBLE}
You produce actionable plans. You have read-only tools.
Rules:
- Inspect the workspace as needed; ground every step in real file paths.
- Final message: a numbered plan — concrete steps with file paths and how to verify each step.`,
};

export function buildSubagentSystemPrompt(type: SubagentType, cwd: string): string {
	return buildSystemPrompt({ customPrompt: PROFILE_PROMPTS[type], cwd });
}

// ============================================================================
// Model routing
// ============================================================================

export function resolveSubagentModel(
	deps: Pick<SubagentRunnerDeps, "modelRegistry" | "getParentModel">,
	request: Pick<SubagentRunRequest, "type" | "model">,
): { model: Model<any> } | { error: string } {
	const registry = deps.modelRegistry;
	if (request.model) {
		const slash = request.model.indexOf("/");
		if (slash <= 0 || slash === request.model.length - 1) {
			return { error: `Invalid model "${request.model}" — expected provider/id.` };
		}
		const found = registry.find(request.model.slice(0, slash), request.model.slice(slash + 1));
		if (!found) return { error: `Unknown model "${request.model}".` };
		if (!registry.hasConfiguredAuth(found)) return { error: `No credentials configured for "${request.model}".` };
		return { model: found };
	}

	const parent = deps.getParentModel();
	if (!parent) return { error: "No parent model is available to route this subagent." };
	// The cardinal rule: capability profiles run the driver model, never a weaker one.
	if (request.type === "implement" || request.type === "plan") return { model: parent };

	const candidates = registry.getAvailable().filter((model) => registry.hasConfiguredAuth(model));
	const route = selectCheapModelForTask({
		task: "direct_lookup",
		currentModel: parent,
		candidates,
		minContextWindow: 16_384,
		minMaxTokens: 4_096,
	});
	return { model: route.model };
}

// ============================================================================
// Runner internals
// ============================================================================

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
		.join(",")}}`;
}

function extractAssistantText(message: AgentMessage): string {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function summarizeToolArgs(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object") return toolName;
	const record = args as Record<string, unknown>;
	const clamp = (value: string, max = 80) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
	switch (toolName) {
		case "bash":
			return typeof record.command === "string" ? `bash: ${clamp(record.command)}` : "bash";
		case "read":
		case "write":
		case "edit": {
			const path =
				typeof record.path === "string"
					? record.path
					: typeof record.file_path === "string"
						? record.file_path
						: "";
			return `${toolName}: ${clamp(path)}`;
		}
		case "grep":
			return typeof record.pattern === "string" ? `grep: ${clamp(record.pattern)}` : "grep";
		case "find":
			return typeof record.pattern === "string" ? `find: ${clamp(record.pattern)}` : "find";
		case "webFetch":
			return typeof record.url === "string" ? `webFetch: ${clamp(record.url)}` : "webFetch";
		case "webSearch":
			return typeof record.query === "string" ? `webSearch: ${clamp(record.query)}` : "webSearch";
		default:
			return toolName;
	}
}

function resultText(result: { content?: unknown }): string {
	if (!Array.isArray(result.content)) return "";
	return result.content
		.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null)
		.map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
		.join("\n");
}

function parseBashExitCode(text: string, isError: boolean): number | null {
	const match = text.match(/Command exited with code (\d+)/);
	if (match) return Number(match[1]);
	if (isError || /killed|terminated|aborted/i.test(text)) return null;
	return 0;
}

function clampMaxTurns(value: number | undefined): number {
	const requested = Math.floor(value ?? DEFAULT_MAX_TURNS);
	if (!Number.isFinite(requested) || requested < 1) return DEFAULT_MAX_TURNS;
	return Math.min(requested, MAX_TURNS_CAP);
}

/**
 * Run one delegated task in an isolated subagent. Never throws — failures are
 * encoded in the returned SubagentResult.
 */
export async function runSubagent(
	deps: SubagentRunnerDeps,
	request: SubagentRunRequest,
	options?: {
		signal?: AbortSignal;
		onProgress?: (progress: SubagentProgress) => void;
		/** Observer hook: receives every raw AgentEvent from the subagent run (debug recording). */
		onEvent?: (event: AgentEvent) => void;
	},
): Promise<SubagentResult> {
	const startedAt = Date.now();
	const resolved = resolveSubagentModel(deps, request);
	if ("error" in resolved) {
		return {
			state: "failed",
			type: request.type,
			description: request.description,
			model: request.model ?? "unresolved",
			summary: "",
			partial: false,
			evidence: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
			turns: 0,
			durationMs: Date.now() - startedAt,
			error: resolved.error,
		};
	}
	const model = resolved.model;
	const maxTurns = clampMaxTurns(request.maxTurns);
	const timeoutMs = Math.max(1, request.timeout ?? DEFAULT_TIMEOUT_S) * 1000;
	const tokenBudget = request.tokenBudget ?? DEFAULT_TOKEN_BUDGET;

	const profile = inferModelCapabilityProfile(model);
	const hygieneOptions: ContextHygieneOptions | undefined =
		profile?.recommendedCompactionPolicy === "local_small"
			? { keepTurns: 1, maxToolResultChars: 160, maxHiddenCustomChars: 100 }
			: profile?.toolCallReliability === "medium"
				? { keepTurns: 2, maxToolResultChars: 180, maxHiddenCustomChars: 140 }
				: undefined;

	const thinkingLevel: ThinkingLevel = model.reasoning ? (deps.getParentThinkingLevel?.() ?? "medium") : "off";
	const tools = buildSubagentTools(request.type, deps.cwd, {
		bash: { commandPrefix: deps.getBashCommandPrefix?.() },
	});

	const agent = new Agent({
		initialState: {
			systemPrompt: buildSubagentSystemPrompt(request.type, deps.cwd),
			model,
			thinkingLevel,
			tools,
		},
		streamFn: (deps.streamFnFactory ?? createResilientStreamFn)(deps.modelRegistry),
		convertToLlm: (messages) =>
			convertToLlm(createLiveProviderContext(createContextHygieneCopy(messages, hygieneOptions, undefined))),
		sessionId: `subagent-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		maxTurns,
		beforeToolCall: async ({ toolCall, args }) => {
			const policy = deps.getSafetyPolicy?.();
			if (!policy) return undefined;
			const decision = evaluateToolSafety(toolCall.name, args, policy);
			if (!decision.allow) {
				return {
					block: true,
					reason: decision.reason ?? `Tool ${toolCall.name} was blocked by the active safety policy.`,
				};
			}
			if (!decision.approvalRequest) return undefined;
			if (!policy.approvalHandler) {
				return {
					block: true,
					reason: `${decision.approvalRequest.summary} No interactive approval handler is available.`,
				};
			}
			const approved = await policy.approvalHandler(decision.approvalRequest);
			return approved ? undefined : { block: true, reason: `User denied ${toolCall.name} execution.` };
		},
	});

	// --- Run tracking -------------------------------------------------------
	const usage: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
	const evidence: SubagentEvidence[] = [];
	const pendingArgs = new Map<string, { toolName: string; args: unknown }>();
	const recentSignatures: string[] = [];
	let turns = 0;
	let toolCalls = 0;
	let lastAssistantText = "";
	let lastAction = "starting";
	let failureError: string | undefined;
	let abortReason: "timeout" | "budget" | "loop" | "external" | undefined;
	let lastProgressAt = 0;

	const emitProgress = (force = false) => {
		if (!options?.onProgress) return;
		const now = Date.now();
		if (!force && now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
		lastProgressAt = now;
		options.onProgress({
			turn: turns,
			toolCalls,
			tokens: usage.totalTokens,
			elapsedS: Math.floor((now - startedAt) / 1000),
			lastAction,
			model: `${model.provider}/${model.id}`,
		});
	};

	const abort = (reason: NonNullable<typeof abortReason>) => {
		if (abortReason) return;
		abortReason = reason;
		agent.abort();
	};

	agent.subscribe((event) => {
		// Forward every raw event to observers (debug recorder) before the
		// runner's own bookkeeping; the hook must not affect the run.
		try {
			options?.onEvent?.(event);
		} catch {
			// Observer failures never disturb the subagent run.
		}
		switch (event.type) {
			case "message_end": {
				const message = event.message;
				if (message.role !== "assistant") break;
				if (message.usage) {
					usage.input += message.usage.input ?? 0;
					usage.output += message.usage.output ?? 0;
					usage.cacheRead += message.usage.cacheRead ?? 0;
					usage.cacheWrite += message.usage.cacheWrite ?? 0;
					usage.totalTokens += message.usage.totalTokens ?? 0;
					usage.cost += message.usage.cost?.total ?? 0;
				}
				const text = extractAssistantText(message);
				if (text.trim()) lastAssistantText = text;
				if (message.errorMessage) failureError = message.errorMessage;
				if (usage.totalTokens > tokenBudget) abort("budget");
				break;
			}
			case "turn_end":
				if (event.message.role === "assistant") turns++;
				break;
			case "tool_execution_start": {
				toolCalls++;
				pendingArgs.set(event.toolCallId, { toolName: event.toolName, args: event.args });
				lastAction = summarizeToolArgs(event.toolName, event.args);
				const signature = `${event.toolName}:${stableStringify(event.args)}`;
				recentSignatures.push(signature);
				if (recentSignatures.length > LOOP_SIGNATURE_REPEAT) recentSignatures.shift();
				if (
					recentSignatures.length === LOOP_SIGNATURE_REPEAT &&
					recentSignatures.every((entry) => entry === signature)
				) {
					abort("loop");
				}
				emitProgress(true);
				break;
			}
			case "tool_execution_end": {
				const tracked = pendingArgs.get(event.toolCallId);
				pendingArgs.delete(event.toolCallId);
				const args = tracked?.args as Record<string, unknown> | undefined;
				if (event.toolName === "bash" && typeof args?.command === "string") {
					evidence.push({
						kind: "bash",
						command: args.command.slice(0, 200),
						exitCode: parseBashExitCode(resultText(event.result ?? {}), event.isError),
					});
				} else if ((event.toolName === "write" || event.toolName === "edit") && !event.isError) {
					const path =
						typeof args?.path === "string"
							? args.path
							: typeof args?.file_path === "string"
								? args.file_path
								: undefined;
					if (path) evidence.push({ kind: "file", action: event.toolName, path });
				} else if (event.toolName === "webFetch" && typeof args?.url === "string") {
					evidence.push({ kind: "web", url: args.url });
				}
				if (evidence.length > MAX_EVIDENCE_ENTRIES) evidence.splice(0, evidence.length - MAX_EVIDENCE_ENTRIES);
				emitProgress();
				break;
			}
			default:
				break;
		}
		emitProgress();
	});

	const timeoutHandle = setTimeout(() => abort("timeout"), timeoutMs);
	const onExternalAbort = () => abort("external");
	options?.signal?.addEventListener("abort", onExternalAbort, { once: true });

	// Scheduler: local models serialize on a single slot (LM Studio cannot run
	// parallel streams); API models share a small pool. Queued tasks wait here.
	const releaseSlot = await acquireSubagentSlot(model);

	try {
		await agent.prompt(request.prompt);
	} catch (error) {
		// Agent.prompt() encodes failures in messages rather than rejecting, but
		// never let a runner exception escape into the parent's tool execution.
		if (!failureError) failureError = error instanceof Error ? error.message : String(error);
	} finally {
		clearTimeout(timeoutHandle);
		options?.signal?.removeEventListener("abort", onExternalAbort);
		releaseSlot();
	}

	emitProgress(true);

	const turnLimitHit = failureError?.startsWith("Maximum turn limit") === true;
	const state: SubagentState =
		abortReason === "timeout"
			? "timeout"
			: abortReason === "budget" || abortReason === "loop" || turnLimitHit
				? "budget"
				: failureError
					? "failed"
					: "completed";

	const truncated = lastAssistantText.length > MAX_SUMMARY_CHARS;
	const summary = truncated ? `${lastAssistantText.slice(0, MAX_SUMMARY_CHARS)}\n…[truncated]` : lastAssistantText;
	const error =
		abortReason === "loop"
			? `Loop detected: the same tool call repeated ${LOOP_SIGNATURE_REPEAT} times consecutively.`
			: abortReason === "budget"
				? `Token budget (${tokenBudget}) exceeded.`
				: abortReason === "external"
					? "Aborted by the parent run."
					: failureError;

	return {
		state,
		type: request.type,
		description: request.description,
		model: `${model.provider}/${model.id}`,
		summary,
		partial: state !== "completed" && summary.length > 0,
		evidence,
		usage,
		turns,
		durationMs: Date.now() - startedAt,
		...(error ? { error } : {}),
	};
}
