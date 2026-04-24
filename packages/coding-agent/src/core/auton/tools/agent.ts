// Auton — Agent Tool
// Spawns a child agent process to handle sub-tasks.

import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { APP_SLUG, CLI_NAME, LEGACY_CLI_NAMES } from "../../../config.js";
import type { ToolDefinition } from "../../extensions/types.js";

const MAX_OUTPUT_CHARS = 30000;
let activeChildAgents = 0;
const MAX_ACTIVE_CHILD_AGENTS = 3;
const ALLOWED_AGENT_BIN_NAMES = new Set([
	CLI_NAME,
	APP_SLUG,
	...LEGACY_CLI_NAMES,
	"auton",
	"coding-agent",
	"index.js",
	"cli.js",
]);

function truncateOutput(output: string): string {
	if (output.length <= MAX_OUTPUT_CHARS) return output;
	return `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[Output truncated: ${output.length - MAX_OUTPUT_CHARS} more characters omitted]`;
}

function resolveAgentBinaryPath(argv1 = process.argv[1] || ""): string {
	const invokedName = basename(argv1);
	return argv1 && ALLOWED_AGENT_BIN_NAMES.has(invokedName) ? argv1 : CLI_NAME;
}

const agentParamsSchema = Type.Object({
	task: Type.String({ description: "Task description for the child agent" }),
	maxTokens: Type.Optional(
		Type.Number({ default: 8000, description: "Maximum tokens for the child agent (default 8000)" }),
	),
	maxTurns: Type.Optional(Type.Number({ default: 10, description: "Maximum turns for the child agent (default 10)" })),
	timeoutMs: Type.Optional(
		Type.Number({
			default: 300000,
			description: "Timeout in milliseconds for the child agent (default 300000 = 5 min)",
		}),
	),
});
type AgentToolParams = Static<typeof agentParamsSchema>;

export const agentToolDefinition: ToolDefinition<typeof agentParamsSchema, undefined, undefined> = {
	name: "Agent",
	label: "Agent",
	description: "Spawn a child agent process to handle a sub-task. Useful for delegating complex work.",
	parameters: agentParamsSchema,
	execute: async (
		_toolCallId: string,
		params: AgentToolParams,
		signal: AbortSignal | undefined,
		onUpdate: (update: unknown) => Promise<void>,
		ctx: { cwd?: string } | undefined,
	) => {
		const task = params.task;
		const maxTokens = params.maxTokens ?? 8000;
		const maxTurns = params.maxTurns ?? 10;
		const timeoutMs = params.timeoutMs ?? 300000;
		const cwd = ctx?.cwd || process.cwd();

		if (!task || task.trim().length === 0) {
			return {
				content: [{ type: "text", text: "Error: 'task' is required and cannot be empty." }],
				details: undefined,
			};
		}

		// Resolve the current CLI binary path — use an allowlist of known entry point names
		// rather than trusting arbitrary process.argv[1] values.
		const agentBin = resolveAgentBinaryPath();

		// Concurrency guard
		if (activeChildAgents >= MAX_ACTIVE_CHILD_AGENTS) {
			return {
				content: [
					{
						type: "text",
						text: `Error: Maximum concurrent child agents (${MAX_ACTIVE_CHILD_AGENTS}) already running. Wait for existing agents to complete before spawning more.`,
					},
				],
				details: undefined,
			};
		}
		activeChildAgents++;

		// Build the child agent command
		const args = [
			"--print",
			"--non-interactive",
			"--max-tokens",
			String(maxTokens),
			"--max-turns",
			String(maxTurns),
			task,
		];

		// Notify start
		if (onUpdate) {
			try {
				await onUpdate({
					type: "text",
					text: `Spawning child agent...\nTask: ${task.slice(0, 200)}\nMax tokens: ${maxTokens}\nMax turns: ${maxTurns}\nTimeout: ${Math.round(timeoutMs / 1000)}s`,
				});
			} catch {
				// ignore
			}
		}
		if (signal?.aborted) {
			activeChildAgents = Math.max(0, activeChildAgents - 1);
			return {
				content: [{ type: "text", text: "Child Agent Cancelled before launch." }],
				details: undefined,
			};
		}

		return new Promise((resolve) => {
			let stdout = "";
			let stderr = "";
			let killed = false;
			let timedOut = false;
			let finished = false;
			let abortHandler: (() => void) | null = null;
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const finish = (
				result:
					| {
							content: Array<{ type: "text"; text: string }>;
							details: undefined;
					  }
					| undefined,
			): void => {
				if (finished) return;
				finished = true;
				activeChildAgents = Math.max(0, activeChildAgents - 1);
				if (timeoutId) clearTimeout(timeoutId);
				if (signal && abortHandler) {
					signal.removeEventListener("abort", abortHandler);
				}
				if (result) resolve(result);
			};

			let child: ReturnType<typeof spawn>;
			try {
				child = spawn(agentBin, args, {
					cwd,
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env, AG1_NON_INTERACTIVE: "1" },
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				finish({
					content: [
						{
							type: "text",
							text: `Child Agent Error: Failed to spawn process. ${message}\n\nAttempted command: ${agentBin} ${args.join(" ")}\n\nMake sure the CLI launcher is installed and available in PATH.`,
						},
					],
					details: undefined,
				});
				return;
			}

			// Handle abort signal
			if (signal) {
				abortHandler = () => {
					if (!killed) {
						killed = true;
						child.kill("SIGTERM");
						setTimeout(() => {
							if (!child.killed) child.kill("SIGKILL");
						}, 5000);
					}
				};
				if (signal.aborted) {
					abortHandler();
				} else {
					signal.addEventListener("abort", abortHandler, { once: true });
				}
			}

			// Set a configurable timeout (default 5 minutes)
			timeoutId = setTimeout(() => {
				if (!killed) {
					timedOut = true;
					killed = true;
					child.kill("SIGTERM");
					setTimeout(() => {
						if (!child.killed) child.kill("SIGKILL");
					}, 5000);
				}
			}, timeoutMs);

			child.stdout?.on("data", (data: Buffer) => {
				const chunk = data.toString();
				stdout += chunk;

				// Stream partial updates
				if (onUpdate && chunk.length > 0) {
					try {
						onUpdate({
							type: "text",
							text: chunk.slice(0, 2000),
						}).catch(() => {});
					} catch {
						// ignore
					}
				}
			});

			child.stderr?.on("data", (data: Buffer) => {
				stderr += data.toString();
			});

			child.on("close", (code) => {
				const output = [
					`## Child Agent Result`,
					"",
					`**Task:** ${task.slice(0, 500)}`,
					`**Exit code:** ${code}`,
					`**Status:** ${killed ? (timedOut ? "Timed out" : "Cancelled") : "Completed"}`,
					"",
				];

				if (stdout) {
					output.push("### Output", "", truncateOutput(stdout));
				}

				if (stderr) {
					output.push("### Stderr", "", truncateOutput(stderr));
				}

				finish({
					content: [{ type: "text", text: output.join("\n") }],
					details: undefined,
				});
			});

			child.on("error", (err) => {
				finish({
					content: [
						{
							type: "text",
							text: `Child Agent Error: Failed to spawn process. ${err.message}\n\nAttempted command: ${agentBin} ${args.join(" ")}\n\nMake sure the CLI launcher is installed and available in PATH.`,
						},
					],
					details: undefined,
				});
			});
		});
	},
};
