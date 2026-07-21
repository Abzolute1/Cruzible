import { describe, expect, test } from "vitest";
import {
	appendTodoSnapshot,
	clearTodoList,
	isTodoListStale,
	readLatestTodoSnapshot,
	replaceTodoList,
	summarizeTodos,
	TODO_JOURNAL_TYPE,
	TODO_MAX_ITEMS,
	TODO_STALE_CALL_THRESHOLD,
	type TodoItem,
	type TodoListSnapshot,
	validateTodoItems,
} from "../src/core/todos.js";
import { createTodoToolDefinition, type TodoToolDetails } from "../src/core/tools/todo.js";

function makeSnapshot(items: TodoItem[], updatedAt = 1000): TodoListSnapshot {
	return { version: 1, items, updatedAt };
}

describe("validateTodoItems", () => {
	test("rejects non-array input", () => {
		const result = validateTodoItems("nope");
		expect(result.ok).toBe(false);
	});

	test("rejects empty or whitespace-only titles", () => {
		expect(validateTodoItems([{ title: "" }]).ok).toBe(false);
		expect(validateTodoItems([{ title: "   " }]).ok).toBe(false);
	});

	test("trims titles and collapses whitespace", () => {
		const result = validateTodoItems([{ title: "  fix   the\n bug " }]);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.items[0].title).toBe("fix the bug");
	});

	test("rejects invalid status values", () => {
		const result = validateTodoItems([{ title: "x", status: "done" }]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('"pending"');
	});

	test("defaults missing status to pending", () => {
		const result = validateTodoItems([{ title: "x" }]);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.items[0].status).toBe("pending");
	});

	test("rejects more than one in_progress item with a model-actionable error", () => {
		const result = validateTodoItems([
			{ title: "a", status: "in_progress" },
			{ title: "b", status: "in_progress" },
		]);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBe("Only one todo may be in_progress at a time. Mark the others pending or completed.");
		}
	});

	test("assigns stable ids to items missing ids", () => {
		const result = validateTodoItems([{ title: "a" }, { title: "b" }, { title: "c" }]);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.items.map((item) => item.id)).toEqual(["t1", "t2", "t3"]);
	});

	test("keeps explicit unique ids and reassigns duplicates", () => {
		const result = validateTodoItems([
			{ id: "mine", title: "a" },
			{ id: "mine", title: "b" },
		]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.items[0].id).toBe("mine");
			expect(result.items[1].id).not.toBe("mine");
			expect(new Set(result.items.map((item) => item.id)).size).toBe(2);
		}
	});

	test(`caps the list at ${TODO_MAX_ITEMS} items`, () => {
		const atCap = validateTodoItems(Array.from({ length: TODO_MAX_ITEMS }, (_, i) => ({ title: `item ${i + 1}` })));
		expect(atCap.ok).toBe(true);
		const overCap = validateTodoItems(
			Array.from({ length: TODO_MAX_ITEMS + 1 }, (_, i) => ({ title: `item ${i + 1}` })),
		);
		expect(overCap.ok).toBe(false);
		if (!overCap.ok) expect(overCap.error).toContain(`${TODO_MAX_ITEMS}`);
	});
});

describe("todo reducers", () => {
	test("replaceTodoList returns a versioned snapshot with copied items", () => {
		const items: TodoItem[] = [{ id: "t1", title: "a", status: "in_progress" }];
		const snapshot = replaceTodoList(null, items, 42);
		expect(snapshot.version).toBe(1);
		expect(snapshot.updatedAt).toBe(42);
		expect(snapshot.items).toEqual(items);
		expect(snapshot.items).not.toBe(items);
	});

	test("clearTodoList returns an empty snapshot", () => {
		const snapshot = clearTodoList(7);
		expect(snapshot).toEqual({ version: 1, items: [], updatedAt: 7 });
	});
});

describe("todo tool", () => {
	const tool = createTodoToolDefinition();
	const execute = (input: unknown) => tool.execute("call-1", input as never, undefined, undefined, undefined as never);
	const resultText = (result: Awaited<ReturnType<typeof execute>>): string =>
		result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

	test("is named todo", () => {
		expect(tool.name).toBe("todo");
	});

	test("replaces the list and echoes validated items in details", async () => {
		const result = await execute({
			todos: [
				{ title: "write code", status: "completed" },
				{ title: "run tests", status: "in_progress" },
				{ title: "ship" },
			],
		});
		const details = result.details as TodoToolDetails;
		expect(details.cleared).toBeUndefined();
		expect(details.todos).toEqual([
			{ id: "t1", title: "write code", status: "completed" },
			{ id: "t2", title: "run tests", status: "in_progress" },
			{ id: "t3", title: "ship", status: "pending" },
		]);
		expect(resultText(result)).toContain("1/3 completed");
		expect(resultText(result)).toContain("run tests");
	});

	test("clear wipes the list", async () => {
		const result = await execute({ clear: true });
		const details = result.details as TodoToolDetails;
		expect(details.cleared).toBe(true);
		expect(details.todos).toEqual([]);
		expect(resultText(result)).toContain("cleared");
	});

	test("rejects todos and clear together", async () => {
		await expect(execute({ todos: [{ title: "a" }], clear: true })).rejects.toThrow(/either todos/);
	});

	test("calling with no arguments is a no-change query", async () => {
		const result = await execute({});
		const details = result.details as TodoToolDetails;
		expect(details.todos).toBeNull();
		expect(details.cleared).toBeUndefined();
	});

	test("validation failure throws an error containing the model-actionable message", async () => {
		await expect(
			execute({
				todos: [
					{ title: "a", status: "in_progress" },
					{ title: "b", status: "in_progress" },
				],
			}),
		).rejects.toThrow("Only one todo may be in_progress at a time. Mark the others pending or completed.");
		await expect(execute({ todos: [{ title: "" }] })).rejects.toThrow(/empty title/);
	});
});

describe("todo journal", () => {
	function createFakeSessionManager() {
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		return {
			entries,
			appendCustomEntry(customType: string, data?: unknown) {
				entries.push({ type: "custom", customType, data });
				return `entry-${entries.length}`;
			},
		};
	}

	test("round-trips a snapshot through appendCustomEntry and readLatestTodoSnapshot", () => {
		const sessionManager = createFakeSessionManager();
		const snapshot = makeSnapshot([
			{ id: "t1", title: "a", status: "completed" },
			{ id: "t2", title: "b", status: "in_progress" },
		]);
		const entryId = appendTodoSnapshot(sessionManager, snapshot);
		expect(entryId).toBe("entry-1");
		expect(sessionManager.entries[0].customType).toBe(TODO_JOURNAL_TYPE);

		const restored = readLatestTodoSnapshot(sessionManager.entries as never);
		expect(restored).toEqual(snapshot);
	});

	test("returns the latest snapshot when several exist", () => {
		const sessionManager = createFakeSessionManager();
		appendTodoSnapshot(sessionManager, makeSnapshot([{ id: "t1", title: "old", status: "pending" }], 1));
		const latest = makeSnapshot([{ id: "t1", title: "new", status: "completed" }], 2);
		appendTodoSnapshot(sessionManager, latest);
		expect(readLatestTodoSnapshot(sessionManager.entries as never)).toEqual(latest);
	});

	test("returns null when no todo entries exist", () => {
		expect(readLatestTodoSnapshot([])).toBeNull();
		expect(readLatestTodoSnapshot([{ type: "custom", customType: "other", data: {} }] as never)).toBeNull();
	});
});

describe("isTodoListStale", () => {
	const openSnapshot = makeSnapshot([
		{ id: "t1", title: "a", status: "completed" },
		{ id: "t2", title: "b", status: "pending" },
	]);

	test("is false for a null snapshot", () => {
		expect(isTodoListStale(null, TODO_STALE_CALL_THRESHOLD + 10)).toBe(false);
	});

	test("is false below the threshold", () => {
		expect(isTodoListStale(openSnapshot, TODO_STALE_CALL_THRESHOLD - 1)).toBe(false);
	});

	test("is true at the threshold with open items", () => {
		expect(isTodoListStale(openSnapshot, TODO_STALE_CALL_THRESHOLD)).toBe(true);
	});

	test("is false when every item is completed", () => {
		const done = makeSnapshot([{ id: "t1", title: "a", status: "completed" }]);
		expect(isTodoListStale(done, TODO_STALE_CALL_THRESHOLD + 10)).toBe(false);
	});
});

describe("summarizeTodos", () => {
	test("summarizes counts and the in_progress title", () => {
		const snapshot = makeSnapshot([
			{ id: "t1", title: "a", status: "completed" },
			{ id: "t2", title: "b", status: "completed" },
			{ id: "t3", title: "c", status: "in_progress" },
			{ id: "t4", title: "d", status: "pending" },
		]);
		expect(summarizeTodos(snapshot)).toEqual({ total: 4, completed: 2, inProgressTitle: "c" });
	});

	test("handles null and empty snapshots", () => {
		expect(summarizeTodos(null)).toEqual({ total: 0, completed: 0, inProgressTitle: null });
		expect(summarizeTodos(makeSnapshot([]))).toEqual({ total: 0, completed: 0, inProgressTitle: null });
	});
});
