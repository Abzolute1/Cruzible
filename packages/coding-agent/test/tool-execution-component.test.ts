import { Text, type TUI } from "@ag1/tui";
import { Type } from "@sinclair/typebox";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.js";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.js";
import { createReadTool, createReadToolDefinition } from "../src/core/tools/read.js";
import { createWriteToolDefinition } from "../src/core/tools/write.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function createBaseToolDefinition(name = "custom_tool"): ToolDefinition {
	return {
		name,
		label: name,
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
	};
}

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

describe("ToolExecutionComponent parity", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("stacks custom call and result renderers like the old implementation", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};

		const component = new ToolExecutionComponent("custom_tool", "tool-1", {}, {}, toolDefinition, createFakeTui());
		expect(stripAnsi(component.render(120).join("\n"))).toContain("custom call");

		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call");
		expect(rendered).toContain("custom result");
	});

	test("uses built-in rendering for built-in overrides without custom renderers", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("edit"),
		};

		const component = new ToolExecutionComponent(
			"edit",
			"tool-2",
			{ path: "README.md", oldText: "before", newText: "after" },
			{},
			overrideDefinition,
			createFakeTui(),
		);
		component.updateResult({ content: [], details: { diff: "+1 after", firstChangedLine: 1 }, isError: false });
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("edit");
		expect(rendered).toContain("README.md");
		expect(rendered).not.toContain(":1");
	});

	test("preserves legacy file_path rendering compatibility for built-in tools", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-3",
			{ file_path: "README.md" },
			{},
			undefined,
			createFakeTui(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("READ");
		expect(rendered).toContain("README.md");
	});

	test("shows a neutral receiving state while args stream, not a missing-path error", () => {
		// Model streams {"content": ...} before "path" (alphabetical key order)
		const component = new ToolExecutionComponent(
			"write",
			"tool-args-1",
			{ content: "partial file body" },
			{},
			undefined,
			createFakeTui(),
		);
		const streaming = stripAnsi(component.render(120).join("\n"));
		expect(streaming).toContain("receiving args…");
		expect(streaming).not.toContain("(missing path)");

		// Once args are final, a genuinely absent path is an actual error again
		component.setArgsComplete();
		const completed = stripAnsi(component.render(120).join("\n"));
		expect(completed).toContain("(missing path)");
	});

	test("bash call shows receiving state until the command finishes streaming", () => {
		const component = new ToolExecutionComponent("bash", "tool-args-2", {}, {}, undefined, createFakeTui());
		expect(stripAnsi(component.render(120).join("\n"))).toContain("receiving args…");

		component.updateArgs({ command: "ls -la" });
		expect(stripAnsi(component.render(120).join("\n"))).toContain("ls -la");
	});

	test("bash execute emits an initial empty partial update before output arrives", async () => {
		const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
		const operations: BashOperations = {
			exec: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });
		const promise = tool.execute(
			"tool-bash-1",
			{ command: "sleep 10" },
			undefined,
			(update) => updates.push(update as { content: Array<{ type: string; text?: string }>; details?: unknown }),
			{} as never,
		);
		expect(updates).toEqual([{ content: [], details: undefined }]);
		await promise;
	});

	test("does not duplicate built-in headers when passed the active built-in definition", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-4",
			{ path: "README.md" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered.match(/\bREAD\b/g)?.length ?? 0).toBe(1);
	});

	test("inherits missing built-in result renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderCall: () => new Text("override call", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4b",
			{ path: "README.md" },
			{},
			overrideDefinition,
			createFakeTui(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("hello");
	});

	test("inherits missing built-in call renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderResult: () => new Text("override result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4c",
			{ path: "README.md" },
			{},
			overrideDefinition,
			createFakeTui(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
		expect(rendered).toContain("override result");
	});

	test("uses custom renderers for built-in overrides that reuse built-in definition parameters", () => {
		const builtInDefinition = createReadToolDefinition(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4d",
			{ path: "README.md" },
			{},
			{
				...builtInDefinition,
				renderCall: () => new Text("override call", 0, 0),
				renderResult: () => new Text("override result", 0, 0),
			},
			createFakeTui(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("override result");
		expect(rendered).not.toContain("read README.md");
	});

	test("uses custom renderers for built-in overrides that reuse wrapped built-in tool parameters", () => {
		const builtInTool = createReadTool(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4e",
			{ path: "README.md" },
			{},
			{
				...createBaseToolDefinition("read"),
				parameters: builtInTool.parameters,
				renderCall: () => new Text("wrapped override call", 0, 0),
				renderResult: () => new Text("wrapped override result", 0, 0),
			},
			createFakeTui(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("wrapped override call");
		expect(rendered).toContain("wrapped override result");
	});

	test("shares renderer state across custom call and result slots", () => {
		type RenderState = { token?: string };
		const toolDefinition: ToolDefinition<any, unknown, RenderState> = {
			...createBaseToolDefinition(),
			renderCall: (_args, _theme, context) => {
				context.state.token ??= "shared-token";
				return new Text(`custom call ${context.state.token}`, 0, 0);
			},
			renderResult: (_result, _options, _theme, context) => {
				return new Text(`custom result ${context.state.token}`, 0, 0);
			},
		};

		const component = new ToolExecutionComponent("custom_tool", "tool-5", {}, {}, toolDefinition, createFakeTui());
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call shared-token");
		expect(rendered).toContain("custom result shared-token");
	});

	test("exposes args in render result context", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("call", 0, 0),
			renderResult: (_result, _options, _theme, context) =>
				new Text(`arg:${String((context.args as { foo: string }).foo)}`, 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5b",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("arg:bar");
	});

	test("falls back when custom renderers are absent", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-6",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom_tool");
		expect(rendered).toContain("done");
	});

	test("trims trailing blank display lines from write previews", () => {
		const component = new ToolExecutionComponent(
			"write",
			"tool-7",
			{ path: "README.md", content: "one\ntwo\n" },
			{},
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("README.md");
		expect(rendered).toContain("3 lines staged");
		expect(rendered).not.toContain("one");
		expect(rendered).not.toContain("two");
	});

	test("summarizes read results without dumping file content by default", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-8",
			{ path: "README.md" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "one\ntwo\n" }], details: undefined, isError: false },
			false,
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("READ");
		expect(rendered).toContain("Loaded README.md · 2 lines");
		expect(rendered).toContain("README.md");
		expect(rendered).not.toContain("to expand");
		expect(rendered).not.toContain("one");
		expect(rendered).not.toContain("two");
		expect(rendered).not.toContain("DONE");
	});

	test("keeps read summaries compact by default", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-9",
			{ path: "README.md" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
		);
		component.updateResult(
			{
				content: [
					{
						type: "text",
						text: "l1\nl2\nl3\nl4\nl5\nl6",
					},
				],
				details: undefined,
				isError: false,
			},
			false,
		);
		const rendered = stripAnsi(component.render(160).join("\n"));
		expect(rendered).toContain("Loaded README.md · 6 lines");
		expect(rendered).toContain("README.md");
		expect(rendered).not.toContain("to expand");
		expect(rendered).not.toContain("l1");
		expect(rendered).not.toContain("l2");
		expect(rendered).not.toContain("l6");
	});

	test("keeps web fetch results summarized by default", () => {
		const component = new ToolExecutionComponent(
			"webFetch",
			"tool-10",
			{ url: "https://example.com" },
			{},
			undefined,
			createFakeTui(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "full body that should not dominate the transcript" }],
				details: {
					title: "Example Domain",
					facts: ["Static example page", "Often used for tests", "Extra fact"],
					preview: "Preview line 1\nPreview line 2\nPreview line 3",
					truncated: true,
				},
				isError: false,
			},
			false,
		);
		const rendered = stripAnsi(component.render(160).join("\n"));
		expect(rendered).toContain("WEBFETCH");
		expect(rendered).toContain("Fetched Example Domain");
		expect(rendered).toContain("https://example.com");
		expect(rendered).not.toContain("to expand");
		expect(rendered).not.toContain("Static example page");
		expect(rendered).not.toContain("Preview line 1");
		expect(rendered).not.toContain("Preview line 3");
	});

	test("keeps bash results as a compact execution log by default", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-11",
			{ command: "ls -la ~/Downloads" },
			{},
			undefined,
			createFakeTui(),
		);
		component.markExecutionStarted();
		component.updateResult(
			{
				content: [{ type: "text", text: "file1\nfile2\nfile3" }],
				details: undefined,
				isError: false,
			},
			false,
		);
		const rendered = stripAnsi(component.render(160).join("\n"));
		expect(rendered).toContain("BASH");
		expect(rendered).toContain("directory listing · 3 lines available");
		expect(rendered).toContain("ls -la ~/Downloads");
		expect(rendered).not.toContain("to expand");
		expect(rendered).not.toContain("file1");
		expect(rendered).not.toContain("file2");
	});

	test("verbose mode restores the three-line layout with expand hints", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-verbose-1",
			{ path: "README.md" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
		);
		component.setVerbose(true);
		component.updateResult(
			{ content: [{ type: "text", text: "one\ntwo\n" }], details: undefined, isError: false },
			false,
		);
		const rendered = stripAnsi(component.render(160).join("\n"));
		expect(rendered).toContain("to expand");
		expect(rendered).toContain("└ README.md");
	});

	test("uses a dot indicator instead of text status badges in tool headers", () => {
		const running = new ToolExecutionComponent(
			"bash",
			"tool-12",
			{ command: "ls -la" },
			{},
			undefined,
			createFakeTui(),
		);
		running.markExecutionStarted();
		const runningRendered = stripAnsi(running.render(160).join("\n"));
		expect(runningRendered).toContain("● BASH");
		expect(runningRendered).not.toContain("RUNNING");

		const success = new ToolExecutionComponent(
			"webFetch",
			"tool-13",
			{ url: "https://example.com" },
			{},
			undefined,
			createFakeTui(),
		);
		success.markExecutionStarted();
		success.updateResult({ content: [], details: {}, isError: false }, false);
		const successRendered = stripAnsi(success.render(160).join("\n"));
		expect(successRendered).toContain("● WEBFETCH");
		expect(successRendered).not.toContain("DONE");

		const failure = new ToolExecutionComponent(
			"bash",
			"tool-14",
			{ command: "exit 1" },
			{},
			undefined,
			createFakeTui(),
		);
		failure.markExecutionStarted();
		failure.updateResult({ content: [], details: {}, isError: true }, false);
		const failureRendered = stripAnsi(failure.render(160).join("\n"));
		expect(failureRendered).toContain("● BASH");
		expect(failureRendered).not.toContain("ERROR");
	});
});
