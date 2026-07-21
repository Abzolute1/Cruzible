import type { SessionEntry, SessionManager } from "./session-manager.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
	id: string;
	title: string;
	status: TodoStatus;
}

export interface TodoListSnapshot {
	version: 1;
	items: TodoItem[];
	/** Epoch milliseconds of the last update. */
	updatedAt: number;
}

export type TodoValidationResult = { ok: true; items: TodoItem[] } | { ok: false; error: string };

export interface TodoSummary {
	total: number;
	completed: number;
	inProgressTitle: string | null;
}

/** Journal customType used to persist todo list snapshots in the session. */
export const TODO_JOURNAL_TYPE = "todo_list";
/** Tool calls without a todo update after which the list is considered stale. */
export const TODO_STALE_CALL_THRESHOLD = 6;
/** Maximum number of items allowed in the todo list. */
export const TODO_MAX_ITEMS = 50;

const TODO_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

function normalizeTitle(title: string): string {
	return title.trim().replace(/\s+/g, " ");
}

function assignId(index: number, rawId: unknown, usedIds: Set<string>): string {
	const explicit = typeof rawId === "string" ? rawId.trim() : "";
	if (explicit && !usedIds.has(explicit)) return explicit;
	let n = index + 1;
	while (usedIds.has(`t${n}`)) n++;
	return `t${n}`;
}

/**
 * Validate and normalize a model-provided todo list.
 * Trims and collapses title whitespace, defaults missing status to "pending",
 * assigns stable ids (t1..tn) to missing or duplicate ids, and enforces
 * that at most one item is in_progress.
 */
export function validateTodoItems(input: unknown): TodoValidationResult {
	if (!Array.isArray(input)) {
		return { ok: false, error: "todos must be an array of items like [{ title, status }]." };
	}
	if (input.length > TODO_MAX_ITEMS) {
		return {
			ok: false,
			error: `Too many todos (${input.length}). Keep the list to ${TODO_MAX_ITEMS} items or fewer; remove or merge items.`,
		};
	}

	const items: TodoItem[] = [];
	const usedIds = new Set<string>();
	let inProgressCount = 0;
	for (let i = 0; i < input.length; i++) {
		const raw = input[i] as { id?: unknown; title?: unknown; status?: unknown } | null;
		if (!raw || typeof raw !== "object") {
			return { ok: false, error: `Todo item ${i + 1} must be an object with a title.` };
		}
		if (typeof raw.title !== "string" || !normalizeTitle(raw.title)) {
			return { ok: false, error: `Todo item ${i + 1} has an empty title. Provide a short imperative title.` };
		}
		const title = normalizeTitle(raw.title);

		let status: TodoStatus = "pending";
		if (raw.status !== undefined && raw.status !== null) {
			if (typeof raw.status !== "string" || !TODO_STATUSES.has(raw.status)) {
				return {
					ok: false,
					error: `Todo item ${i + 1} ("${title}") has invalid status ${JSON.stringify(raw.status)}. Use "pending", "in_progress", or "completed".`,
				};
			}
			status = raw.status as TodoStatus;
		}
		if (status === "in_progress") inProgressCount++;

		const id = assignId(i, raw.id, usedIds);
		usedIds.add(id);
		items.push({ id, title, status });
	}

	if (inProgressCount > 1) {
		return {
			ok: false,
			error: "Only one todo may be in_progress at a time. Mark the others pending or completed.",
		};
	}
	return { ok: true, items };
}

/** Replace the whole list with already-validated items, returning a new snapshot. */
export function replaceTodoList(
	_current: TodoListSnapshot | null,
	items: TodoItem[],
	now = Date.now(),
): TodoListSnapshot {
	return { version: 1, items: items.map((item) => ({ ...item })), updatedAt: now };
}

/** Wipe the list, returning an empty snapshot. */
export function clearTodoList(now = Date.now()): TodoListSnapshot {
	return { version: 1, items: [], updatedAt: now };
}

/** Persist a snapshot to the session journal. Returns the entry id. */
export function appendTodoSnapshot(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	snapshot: TodoListSnapshot,
): string {
	return sessionManager.appendCustomEntry(TODO_JOURNAL_TYPE, snapshot);
}

function parseTodoSnapshot(data: unknown): TodoListSnapshot | null {
	if (!data || typeof data !== "object") return null;
	const candidate = data as Partial<TodoListSnapshot>;
	if (candidate.version !== 1 || typeof candidate.updatedAt !== "number") return null;
	const validation = validateTodoItems(candidate.items);
	if (!validation.ok) return null;
	return { version: 1, items: validation.items, updatedAt: candidate.updatedAt };
}

/** Reconstruct the latest todo snapshot from journal entries, scanning backwards. */
export function readLatestTodoSnapshot(entries: readonly SessionEntry[]): TodoListSnapshot | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== TODO_JOURNAL_TYPE) continue;
		const snapshot = parseTodoSnapshot(entry.data);
		if (snapshot) return snapshot;
	}
	return null;
}

/**
 * True when the list still has open work but has not been touched for
 * TODO_STALE_CALL_THRESHOLD tool calls (a nudge signal for the model).
 */
export function isTodoListStale(snapshot: TodoListSnapshot | null, toolCallsSinceUpdate: number): boolean {
	if (!snapshot) return false;
	if (!snapshot.items.some((item) => item.status !== "completed")) return false;
	return toolCallsSinceUpdate >= TODO_STALE_CALL_THRESHOLD;
}

/** Compact progress summary of a snapshot. */
export function summarizeTodos(snapshot: TodoListSnapshot | null): TodoSummary {
	if (!snapshot) return { total: 0, completed: 0, inProgressTitle: null };
	const completed = snapshot.items.filter((item) => item.status === "completed").length;
	const inProgress = snapshot.items.find((item) => item.status === "in_progress");
	return { total: snapshot.items.length, completed, inProgressTitle: inProgress?.title ?? null };
}
