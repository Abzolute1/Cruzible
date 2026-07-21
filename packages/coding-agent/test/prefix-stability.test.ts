/**
 * Prefix-stability cache guard (regression harness).
 *
 * DeepSeek-style prefix caching only pays if the request prefix is byte-stable
 * across turns: the system prompt is the cacheable head of every request, and
 * the message history must grow append-only. This test drives a realistic
 * multi-turn AgentSession (faux provider, real session wiring, one tool call)
 * and asserts nothing in the prompt/tool-loop flow mutates the prefix
 * mid-session:
 *
 *  1. the system prompt is byte-identical before every LLM call — a per-turn
 *     addendum, when present, is appended AFTER the base prompt, so the cached
 *     prefix position never moves;
 *  2. the message history grows append-only — every prior message stays
 *     byte-identical at the same index in every later request;
 *  3. tool schema serialization is byte-identical across calls.
 *
 * Reference shape: reasonix internal/agent/cachehit_e2e_test.go, whose mock
 * endpoint derives cache hits from the byte-identical prefix shared with the
 * previous request. Here the stream function snapshots each LLM-bound context
 * at call time (deep serialization, so after-the-fact in-place mutation cannot
 * hide), which plays the same role. Self-contained: no network, no LM Studio.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTool } from "@ag1/agent-core";
import type { Context, Model, SimpleStreamOptions } from "@ag1/ai";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createFauxStreamFn, type FauxResponseInput, fauxModel } from "./test-harness.js";
import { createTestResourceLoader } from "./utilities.js";

/** Byte-level snapshot of one LLM-bound request context, taken at call time. */
interface LlmCallSnapshot {
	systemPrompt: string;
	/** Per-message JSON, so prefix equality can be checked element-wise. */
	messagesJson: string[];
	/** JSON of the serialized tool schemas sent with the request. */
	toolsJson: string;
}

interface PrefixGuardSession {
	session: AgentSession;
	calls: LlmCallSnapshot[];
	echoExecutions: () => number;
	cleanup: () => void;
}

/**
 * Wire a real AgentSession the way test-harness.ts does, but with a stream
 * function that deep-snapshots every LLM-bound context before delegating to
 * the shared faux provider.
 */
function createPrefixGuardSession(responses: FauxResponseInput[]): PrefixGuardSession {
	const tempDir = join(tmpdir(), `ag1-prefix-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const { streamFn: fauxStreamFn } = createFauxStreamFn(responses);
	const calls: LlmCallSnapshot[] = [];
	const streamFn = (model: Model<any>, context: Context, options?: SimpleStreamOptions) => {
		calls.push({
			systemPrompt: context.systemPrompt ?? "",
			messagesJson: context.messages.map((message) => JSON.stringify(message)),
			toolsJson: JSON.stringify(context.tools ?? []),
		});
		return fauxStreamFn(model, context, options);
	};

	// Trivial read-only tool driving the multi-step tool loop, like the echo
	// tool in the reasonix cache-hit e2e test.
	let executions = 0;
	const echoTool: AgentTool = {
		name: "echo",
		label: "Echo",
		description: "Echo back the given text",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_toolCallId, args) => {
			executions++;
			const { text } = args as { text: string };
			return { content: [{ type: "text", text: `echoed: ${text}` }], details: {} };
		},
	};

	const agent = new Agent({
		getApiKey: () => "faux-key",
		initialState: {
			model: fauxModel,
			// Replaced by the session's rebuilt prompt at construction time.
			systemPrompt: "You are a test assistant.",
			tools: [echoTool],
		},
		streamFn,
	});

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	authStorage.setRuntimeApiKey(fauxModel.provider, "faux-key");
	const modelRegistry = ModelRegistry.create(authStorage, tempDir);

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRegistry,
		resourceLoader: createTestResourceLoader(),
		baseToolsOverride: { echo: echoTool },
	});
	session.subscribe(() => {});

	return {
		session,
		calls,
		echoExecutions: () => executions,
		cleanup: () => {
			session.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		},
	};
}

describe("prefix stability (cache guard)", () => {
	let guard: PrefixGuardSession | undefined;

	afterEach(() => {
		guard?.cleanup();
		guard = undefined;
	});

	it("keeps the request prefix byte-stable across a multi-turn session with a tool call", async () => {
		const addendum = "Runtime note: the user is on a train; prefer short answers.";
		guard = createPrefixGuardSession([
			"answer one",
			{ toolCalls: [{ name: "echo", args: { text: "round-2" } }] },
			"tool done",
			"answer three",
		]);
		const { session, calls } = guard;

		// 3 turns, 4 LLM calls: plain turn, addendum turn with a tool call (2
		// calls), plain turn. The addendum turn exercises the only sanctioned
		// per-turn prompt mutation.
		await session.prompt("first question");
		await session.prompt("use the echo tool", { systemPromptAddendum: addendum });
		await session.prompt("final question");

		expect(calls).toHaveLength(4);
		expect(guard.echoExecutions()).toBe(1);

		const base = calls[0].systemPrompt;
		expect(base.length).toBeGreaterThan(0);

		// (1) The system prompt is byte-identical before every LLM call whose
		// turn carries no addendum, and identical across the addendum turn's own
		// tool loop. In particular the base prompt returns byte-identical on the
		// turn AFTER the addendum turn — no addendum leaks into the cached head.
		expect(calls[3].systemPrompt).toBe(base);
		expect(calls[2].systemPrompt).toBe(calls[1].systemPrompt);
		for (const [index, call] of calls.entries()) {
			const prefixStable = call.systemPrompt === base || call.systemPrompt.startsWith(`${base}\n\n`);
			expect(prefixStable, `call ${index} rewrote the cached system-prompt prefix`).toBe(true);
		}

		// (2) The per-turn addendum is appended strictly AFTER the base prompt.
		const withAddendum = calls[1].systemPrompt;
		expect(withAddendum.startsWith(base)).toBe(true);
		expect(withAddendum.indexOf(addendum)).toBeGreaterThan(base.length);

		// (3) Tool schema serialization is stable across all calls.
		expect(calls[0].toolsJson).toContain('"echo"');
		for (const [index, call] of calls.entries()) {
			expect(call.toolsJson, `tool schema serialization changed before call ${index}`).toBe(calls[0].toolsJson);
		}

		// The message history grows append-only: on every later call, each prior
		// message is byte-identical at the same index. Any flow rewriting
		// history mid-session (compaction bugs, in-place edits, reordering)
		// breaks the cached prefix and fails here.
		for (let i = 1; i < calls.length; i++) {
			const prev = calls[i - 1].messagesJson;
			const curr = calls[i].messagesJson;
			expect(curr.length, `call ${i} dropped messages from the request prefix`).toBeGreaterThan(prev.length);
			for (let j = 0; j < prev.length; j++) {
				expect(curr[j], `call ${i} mutated message ${j} mid-session`).toBe(prev[j]);
			}
		}
	});
});
