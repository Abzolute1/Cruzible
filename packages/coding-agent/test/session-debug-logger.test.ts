import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.js";
import { SessionDebugLogger } from "../src/core/session-debug-logger.js";
import type { SessionEntry } from "../src/core/session-manager.js";

function createStubSession(): AgentSession {
	return {
		model: {
			provider: "local",
			id: "lm-studio",
			name: "LM Studio",
		},
		contextWindow: 50000,
		thinkingLevel: "medium",
		sessionManager: {
			getCwd: () => "/tmp/project",
			getSessionId: () => "session-123",
			getSessionName: () => "test session",
		},
		getActiveToolNames: () => ["read", "bash"],
		subscribe: () => () => {},
	} as unknown as AgentSession;
}

// ---------------------------------------------------------------------------
// Fake session harness — captures the event listener and journal hook so
// tests can drive turns, tool calls, and custom entries through the logger.
// ---------------------------------------------------------------------------

interface FakeSession {
	session: AgentSession;
	emit: (event: AgentSessionEvent) => void;
	appendCustomEntry: (customType: string, data: unknown) => void;
	setActiveTools: (tools: string[]) => void;
	setVisionVerdict: (verdict: "yes" | "no" | undefined) => void;
	entries: SessionEntry[];
}

function createFakeSession(options?: { entries?: SessionEntry[]; usage?: boolean }): FakeSession {
	let listener: ((event: AgentSessionEvent) => void) | null = null;
	const entryListeners: Array<(entry: SessionEntry) => void> = [];
	const entries: SessionEntry[] = options?.entries ?? [];
	let activeTools = ["read", "bash", "edit"];
	let visionVerdict: "yes" | "no" | undefined;

	if (options?.usage) {
		entries.push({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				usage: { input: 8412, output: 1204, cacheRead: 0, cacheWrite: 0, cost: { total: 0.012 } },
			},
		} as unknown as SessionEntry);
	}

	const session = {
		model: { provider: "local", id: "lm-studio", name: "LM Studio" },
		contextWindow: 50000,
		thinkingLevel: "medium",
		sessionManager: {
			getCwd: () => "/tmp/project",
			getSessionId: () => "session-123",
			getSessionName: () => "test session",
			getEntries: () => entries,
			onEntryAppended: (cb: (entry: SessionEntry) => void) => {
				entryListeners.push(cb);
				return () => {
					const index = entryListeners.indexOf(cb);
					if (index >= 0) entryListeners.splice(index, 1);
				};
			},
		},
		getActiveToolNames: () => activeTools,
		getContextUsage: () => ({ percent: 71 }),
		getVisionVerdict: () => visionVerdict,
		subscribe: (cb: (event: AgentSessionEvent) => void) => {
			listener = cb;
			return () => {
				listener = null;
			};
		},
	} as unknown as AgentSession;

	return {
		session,
		emit: (event) => listener?.(event),
		appendCustomEntry: (customType, data) => {
			const entry = {
				type: "custom",
				customType,
				data,
				id: `c${entries.length + 1}`,
				parentId: null,
				timestamp: new Date().toISOString(),
			} as unknown as SessionEntry;
			entries.push(entry);
			for (const cb of entryListeners) cb(entry);
		},
		setActiveTools: (tools) => {
			activeTools = tools;
		},
		setVisionVerdict: (verdict) => {
			visionVerdict = verdict;
		},
		entries,
	};
}

/** Run one full turn through the logger. */
function runTurn(fake: FakeSession, body?: () => void): void {
	fake.emit({ type: "agent_start" } as AgentSessionEvent);
	body?.();
	fake.emit({ type: "agent_end", stopReason: "stop" } as unknown as AgentSessionEvent);
}

function runToolCall(
	fake: FakeSession,
	toolName: string,
	args: Record<string, unknown>,
	result: unknown,
	isError = false,
): void {
	fake.emit({
		type: "tool_execution_start",
		toolName,
		toolCallId: `id-${toolName}`,
		args,
	} as unknown as AgentSessionEvent);
	fake.emit({
		type: "tool_execution_end",
		toolName,
		toolCallId: `id-${toolName}`,
		result,
		isError,
	} as unknown as AgentSessionEvent);
}

/** Wait for the logger's async write queue to drain. */
function flushWrites(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeTodoSnapshot(): unknown {
	return {
		version: 1,
		updatedAt: Date.now(),
		items: [
			{ id: "t1", title: "Fix auth", status: "in_progress" },
			{ id: "t2", title: "Add tests", status: "pending" },
			{ id: "t3", title: "Read docs", status: "completed" },
		],
	};
}

function makePlanArtifact(overrides: Record<string, unknown> = {}): unknown {
	return {
		version: 1,
		planId: "plan-1",
		revision: 2,
		status: "accepted",
		goal: "Ship the feature",
		assumptions: [],
		constraints: [],
		steps: ["one", "two", "three", "four", "five"],
		risks: [],
		verification: [],
		openQuestions: [],
		completedStepIndexes: [0, 1],
		rawPlan: "raw",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

describe("session-debug-logger", () => {
	const tempRoots: string[] = [];

	function makeLogger(fake: FakeSession): { logger: SessionDebugLogger; projectRoot: string } {
		const projectRoot = mkdtempSync(join(tmpdir(), "ag1-debug-root-"));
		tempRoots.push(projectRoot);
		const logger = new SessionDebugLogger({ session: fake.session, projectRoot });
		return { logger, projectRoot };
	}

	function readArtifacts(logger: SessionDebugLogger) {
		const artifacts = logger.getArtifacts();
		return {
			sessionMd: readFileSync(artifacts.sessionMd!, "utf8"),
			compactMd: readFileSync(artifacts.sessionCompactMd!, "utf8"),
			timeline: JSON.parse(readFileSync(artifacts.timelineJson!, "utf8")) as Array<Record<string, unknown>>,
		};
	}

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		for (const root of tempRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("writes debug artifacts under the provided project root with UTC time in the folder name", () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "ag1-debug-root-"));
		tempRoots.push(projectRoot);
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-13T22:49:15.000Z"));

		const logger = new SessionDebugLogger({
			session: createStubSession(),
			projectRoot,
		});

		logger.start();

		const artifacts = logger.getArtifacts();
		expect(artifacts.sessionDir).toBe(join(projectRoot, "Debug", "2026-04-13_22-49-15_local_lm-studio"));
		expect(existsSync(artifacts.sessionDir!)).toBe(true);
		expect(existsSync(artifacts.sessionMd!)).toBe(true);
		expect(readFileSync(artifacts.sessionMd!, "utf8")).toContain("2026-04-13 22:49:15 UTC");
	});

	test("adds a numeric suffix when the same timestamp/model directory already exists", () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "ag1-debug-root-"));
		tempRoots.push(projectRoot);
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-13T22:49:15.000Z"));

		const first = new SessionDebugLogger({
			session: createStubSession(),
			projectRoot,
		});
		first.start();

		const second = new SessionDebugLogger({
			session: createStubSession(),
			projectRoot,
		});
		second.start();

		expect(first.getArtifacts().sessionDir).toBe(join(projectRoot, "Debug", "2026-04-13_22-49-15_local_lm-studio"));
		expect(second.getArtifacts().sessionDir).toBe(
			join(projectRoot, "Debug", "2026-04-13_22-49-15_local_lm-studio-2"),
		);
	});

	test("names the directory like a built-in subagent log when AG1_DEBUG_SESSION_NAME is set", () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "ag1-debug-root-"));
		tempRoots.push(projectRoot);
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-13T22:49:15.000Z"));
		vi.stubEnv("AG1_DEBUG_SESSION_NAME", "code reviewer v2");

		const logger = new SessionDebugLogger({
			session: createStubSession(),
			projectRoot,
		});
		logger.start();

		expect(logger.getArtifacts().sessionDir).toBe(
			join(projectRoot, "Debug", "subagent_2026-04-13_22-49-15_codereviewerv2_local_lm-studio"),
		);
	});

	test("emits custom_entry timeline events and a Journal section for journal entries", async () => {
		const fake = createFakeSession();
		const { logger } = makeLogger(fake);
		logger.start();

		fake.appendCustomEntry("todo_list", makeTodoSnapshot());
		fake.appendCustomEntry("interactive_plan_artifact", makePlanArtifact());
		fake.appendCustomEntry("ag1.subagent_task", {
			type: "implement",
			state: "completed",
			usage: { totalTokens: 11012 },
		});
		fake.appendCustomEntry("some_extension_state", { foo: "bar" });

		runTurn(fake);
		logger.dispose();
		await flushWrites();

		const { sessionMd, timeline } = readArtifacts(logger);
		const customEvents = timeline.filter((e) => e.type === "custom_entry");
		expect(customEvents).toHaveLength(4);
		expect(customEvents[0]).toMatchObject({
			customType: "todo_list",
			summary: "todos 1/3 · in progress: Fix auth",
		});
		expect(customEvents[1]).toMatchObject({
			customType: "interactive_plan_artifact",
			summary: "plan v2 accepted · 5 steps · 2/5 done",
		});
		expect(customEvents[2]).toMatchObject({
			customType: "ag1.subagent_task",
			summary: "task implement · completed · 11,012 tok",
		});
		expect(customEvents[3]).toMatchObject({
			customType: "some_extension_state",
			summary: '{"foo":"bar"}',
		});

		expect(sessionMd).toContain("## Journal");
		expect(sessionMd).toMatch(/- \d{2}:\d{2}:\d{2}Z · todo_list · todos 1\/3 · in progress: Fix auth/);
		expect(sessionMd).toContain("interactive_plan_artifact · plan v2 accepted · 5 steps · 2/5 done");
	});

	test("emits a state_snapshot per turn with todos, plan, tools, and context", async () => {
		const fake = createFakeSession();
		const { logger } = makeLogger(fake);
		logger.start();

		fake.appendCustomEntry("todo_list", makeTodoSnapshot());
		fake.appendCustomEntry("interactive_plan_artifact", makePlanArtifact());
		runTurn(fake);
		logger.dispose();
		await flushWrites();

		const { sessionMd, timeline } = readArtifacts(logger);
		const snapshot = timeline.find((e) => e.type === "state_snapshot");
		expect(snapshot).toBeDefined();
		expect(snapshot).toMatchObject({
			turn: 1,
			thinkingLevel: "medium",
			contextPercent: 71,
			activeTools: ["read", "bash", "edit"],
			model: { provider: "local", id: "lm-studio" },
		});
		expect(snapshot?.todos).toEqual({ total: 3, completed: 1, inProgressTitle: "Fix auth" });
		expect(snapshot?.plan).toMatchObject({ revision: 2, status: "accepted", steps: 5, completedSteps: 2 });

		expect(sessionMd).toContain("state: todos 1/3 in:Fix auth · plan v2 accepted · tools 3 · ctx 71%");
	});

	test("emits tools_changed when the active tool set changes between turns", async () => {
		const fake = createFakeSession();
		const { logger } = makeLogger(fake);
		logger.start();

		runTurn(fake);
		fake.setActiveTools(["read", "bash", "edit", "verify_ui"]);
		runTurn(fake);
		logger.dispose();
		await flushWrites();

		const { sessionMd, timeline } = readArtifacts(logger);
		const changed = timeline.filter((e) => e.type === "tools_changed");
		expect(changed).toHaveLength(1);
		expect(changed[0]).toMatchObject({ turn: 2, added: ["verify_ui"], removed: [] });
		expect(sessionMd).toContain("⚑ tools changed: +verify_ui");
	});

	test("emits nudge_fired for session nudge events and nudge_resolved once the condition clears", async () => {
		const fake = createFakeSession();
		const { logger } = makeLogger(fake);
		logger.start();

		runTurn(fake, () => {
			fake.emit({
				type: "nudge",
				nudgeType: "verify_ui_missing",
				message: "Frontend changed without visual verification.",
				shouldStop: false,
			} as unknown as AgentSessionEvent);
		});
		runTurn(fake); // no nudges in this turn's evaluation → resolution
		logger.dispose();
		await flushWrites();

		const { sessionMd, timeline } = readArtifacts(logger);
		const fired = timeline.filter((e) => e.type === "nudge_fired");
		expect(fired).toHaveLength(1);
		expect(fired[0]).toMatchObject({ turn: 1, nudgeType: "verify_ui_missing" });

		const resolved = timeline.filter((e) => e.type === "nudge_resolved");
		expect(resolved).toHaveLength(1);
		expect(resolved[0]).toMatchObject({ turn: 2, nudgeType: "verify_ui_missing", turnsToResolve: 1 });

		expect(sessionMd).toContain("⚑ nudge fired (verify_ui_missing): Frontend changed without visual verification.");
		expect(sessionMd).toContain("⚑ nudge resolved (verify_ui_missing) after 1 turn(s)");
	});

	test("emits retry, stall, and vision_verdict harness events", async () => {
		const fake = createFakeSession();
		const { logger } = makeLogger(fake);
		logger.start();

		fake.setVisionVerdict("yes");
		runTurn(fake, () => {
			fake.emit({
				type: "auto_retry_start",
				attempt: 2,
				maxAttempts: 3,
				delayMs: 4000,
				errorMessage: "rate limited",
			} as unknown as AgentSessionEvent);
			fake.emit({
				type: "degraded_turn",
				severity: "elevated",
				stopReason: "length",
				outputTokens: 9000,
				textLength: 20000,
				reasons: ["high_output_tokens"],
			} as unknown as AgentSessionEvent);
		});
		logger.dispose();
		await flushWrites();

		const { sessionMd, timeline } = readArtifacts(logger);
		expect(timeline.find((e) => e.type === "retry")).toMatchObject({ attempt: 2, maxAttempts: 3 });
		expect(timeline.find((e) => e.type === "stall")).toMatchObject({ severity: "elevated" });
		expect(timeline.find((e) => e.type === "vision_verdict")).toMatchObject({ verdict: "yes" });

		expect(sessionMd).toContain("⚑ retry attempt 2/3: rate limited");
		expect(sessionMd).toContain("⚑ stall: degraded turn (elevated) — high_output_tokens");
		expect(sessionMd).toContain("⚑ vision verdict: yes");
	});

	test("writes the session outcome record with derived metrics and tool totals", async () => {
		const fake = createFakeSession({ usage: true });
		const { logger } = makeLogger(fake);
		logger.start();

		fake.appendCustomEntry("todo_list", makeTodoSnapshot());
		runTurn(fake, () => {
			runToolCall(fake, "read", { path: "src/a.ts" }, { content: [{ type: "text", text: "file contents" }] });
			runToolCall(
				fake,
				"edit",
				{ path: "src/b.ts" },
				{ content: [{ type: "text", text: "Could not find the exact text" }] },
				true,
			);
			runToolCall(
				fake,
				"verify_ui",
				{ claim: "button visible" },
				{
					content: [{ type: "text", text: "PASS: button is visible" }],
					details: { verdict: "PASS" },
				},
			);
		});
		logger.dispose();
		await flushWrites();

		const { sessionMd, compactMd, timeline } = readArtifacts(logger);

		// Outcome section
		expect(sessionMd).toContain("## Session Outcome");
		expect(sessionMd).toContain("| End reason | session closed |");
		expect(sessionMd).toContain("| Turns | 1 |");
		expect(sessionMd).toContain("| Total tokens | 8,412 in / 1,204 out |");
		expect(sessionMd).toContain("| Todos | 1/3 completed · pending: Fix auth, Add tests |");
		expect(sessionMd).toContain("| verify_ui | 1 pass · 0 fail · 0 unclear |");

		// Derived metrics + tool totals
		expect(sessionMd).toContain("## Derived Metrics");
		expect(sessionMd).toContain("## Tool Totals");
		expect(sessionMd).toMatch(/\| read \| 1 \| 0 \| \d+ms \| \d+/);
		expect(sessionMd).toMatch(/\| edit \| 1 \| 1 \| \d+ms \|/);
		expect(sessionMd).toMatch(/\| verify_ui \| 1 \| 0 \|/);

		// Compact outcome block
		expect(compactMd).toContain("## Outcome");
		expect(compactMd).toContain("end: session closed");
		expect(compactMd).toContain("todos: 1/3 completed");
		expect(compactMd).toContain("verify_ui: 1 pass · 0 fail · 0 unclear");

		// Final timeline events
		const outcome = timeline.find((e) => e.type === "outcome");
		expect(outcome).toMatchObject({ endReason: "session closed", turns: 1 });
		const metricsEvent = timeline.find((e) => e.type === "metrics");
		expect(metricsEvent).toBeDefined();
		const metrics = metricsEvent?.metrics as {
			turns: number;
			verifyUi: { pass: number };
			tools: Record<string, { calls: number }>;
		};
		expect(metrics.turns).toBe(1);
		expect(metrics.verifyUi.pass).toBe(1);
		expect(metrics.tools.edit.calls).toBe(1);
	});

	test("renders scannable turn blocks with one-line header and tool lines", async () => {
		const fake = createFakeSession({ usage: true });
		const { logger } = makeLogger(fake);
		logger.start();

		runTurn(fake, () => {
			runToolCall(fake, "read", { path: "src/a.ts" }, { content: [{ type: "text", text: "hello world" }] });
			runToolCall(
				fake,
				"edit",
				{ path: "src/b.ts" },
				{ content: [{ type: "text", text: "Could not find the exact text" }] },
				true,
			);
		});
		logger.dispose();
		await flushWrites();

		const { sessionMd } = readArtifacts(logger);
		expect(sessionMd).toMatch(
			/## Turn 1 · \d{2}:\d{2}:\d{2}Z · \d+[ms][ s]?\d*s? · in 8,412 \/ out 1,204 · ctx 71% · \$0\.012/,
		);
		expect(sessionMd).toMatch(/ {2}✓ read src\/a\.ts · \d+ms · \d+ B\n {4}↳ hello world/);
		expect(sessionMd).toMatch(/ {2}✗ edit src\/b\.ts · \d+ms · Could not find the exact text/);
	});

	test("segments one run into one turn block per turn_start (autonomous multi-round)", async () => {
		const fake = createFakeSession();
		const { logger } = makeLogger(fake);
		logger.start();

		// One run with three LLM round-trips, like an autonomous task with N rounds.
		fake.emit({ type: "agent_start" } as AgentSessionEvent);
		for (const toolName of ["read", "bash", "edit"]) {
			fake.emit({ type: "turn_start" } as AgentSessionEvent);
			runToolCall(fake, toolName, {}, { content: [{ type: "text", text: `${toolName} output` }] });
			fake.emit({
				type: "turn_end",
				message: { role: "assistant", stopReason: "toolUse" },
				toolResults: [],
			} as unknown as AgentSessionEvent);
		}
		fake.emit({ type: "agent_end", stopReason: "stop" } as unknown as AgentSessionEvent);
		logger.dispose();
		await flushWrites();

		const { sessionMd, compactMd, timeline } = readArtifacts(logger);

		// Three turn blocks, in order
		expect(sessionMd).toContain("## Turn 1 ·");
		expect(sessionMd).toContain("## Turn 2 ·");
		expect(sessionMd).toContain("## Turn 3 ·");
		expect(sessionMd).not.toContain("## Turn 4 ·");
		expect(sessionMd.indexOf("## Turn 1 ·")).toBeLessThan(sessionMd.indexOf("## Turn 2 ·"));
		expect(sessionMd.indexOf("## Turn 2 ·")).toBeLessThan(sessionMd.indexOf("## Turn 3 ·"));

		// One compact row per turn
		const compactRows = compactMd.match(/^ *\d+ \|/gm) ?? [];
		expect(compactRows).toHaveLength(3);

		// Timeline, footer, and derived metrics agree with the runner's round-trip count
		expect(timeline.filter((e) => e.type === "turn_start")).toHaveLength(3);
		expect(timeline.filter((e) => e.type === "turn_end")).toHaveLength(3);
		expect(timeline.find((e) => e.type === "session_end")).toMatchObject({ totalTurns: 3 });
		expect(sessionMd).toContain("| Turns | 3 |");
		const metricsEvent = timeline.find((e) => e.type === "metrics");
		expect((metricsEvent?.metrics as { turns: number }).turns).toBe(3);

		// Tool calls land in their own turn blocks
		expect(sessionMd).toMatch(/## Turn 1 ·[\s\S]*?✓ read/);
		expect(sessionMd).toMatch(/## Turn 2 ·[\s\S]*?✓ bash/);
		expect(sessionMd).toMatch(/## Turn 3 ·[\s\S]*?✓ edit/);
	});

	test("does not double-count when agent_start and turn_start both fire", async () => {
		const fake = createFakeSession();
		const { logger } = makeLogger(fake);
		logger.start();

		// Run 1: agent_start opens a fallback turn, the following turn_start adopts it.
		fake.emit({ type: "agent_start" } as AgentSessionEvent);
		fake.emit({ type: "turn_start" } as AgentSessionEvent);
		fake.emit({
			type: "turn_end",
			message: { role: "assistant", stopReason: "stop" },
			toolResults: [],
		} as unknown as AgentSessionEvent);
		fake.emit({ type: "agent_end", stopReason: "stop" } as unknown as AgentSessionEvent);

		// Run 2: agent_start only marks the boundary now; turn_start drives.
		fake.emit({ type: "agent_start" } as AgentSessionEvent);
		fake.emit({ type: "turn_start" } as AgentSessionEvent);
		fake.emit({
			type: "turn_end",
			message: { role: "assistant", stopReason: "stop" },
			toolResults: [],
		} as unknown as AgentSessionEvent);
		fake.emit({ type: "agent_end", stopReason: "stop" } as unknown as AgentSessionEvent);
		logger.dispose();
		await flushWrites();

		const { sessionMd, timeline } = readArtifacts(logger);
		expect(sessionMd).toContain("## Turn 1 ·");
		expect(sessionMd).toContain("## Turn 2 ·");
		expect(sessionMd).not.toContain("## Turn 3 ·");
		expect(timeline.filter((e) => e.type === "turn_start")).toHaveLength(2);
		expect(timeline.filter((e) => e.type === "turn_end")).toHaveLength(2);
		// The second run's agent_start leaves a run-boundary marker; the first did not.
		expect(timeline.filter((e) => e.type === "agent_start")).toHaveLength(1);
		expect(sessionMd).toContain("| Turns | 2 |");
	});

	test("falls back to agent_start counting when no turn events are emitted", async () => {
		const fake = createFakeSession();
		const { logger } = makeLogger(fake);
		logger.start();

		// Older path: two runs, agent events only.
		runTurn(fake);
		runTurn(fake);
		logger.dispose();
		await flushWrites();

		const { sessionMd, timeline } = readArtifacts(logger);
		expect(sessionMd).toContain("## Turn 1 ·");
		expect(sessionMd).toContain("## Turn 2 ·");
		expect(sessionMd).not.toContain("## Turn 3 ·");
		expect(timeline.filter((e) => e.type === "turn_start")).toHaveLength(2);
		expect(timeline.filter((e) => e.type === "turn_end")).toHaveLength(2);
		expect(timeline.filter((e) => e.type === "agent_start")).toHaveLength(0);
		expect(sessionMd).toContain("| Turns | 2 |");
	});

	test("interactive prompt with multiple tool rounds segments per LLM turn", async () => {
		const fake = createFakeSession();
		const { logger } = makeLogger(fake);
		logger.start();

		fake.emit({ type: "agent_start" } as AgentSessionEvent);
		fake.emit({ type: "turn_start" } as AgentSessionEvent);
		fake.emit({
			type: "message_start",
			role: "user",
			message: { role: "user", content: "fix the bug" },
		} as unknown as AgentSessionEvent);
		runToolCall(fake, "read", { path: "src/a.ts" }, { content: [{ type: "text", text: "src" }] });
		fake.emit({
			type: "turn_end",
			message: { role: "assistant", stopReason: "toolUse" },
			toolResults: [],
		} as unknown as AgentSessionEvent);
		fake.emit({ type: "turn_start" } as AgentSessionEvent);
		runToolCall(fake, "edit", { path: "src/a.ts" }, { content: [{ type: "text", text: "ok" }] });
		fake.emit({
			type: "turn_end",
			message: { role: "assistant", stopReason: "stop" },
			toolResults: [],
		} as unknown as AgentSessionEvent);
		fake.emit({ type: "agent_end", stopReason: "stop" } as unknown as AgentSessionEvent);
		logger.dispose();
		await flushWrites();

		const { sessionMd } = readArtifacts(logger);
		expect(sessionMd).toContain("## Turn 1 ·");
		expect(sessionMd).toContain("## Turn 2 ·");
		// User input belongs to turn 1; the edit belongs to turn 2.
		expect(sessionMd).toMatch(/## Turn 1 ·[\s\S]*?\*\*Input:\*\* "fix the bug"/);
		expect(sessionMd.indexOf('**Input:** "fix the bug"')).toBeLessThan(sessionMd.indexOf("## Turn 2 ·"));
		expect(sessionMd).toMatch(/## Turn 2 ·[\s\S]*?✓ edit src\/a\.ts/);
	});

	test("buffers steering messages that arrive between turns into the next turn block", async () => {
		const fake = createFakeSession();
		const { logger } = makeLogger(fake);
		logger.start();

		fake.emit({ type: "agent_start" } as AgentSessionEvent);
		fake.emit({ type: "turn_start" } as AgentSessionEvent);
		fake.emit({
			type: "turn_end",
			message: { role: "assistant", stopReason: "toolUse" },
			toolResults: [],
		} as unknown as AgentSessionEvent);
		// Steering arrives in the gap between turns.
		fake.emit({ type: "queue_update", steering: ["focus on tests"], followUp: [] } as unknown as AgentSessionEvent);
		fake.emit({ type: "turn_start" } as AgentSessionEvent);
		fake.emit({
			type: "turn_end",
			message: { role: "assistant", stopReason: "stop" },
			toolResults: [],
		} as unknown as AgentSessionEvent);
		fake.emit({ type: "agent_end", stopReason: "stop" } as unknown as AgentSessionEvent);
		logger.dispose();
		await flushWrites();

		const { sessionMd } = readArtifacts(logger);
		expect(sessionMd).toMatch(/## Turn 2 ·[\s\S]*?\*\*Steering Messages:\*\*\n- "focus on tests"/);
	});
});
