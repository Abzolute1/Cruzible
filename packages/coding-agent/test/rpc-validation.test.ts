import { describe, expect, it } from "vitest";
import { SESSION_MUTATING_COMMANDS, validateRpcCommand } from "../src/modes/rpc/rpc-validation.js";

describe("validateRpcCommand", () => {
	it("accepts valid commands", () => {
		expect(validateRpcCommand({ type: "prompt", message: "hello" })).toBeUndefined();
		expect(
			validateRpcCommand({ id: "1", type: "prompt", message: "hello", streamingBehavior: "steer", images: [] }),
		).toBeUndefined();
		expect(validateRpcCommand({ type: "steer", message: "hello" })).toBeUndefined();
		expect(validateRpcCommand({ type: "follow_up", message: "hello" })).toBeUndefined();
		expect(validateRpcCommand({ type: "abort" })).toBeUndefined();
		expect(validateRpcCommand({ type: "new_session", parentSession: "/tmp/a.jsonl" })).toBeUndefined();
		expect(validateRpcCommand({ type: "get_state" })).toBeUndefined();
		expect(
			validateRpcCommand({ type: "set_model", provider: "anthropic", modelId: "claude-sonnet-4-5" }),
		).toBeUndefined();
		expect(validateRpcCommand({ type: "set_thinking_level", level: "high" })).toBeUndefined();
		expect(validateRpcCommand({ type: "set_steering_mode", mode: "all" })).toBeUndefined();
		expect(validateRpcCommand({ type: "set_follow_up_mode", mode: "one-at-a-time" })).toBeUndefined();
		expect(validateRpcCommand({ type: "compact", customInstructions: "focus on tests" })).toBeUndefined();
		expect(validateRpcCommand({ type: "set_auto_compaction", enabled: true })).toBeUndefined();
		expect(validateRpcCommand({ type: "set_auto_retry", enabled: false })).toBeUndefined();
		expect(validateRpcCommand({ type: "bash", command: "ls" })).toBeUndefined();
		expect(validateRpcCommand({ type: "switch_session", sessionPath: "/tmp/a.jsonl" })).toBeUndefined();
		expect(validateRpcCommand({ type: "fork", entryId: "abc123" })).toBeUndefined();
		expect(validateRpcCommand({ type: "set_session_name", name: "my session" })).toBeUndefined();
		expect(validateRpcCommand({ type: "get_commands" })).toBeUndefined();
	});

	it("rejects non-object and typeless input", () => {
		expect(validateRpcCommand(null)).toBeDefined();
		expect(validateRpcCommand("prompt")).toBeDefined();
		expect(validateRpcCommand([{ type: "abort" }])).toBeDefined();
		expect(validateRpcCommand({})).toBeDefined();
		expect(validateRpcCommand({ type: 42 })).toBeDefined();
	});

	it("rejects unknown command types", () => {
		expect(validateRpcCommand({ type: "explode" })).toMatch(/unknown command type/);
	});

	it("rejects missing or mistyped required fields", () => {
		expect(validateRpcCommand({ type: "prompt" })).toMatch(/'message'/);
		expect(validateRpcCommand({ type: "prompt", message: 5 })).toMatch(/'message'/);
		expect(validateRpcCommand({ type: "set_model", provider: "anthropic" })).toMatch(/'modelId'/);
		expect(validateRpcCommand({ type: "bash", command: ["ls"] })).toMatch(/'command'/);
		expect(validateRpcCommand({ type: "set_auto_retry", enabled: "yes" })).toMatch(/'enabled'/);
		expect(validateRpcCommand({ type: "switch_session" })).toMatch(/'sessionPath'/);
		expect(validateRpcCommand({ type: "fork", entryId: 7 })).toMatch(/'entryId'/);
	});

	it("rejects invalid enum fields", () => {
		expect(validateRpcCommand({ type: "set_thinking_level", level: "max" })).toMatch(/'level'/);
		expect(validateRpcCommand({ type: "set_steering_mode", mode: "sometimes" })).toMatch(/'mode'/);
		expect(validateRpcCommand({ type: "prompt", message: "hi", streamingBehavior: "interrupt" })).toMatch(
			/streamingBehavior/,
		);
	});

	it("rejects mistyped optional fields", () => {
		expect(validateRpcCommand({ type: "abort", id: 3 })).toMatch(/'id'/);
		expect(validateRpcCommand({ type: "new_session", parentSession: 4 })).toMatch(/'parentSession'/);
		expect(validateRpcCommand({ type: "prompt", message: "hi", images: "not-an-array" })).toMatch(/'images'/);
		expect(validateRpcCommand({ type: "export_html", outputPath: true })).toMatch(/'outputPath'/);
	});
});

describe("SESSION_MUTATING_COMMANDS", () => {
	it("contains the session teardown commands", () => {
		expect([...SESSION_MUTATING_COMMANDS].sort()).toEqual(["fork", "new_session", "switch_session"]);
	});
});
