import { describe, expect, test } from "vitest";
import {
	resolveInteractiveContextWindowCommand,
	resolveInteractiveContextWindowInput,
} from "../src/modes/interactive/interactive-context-window.js";

describe("interactive-context-window", () => {
	test("shows the dialog when no argument is provided", () => {
		expect(resolveInteractiveContextWindowCommand(undefined)).toEqual({ type: "show-dialog" });
	});

	test("clears the custom context window for auto/reset", () => {
		expect(resolveInteractiveContextWindowCommand("auto")).toEqual({ type: "clear" });
		expect(resolveInteractiveContextWindowCommand("reset")).toEqual({ type: "clear" });
	});

	test("validates slash-command context sizes", () => {
		expect(resolveInteractiveContextWindowCommand("44000")).toEqual({ type: "set", value: 44000 });
		expect(resolveInteractiveContextWindowCommand("512")).toEqual({
			type: "invalid",
			message: "Invalid number - usage: /set-context <tokens>, e.g. /set-context 44000",
		});
	});

	test("validates dialog input", () => {
		expect(resolveInteractiveContextWindowInput(undefined)).toEqual({ type: "clear" });
		expect(resolveInteractiveContextWindowInput("16384")).toEqual({ type: "set", value: 16384 });
		expect(resolveInteractiveContextWindowInput("bad")).toEqual({
			type: "invalid",
			message: 'Invalid value: "bad". Enter a number >= 1024.',
		});
	});
});
