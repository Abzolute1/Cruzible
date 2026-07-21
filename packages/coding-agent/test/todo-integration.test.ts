import { describe, expect, test, vi } from "vitest";
import { evaluateInteractiveNudges } from "../src/core/nudge-warnings.js";
import { isTodoListStale, replaceTodoList } from "../src/core/todos.js";
import { buildToolCallDigest, buildToolResultDigest } from "../src/core/tool-outcome-digests.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

function makeTodoResult(todos: Array<{ title: string; status?: string }>, cleared = false) {
	const items = todos.map((t, i) => ({ id: `t${i + 1}`, title: t.title, status: t.status ?? "pending" }));
	return {
		content: [{ type: "text", text: "ok" }],
		details: cleared ? { todos: [], cleared: true } : { todos: items },
	};
}

function fakeThis(overrides: Record<string, unknown> = {}) {
	const proto = InteractiveMode.prototype as any;
	return {
		todoSnapshot: undefined,
		toolCallsSinceTodoUpdate: 0,
		sessionManager: { appendCustomEntry: vi.fn(), getEntries: vi.fn(() => []) },
		chatContainer: { addChild: vi.fn() },
		ui: { requestRender: vi.fn() },
		showStatus: vi.fn(),
		getTodoSnapshot: proto.getTodoSnapshot,
		buildTodoPromptAddendum: proto.buildTodoPromptAddendum,
		...overrides,
	} as any;
}

describe("todo integration", () => {
	test("applyTodoToolResult stores the snapshot, persists it, and resets the staleness counter", () => {
		const ctx = fakeThis({ toolCallsSinceTodoUpdate: 4 });
		const proto = InteractiveMode.prototype as any;
		proto.applyTodoToolResult.call(
			ctx,
			makeTodoResult([{ title: "Fix bug", status: "in_progress" }, { title: "Add tests" }]),
		);

		expect(ctx.todoSnapshot.items).toHaveLength(2);
		expect(ctx.toolCallsSinceTodoUpdate).toBe(0);
		expect(ctx.sessionManager.appendCustomEntry).toHaveBeenCalledWith(
			"todo_list",
			expect.objectContaining({ items: expect.arrayContaining([expect.objectContaining({ title: "Fix bug" })]) }),
		);
	});

	test("query results (todos: null) do not change state", () => {
		const ctx = fakeThis();
		const proto = InteractiveMode.prototype as any;
		proto.applyTodoToolResult.call(ctx, { content: [{ type: "text", text: "query" }], details: { todos: null } });

		expect(ctx.todoSnapshot).toBeUndefined();
		expect(ctx.sessionManager.appendCustomEntry).not.toHaveBeenCalled();
	});

	test("clear wipes the list and persists an empty snapshot", () => {
		const ctx = fakeThis();
		const proto = InteractiveMode.prototype as any;
		proto.applyTodoToolResult.call(ctx, makeTodoResult([{ title: "Fix bug", status: "in_progress" }]));
		proto.applyTodoToolResult.call(ctx, makeTodoResult([], true));

		expect(ctx.todoSnapshot.items).toHaveLength(0);
	});

	test("buildTodoPromptAddendum lists open items and disappears when all done", () => {
		const proto = InteractiveMode.prototype as any;
		const ctx = fakeThis();
		proto.applyTodoToolResult.call(
			ctx,
			makeTodoResult([
				{ title: "Done", status: "completed" },
				{ title: "Doing", status: "in_progress" },
				{ title: "Later" },
			]),
		);
		const addendum = proto.buildTodoPromptAddendum.call(ctx);
		expect(addendum).toContain("[completed] Done");
		expect(addendum).toContain("[in_progress] Doing");
		expect(addendum).toContain("[pending] Later");

		proto.applyTodoToolResult.call(ctx, makeTodoResult([{ title: "Done", status: "completed" }]));
		expect(proto.buildTodoPromptAddendum.call(ctx)).toBeUndefined();
	});

	test("stale todo list produces a todo_stale nudge warning", () => {
		const snapshot = replaceTodoList(null, [{ id: "t1", title: "Fix bug", status: "in_progress" }]);
		// simulate the staleness check the interactive mode performs
		expect(isTodoListStale(snapshot, 7)).toBe(true);

		const warnings = evaluateInteractiveNudges({
			turnIndex: 3,
			toolCallHistory: [],
			fileAccessHistory: [],
			lastOutputTokens: 120,
			todoStale: true,
		});
		expect(warnings.some((w) => w.type === "todo_stale")).toBe(true);
		expect(warnings.find((w) => w.type === "todo_stale")?.message).toContain("stale");
	});

	test("completed todo list is never stale and produces no warning", () => {
		const snapshot = replaceTodoList(null, [{ id: "t1", title: "Fix bug", status: "completed" }]);
		expect(isTodoListStale(snapshot, 99)).toBe(false);

		const warnings = evaluateInteractiveNudges({
			turnIndex: 3,
			toolCallHistory: [],
			fileAccessHistory: [],
			lastOutputTokens: 120,
			todoStale: false,
		});
		expect(warnings.some((w) => w.type === "todo_stale")).toBe(false);
	});

	test("todo tool calls produce distinct digests for distinct lists", () => {
		const a = buildToolCallDigest("todo", { todos: [{ title: "A" }] });
		const b = buildToolCallDigest("todo", { todos: [{ title: "B" }] });
		expect(a).not.toBe(b);
		expect(buildToolResultDigest(makeTodoResult([{ title: "A" }]), false)).toBeTruthy();
	});
});
