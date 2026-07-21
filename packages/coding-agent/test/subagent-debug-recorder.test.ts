/**
 * Subagent debug recorder tests.
 *
 * Covers the full-run visibility contract:
 * - The recorder writes session.md / session.compact.md / timeline.json into
 *   `Debug/subagent_<datetime>_<type>_<model>/` in the same readable style as
 *   the parent session logger.
 * - Tool calls appear as one-liners (✓/✗, duration, size / exit code) with
 *   bounded, redacted output previews.
 * - finish() writes an outcome section, is idempotent, and returns undefined
 *   when the debug dir cannot be created (recorder becomes a no-op).
 * - runSubagent forwards every raw AgentEvent to options.onEvent.
 * - The task tool wires the recorder: recordTaskEntry payload and tool-result
 *   details carry the debugLog ref.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, StreamFn } from "@ag1/agent-core";
import type { Model } from "@ag1/ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelRegistry } from "../src/core/model-registry.js";
import { createSubagentDebugRecorder } from "../src/core/subagent-debug-recorder.js";
import { runSubagent, type SubagentResult, type SubagentRunnerDeps } from "../src/core/subagent-runner.js";
import { createTaskToolDefinition, type TaskToolDeps } from "../src/core/tools/task.js";
import { createFauxStreamFn, fauxModel } from "./test-harness.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ag1-subagent-debug-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

// ============================================================================
// Fake events / results
// ============================================================================

function userMessage(text: string) {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantMessage(text: string, usage = { input: 100, output: 50, totalTokens: 150 }) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: usage.totalTokens,
			cost: { total: 0.001 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function toolResultMessage() {
	return {
		role: "toolResult",
		toolCallId: "tc1",
		toolName: "read",
		content: [{ type: "text", text: "ok" }],
		timestamp: Date.now(),
	};
}

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz123456";

/** One scripted turn: prompt in, assistant text, one ✓ read, one ✗ bash. */
function scriptedEvents(): AgentEvent[] {
	return [
		{ type: "agent_start" },
		{ type: "turn_start" },
		{ type: "message_start", message: userMessage("Find the config file.") },
		{ type: "message_end", message: userMessage("Find the config file.") },
		{ type: "message_start", message: assistantMessage("Let me look.") },
		{
			type: "message_update",
			message: assistantMessage("Let me look."),
			assistantMessageEvent: { type: "text_delta", delta: "Let me look." },
		} as unknown as AgentEvent,
		{ type: "message_end", message: assistantMessage("Let me look.") },
		{ type: "tool_execution_start", toolCallId: "tc1", toolName: "read", args: { path: "src/a.ts" } },
		{
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "read",
			result: { content: [{ type: "text", text: `file contents\napi key: ${SECRET}` }] },
			isError: false,
		},
		{ type: "tool_execution_start", toolCallId: "tc2", toolName: "bash", args: { command: "npm test" } },
		{
			type: "tool_execution_end",
			toolCallId: "tc2",
			toolName: "bash",
			result: { content: [{ type: "text", text: "1 failing\n\nCommand exited with code 1" }] },
			isError: true,
		},
		{ type: "message_start", message: toolResultMessage() },
		{ type: "message_end", message: toolResultMessage() },
		{ type: "turn_end", message: assistantMessage("Let me look."), toolResults: [toolResultMessage()] },
		{ type: "agent_end", messages: [] },
	] as AgentEvent[];
}

function fakeResult(overrides: Partial<SubagentResult> = {}): SubagentResult {
	return {
		state: "completed",
		type: "explore",
		description: "inspect files",
		model: "faux/faux-1",
		summary: "Found the config file at src/a.ts.",
		partial: false,
		evidence: [{ kind: "bash", command: "npm test", exitCode: 1 }],
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: 0.001 },
		turns: 1,
		durationMs: 1_234,
		...overrides,
	};
}

// ============================================================================
// Recorder behavior
// ============================================================================

describe("createSubagentDebugRecorder", () => {
	it("creates a debug dir with the expected name shape", () => {
		const cwd = makeTempDir();
		const recorder = createSubagentDebugRecorder({
			cwd,
			type: "explore",
			description: "inspect files",
			model: "faux/faux-1",
			toolCallId: "tc-parent-1",
		});
		const ref = recorder.finish(fakeResult());
		expect(ref).toBeDefined();
		expect(ref!.logRef).toMatch(/^subagent_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_explore_faux_faux-1$/);
		expect(ref!.logDir).toBe(join(cwd, "Debug", ref!.logRef));
		expect(existsSync(join(ref!.logDir, "session.md"))).toBe(true);
		expect(existsSync(join(ref!.logDir, "session.compact.md"))).toBe(true);
		expect(existsSync(join(ref!.logDir, "timeline.json"))).toBe(true);
	});

	it("writes header, tool lines, and outcome section to session.md", () => {
		const cwd = makeTempDir();
		const recorder = createSubagentDebugRecorder({
			cwd,
			type: "explore",
			description: "inspect files",
			model: "faux/faux-1",
			toolCallId: "tc-parent-1",
		});
		for (const event of scriptedEvents()) recorder.handleEvent(event);
		const ref = recorder.finish(fakeResult());
		expect(ref).toBeDefined();

		const sessionMd = readFileSync(join(ref!.logDir, "session.md"), "utf8");
		// Header fields
		expect(sessionMd).toContain("| Type | explore |");
		expect(sessionMd).toContain("| Description | inspect files |");
		expect(sessionMd).toContain("| Model | faux/faux-1 |");
		expect(sessionMd).toContain("| Parent Tool Call | tc-parent-1 |");
		// Turn + tool lines
		expect(sessionMd).toContain("## Turn 1");
		expect(sessionMd).toContain("✓ read src/a.ts");
		expect(sessionMd).toMatch(/✗ bash npm test · \d+ms · exit 1/);
		// Secrets never hit disk
		expect(sessionMd).not.toContain(SECRET);
		expect(sessionMd).toContain("[REDACTED]");
		// Outcome section
		expect(sessionMd).toContain("## Outcome");
		expect(sessionMd).toContain("| State | completed |");
		expect(sessionMd).toContain("| Turns | 1 |");
		expect(sessionMd).toContain("Found the config file at src/a.ts.");
	});

	it("records every event in timeline.json as typed entries", () => {
		const cwd = makeTempDir();
		const recorder = createSubagentDebugRecorder({
			cwd,
			type: "verify",
			description: "run checks",
			model: "auto",
		});
		for (const event of scriptedEvents()) recorder.handleEvent(event);
		const ref = recorder.finish(fakeResult({ type: "verify", model: "auto" }));

		const timeline = JSON.parse(readFileSync(join(ref!.logDir, "timeline.json"), "utf8")) as Array<{
			type: string;
			phase?: string;
			tool?: string;
		}>;
		expect(Array.isArray(timeline)).toBe(true);
		const types = timeline.map((entry) => entry.type);
		expect(types).toContain("run_start");
		expect(types).toContain("agent");
		expect(types).toContain("turn");
		expect(types).toContain("message");
		expect(types).toContain("tool_call");
		expect(types).toContain("tool_result");
		expect(types).toContain("outcome");
		// The scripted run has exactly one tool call + one tool result.
		expect(timeline.filter((entry) => entry.type === "tool_call" && !entry.phase)).toHaveLength(2);
		expect(timeline.filter((entry) => entry.type === "tool_result")).toHaveLength(2);
		// Streaming updates are recorded too (buffered, flushed at finish).
		expect(timeline.some((entry) => entry.type === "message" && entry.phase === "update")).toBe(true);
	});

	it("finish is idempotent and returns the same ref", () => {
		const cwd = makeTempDir();
		const recorder = createSubagentDebugRecorder({
			cwd,
			type: "explore",
			description: "inspect files",
			model: "faux/faux-1",
		});
		for (const event of scriptedEvents()) recorder.handleEvent(event);
		const first = recorder.finish(fakeResult());
		const second = recorder.finish(fakeResult());
		expect(first).toEqual(second);
		const sessionMd = readFileSync(join(first!.logDir, "session.md"), "utf8");
		expect(sessionMd.match(/## Outcome/g)).toHaveLength(1);
		// Events after finish are ignored.
		recorder.handleEvent({ type: "agent_start" });
		const timeline = JSON.parse(readFileSync(join(first!.logDir, "timeline.json"), "utf8")) as unknown[];
		expect(timeline.filter((entry) => (entry as { type: string }).type === "agent")).toHaveLength(2); // start + end from script
	});

	it("becomes a no-op when the debug dir cannot be created", () => {
		const cwd = makeTempDir();
		// A regular file where the Debug dir would need to descend into.
		const blocker = join(cwd, "blocked");
		writeFileSync(blocker, "not a directory");
		const recorder = createSubagentDebugRecorder({
			cwd: blocker,
			type: "explore",
			description: "inspect files",
			model: "faux/faux-1",
		});
		// handleEvent must not throw.
		expect(() => {
			for (const event of scriptedEvents()) recorder.handleEvent(event);
		}).not.toThrow();
		expect(recorder.finish(fakeResult())).toBeUndefined();
	});

	it("honors projectRoot over cwd for the Debug root", () => {
		const cwd = makeTempDir();
		const projectRoot = makeTempDir();
		const recorder = createSubagentDebugRecorder({
			cwd,
			projectRoot,
			type: "plan",
			description: "make a plan",
			model: "auto",
		});
		const ref = recorder.finish(fakeResult({ type: "plan", model: "auto" }));
		expect(ref).toBeDefined();
		expect(ref!.logDir).toBe(join(projectRoot, "Debug", ref!.logRef));
		expect(existsSync(join(cwd, "Debug"))).toBe(false);
	});
});

// ============================================================================
// Runner onEvent forwarding
// ============================================================================

function stubModelRegistry(models: Model<any>[]): ModelRegistry {
	return {
		find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
		getAvailable: () => models,
		hasConfiguredAuth: () => true,
	} as unknown as ModelRegistry;
}

function makeDeps(streamFn: StreamFn, cwd: string): SubagentRunnerDeps {
	return {
		cwd,
		modelRegistry: stubModelRegistry([fauxModel]),
		getParentModel: () => fauxModel,
		streamFnFactory: () => streamFn,
	};
}

describe("runSubagent onEvent hook", () => {
	it("forwards every raw agent event to options.onEvent", async () => {
		const cwd = makeTempDir();
		writeFileSync(join(cwd, "note.txt"), "hello\n");
		const { streamFn } = createFauxStreamFn([
			{ toolCalls: [{ name: "read", args: { path: "note.txt" } }] },
			{ text: "done reading" },
		]);
		const events: AgentEvent[] = [];
		const result = await runSubagent(
			makeDeps(streamFn, cwd),
			{ description: "read a file", type: "explore", prompt: "Read note.txt." },
			{ onEvent: (event) => events.push(event) },
		);
		expect(result.state).toBe("completed");

		const types = new Set(events.map((event) => event.type));
		for (const expected of [
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
			"turn_end",
			"agent_end",
		]) {
			expect(types.has(expected as AgentEvent["type"]), expected).toBe(true);
		}
		// The read tool execution flowed through with its args and result.
		const toolStart = events.find((event) => event.type === "tool_execution_start");
		expect(toolStart).toMatchObject({ toolName: "read", args: { path: "note.txt" } });
		const toolEnd = events.find((event) => event.type === "tool_execution_end");
		expect(toolEnd).toMatchObject({ toolName: "read", isError: false });
	});

	it("a throwing observer does not disturb the run", async () => {
		const cwd = makeTempDir();
		const { streamFn } = createFauxStreamFn([{ text: "still fine" }]);
		const result = await runSubagent(
			makeDeps(streamFn, cwd),
			{ description: "observer throws", type: "explore", prompt: "Hi." },
			{
				onEvent: () => {
					throw new Error("observer bug");
				},
			},
		);
		expect(result.state).toBe("completed");
		expect(result.summary).toBe("still fine");
	});
});

// ============================================================================
// task tool wiring
// ============================================================================

describe("task tool debug wiring", () => {
	it("records a full debug log and links it in the entry payload and details", async () => {
		const cwd = makeTempDir();
		writeFileSync(join(cwd, "note.txt"), "hello\n");
		const { streamFn } = createFauxStreamFn([
			{ toolCalls: [{ name: "read", args: { path: "note.txt" } }] },
			{ text: "done reading" },
		]);
		const entries: Array<Record<string, unknown>> = [];
		const deps = {
			cwd,
			modelRegistry: stubModelRegistry([fauxModel]),
			getParentModel: () => fauxModel,
			recordTaskEntry: (data: Record<string, unknown>) => entries.push(data),
			streamFnFactory: () => streamFn,
		} as unknown as TaskToolDeps;

		const tool = createTaskToolDefinition(deps);
		const result = await tool.execute(
			"tc-parent-9",
			{ description: "read a file", type: "explore", prompt: "Read note.txt.", model: "faux/faux-1" },
			undefined,
			undefined,
			{} as never,
		);

		const debugLog = result.details?.debugLog;
		expect(debugLog).toMatch(/^subagent_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_explore_faux_faux-1$/);
		// Same ref lands in the session journal entry payload.
		expect(entries).toHaveLength(1);
		expect(entries[0].debugLog).toBe(debugLog);
		// The rest of the entry payload shape is unchanged.
		expect(entries[0]).toMatchObject({ description: "read a file", type: "explore", state: "completed" });

		// The linked directory holds the full run.
		const logDir = join(cwd, "Debug", debugLog!);
		const sessionMd = readFileSync(join(logDir, "session.md"), "utf8");
		expect(sessionMd).toContain("| Parent Tool Call | tc-parent-9 |");
		expect(sessionMd).toContain("✓ read note.txt");
		expect(sessionMd).toContain("## Outcome");
		const timeline = JSON.parse(readFileSync(join(logDir, "timeline.json"), "utf8")) as unknown[];
		expect(timeline.length).toBeGreaterThan(0);
	});
});
