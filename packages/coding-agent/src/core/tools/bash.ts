import { createWriteStream, existsSync } from "node:fs";
import type { AgentTool } from "@ag1/agent-core";
import { Container, Text, truncateToWidth } from "@ag1/tui";
import { type Static, Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import stripAnsi from "strip-ansi";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.js";
import { theme } from "../../modes/interactive/theme/theme.js";
import { waitForChildProcess } from "../../utils/child-process.js";
import { getShellConfig, getShellEnv, killProcessTree, sanitizeBinaryOutput } from "../../utils/shell.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import {
	isBubblewrapAvailable,
	parseSandboxMode,
	SANDBOX_UNAVAILABLE_NOTE,
	type SandboxSetting,
	wrapInSandbox,
} from "../sandbox.js";
import { getBashFullOutputTempPath, shouldRetainBashFullOutput } from "./bash-output-retention.js";
import { createSandboxedBashOperations } from "./bash-sandbox.js";
import { getTextOutput, invalidArgText, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from "./truncate.js";

/** Default timeout for bash commands in seconds (5 minutes). */
const DEFAULT_BASH_TIMEOUT = 300;

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: `Timeout in seconds. Default: ${DEFAULT_BASH_TIMEOUT}s.` })),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * Create bash operations using AG1's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want AG1's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(): BashOperations {
	return {
		exec: (command, cwd, { onData, signal, timeout, env }) => {
			return new Promise((resolve, reject) => {
				const { shell, args } = getShellConfig();
				if (!existsSync(cwd)) {
					reject(new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`));
					return;
				}
				const child = spawn(shell, [...args, command], {
					cwd,
					detached: true,
					env: env ?? getShellEnv(),
					stdio: ["ignore", "pipe", "pipe"],
				});
				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				// Set timeout if provided.
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeout * 1000);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				const onAbort = () => {
					if (child.pid) killProcessTree(child.pid);
				};
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				waitForChildProcess(child)
					.then((code) => {
						if (timeoutHandle) clearTimeout(timeoutHandle);
						if (signal) signal.removeEventListener("abort", onAbort);
						if (signal?.aborted) {
							reject(new Error("aborted"));
							return;
						}
						if (timedOut) {
							reject(new Error(`timeout:${timeout}`));
							return;
						}
						resolve({ exitCode: code });
					})
					.catch((err) => {
						if (timeoutHandle) clearTimeout(timeoutHandle);
						if (signal) signal.removeEventListener("abort", onAbort);
						reject(err);
					});
			});
		},
	};
}

export function createDefaultBashOperations(): BashOperations {
	return createSandboxedBashOperations(createLocalBashOperations());
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = { command, cwd, env: { ...getShellEnv() } };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
	/**
	 * OS-level sandboxing of spawned commands via bubblewrap (see core/sandbox.ts).
	 * Resolution: this option > AG1_BASH_SANDBOX env > "off". When active but
	 * bwrap is unavailable, commands run unsandboxed with a warning note
	 * prefixed to their output. "strict" additionally drops network access.
	 */
	sandbox?: SandboxSetting;
}

const BASH_PREVIEW_LINES = 5;

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatBashCall(args: { command?: string; timeout?: number } | undefined): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix;
}

function isInspectionBashCommand(command: string): boolean {
	const normalized = command.replace(/\s+/g, " ").trim();
	return /(^|[;&|]\s*)(ls\b|find\b|fd\b|rg\s+--files\b|pwd\b|git\s+status(\s|$)|git\s+branch(\s|$)|which\b)/.test(
		normalized,
	);
}

function compactInspectionBashOutput(output: string): string {
	const lines = output
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
	if (lines.length <= 40) return output;
	const shown = lines.slice(0, 25);
	const omitted = lines.length - shown.length;
	return `${shown.join("\n")}\n\n[${omitted} more lines omitted from inspection output]`;
}

function formatBashContinuationNotice(options: {
	startLine: number;
	endLine: number;
	totalLines: number;
	truncatedBy?: "lines" | "bytes";
	fullOutputPath?: string;
}): string {
	const base =
		options.truncatedBy === "lines"
			? `[tail lines ${options.startLine}-${options.endLine}/${options.totalLines}]`
			: `[tail lines ${options.startLine}-${options.endLine}/${options.totalLines}; byte limit hit]`;
	return options.fullOutputPath ? `${base} [full output: ${options.fullOutputPath}]` : base;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();

	const output = getTextOutput(result as any, showImages).trim();

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")})`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createDefaultBashOperations();
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Full output is retained only when AG1_RETAIN_BASH_FULL_OUTPUT=1. Default timeout: ${DEFAULT_BASH_TIMEOUT}s.`,
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		promptGuidelines: [
			"Prefer read, grep, find, and ls for routine inspection when those dedicated tools are sufficient.",
			"Use bash when shell semantics, compound commands, or tools outside the dedicated toolset are actually needed.",
			"After an inspection-style bash command surfaces the needed path or status, switch to a targeted read/grep/find step instead of repeating shell discovery.",
		],
		parameters: bashSchema,
		async execute(
			_toolCallId,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
			_ctx?,
		) {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);
			// OS-level containment: explicit option > AG1_BASH_SANDBOX env > off.
			const sandboxMode = options?.sandbox ?? parseSandboxMode(process.env.AG1_BASH_SANDBOX) ?? "off";
			let execCommand = spawnContext.command;
			let sandboxUnavailable = false;
			if (sandboxMode !== "off") {
				if (isBubblewrapAvailable()) {
					execCommand = wrapInSandbox(execCommand, { cwd: spawnContext.cwd, mode: sandboxMode });
				} else {
					sandboxUnavailable = true;
				}
			}
			const retainFullOutput = shouldRetainBashFullOutput();
			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}
			return new Promise((resolve, reject) => {
				let tempFilePath: string | undefined;
				let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
				let tempFileFailed = false;
				let totalBytes = 0;
				const chunks: Buffer[] = [];
				let chunksBytes = 0;
				const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

				// Sanitize raw process output the same way the interactive `!` path
				// does: strip ANSI escape sequences and control characters so model-
				// invoked commands cannot inject terminal escapes into the TUI or
				// control chars into the session transcript. Newlines/tabs survive.
				const decodeOutput = (buffer: Buffer): string =>
					sanitizeBinaryOutput(stripAnsi(buffer.toString("utf-8"))).replace(/\r/g, "");

				const ensureTempFile = () => {
					if (!retainFullOutput || tempFileFailed) return;
					if (tempFilePath) return;
					tempFilePath = getBashFullOutputTempPath();
					tempFileStream = createWriteStream(tempFilePath, { mode: 0o600 });
					tempFileStream.on("error", () => {
						// Degrade gracefully (ENOSPC/EACCES in tmpdir): stop retaining
						// full output instead of crashing on an unhandled stream error.
						tempFileFailed = true;
						tempFileStream = undefined;
						tempFilePath = undefined;
					});
					for (const chunk of chunks) tempFileStream.write(chunk);
				};

				// Close the temp stream and wait for the flush so fullOutputPath is
				// complete on disk before it is advertised to the model.
				const closeTempFileStream = (): Promise<void> => {
					const stream = tempFileStream;
					if (!stream) return Promise.resolve();
					return new Promise((resolveClose) => {
						stream.once("error", () => resolveClose());
						stream.end(() => resolveClose());
					});
				};

				const handleData = (data: Buffer) => {
					totalBytes += data.length;
					// Start writing to a temp file once output exceeds the in-memory threshold.
					if (totalBytes > DEFAULT_MAX_BYTES) {
						ensureTempFile();
					}
					// Write to temp file if we have one.
					if (tempFileStream) tempFileStream.write(data);
					// Keep a rolling buffer of recent output for tail truncation.
					chunks.push(data);
					chunksBytes += data.length;
					// Trim old chunks if the rolling buffer grows too large.
					while (chunksBytes > maxChunksBytes && chunks.length > 1) {
						const removed = chunks.shift()!;
						chunksBytes -= removed.length;
					}
					// Stream partial output using the rolling tail buffer.
					if (onUpdate) {
						const fullBuffer = Buffer.concat(chunks);
						const fullText = decodeOutput(fullBuffer);
						const truncation = truncateTail(fullText);
						if (truncation.truncated) {
							ensureTempFile();
						}
						onUpdate({
							content: [{ type: "text", text: truncation.content || "" }],
							details: {
								truncation: truncation.truncated ? truncation : undefined,
								fullOutputPath: tempFilePath,
							},
						});
					}
				};

				if (sandboxUnavailable) {
					// Degraded mode: requested sandboxing is missing, so say so on the
					// (merged) stderr stream before any real command output.
					handleData(Buffer.from(`${SANDBOX_UNAVAILABLE_NOTE}\n`, "utf-8"));
				}
				ops.exec(execCommand, spawnContext.cwd, {
					onData: handleData,
					signal,
					timeout: timeout ?? DEFAULT_BASH_TIMEOUT,
					env: spawnContext.env,
				})
					.then(async ({ exitCode }) => {
						// Combine the rolling buffer chunks.
						const fullBuffer = Buffer.concat(chunks);
						const fullOutput = decodeOutput(fullBuffer);
						const transcriptOutput =
							exitCode === 0 && isInspectionBashCommand(command)
								? compactInspectionBashOutput(fullOutput)
								: fullOutput;
						// Apply tail truncation for the final display payload.
						const truncation = truncateTail(transcriptOutput);
						if (truncation.truncated) {
							ensureTempFile();
						}
						// Close temp file stream and flush it before building the final result.
						await closeTempFileStream();
						let outputText = truncation.content || "(no output)";
						let details: BashToolDetails | undefined;
						if (truncation.truncated) {
							// Build truncation details and an actionable notice.
							details = { truncation, fullOutputPath: tempFilePath };
							const startLine = truncation.totalLines - truncation.outputLines + 1;
							const endLine = truncation.totalLines;
							if (truncation.lastLinePartial) {
								// Edge case: the last line alone is larger than the byte limit.
								const lastLineSize = formatSize(
									Buffer.byteLength(transcriptOutput.split("\n").pop() || "", "utf-8"),
								);
								outputText += `\n\n[last ${formatSize(truncation.outputBytes)} of line ${endLine}; line size ${lastLineSize}]${
									tempFilePath ? ` [full output: ${tempFilePath}]` : ""
								}`;
							} else {
								outputText += `\n\n${formatBashContinuationNotice({
									startLine,
									endLine,
									totalLines: truncation.totalLines,
									truncatedBy: truncation.truncatedBy === "lines" ? "lines" : "bytes",
									fullOutputPath: tempFilePath,
								})}`;
							}
						}
						if (exitCode === null) {
							// Killed by a signal (e.g. OOM killer) — not a successful exit.
							outputText += "\n\nCommand was killed by a signal";
							reject(new Error(outputText));
						} else if (exitCode !== 0) {
							outputText += `\n\nCommand exited with code ${exitCode}`;
							reject(new Error(outputText));
						} else {
							resolve({ content: [{ type: "text", text: outputText }], details });
						}
					})
					.catch(async (err: Error) => {
						// Close temp file stream (flushed) and include buffered output in the error message.
						await closeTempFileStream();
						const fullBuffer = Buffer.concat(chunks);
						let output = decodeOutput(fullBuffer);
						if (err.message === "aborted") {
							if (output) output += "\n\n";
							output += "Command aborted";
							reject(new Error(output));
						} else if (err.message.startsWith("timeout:")) {
							const timeoutSecs = err.message.split(":")[1];
							if (output) output += "\n\n";
							output += `Command timed out after ${timeoutSecs} seconds`;
							reject(new Error(output));
						} else {
							reject(err);
						}
					});
			});
		},
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBashCall(args));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createBashToolDefinition(cwd, options));
}

/** Default bash tool using process.cwd() for backwards compatibility. */
export const bashToolDefinition = createBashToolDefinition(process.cwd());
export const bashTool = createBashTool(process.cwd());
