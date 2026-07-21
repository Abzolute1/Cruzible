import type { AgentTool } from "@ag1/agent-core";
import { Text } from "@ag1/tui";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../extensions/types.js";
import { replaceTodoList, summarizeTodos, type TodoItem, validateTodoItems } from "../todos.js";
import { invalidArgText } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const todoItemSchema = Type.Object(
	{
		id: Type.Optional(
			Type.String({
				description: "Stable id for the item. Omit to have one assigned; keep ids stable across calls.",
			}),
		),
		title: Type.String({ description: 'Short imperative description of the task, e.g. "Add validation tests".' }),
		status: Type.Optional(
			Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], {
				description: 'Item status. Defaults to "pending" when omitted. At most one item may be in_progress.',
			}),
		),
	},
	{ additionalProperties: false },
);

const todoSchema = Type.Object(
	{
		todos: Type.Optional(
			Type.Array(todoItemSchema, {
				description: "Full replacement list. Every call must pass the entire list with updated statuses.",
			}),
		),
		clear: Type.Optional(Type.Boolean({ description: "Set true to wipe the todo list entirely." })),
	},
	{ additionalProperties: false },
);

export type TodoToolInput = Static<typeof todoSchema>;

export interface TodoToolDetails {
	/** The validated replacement list, or null for a no-change query call. */
	todos: TodoItem[] | null;
	/** True when the list was cleared. */
	cleared?: boolean;
}

type RenderableTodoArgs = {
	todos?: unknown;
	clear?: unknown;
};

function formatTodoCall(
	args: RenderableTodoArgs | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const title = theme.fg("toolTitle", theme.bold("todo"));
	if (args?.clear === true) {
		return `${title} ${theme.fg("toolOutput", "clear")}`;
	}
	if (Array.isArray(args?.todos)) {
		const validation = validateTodoItems(args.todos);
		if (!validation.ok) return `${title} ${invalidArgText(theme)}`;
		const summary = summarizeTodos(replaceTodoList(null, validation.items));
		const parts = [`${summary.completed}/${summary.total} done`];
		if (summary.inProgressTitle) parts.push(`in progress: ${summary.inProgressTitle}`);
		return `${title} ${theme.fg("toolOutput", parts.join(" · "))}`;
	}
	return title;
}

function formatTodoResult(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: TodoToolDetails;
	},
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	isError: boolean,
): string {
	if (isError) {
		const errorText = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n");
		return errorText ? `\n${theme.fg("error", errorText)}` : "";
	}
	const details = result.details;
	if (details?.cleared) {
		return `\n${theme.fg("toolOutput", "list cleared")}`;
	}
	if (details?.todos) {
		const summary = summarizeTodos({ version: 1, items: details.todos, updatedAt: 0 });
		const header = [`${summary.completed}/${summary.total} done`];
		if (summary.inProgressTitle) header.push(`in progress: ${summary.inProgressTitle}`);
		const MAX_SHOWN = 15;
		const lines = details.todos.slice(0, MAX_SHOWN).map((item) => {
			if (item.status === "completed") return theme.fg("success", `✓ ${item.title}`);
			if (item.status === "in_progress") return theme.fg("accent", `◐ ${item.title}`);
			return theme.fg("muted", `○ ${item.title}`);
		});
		if (details.todos.length > MAX_SHOWN) {
			lines.push(theme.fg("dim", `… ${details.todos.length - MAX_SHOWN} more`));
		}
		return `\n${theme.fg("toolOutput", header.join(" · "))}\n${lines.join("\n")}`;
	}
	return "";
}

function formatTodoSummaryText(items: TodoItem[]): string {
	const summary = summarizeTodos({ version: 1, items, updatedAt: 0 });
	const parts = [`Todo list updated: ${summary.completed}/${summary.total} completed.`];
	if (summary.inProgressTitle) parts.push(`In progress: ${summary.inProgressTitle}.`);
	parts.push(
		"The harness stored this list. Keep working on the in_progress item; pass the full list again with updated statuses when you finish a step or the plan changes.",
	);
	return parts.join(" ");
}

export function createTodoToolDefinition(): ToolDefinition<typeof todoSchema, TodoToolDetails> {
	return {
		name: "todo",
		label: "todo",
		description:
			"Track progress on multi-step tasks as a todo list. Use for any task with 3+ steps. Every call replaces the whole list, so always pass ALL items with their current statuses. Keep exactly one item in_progress, mark an item completed immediately after finishing it, and keep titles short and imperative. Call with clear=true to wipe the list, or with no arguments to query the current list.",
		promptSnippet: "Track multi-step tasks in a todo list (full-list replace on every call)",
		promptGuidelines: [
			"Use todo for any task with 3+ steps to track progress; skip it for single-step requests.",
			"Always pass the full list on every todo call; it replaces the previous list entirely.",
			"Keep exactly one todo in_progress and mark items completed immediately after finishing them.",
		],
		parameters: todoSchema,
		async execute(_toolCallId, input: TodoToolInput, _signal?, _onUpdate?, _ctx?) {
			if (input.clear === true && input.todos !== undefined) {
				throw new Error("Pass either todos (full replace) or clear=true, not both.");
			}

			if (input.clear === true) {
				return {
					content: [{ type: "text" as const, text: "Todo list cleared." }],
					details: { todos: [], cleared: true },
				};
			}

			if (input.todos === undefined) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No change requested (query). The harness tracks the current todo list; pass todos to replace it or clear=true to wipe it.",
						},
					],
					details: { todos: null },
				};
			}

			const validation = validateTodoItems(input.todos);
			if (!validation.ok) {
				throw new Error(validation.error);
			}
			return {
				content: [{ type: "text" as const, text: formatTodoSummaryText(validation.items) }],
				details: { todos: validation.items },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatTodoCall(args, theme));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatTodoResult(result as any, theme, context.isError));
			return text;
		},
	};
}

export function createTodoTool(): AgentTool<typeof todoSchema, TodoToolDetails> {
	return wrapToolDefinition(createTodoToolDefinition());
}

/** Default todo tool (stateless; list state is owned by the caller). */
export const todoToolDefinition = createTodoToolDefinition();
export const todoTool = createTodoTool();
