import { describe, expect, test } from "vitest";
import { parseInteractiveBuiltinCommand } from "../src/modes/interactive/interactive-command-parser.js";

describe("interactive-command-parser", () => {
	test("parses exact selector and utility commands", () => {
		expect(parseInteractiveBuiltinCommand("/settings")).toEqual({ kind: "settings" });
		expect(parseInteractiveBuiltinCommand("/scoped-models")).toEqual({ kind: "scoped-models" });
		expect(parseInteractiveBuiltinCommand("/share")).toEqual({ kind: "share" });
		expect(parseInteractiveBuiltinCommand("/copy")).toEqual({ kind: "copy" });
		expect(parseInteractiveBuiltinCommand("/session")).toEqual({ kind: "session" });
		expect(parseInteractiveBuiltinCommand("/plan")).toEqual({ kind: "plan", action: "toggle" });
		expect(parseInteractiveBuiltinCommand("/plan show")).toEqual({ kind: "plan", action: "show" });
		expect(parseInteractiveBuiltinCommand("/plan show 2")).toEqual({ kind: "plan", action: "show", revision: 2 });
		expect(parseInteractiveBuiltinCommand("/plan history")).toEqual({ kind: "plan", action: "history" });
		expect(parseInteractiveBuiltinCommand("/plan routes")).toEqual({ kind: "plan", action: "routes" });
		expect(parseInteractiveBuiltinCommand("/plan review")).toEqual({ kind: "plan", action: "review" });
		expect(parseInteractiveBuiltinCommand("/plan interview")).toEqual({ kind: "plan", action: "interview" });
		expect(parseInteractiveBuiltinCommand("/plan interview 2")).toEqual({ kind: "plan", action: "interview", revision: 2 });
		expect(parseInteractiveBuiltinCommand("/plan planner-model")).toEqual({
			kind: "plan",
			action: "planner-model",
			modelRef: undefined,
		});
		expect(parseInteractiveBuiltinCommand("/plan planner-model openai/gpt-5.4")).toEqual({
			kind: "plan",
			action: "planner-model",
			modelRef: "openai/gpt-5.4",
		});
		expect(parseInteractiveBuiltinCommand("/plan executor-model clear")).toEqual({
			kind: "plan",
			action: "executor-model",
			modelRef: "clear",
		});
		expect(parseInteractiveBuiltinCommand("/plan answer clarify the CLI compatibility expectations")).toEqual({
			kind: "plan",
			action: "answer",
			feedback: "clarify the CLI compatibility expectations",
		});
		expect(parseInteractiveBuiltinCommand("/plan answer 2 keep the runtime split in place")).toEqual({
			kind: "plan",
			action: "answer",
			revision: 2,
			feedback: "keep the runtime split in place",
		});
		expect(parseInteractiveBuiltinCommand("/plan accept")).toEqual({ kind: "plan", action: "accept" });
		expect(parseInteractiveBuiltinCommand("/plan accept 2")).toEqual({ kind: "plan", action: "accept", revision: 2 });
		expect(parseInteractiveBuiltinCommand("/plan reject")).toEqual({ kind: "plan", action: "reject" });
		expect(parseInteractiveBuiltinCommand("/plan reject 2")).toEqual({ kind: "plan", action: "reject", revision: 2 });
		expect(parseInteractiveBuiltinCommand("/plan execute")).toEqual({ kind: "plan", action: "execute" });
		expect(parseInteractiveBuiltinCommand("/plan execute 2")).toEqual({ kind: "plan", action: "execute", revision: 2 });
		expect(parseInteractiveBuiltinCommand("/plan next")).toEqual({ kind: "plan", action: "next" });
		expect(parseInteractiveBuiltinCommand("/plan next 2")).toEqual({ kind: "plan", action: "next", revision: 2 });
		expect(parseInteractiveBuiltinCommand("/plan step 2")).toEqual({ kind: "plan", action: "step", stepIndex: 1 });
		expect(parseInteractiveBuiltinCommand("/plan step 3 2")).toEqual({
			kind: "plan",
			action: "step",
			revision: 3,
			stepIndex: 1,
		});
		expect(parseInteractiveBuiltinCommand("/plan clear")).toEqual({ kind: "plan", action: "clear" });
		expect(parseInteractiveBuiltinCommand("/plan clear 2")).toEqual({ kind: "plan", action: "clear", revision: 2 });
		expect(parseInteractiveBuiltinCommand("/plan done 2")).toEqual({ kind: "plan", action: "done", stepIndex: 1 });
		expect(parseInteractiveBuiltinCommand("/plan done 3 2")).toEqual({
			kind: "plan",
			action: "done",
			revision: 3,
			stepIndex: 1,
		});
		expect(parseInteractiveBuiltinCommand("/plan reopen 1")).toEqual({ kind: "plan", action: "reopen", stepIndex: 0 });
		expect(parseInteractiveBuiltinCommand("/plan reopen 3 1")).toEqual({
			kind: "plan",
			action: "reopen",
			revision: 3,
			stepIndex: 0,
		});
		expect(parseInteractiveBuiltinCommand("/plan revise tighten the verification")).toEqual({
			kind: "plan",
			action: "revise",
			feedback: "tighten the verification",
		});
		expect(parseInteractiveBuiltinCommand("/plan revise 2 tighten the verification")).toEqual({
			kind: "plan",
			action: "revise",
			revision: 2,
			feedback: "tighten the verification",
		});
		expect(parseInteractiveBuiltinCommand("/plan revise")).toEqual({
			kind: "plan",
			action: "revise",
			feedback: undefined,
		});
		expect(parseInteractiveBuiltinCommand("/debug")).toEqual({ kind: "debug" });
		expect(parseInteractiveBuiltinCommand("/changelog")).toEqual({ kind: "changelog" });
		expect(parseInteractiveBuiltinCommand("/hotkeys")).toEqual({ kind: "hotkeys" });
		expect(parseInteractiveBuiltinCommand("/fork")).toEqual({ kind: "fork" });
		expect(parseInteractiveBuiltinCommand("/tree")).toEqual({ kind: "tree" });
		expect(parseInteractiveBuiltinCommand("/login")).toEqual({ kind: "login" });
		expect(parseInteractiveBuiltinCommand("/logout")).toEqual({ kind: "logout" });
		expect(parseInteractiveBuiltinCommand("/new")).toEqual({ kind: "new" });
		expect(parseInteractiveBuiltinCommand("/reload")).toEqual({ kind: "reload" });
		expect(parseInteractiveBuiltinCommand("/arminsayshi")).toEqual({ kind: "arminsayshi" });
		expect(parseInteractiveBuiltinCommand("/resume")).toEqual({ kind: "resume" });
		expect(parseInteractiveBuiltinCommand("/quit")).toEqual({ kind: "quit" });
	});

	test("parses commands with optional arguments", () => {
		expect(parseInteractiveBuiltinCommand("/model")).toEqual({ kind: "model", searchTerm: undefined });
		expect(parseInteractiveBuiltinCommand("/model lm-studio/qwen")).toEqual({
			kind: "model",
			searchTerm: "lm-studio/qwen",
		});
		expect(parseInteractiveBuiltinCommand("/compact")).toEqual({
			kind: "compact",
			customInstructions: undefined,
		});
		expect(parseInteractiveBuiltinCommand("/compact focus only on tests")).toEqual({
			kind: "compact",
			customInstructions: "focus only on tests",
		});
		expect(parseInteractiveBuiltinCommand("/set-context")).toEqual({
			kind: "set-context",
			arg: undefined,
		});
		expect(parseInteractiveBuiltinCommand("/set-context 44000")).toEqual({
			kind: "set-context",
			arg: "44000",
		});
	});

	test("parses passthrough text commands", () => {
		expect(parseInteractiveBuiltinCommand("/export /tmp/out.html")).toEqual({
			kind: "export",
			text: "/export /tmp/out.html",
		});
		expect(parseInteractiveBuiltinCommand("/import /tmp/session.jsonl")).toEqual({
			kind: "import",
			text: "/import /tmp/session.jsonl",
		});
		expect(parseInteractiveBuiltinCommand("/name Better Session")).toEqual({
			kind: "name",
			text: "/name Better Session",
		});
		expect(parseInteractiveBuiltinCommand("/research react compiler")).toEqual({
			kind: "research",
			text: "/research react compiler",
		});
		expect(parseInteractiveBuiltinCommand("/workspace diff")).toEqual({
			kind: "workspace",
			text: "/workspace diff",
		});
	});

	test("rejects non-commands and malformed prefixes", () => {
		expect(parseInteractiveBuiltinCommand("hello")).toBeUndefined();
		expect(parseInteractiveBuiltinCommand("/exportfoo")).toBeUndefined();
		expect(parseInteractiveBuiltinCommand("/workspacex")).toBeUndefined();
		expect(parseInteractiveBuiltinCommand("/plan done")).toBeUndefined();
		expect(parseInteractiveBuiltinCommand("/plan done x")).toBeUndefined();
		expect(parseInteractiveBuiltinCommand("/plan step")).toBeUndefined();
		expect(parseInteractiveBuiltinCommand("/plan answer")).toEqual({ kind: "plan", action: "answer", feedback: undefined });
		expect(parseInteractiveBuiltinCommand("/plan routes extra")).toBeUndefined();
	});
});
