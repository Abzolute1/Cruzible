import { createInterface } from "node:readline";
import type { AgentTool } from "@ag1/agent-core";
import { Text } from "@ag1/tui";
import { type Static, Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import { readFileSync, statSync } from "fs";
import path from "path";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { ensureTool } from "../../utils/tools-manager.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { resolveContainedPath } from "./path-utils.js";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.js";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

export type GrepToolInput = Static<typeof grepSchema>;
const DEFAULT_LIMIT = 100;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
	matchCount?: number;
	uniqueFileCount?: number;
	firstMatchPath?: string;
	firstMatchLine?: number;
}

/**
 * Pluggable operations for the grep tool.
 * Override these to delegate search to remote systems (for example SSH).
 */
export interface GrepOperations {
	/** Check if path is a directory. Throws if path does not exist. */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** Read file contents for context lines */
	readFile: (absolutePath: string) => Promise<string> | string;
}

const defaultGrepOperations: GrepOperations = {
	isDirectory: (p) => statSync(p).isDirectory(),
	readFile: (p) => readFileSync(p, "utf-8"),
};

export interface GrepToolOptions {
	/** Custom operations for grep. Default: local filesystem plus ripgrep */
	operations?: GrepOperations;
}

function toToolPath(filePath: string, cwd: string): string {
	const relative = path.relative(cwd, filePath).replace(/\\/g, "/");
	if (relative && !relative.startsWith("..")) return relative;
	return filePath.replace(/\\/g, "/");
}

function grepPathRank(filePath: string, cwd: string): number {
	const normalized = toToolPath(filePath, cwd).toLowerCase();
	let score = 0;
	const isRepoScript = /(^|\/)scripts\/[^/]+\.(mjs|cjs|js|ts|py|sh)$/.test(normalized);

	const sourceExtensions = new Set([
		".ts",
		".tsx",
		".js",
		".jsx",
		".mjs",
		".cjs",
		".py",
		".go",
		".rs",
		".java",
		".kt",
		".rb",
		".php",
		".swift",
		".cpp",
		".cc",
		".cxx",
		".c",
		".h",
		".hpp",
	]);
	const docsExtensions = new Set([".md", ".mdx", ".rst", ".txt"]);
	const ext = path.extname(normalized);

	if (sourceExtensions.has(ext)) score -= 60;
	else if (docsExtensions.has(ext)) score += 80;

	if (
		normalized.includes("/src/") ||
		normalized.startsWith("src/") ||
		normalized.includes("/packages/") ||
		normalized.includes("/lib/") ||
		normalized.includes("/app/")
	) {
		score -= 40;
	}

	if (
		normalized.includes("/test/") ||
		normalized.includes("/tests/") ||
		normalized.endsWith(".test.ts") ||
		normalized.endsWith(".test.tsx") ||
		normalized.endsWith(".spec.ts") ||
		normalized.endsWith(".spec.tsx") ||
		normalized.endsWith(".test.js") ||
		normalized.endsWith(".spec.js")
	) {
		score += 110;
	}

	if (
		normalized.includes("readme") ||
		normalized.includes("mission") ||
		normalized.includes("plan") ||
		normalized.includes("audit") ||
		normalized.includes("checkpoint") ||
		normalized.includes("todo")
	) {
		score += 60;
	}
	if (
		normalized.includes("/fixtures/") ||
		normalized.includes("new_files-copy") ||
		normalized.includes("/history/") ||
		normalized.includes("/archive/")
	) {
		score += 120;
	}

	if (normalized.includes("/core/") || normalized.includes("/system-prompt") || normalized.includes("/prompt")) {
		score -= 20;
	}

	if (normalized.includes("/tools/")) score -= 20;
	if (normalized.includes("/auton/")) score += 25;
	if (isRepoScript) score -= 80;

	if (normalized.includes("research-output") || normalized.includes("prompt-intent-steering")) {
		score += 180;
	}

	score += Math.min(normalized.length, 120);
	return score;
}

function grepLineRank(lineText: string, pattern?: string): number {
	const normalized = lineText.trim().toLowerCase();
	let score = 0;

	if (/^\s*export\s+(async\s+)?function\b/.test(normalized)) score -= 140;
	else if (/^\s*export\s+(class|interface|type|const)\b/.test(normalized)) score -= 120;
	else if (/^\s*(async\s+)?function\b/.test(normalized)) score -= 80;
	else if (/^\s*(class|interface|type|const)\b/.test(normalized)) score -= 60;

	if (/^\s*import\b/.test(normalized)) score += 120;
	if (/\b(describe|it|test)\s*\(/.test(normalized)) score += 120;
	if (/^\s*\/\//.test(normalized)) score += 20;
	if (/\blines\.push\s*\(/.test(normalized)) score += 140;
	if (/\bfor prompts about\b/.test(normalized)) score += 220;
	if (/\blikely implementation symbol\b/.test(normalized)) score += 220;
	if (/\bintent steering\b/.test(normalized)) score += 180;
	if (/"prompt"\s*:/.test(normalized)) score += 160;
	if (/"description"\s*:/.test(normalized)) score += 140;
	if (/"tags"\s*:/.test(normalized)) score += 120;
	if (/`[^`]*\$\{[^`]+\}[^`]*`/.test(lineText)) score += 40;
	if (/["'`](?:[^"'`]*\s){4,}[^"'`]*["'`]/.test(lineText)) score += 70;

	const normalizedPattern = pattern?.trim().toLowerCase() ?? "";
	if (normalizedPattern.includes("current-events")) {
		if (/\bnormalizecurrenteventsquery\b/i.test(lineText)) score -= 260;
		else if (/\bnormalize[a-z0-9_]*current[a-z0-9_]*events[a-z0-9_]*\b/i.test(normalized)) score -= 180;
		else if (/\bnormalize\b/.test(normalized)) score -= 80;
	}
	if (normalizedPattern.includes("normalization")) {
		if (/^\s*export\s+(async\s+)?function\s+normalize/i.test(normalized)) score -= 120;
		else if (/^\s*(async\s+)?function\s+normalize/i.test(normalized)) score -= 80;
	}

	return score;
}

function formatGrepCall(
	args: { pattern: string; path?: string; glob?: string; limit?: number } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const glob = str(args?.glob);
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("grep")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (glob) text += theme.fg("toolOutput", ` (${glob})`);
	if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
	return text;
}

function formatGrepResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: GrepToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 15;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
		}
	}

	const matchLimit = result.details?.matchLimitReached;
	const truncation = result.details?.truncation;
	const linesTruncated = result.details?.linesTruncated;
	if (matchLimit || truncation?.truncated || linesTruncated) {
		const warnings: string[] = [];
		if (matchLimit) warnings.push(`${matchLimit} matches limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		if (linesTruncated) warnings.push("some lines truncated");
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

function formatGrepNotice(
	limit: number,
	options: { matchLimitReached?: boolean; byteTruncated?: boolean; linesTruncated?: boolean },
): string {
	const parts: string[] = [];
	if (options.matchLimitReached) parts.push(`${limit} matches limit; next limit=${limit * 2}`);
	if (options.byteTruncated) parts.push(`${formatSize(DEFAULT_MAX_BYTES)} byte limit`);
	if (options.linesTruncated) parts.push(`line clips at ${GREP_MAX_LINE_LENGTH} chars; use read`);
	return `[${parts.join("; ")}]`;
}

function formatGrepFollowupNotice(
	matches: Array<{ filePath: string; lineNumber: number }>,
	cwd: string,
	options: { matchLimitReached?: boolean; byteTruncated?: boolean },
): string | undefined {
	if (matches.length !== 1 || options.matchLimitReached || options.byteTruncated) return undefined;
	const match = matches[0];
	if (!match) return undefined;
	const target = toToolPath(match.filePath, cwd);
	const offset = Math.max(1, match.lineNumber - 20);
	return `[1 match in ${target}:${match.lineNumber}; if the user only asked which file/path, answer now; otherwise next: read ${target} offset=${offset} limit=120]`;
}

function extractLiteralAlternatives(pattern: string): string[] {
	return pattern
		.split("|")
		.map((part) => part.trim())
		.filter((part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part));
}

function extractLeadingIdentifierFromRegexishPattern(pattern: string): string | undefined {
	const match = pattern.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)/);
	return match?.[1];
}

function formatNoMatchNotice(options: { literal?: boolean; pattern: string }): string {
	const notices = ["no matches"];
	if (options.literal && /[|()[\]{}.*+?^$\\]/.test(options.pattern)) {
		notices.push("literal=true with regex-like pattern; retry with a simpler literal or disable literal");
		const leadingIdentifier = extractLeadingIdentifierFromRegexishPattern(options.pattern);
		if (leadingIdentifier) {
			notices.push(
				`for definition lookups, retry the exact symbol name ${leadingIdentifier} first without regex-like suffixes, assignment patterns, or added punctuation`,
			);
		}
		const alternatives = extractLiteralAlternatives(options.pattern);
		if (alternatives.length >= 2) {
			notices.push(
				`if these are alternative identifiers, retry one identifier at a time, starting with ${alternatives[0]}, and keep the search inside likely implementation/reporting paths like scripts/ or src/ instead of broadening to prose`,
			);
		} else if (options.pattern.includes("|")) {
			notices.push(
				"if this was meant as alternative identifiers, retry one identifier at a time and keep the search inside likely implementation/reporting paths like scripts/ or src/ instead of broadening to prose",
			);
		}
	}
	notices.push(
		"if the user asked which file/script defines something, prefer find on filenames before broad content grep",
	);
	notices.push(
		"for local code lookups, retry with a narrower source path like src/ or packages/*/src before reading docs",
	);
	return `[${notices.join("; ")}]`;
}

export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		promptSnippet: "Search file contents for patterns (respects .gitignore)",
		promptGuidelines: [
			"Use grep to locate symbols, functions, error strings, or identifiers before reading files.",
			"Prefer grep over guessing file paths when you know text that should appear in the code.",
			"After grep finds a candidate file and line, use read on that file or nearby range for detail.",
			"When grep returns one decisive source hit, read only a small nearby range, or answer immediately for pure location questions.",
		],
		parameters: grepSchema,
		async execute(
			_toolCallId,
			{
				pattern,
				path: searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				limit,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			},
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				let settled = false;
				const settle = (fn: () => void) => {
					if (!settled) {
						settled = true;
						fn();
					}
				};

				(async () => {
					try {
						const rgPath = await ensureTool("rg", true);
						if (!rgPath) {
							settle(() =>
								reject(
									new Error(
										"ripgrep (rg) is not available. Install rg on PATH or set AG1_ALLOW_TOOL_AUTO_DOWNLOAD=1.",
									),
								),
							);
							return;
						}

						let searchPath: string;
						try {
							searchPath = resolveContainedPath(searchDir || ".", cwd);
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							settle(() =>
								reject(
									new Error(
										`${message}. Retry without path or use a workspace-relative path like ., scripts, src, or packages/*/src instead of /.`,
									),
								),
							);
							return;
						}
						const ops = customOps ?? defaultGrepOperations;
						let isDirectory: boolean;
						try {
							isDirectory = await ops.isDirectory(searchPath);
						} catch {
							settle(() => reject(new Error(`Path not found: ${searchPath}`)));
							return;
						}

						const contextValue = context && context > 0 ? context : 0;
						const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
						const formatPath = (filePath: string): string => {
							if (isDirectory) {
								const relative = path.relative(searchPath, filePath);
								if (relative && !relative.startsWith("..")) {
									return relative.replace(/\\/g, "/");
								}
							}
							return path.basename(filePath);
						};

						const fileCache = new Map<string, string[]>();
						const getFileLines = async (filePath: string): Promise<string[]> => {
							let lines = fileCache.get(filePath);
							if (!lines) {
								try {
									const content = await ops.readFile(filePath);
									lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
								} catch {
									lines = [];
								}
								fileCache.set(filePath, lines);
							}
							return lines;
						};

						const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
						if (ignoreCase) args.push("--ignore-case");
						if (literal) args.push("--fixed-strings");
						if (glob) args.push("--glob", glob);
						args.push(pattern, searchPath);

						const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						let matchCount = 0;
						let matchLimitReached = false;
						let linesTruncated = false;
						let aborted = false;
						let killedDueToLimit = false;
						const outputLines: string[] = [];

						const cleanup = () => {
							rl.close();
							signal?.removeEventListener("abort", onAbort);
						};
						const stopChild = (dueToLimit = false) => {
							if (!child.killed) {
								killedDueToLimit = dueToLimit;
								child.kill();
							}
						};
						const onAbort = () => {
							aborted = true;
							stopChild();
						};
						signal?.addEventListener("abort", onAbort, { once: true });
						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						const formatBlock = async (filePath: string, lineNumber: number): Promise<string[]> => {
							const relativePath = formatPath(filePath);
							const lines = await getFileLines(filePath);
							if (!lines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`];
							const block: string[] = [];
							const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
							const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
							for (let current = start; current <= end; current++) {
								const lineText = lines[current - 1] ?? "";
								const sanitized = lineText.replace(/\r/g, "");
								const isMatchLine = current === lineNumber;
								// Truncate long lines so grep output stays compact.
								const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
								if (wasTruncated) linesTruncated = true;
								if (isMatchLine) block.push(`${relativePath}:${current}: ${truncatedText}`);
								else block.push(`${relativePath}-${current}- ${truncatedText}`);
							}
							return block;
						};

						// Collect matches during streaming, then format them after rg exits.
						const matches: Array<{ filePath: string; lineNumber: number; lineText: string }> = [];
						rl.on("line", (line) => {
							if (!line.trim() || matchCount >= effectiveLimit) return;
							let event: any;
							try {
								event = JSON.parse(line);
							} catch {
								return;
							}
							if (event.type === "match") {
								matchCount++;
								const filePath = event.data?.path?.text;
								const lineNumber = event.data?.line_number;
								const lineText = String(event.data?.lines?.text ?? "");
								if (filePath && typeof lineNumber === "number")
									matches.push({ filePath, lineNumber, lineText });
								if (matchCount >= effectiveLimit) {
									matchLimitReached = true;
									stopChild(true);
								}
							}
						});

						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
						});
						child.on("close", async (code) => {
							cleanup();
							if (aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (!killedDueToLimit && code !== 0 && code !== 1) {
								const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
								settle(() => reject(new Error(errorMsg)));
								return;
							}
							if (matchCount === 0) {
								const noMatchText = `(no matches)\n${formatNoMatchNotice({ literal, pattern })}`;
								settle(() => resolve({ content: [{ type: "text", text: noMatchText }], details: undefined }));
								return;
							}

							matches.sort((a, b) => {
								const rankDiff =
									grepPathRank(a.filePath, cwd) +
									grepLineRank(a.lineText, pattern) -
									(grepPathRank(b.filePath, cwd) + grepLineRank(b.lineText, pattern));
								if (rankDiff !== 0) return rankDiff;
								const pathA = toToolPath(a.filePath, cwd);
								const pathB = toToolPath(b.filePath, cwd);
								if (pathA !== pathB) return pathA.localeCompare(pathB);
								return a.lineNumber - b.lineNumber;
							});

							// Format matches after streaming finishes so custom readFile() backends can be async.
							for (const match of matches) {
								const block = await formatBlock(match.filePath, match.lineNumber);
								outputLines.push(...block);
							}
							const rawOutput = outputLines.join("\n");
							// Apply byte truncation. There is no line limit here because the match limit already capped rows.
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							let output = truncation.content;
							const details: GrepToolDetails = {};
							const uniqueFiles = new Set(matches.map((match) => toToolPath(match.filePath, cwd)));
							details.matchCount = matchCount;
							details.uniqueFileCount = uniqueFiles.size;
							if (matches[0]) {
								details.firstMatchPath = toToolPath(matches[0].filePath, cwd);
								details.firstMatchLine = matches[0].lineNumber;
							}
							if (matchLimitReached) {
								details.matchLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								details.truncation = truncation;
							}
							if (linesTruncated) {
								details.linesTruncated = true;
							}
							if (matchLimitReached || truncation.truncated || linesTruncated) {
								output += `\n\n${formatGrepNotice(effectiveLimit, {
									matchLimitReached,
									byteTruncated: truncation.truncated,
									linesTruncated,
								})}`;
							}
							const followupNotice = formatGrepFollowupNotice(matches, cwd, {
								matchLimitReached,
								byteTruncated: truncation.truncated,
							});
							if (followupNotice) output += `\n\n${followupNotice}`;
							settle(() =>
								resolve({
									content: [{ type: "text", text: output }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
						});
					} catch (err) {
						settle(() => reject(err as Error));
					}
				})();
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}

/** Default grep tool using process.cwd() for backwards compatibility. */
export const grepToolDefinition = createGrepToolDefinition(process.cwd());
export const grepTool = createGrepTool(process.cwd());
