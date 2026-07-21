import { describe, expect, it } from "vitest";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.js";

describe("bash tool output handling", () => {
	it("strips ANSI escapes and control characters from the tool result", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				// SGR color, OSC 52 clipboard write, and stray C0 control chars.
				onData(Buffer.from("hello \x1b[31mred\x1b[0m \x1b]52;c;aGVsbG8=\x07\x01\x02done\n"));
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });
		const result = await tool.execute("tool-bash-1", { command: "emit escapes" }, undefined, undefined, {} as never);
		const block = result.content[0];
		const text = block.type === "text" ? block.text : "";
		expect(text).not.toContain("\x1b");
		expect(text).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f]/);
		expect(text).toContain("hello red done");
	});

	it("preserves newlines and tabs in the tool result", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("line1\n\tindented\n"));
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });
		const result = await tool.execute(
			"tool-bash-2",
			{ command: "emit whitespace" },
			undefined,
			undefined,
			{} as never,
		);
		const block = result.content[0];
		const text = block.type === "text" ? block.text : "";
		expect(text).toContain("line1\n\tindented\n");
	});

	it("surfaces an error when the command is killed by a signal (exitCode null)", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("partial output\n"));
				return { exitCode: null };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });
		await expect(tool.execute("tool-bash-3", { command: "oom" }, undefined, undefined, {} as never)).rejects.toThrow(
			/killed by a signal/,
		);
	});
});
