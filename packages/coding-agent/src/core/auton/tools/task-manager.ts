// Auton — TaskManager Tool
// Manages tasks in .auton/tasks.json file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../../extensions/types.js";

interface Task {
	id: string;
	subject: string;
	description: string;
	status: "active" | "completed" | "stopped";
	createdAt: string;
	updatedAt: string;
	output?: string;
	[key: string]: unknown;
}

interface TaskFile {
	tasks: Task[];
}

function getTaskFilePath(cwd: string): string {
	const autonDir = join(cwd, ".auton");
	if (!existsSync(autonDir)) {
		mkdirSync(autonDir, { recursive: true });
	}
	return join(autonDir, "tasks.json");
}

function loadTasks(cwd: string): TaskFile {
	const path = getTaskFilePath(cwd);
	if (!existsSync(path)) {
		return { tasks: [] };
	}
	try {
		const content = readFileSync(path, "utf-8");
		return JSON.parse(content);
	} catch {
		return { tasks: [] };
	}
}

function saveTasks(cwd: string, data: TaskFile): void {
	const path = getTaskFilePath(cwd);
	writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

function generateId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).slice(2, 8);
	return `task_${timestamp}_${random}`;
}

const MAX_OUTPUT_CHARS = 10000;

function truncateOutput(output: string): string {
	if (output.length <= MAX_OUTPUT_CHARS) return output;
	return (
		output.slice(0, MAX_OUTPUT_CHARS) +
		`\n\n[Output truncated: ${output.length - MAX_OUTPUT_CHARS} more characters omitted]`
	);
}

const taskManagerParamsSchema = Type.Object({
	action: Type.Enum(
		{
			create: "create",
			list: "list",
			get: "get",
			update: "update",
			stop: "stop",
			output: "output",
		},
		{ description: "Action to perform" },
	),
	taskId: Type.Optional(Type.String({ description: "Task ID (required for get, update, stop, output)" })),
	subject: Type.Optional(Type.String({ description: "Task subject (required for create)" })),
	description: Type.Optional(
		Type.String({ description: "Task description (required for create, optional for update)" }),
	),
});
type TaskManagerParams = Static<typeof taskManagerParamsSchema>;

export const taskManagerToolDefinition: ToolDefinition<typeof taskManagerParamsSchema, undefined, undefined> = {
	name: "TaskManager",
	label: "TaskManager",
	description: "Manage tasks in .auton/tasks.json. Supports create, list, get, update, stop, and output actions.",
	parameters: taskManagerParamsSchema,
	execute: async (
		_toolCallId: string,
		params: TaskManagerParams,
		_signal: AbortSignal | undefined,
		_onUpdate: (update: unknown) => Promise<void>,
		ctx: { cwd?: string } | undefined,
	) => {
		const action = params.action;
		const taskId = params.taskId;
		const subject = params.subject;
		const description = params.description;
		const cwd = ctx?.cwd || process.cwd();

		try {
			const taskFile = loadTasks(cwd);

			switch (action) {
				case "create": {
					if (!subject) {
						return {
							content: [{ type: "text", text: "Error: 'subject' is required for create action." }],
							details: undefined,
						};
					}
					if (!description) {
						return {
							content: [{ type: "text", text: "Error: 'description' is required for create action." }],
							details: undefined,
						};
					}

					const now = new Date().toISOString();
					const task: Task = {
						id: generateId(),
						subject: subject.trim(),
						description: description.trim(),
						status: "active",
						createdAt: now,
						updatedAt: now,
					};

					taskFile.tasks.push(task);
					saveTasks(cwd, taskFile);

					return {
						content: [
							{
								type: "text",
								text: `Task created.\n\n**ID:** ${task.id}\n**Subject:** ${task.subject}\n**Description:** ${task.description}\n**Status:** ${task.status}\n**Created:** ${task.createdAt}`,
							},
						],
						details: undefined,
					};
				}

				case "list": {
					if (taskFile.tasks.length === 0) {
						return {
							content: [{ type: "text", text: "No tasks found." }],
							details: undefined,
						};
					}

					const output = [
						`## Tasks (${taskFile.tasks.length})`,
						"",
						...taskFile.tasks.map(
							(t, i) =>
								`${i + 1}. **${t.subject}** (\`${t.id}\`)\n   Status: ${t.status} | Created: ${t.createdAt}`,
						),
					].join("\n");

					return {
						content: [{ type: "text", text: truncateOutput(output) }],
						details: undefined,
					};
				}

				case "get": {
					if (!taskId) {
						return {
							content: [{ type: "text", text: "Error: 'taskId' is required for get action." }],
							details: undefined,
						};
					}

					const task = taskFile.tasks.find((t) => t.id === taskId);
					if (!task) {
						return {
							content: [{ type: "text", text: `Error: Task not found: ${taskId}` }],
							details: undefined,
						};
					}

					const output = [
						`## Task: ${task.subject}`,
						"",
						`- **ID:** ${task.id}`,
						`- **Subject:** ${task.subject}`,
						`- **Description:** ${task.description}`,
						`- **Status:** ${task.status}`,
						`- **Created:** ${task.createdAt}`,
						`- **Updated:** ${task.updatedAt}`,
						task.output ? `- **Output:**\n\n${task.output}` : "",
					]
						.filter(Boolean)
						.join("\n");

					return {
						content: [{ type: "text", text: truncateOutput(output) }],
						details: undefined,
					};
				}

				case "update": {
					if (!taskId) {
						return {
							content: [{ type: "text", text: "Error: 'taskId' is required for update action." }],
							details: undefined,
						};
					}

					const taskIndex = taskFile.tasks.findIndex((t) => t.id === taskId);
					if (taskIndex === -1) {
						return {
							content: [{ type: "text", text: `Error: Task not found: ${taskId}` }],
							details: undefined,
						};
					}

					const task = taskFile.tasks[taskIndex];
					const updates: string[] = [];

					if (subject) {
						task.subject = subject.trim();
						updates.push("subject");
					}
					if (description) {
						task.description = description.trim();
						updates.push("description");
					}

					if (updates.length === 0) {
						return {
							content: [{ type: "text", text: "No updates provided. Specify 'subject' and/or 'description'." }],
							details: undefined,
						};
					}

					task.updatedAt = new Date().toISOString();
					saveTasks(cwd, taskFile);

					return {
						content: [
							{
								type: "text",
								text: `Task ${taskId} updated.\nUpdated fields: ${updates.join(", ")}\n\n**Subject:** ${task.subject}\n**Description:** ${task.description}`,
							},
						],
						details: undefined,
					};
				}

				case "stop": {
					if (!taskId) {
						return {
							content: [{ type: "text", text: "Error: 'taskId' is required for stop action." }],
							details: undefined,
						};
					}

					const task = taskFile.tasks.find((t) => t.id === taskId);
					if (!task) {
						return {
							content: [{ type: "text", text: `Error: Task not found: ${taskId}` }],
							details: undefined,
						};
					}

					if (task.status === "stopped") {
						return {
							content: [{ type: "text", text: `Task ${taskId} is already stopped.` }],
							details: undefined,
						};
					}
					if (task.status === "completed") {
						return {
							content: [{ type: "text", text: `Task ${taskId} is already completed and cannot be stopped.` }],
							details: undefined,
						};
					}

					task.status = "stopped";
					task.updatedAt = new Date().toISOString();
					saveTasks(cwd, taskFile);

					return {
						content: [{ type: "text", text: `Task stopped: ${taskId} - ${task.subject}` }],
						details: undefined,
					};
				}

				case "output": {
					if (!taskId) {
						return {
							content: [{ type: "text", text: "Error: 'taskId' is required for output action." }],
							details: undefined,
						};
					}

					const task = taskFile.tasks.find((t) => t.id === taskId);
					if (!task) {
						return {
							content: [{ type: "text", text: `Error: Task not found: ${taskId}` }],
							details: undefined,
						};
					}

					if (description) {
						// Set output
						task.output = description;
						task.updatedAt = new Date().toISOString();
						saveTasks(cwd, taskFile);
						return {
							content: [{ type: "text", text: `Output set for task ${taskId} (${description.length} chars).` }],
							details: undefined,
						};
					}

					// Get output
					if (!task.output) {
						return {
							content: [{ type: "text", text: `No output for task ${taskId}.` }],
							details: undefined,
						};
					}

					return {
						content: [
							{
								type: "text",
								text: truncateOutput(`## Output for ${task.subject} (${taskId})\n\n${task.output}`),
							},
						],
						details: undefined,
					};
				}

				default:
					return {
						content: [
							{
								type: "text",
								text: `Error: Unknown action "${action}". Supported: create, list, get, update, stop, output.`,
							},
						],
						details: undefined,
					};
			}
		} catch (err: any) {
			return {
				content: [{ type: "text", text: `TaskManager Error: ${err.message || String(err)}` }],
				details: undefined,
			};
		}
	},
};
