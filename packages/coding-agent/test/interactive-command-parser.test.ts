import { describe, expect, test } from "vitest";
import { parseInteractiveBuiltinCommand } from "../src/modes/interactive/interactive-command-parser.js";

describe("interactive-command-parser", () => {
	test("parses exact selector and utility commands", () => {
		expect(parseInteractiveBuiltinCommand("/settings")).toEqual({ kind: "settings" });
		expect(parseInteractiveBuiltinCommand("/scoped-models")).toEqual({ kind: "scoped-models" });
		expect(parseInteractiveBuiltinCommand("/share")).toEqual({ kind: "share" });
		expect(parseInteractiveBuiltinCommand("/copy")).toEqual({ kind: "copy" });
		expect(parseInteractiveBuiltinCommand("/session")).toEqual({ kind: "session" });
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
	});
});
