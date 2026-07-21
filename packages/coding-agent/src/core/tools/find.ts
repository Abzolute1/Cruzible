import type { AgentTool } from "@ag1/agent-core";
import { Text } from "@ag1/tui";
import { type Static, Type } from "@sinclair/typebox";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { globSync } from "glob";
import path from "path";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { ensureTool } from "../../utils/tools-manager.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { resolveContainedPath } from "./path-utils.js";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}

function toWorkspaceRelativePath(candidatePath: string, searchPath: string, cwd: string): string {
	const normalizedCandidate = toPosixPath(candidatePath.replace(/\/$/, ""));
	const normalizedSearchPath = toPosixPath(searchPath.replace(/\/$/, ""));
	const normalizedCwd = toPosixPath(cwd.replace(/\/$/, ""));

	let absolutePath = normalizedCandidate;
	if (!path.isAbsolute(absolutePath)) {
		absolutePath = toPosixPath(path.resolve(normalizedSearchPath, absolutePath));
	}

	let relative = toPosixPath(path.relative(normalizedCwd, absolutePath));
	if (!relative || relative.startsWith("..")) {
		relative = normalizedCandidate;
	}
	return candidatePath.endsWith("/") && !relative.endsWith("/") ? `${relative}/` : relative;
}

function findPathRank(entry: string): number {
	const normalized = toPosixPath(entry).toLowerCase();
	let score = 0;
	const isDirectory = normalized.endsWith("/");
	const ext = path.posix.extname(normalized.replace(/\/$/, ""));

	if (isDirectory) score += 20;

	const scriptLikeExtensions = new Set([".mjs", ".cjs", ".js", ".ts", ".tsx", ".py", ".sh"]);
	const dataExtensions = new Set([".json", ".jsonl", ".csv", ".log", ".txt", ".md"]);

	if (scriptLikeExtensions.has(ext)) score -= 50;
	if (dataExtensions.has(ext)) score += 25;

	if (
		normalized.startsWith("scripts/") ||
		normalized.includes("/scripts/") ||
		normalized.startsWith("src/") ||
		normalized.includes("/src/") ||
		normalized.startsWith("packages/") ||
		normalized.includes("/packages/")
	) {
		score -= 35;
	}

	if (
		normalized.includes("history/") ||
		normalized.includes("history-test/") ||
		normalized.includes("/reports/") ||
		normalized.includes("/artifacts/") ||
		normalized.includes("/debug/") ||
		normalized.includes("__pycache__")
	) {
		score += 80;
	}

	if (normalized.includes("compare")) score -= 20;

	score += Math.min(normalized.length, 140);
	return score;
}

const findSchema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

export type FindToolInput = Static<typeof findSchema>;

const DEFAULT_LIMIT = 1000;

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
	resultCount?: number;
	firstMatchPath?: string;
	firstMatchIsDirectory?: boolean;
	dominantFileDirectory?: string;
}

/**
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (for example SSH).
 */
export interface FindOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Find files matching glob pattern. Returns relative or absolute paths. */
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

const defaultFindOperations: FindOperations = {
	exists: existsSync,
	// This is a placeholder. Actual fd execution happens in execute() when no custom glob is provided.
	glob: () => [],
};

export interface FindToolOptions {
	/** Custom operations for find. Default: local filesystem plus fd */
	operations?: FindOperations;
}

function formatFindFollowupNotice(
	results: string[],
	options: { resultLimitReached?: boolean; byteTruncated?: boolean },
): string | undefined {
	if (results.length !== 1 || options.resultLimitReached || options.byteTruncated) return undefined;
	const [result] = results;
	if (!result) return undefined;
	if (result.endsWith("/"))
		return `[1 directory match in ${result}; if the directory itself answers the question, answer now; otherwise next: ls ${result}]`;
	return `[1 match in ${result}; if the user only asked which file/path, answer now; otherwise next: read ${result} limit=120]`;
}

function formatFindCall(
	args: { pattern: string; path?: string; limit?: number } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("find")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}

function formatFindResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: FindToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 20;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
		}
	}

	const resultLimit = result.details?.resultLimitReached;
	const truncation = result.details?.truncation;
	if (resultLimit || truncation?.truncated) {
		const warnings: string[] = [];
		if (resultLimit) warnings.push(`${resultLimit} results limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

function formatFindNotice(limit: number, options: { resultLimitReached?: boolean; byteTruncated?: boolean }): string {
	const parts: string[] = [];
	if (options.resultLimitReached) parts.push(`${limit} results limit; next limit=${limit * 2}`);
	if (options.byteTruncated) parts.push(`${formatSize(DEFAULT_MAX_BYTES)} byte limit`);
	return `[${parts.join("; ")}]`;
}

function formatFindNoMatchNotice(pattern: string, searchDir?: string): string {
	const notices = ["no matches"];
	const anchorTerms = [...new Set((pattern.match(/[A-Za-z0-9]+/g) ?? []).map((term) => term.toLowerCase()))].filter(
		(term) => term.length >= 3 && term !== "home" && term !== "alex",
	);
	const normalizedDir = searchDir?.replace(/\\/g, "/").toLowerCase() ?? "";
	if (anchorTerms.length >= 3) {
		notices.push(
			"pattern may be too specific; if you are looking for sibling files or roles, retry with the strongest shared anchor or common prefix instead of one filename containing every term",
		);
		notices.push("retry with the shared anchor itself before falling back to one role-specific term");
		notices.push(
			"if the question is really about which directory holds sibling scripts/files, stop broadening wildcard filenames and inspect the likely shared parent directory instead, for example `scripts/` or one repo-root listing",
		);
	}
	if (anchorTerms.length >= 2) {
		notices.push(
			"if this is a command/script lookup, retry the strongest action stem with a likely extension, for example `*archive*.mjs`, instead of another multi-term permutation",
		);
	}
	if (
		normalizedDir.includes("/packages/coding-agent/scripts") &&
		(anchorTerms.includes("archive") ||
			anchorTerms.includes("compare") ||
			anchorTerms.includes("runner") ||
			anchorTerms.includes("script"))
	) {
		notices.push(
			"for repo-level command/script lookups, do not stay in package-local scripts after a miss; pivot to repo-root `scripts/` and retry a stronger shared anchor like `*archive*.mjs`, `*compare*.mjs`, or `*runner*.mjs`",
		);
	}
	notices.push(
		"if matches later cluster under one directory, answer from that shared parent directory instead of expanding discovery",
	);
	return `[${notices.join("; ")}]`;
}

export function createFindToolDefinition(
	cwd: string,
	options?: FindToolOptions,
): ToolDefinition<typeof findSchema, FindToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "find",
		label: "find",
		description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		promptSnippet: "Find files by glob pattern (respects .gitignore)",
		promptGuidelines: [
			"Use find when the filename or path is uncertain instead of guessing where a file lives.",
			"After a path-not-found error from read, switch to find or ls before retrying.",
			"Use find to narrow candidate files, then read or grep the matches.",
			"If find returns one decisive path for a pure location question, answer immediately instead of running another search.",
			"For sibling script/file roles, do not search for one filename containing every role term; use the shared anchor or inspect the likely shared parent directory such as `scripts/`.",
		],
		parameters: findSchema,
		async execute(
			_toolCallId,
			{ pattern, path: searchDir, limit }: { pattern: string; path?: string; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				const onAbort = () => reject(new Error("Operation aborted"));
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						const searchPath = resolveContainedPath(searchDir || ".", cwd);
						const effectiveLimit = limit ?? DEFAULT_LIMIT;
						const ops = customOps ?? defaultFindOperations;

						// If custom operations provide glob(), use that instead of fd.
						if (customOps?.glob) {
							if (!(await ops.exists(searchPath))) {
								reject(new Error(`Path not found: ${searchPath}`));
								return;
							}
							const results = await ops.glob(pattern, searchPath, {
								ignore: ["**/node_modules/**", "**/.git/**"],
								limit: effectiveLimit,
							});
							signal?.removeEventListener("abort", onAbort);
							if (results.length === 0) {
								resolve({
									content: [
										{ type: "text", text: `(no matches)\n${formatFindNoMatchNotice(pattern, searchDir)}` },
									],
									details: undefined,
								});
								return;
							}

							// Relativize paths against the search root for stable output.
							const relativized = results
								.map((p) => {
									if (p.startsWith(searchPath)) return toPosixPath(p.slice(searchPath.length + 1));
									return toPosixPath(path.relative(searchPath, p));
								})
								.map((entry) => toWorkspaceRelativePath(entry, searchPath, cwd))
								.sort((a, b) => {
									const rankDiff = findPathRank(a) - findPathRank(b);
									if (rankDiff !== 0) return rankDiff;
									return a.localeCompare(b);
								});
							const resultLimitReached = relativized.length >= effectiveLimit;
							const rawOutput = relativized.join("\n");
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							let resultOutput = truncation.content;
							const details: FindToolDetails = {};
							details.resultCount = relativized.length;
							if (relativized[0]) {
								details.firstMatchPath = relativized[0];
								details.firstMatchIsDirectory = relativized[0].endsWith("/");
							}
							const fileDirectories = relativized
								.filter((entry) => !entry.endsWith("/"))
								.map((entry) => {
									const dir = path.posix.dirname(entry);
									return dir === "." ? "" : dir;
								})
								.filter((dir) => dir.length > 0);
							if (fileDirectories.length > 0) {
								const counts = new Map<string, number>();
								for (const dir of fileDirectories) {
									counts.set(dir, (counts.get(dir) ?? 0) + 1);
								}
								const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
								if (dominant) details.dominantFileDirectory = dominant;
							}
							if (resultLimitReached) {
								details.resultLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								details.truncation = truncation;
							}
							if (resultLimitReached || truncation.truncated) {
								resultOutput += `\n\n${formatFindNotice(effectiveLimit, {
									resultLimitReached,
									byteTruncated: truncation.truncated,
								})}`;
							}
							const followupNotice = formatFindFollowupNotice(relativized, {
								resultLimitReached,
								byteTruncated: truncation.truncated,
							});
							if (followupNotice) resultOutput += `\n\n${followupNotice}`;
							resolve({
								content: [{ type: "text", text: resultOutput }],
								details: Object.keys(details).length > 0 ? details : undefined,
							});
							return;
						}

						// Default implementation uses fd.
						const fdPath = await ensureTool("fd", true);
						if (!fdPath) {
							reject(
								new Error("fd is not available. Install fd on PATH or set AG1_ALLOW_TOOL_AUTO_DOWNLOAD=1."),
							);
							return;
						}

						// Build fd arguments.
						const args: string[] = [
							"--glob",
							"--color=never",
							"--hidden",
							"--max-results",
							String(effectiveLimit),
						];
						// Include .gitignore files from the search tree.
						const gitignoreFiles = new Set<string>();
						const rootGitignore = path.join(searchPath, ".gitignore");
						if (existsSync(rootGitignore)) gitignoreFiles.add(rootGitignore);
						try {
							const nestedGitignores = globSync("**/.gitignore", {
								cwd: searchPath,
								dot: true,
								absolute: true,
								ignore: ["**/node_modules/**", "**/.git/**"],
							});
							for (const file of nestedGitignores) gitignoreFiles.add(file);
						} catch {
							// ignore
						}
						for (const gitignorePath of gitignoreFiles) args.push("--ignore-file", gitignorePath);
						args.push(pattern, searchPath);

						const result = spawnSync(fdPath, args, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
						signal?.removeEventListener("abort", onAbort);
						if (result.error) {
							reject(new Error(`Failed to run fd: ${result.error.message}`));
							return;
						}

						const output = result.stdout?.trim() || "";
						if (result.status !== 0) {
							const errorMsg = result.stderr?.trim() || `fd exited with code ${result.status}`;
							if (!output) {
								reject(new Error(errorMsg));
								return;
							}
						}
						if (!output) {
							resolve({
								content: [
									{ type: "text", text: `(no matches)\n${formatFindNoMatchNotice(pattern, searchDir)}` },
								],
								details: undefined,
							});
							return;
						}

						const lines = output.split("\n");
						const relativized: string[] = [];
						for (const rawLine of lines) {
							const line = rawLine.replace(/\r$/, "").trim();
							if (!line) continue;
							const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
							let relativePath = line;
							if (line.startsWith(searchPath)) {
								relativePath = line.slice(searchPath.length + 1);
							} else {
								relativePath = path.relative(searchPath, line);
							}
							if (hadTrailingSlash && !relativePath.endsWith("/")) relativePath += "/";
							relativized.push(toWorkspaceRelativePath(toPosixPath(relativePath), searchPath, cwd));
						}

						relativized.sort((a, b) => {
							const rankDiff = findPathRank(a) - findPathRank(b);
							if (rankDiff !== 0) return rankDiff;
							return a.localeCompare(b);
						});

						const resultLimitReached = relativized.length >= effectiveLimit;
						const rawOutput = relativized.join("\n");
						const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
						let resultOutput = truncation.content;
						const details: FindToolDetails = {};
						details.resultCount = relativized.length;
						if (relativized[0]) {
							details.firstMatchPath = relativized[0];
							details.firstMatchIsDirectory = relativized[0].endsWith("/");
						}
						const fileDirectories = relativized
							.filter((entry) => !entry.endsWith("/"))
							.map((entry) => {
								const dir = path.posix.dirname(entry);
								return dir === "." ? "" : dir;
							})
							.filter((dir) => dir.length > 0);
						if (fileDirectories.length > 0) {
							const counts = new Map<string, number>();
							for (const dir of fileDirectories) {
								counts.set(dir, (counts.get(dir) ?? 0) + 1);
							}
							const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
							if (dominant) details.dominantFileDirectory = dominant;
						}
						if (resultLimitReached) {
							details.resultLimitReached = effectiveLimit;
						}
						if (truncation.truncated) {
							details.truncation = truncation;
						}
						if (resultLimitReached || truncation.truncated) {
							resultOutput += `\n\n${formatFindNotice(effectiveLimit, {
								resultLimitReached,
								byteTruncated: truncation.truncated,
							})}`;
						}
						const followupNotice = formatFindFollowupNotice(relativized, {
							resultLimitReached,
							byteTruncated: truncation.truncated,
						});
						if (followupNotice) resultOutput += `\n\n${followupNotice}`;
						resolve({
							content: [{ type: "text", text: resultOutput }],
							details: Object.keys(details).length > 0 ? details : undefined,
						});
					} catch (e: any) {
						signal?.removeEventListener("abort", onAbort);
						reject(e);
					}
				})();
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatFindCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatFindResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createFindTool(cwd: string, options?: FindToolOptions): AgentTool<typeof findSchema> {
	return wrapToolDefinition(createFindToolDefinition(cwd, options));
}

/** Default find tool using process.cwd() for backwards compatibility. */
export const findToolDefinition = createFindToolDefinition(process.cwd());
export const findTool = createFindTool(process.cwd());
