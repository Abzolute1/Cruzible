// Auton — TodoWrite Tool
// Manages a todo list in .auton/todos.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../../extensions/types.js";

interface TodoItem {
	id: string;
	content: string;
	status: "pending" | "in_progress" | "completed";
	priority: "low" | "medium" | "high";
	createdAt: string;
	updatedAt: string;
}

interface TodoFile {
	todos: TodoItem[];
}

function getTodoFilePath(cwd: string): string {
	const autonDir = join(cwd, ".auton");
	if (!existsSync(autonDir)) {
		mkdirSync(autonDir, { recursive: true });
	}
	return join(autonDir, "todos.json");
}

function loadTodos(cwd: string): TodoFile {
	const path = getTodoFilePath(cwd);
	if (!existsSync(path)) {
		return { todos: [] };
	}
	try {
		const content = readFileSync(path, "utf-8");
		return JSON.parse(content);
	} catch {
		return { todos: [] };
	}
}

function saveTodos(cwd: string, data: TodoFile): void {
	const path = getTodoFilePath(cwd);
	writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

function generateId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).slice(2, 8);
	return `todo_${timestamp}_${random}`;
}

const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
const statusOrder: Record<string, number> = { in_progress: 0, pending: 1, completed: 2 };

function statusIcon(status: string): string {
	switch (status) {
		case "pending":
			return "[ ]";
		case "in_progress":
			return "[~]";
		case "completed":
			return "[x]";
		default:
			return "[ ]";
	}
}

function priorityIcon(priority: string): string {
	switch (priority) {
		case "high":
			return "!!!";
		case "medium":
			return "!";
		case "low":
			return ".";
		default:
			return "";
	}
}

const todoWriteParamsSchema = Type.Object({
	action: Type.Enum(
		{
			create: "create",
			update: "update",
			list: "list",
			clear: "clear",
		},
		{ description: "Action to perform" },
	),
	id: Type.Optional(Type.String({ description: "Todo ID (required for update)" })),
	content: Type.Optional(Type.String({ description: "Todo content (required for create, optional for update)" })),
	status: Type.Optional(
		Type.Enum(
			{
				pending: "pending",
				in_progress: "in_progress",
				completed: "completed",
			},
			{ description: "Todo status (optional for update)" },
		),
	),
	priority: Type.Optional(
		Type.Enum(
			{
				low: "low",
				medium: "medium",
				high: "high",
			},
			{ description: "Todo priority (optional for create/update)" },
		),
	),
});
type TodoWriteParams = Static<typeof todoWriteParamsSchema>;

export const todoWriteToolDefinition: ToolDefinition<typeof todoWriteParamsSchema, undefined, undefined> = {
	name: "TodoWrite",
	label: "TodoWrite",
	description: "Manage a todo list in .auton/todos.json. Supports create, update, list, and clear actions.",
	parameters: todoWriteParamsSchema,
	execute: async (
		_toolCallId: string,
		params: TodoWriteParams,
		_signal: AbortSignal | undefined,
		_onUpdate: (update: unknown) => Promise<void>,
		ctx: { cwd?: string } | undefined,
	) => {
		const action = params.action;
		const id = params.id;
		const content = params.content;
		const status = params.status;
		const priority = params.priority;
		const cwd = ctx?.cwd || process.cwd();

		try {
			const todoFile = loadTodos(cwd);

			switch (action) {
				case "create": {
					if (!content || content.trim().length === 0) {
						return {
							content: [{ type: "text", text: "Error: 'content' is required for create action." }],
							details: undefined,
						};
					}

					const now = new Date().toISOString();
					const todo: TodoItem = {
						id: generateId(),
						content: content.trim(),
						status: (status as TodoItem["status"]) || "pending",
						priority: (priority as TodoItem["priority"]) || "medium",
						createdAt: now,
						updatedAt: now,
					};

					todoFile.todos.push(todo);
					saveTodos(cwd, todoFile);

					return {
						content: [
							{
								type: "text",
								text: `Todo created.\n\n**ID:** ${todo.id}\n**Content:** ${todo.content}\n**Status:** ${todo.status}\n**Priority:** ${todo.priority}`,
							},
						],
						details: undefined,
					};
				}

				case "update": {
					if (!id) {
						return {
							content: [{ type: "text", text: "Error: 'id' is required for update action." }],
							details: undefined,
						};
					}

					const todoIndex = todoFile.todos.findIndex((t) => t.id === id);
					if (todoIndex === -1) {
						return {
							content: [{ type: "text", text: `Error: Todo not found: ${id}` }],
							details: undefined,
						};
					}

					const todo = todoFile.todos[todoIndex];
					const updates: string[] = [];

					if (content && content.trim().length > 0) {
						todo.content = content.trim();
						updates.push("content");
					}
					if (status && (status === "pending" || status === "in_progress" || status === "completed")) {
						todo.status = status as TodoItem["status"];
						updates.push("status");
					}
					if (priority && (priority === "low" || priority === "medium" || priority === "high")) {
						todo.priority = priority as TodoItem["priority"];
						updates.push("priority");
					}

					if (updates.length === 0) {
						return {
							content: [
								{ type: "text", text: "No updates provided. Specify 'content', 'status', and/or 'priority'." },
							],
							details: undefined,
						};
					}

					todo.updatedAt = new Date().toISOString();
					saveTodos(cwd, todoFile);

					return {
						content: [
							{
								type: "text",
								text: `Todo ${id} updated.\nUpdated fields: ${updates.join(", ")}\n\n${statusIcon(todo.status)} ${priorityIcon(todo.priority)} ${todo.content}`,
							},
						],
						details: undefined,
					};
				}

				case "list": {
					if (todoFile.todos.length === 0) {
						return {
							content: [{ type: "text", text: "No todos found." }],
							details: undefined,
						};
					}

					// Sort by priority then status
					const sorted = [...todoFile.todos].sort((a, b) => {
						const priorityDiff = (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1);
						if (priorityDiff !== 0) return priorityDiff;
						return (statusOrder[a.status] ?? 1) - (statusOrder[b.status] ?? 1);
					});

					const output = [
						`## Todos (${todoFile.todos.length})`,
						"",
						...sorted.map((t) => {
							const statusLabel = t.status.replace("_", " ");
							return `${statusIcon(t.status)} **${priorityIcon(t.priority)}** ${t.content}\n   ID: ${t.id} | Status: ${statusLabel} | Priority: ${t.priority}`;
						}),
					].join("\n");

					// Summary
					const pending = todoFile.todos.filter((t) => t.status === "pending").length;
					const inProgress = todoFile.todos.filter((t) => t.status === "in_progress").length;
					const completed = todoFile.todos.filter((t) => t.status === "completed").length;
					const summary = `\n\n**Summary:** ${completed} completed, ${inProgress} in progress, ${pending} pending`;

					return {
						content: [{ type: "text", text: output + summary }],
						details: undefined,
					};
				}

				case "clear": {
					const activeCount = todoFile.todos.filter((t) => t.status !== "completed").length;
					const completedCount = todoFile.todos.filter((t) => t.status === "completed").length;

					if (completedCount === 0) {
						return {
							content: [{ type: "text", text: "No completed todos to clear." }],
							details: undefined,
						};
					}

					todoFile.todos = todoFile.todos.filter((t) => t.status !== "completed");
					saveTodos(cwd, todoFile);

					return {
						content: [
							{
								type: "text",
								text: `Cleared ${completedCount} completed todo(s). ${activeCount} todo(s) remaining.`,
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
								text: `Error: Unknown action "${action}". Supported: create, update, list, clear.`,
							},
						],
						details: undefined,
					};
			}
		} catch (err: any) {
			return {
				content: [{ type: "text", text: `TodoWrite Error: ${err.message || String(err)}` }],
				details: undefined,
			};
		}
	},
};
