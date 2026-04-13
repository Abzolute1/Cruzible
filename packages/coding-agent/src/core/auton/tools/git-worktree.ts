// Auton — GitWorktree Tool
// Manages git worktrees: create, keep, remove.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { execCommand } from "../../exec.js";
import type { ToolDefinition } from "../../extensions/types.js";

const MAX_OUTPUT_CHARS = 10000;

function truncateOutput(output: string): string {
	if (output.length <= MAX_OUTPUT_CHARS) return output;
	return (
		output.slice(0, MAX_OUTPUT_CHARS) +
		`\n\n[Output truncated: ${output.length - MAX_OUTPUT_CHARS} more characters omitted]`
	);
}

async function runGitCommand(
	cwd: string,
	args: string[],
	signal: AbortSignal | undefined,
): Promise<{ stdout: string; stderr: string; code: number }> {
	try {
		const result = await execCommand("git", args, cwd, { signal, timeout: 60000 });
		return { stdout: result.stdout, stderr: result.stderr, code: result.code };
	} catch (err: any) {
		return { stdout: "", stderr: err.message || String(err), code: 1 };
	}
}

async function gitWorktreeCreate(
	cwd: string,
	worktreePath: string,
	branch: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	// First check if worktree already exists
	if (existsSync(join(worktreePath, ".git")) || existsSync(worktreePath)) {
		return `Error: Path already exists: ${worktreePath}`;
	}

	// Check if branch exists; if not, create it
	const { code: branchExists } = await runGitCommand(cwd, ["rev-parse", "--verify", branch], signal);

	const createArgs = ["worktree", "add", worktreePath];

	if (branchExists === 0) {
		createArgs.push(branch);
	} else {
		// Create the branch from current HEAD
		createArgs.push("-b", branch);
	}

	const result = await runGitCommand(cwd, createArgs, signal);

	if (result.code !== 0) {
		return `Error creating worktree:\n${result.stderr || result.stdout}`;
	}

	return `Created worktree at ${worktreePath} on branch '${branch}'.\n${result.stdout}`;
}

async function gitWorktreeList(cwd: string, signal: AbortSignal | undefined): Promise<string> {
	const result = await runGitCommand(cwd, ["worktree", "list", "--porcelain"], signal);

	if (result.code !== 0) {
		return `Error listing worktrees:\n${result.stderr || result.stdout}`;
	}

	// Parse porcelain output
	const worktrees: Array<{ path: string; branch: string; HEAD: string; bare: boolean }> = [];
	let current: Partial<(typeof worktrees)[0]> = {};

	for (const line of result.stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current.path) {
				worktrees.push(current as (typeof worktrees)[0]);
			}
			current = { path: line.slice(9).trim() };
		} else if (line.startsWith("branch ")) {
			current.branch = line.slice(7).trim();
		} else if (line.startsWith("HEAD ")) {
			current.HEAD = line.slice(5).trim();
		} else if (line === "bare") {
			current.bare = true;
		}
	}
	if (current.path) {
		worktrees.push(current as (typeof worktrees)[0]);
	}

	if (worktrees.length === 0) {
		return "No worktrees found.";
	}

	const output = [
		`## Git Worktrees (${worktrees.length})`,
		"",
		...worktrees.map(
			(wt, i) =>
				`${i + 1}. **${wt.path}**\n   Branch: ${wt.branch || "(detached)"}\n   HEAD: ${wt.HEAD || "unknown"}`,
		),
	].join("\n");

	return output;
}

async function gitWorktreeRemove(cwd: string, worktreePath: string, signal: AbortSignal | undefined): Promise<string> {
	if (!existsSync(worktreePath)) {
		return `Error: Worktree path does not exist: ${worktreePath}`;
	}

	// Force remove the worktree
	const result = await runGitCommand(cwd, ["worktree", "remove", "--force", worktreePath], signal);

	if (result.code !== 0) {
		return `Error removing worktree:\n${result.stderr || result.stdout}`;
	}

	return `Removed worktree: ${worktreePath}`;
}

const gitWorktreeParamsSchema = Type.Object({
	action: Type.String({ description: "Action to perform: create, list, or remove" }),
	worktreePath: Type.Optional(Type.String({ description: "Path for the worktree (required for create and remove)" })),
	branch: Type.Optional(
		Type.String({ description: "Branch name (required for create; will be created if it doesn't exist)" }),
	),
});
type GitWorktreeParams = Static<typeof gitWorktreeParamsSchema>;

export const gitWorktreeToolDefinition: ToolDefinition<typeof gitWorktreeParamsSchema, undefined, undefined> = {
	name: "GitWorktree",
	label: "GitWorktree",
	description: "Manage git worktrees. Supports create, list, and remove actions.",
	parameters: gitWorktreeParamsSchema,
	execute: async (
		_toolCallId: string,
		params: GitWorktreeParams,
		signal: AbortSignal | undefined,
		_onUpdate: (update: unknown) => Promise<void>,
		ctx: { cwd?: string } | undefined,
	) => {
		const action = params.action;
		const worktreePath = params.worktreePath;
		const branch = params.branch;
		const cwd = ctx?.cwd || process.cwd();

		try {
			// Verify git is available
			const gitCheck = await runGitCommand(cwd, ["--version"], signal);
			if (gitCheck.code !== 0) {
				return {
					content: [{ type: "text", text: "Error: git is not installed or not in PATH." }],
					details: undefined,
				};
			}

			let result: string;

			switch (action) {
				case "create": {
					if (!worktreePath) {
						return {
							content: [{ type: "text", text: "Error: 'worktreePath' is required for create action." }],
							details: undefined,
						};
					}
					if (!branch) {
						return {
							content: [{ type: "text", text: "Error: 'branch' is required for create action." }],
							details: undefined,
						};
					}
					result = await gitWorktreeCreate(cwd, worktreePath, branch, signal);
					break;
				}
				case "list": {
					result = await gitWorktreeList(cwd, signal);
					break;
				}
				case "remove": {
					if (!worktreePath) {
						return {
							content: [{ type: "text", text: "Error: 'worktreePath' is required for remove action." }],
							details: undefined,
						};
					}
					result = await gitWorktreeRemove(cwd, worktreePath, signal);
					break;
				}
				default:
					return {
						content: [
							{ type: "text", text: `Error: Unknown action "${action}". Supported: create, list, remove.` },
						],
						details: undefined,
					};
			}

			return {
				content: [{ type: "text", text: truncateOutput(result) }],
				details: undefined,
			};
		} catch (err: any) {
			return {
				content: [{ type: "text", text: `GitWorktree Error: ${err.message || String(err)}` }],
				details: undefined,
			};
		}
	},
};
