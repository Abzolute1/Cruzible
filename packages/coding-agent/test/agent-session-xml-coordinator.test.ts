import { describe, expect, it, vi } from "vitest";
import { AgentSessionXmlCoordinator } from "../src/core/agent-session-xml-coordinator.js";

describe("AgentSessionXmlCoordinator", () => {
	it("prepares XML fallback arguments before safety checks and execution", async () => {
		const execute = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "patched" }],
			details: undefined,
		});
		const evaluateToolSafety = vi.fn().mockResolvedValue(undefined);
		const emit = vi.fn();
		const messages = [
			{
				role: "assistant",
				timestamp: 1,
				stopReason: "stop",
				content: [
					{
						type: "thinking",
						thinking: [
							"<tool_call>",
							"<function=edit>",
							"<parameter=path>src/app.mjs</parameter>",
							'<parameter=edits>[{"oldText":"before","newText":"after"}]</parameter>',
							"</function>",
							"</tool_call>",
						].join("\n"),
					},
				],
			},
		];

		const coordinator = new AgentSessionXmlCoordinator({
			agentState: {
				getMessages: () => messages,
				setMessages: (nextMessages) => {
					messages.splice(0, messages.length, ...nextMessages);
				},
				prompt: vi.fn(),
				continue: vi.fn(),
			},
			sessionManager: {
				appendMessage: vi.fn(),
			} as never,
			getActiveToolNames: () => ["edit"],
			getTool: () =>
				({
					name: "edit",
					label: "edit",
					description: "edit",
					parameters: {},
					prepareArguments: (args: any) => ({
						...args,
						edits: JSON.parse(args.edits),
					}),
					execute,
				}) as never,
			getExtensionRunner: () => undefined,
			evaluateToolSafety,
			emit,
			waitForRetry: vi.fn(),
		});

		await coordinator.process();

		const preparedArgs = {
			path: "src/app.mjs",
			edits: [{ oldText: "before", newText: "after" }],
		};
		expect(evaluateToolSafety).toHaveBeenCalledWith("edit", preparedArgs);
		expect(execute).toHaveBeenCalledWith("xml-call-0", preparedArgs, expect.any(AbortSignal));
		expect(emit).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "tool_execution_start",
				args: preparedArgs,
			}),
		);
	});

	it("honors an extension tool_call block instead of executing the tool", async () => {
		const execute = vi.fn();
		const appendMessage = vi.fn();
		const messages = [
			{
				role: "assistant",
				timestamp: 1,
				stopReason: "stop",
				content: [
					{
						type: "text",
						text: [
							"<tool_call>",
							"<function=edit>",
							"<parameter=path>src/app.mjs</parameter>",
							"</function>",
							"</tool_call>",
						].join("\n"),
					},
				],
			},
		];

		const coordinator = new AgentSessionXmlCoordinator({
			agentState: {
				getMessages: () => messages,
				setMessages: (nextMessages) => {
					messages.splice(0, messages.length, ...nextMessages);
				},
				prompt: vi.fn(),
				continue: vi.fn(),
			},
			sessionManager: {
				appendMessage,
			} as never,
			getActiveToolNames: () => ["edit"],
			getTool: () =>
				({
					name: "edit",
					label: "edit",
					description: "edit",
					parameters: {},
					execute,
				}) as never,
			getExtensionRunner: () =>
				({
					hasHandlers: (event: string) => event === "tool_call",
					emitToolCall: vi.fn().mockResolvedValue({ block: true, reason: "blocked by test policy" }),
				}) as never,
			evaluateToolSafety: vi.fn().mockResolvedValue(undefined),
			emit: vi.fn(),
			waitForRetry: vi.fn(),
		});

		await coordinator.process();

		expect(execute).not.toHaveBeenCalled();
		expect(appendMessage).toHaveBeenCalledTimes(2);
		const toolResult = appendMessage.mock.calls[0][0];
		expect(toolResult.role).toBe("toolResult");
		expect(toolResult.isError).toBe(true);
		expect(toolResult.content[0].text).toContain("blocked by test policy");
	});

	it("logs extension tool_call failures and continues with execution", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const execute = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "patched" }],
			details: undefined,
		});
		const messages = [
			{
				role: "assistant",
				timestamp: 1,
				stopReason: "stop",
				content: [
					{
						type: "text",
						text: [
							"<tool_call>",
							"<function=edit>",
							"<parameter=path>src/app.mjs</parameter>",
							"</function>",
							"</tool_call>",
						].join("\n"),
					},
				],
			},
		];

		try {
			const coordinator = new AgentSessionXmlCoordinator({
				agentState: {
					getMessages: () => messages,
					setMessages: (nextMessages) => {
						messages.splice(0, messages.length, ...nextMessages);
					},
					prompt: vi.fn(),
					continue: vi.fn(),
				},
				sessionManager: {
					appendMessage: vi.fn(),
				} as never,
				getActiveToolNames: () => ["edit"],
				getTool: () =>
					({
						name: "edit",
						label: "edit",
						description: "edit",
						parameters: {},
						execute,
					}) as never,
				getExtensionRunner: () =>
					({
						hasHandlers: (event: string) => event === "tool_call",
						emitToolCall: vi.fn().mockRejectedValue(new Error("extension exploded")),
					}) as never,
				evaluateToolSafety: vi.fn().mockResolvedValue(undefined),
				emit: vi.fn(),
				waitForRetry: vi.fn(),
			});

			await coordinator.process();

			expect(consoleError).toHaveBeenCalled();
			expect(execute).toHaveBeenCalledTimes(1);
		} finally {
			consoleError.mockRestore();
		}
	});

	it("aborts an in-flight tool execution when abort() is called", async () => {
		const appendMessage = vi.fn();
		const execute = vi.fn(
			(_id: string, _args: unknown, signal?: AbortSignal) =>
				new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		);
		const messages = [
			{
				role: "assistant",
				timestamp: 1,
				stopReason: "stop",
				content: [
					{
						type: "text",
						text: [
							"<tool_call>",
							"<function=edit>",
							"<parameter=path>src/app.mjs</parameter>",
							"</function>",
							"</tool_call>",
						].join("\n"),
					},
				],
			},
		];

		const coordinator = new AgentSessionXmlCoordinator({
			agentState: {
				getMessages: () => messages,
				setMessages: (nextMessages) => {
					messages.splice(0, messages.length, ...nextMessages);
				},
				prompt: vi.fn(),
				continue: vi.fn(),
			},
			sessionManager: {
				appendMessage,
			} as never,
			getActiveToolNames: () => ["edit"],
			getTool: () =>
				({
					name: "edit",
					label: "edit",
					description: "edit",
					parameters: {},
					execute,
				}) as never,
			getExtensionRunner: () => undefined,
			evaluateToolSafety: vi.fn().mockResolvedValue(undefined),
			emit: vi.fn(),
			waitForRetry: vi.fn(),
		});

		const promise = coordinator.process();
		await vi.waitFor(() => expect(execute).toHaveBeenCalled());
		coordinator.abort();
		await promise;

		expect(appendMessage).toHaveBeenCalledTimes(2);
		const toolResult = appendMessage.mock.calls[0][0];
		expect(toolResult.isError).toBe(true);
		expect(toolResult.content[0].text).toContain("aborted");
	});

	it("keeps the system prompt byte-identical across an XML recovery run", async () => {
		const appendMessage = vi.fn();
		let systemPrompt = "byte-stable system prompt";
		const setSystemPrompt = vi.fn((next: string) => {
			systemPrompt = next;
		});
		const execute = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "patched" }],
			details: undefined,
		});
		const messages = [
			{
				role: "assistant",
				timestamp: 1,
				stopReason: "stop",
				content: [
					{
						type: "text",
						text: [
							"<tool_call>",
							"<function=edit>",
							"<parameter=path>src/app.mjs</parameter>",
							"</function>",
							"</tool_call>",
						].join("\n"),
					},
				],
			},
		];
		// Declared separately so the host-side prompt accessors can be tracked
		// even though the coordinator no longer receives them by contract.
		const agentState = {
			getMessages: () => messages,
			setMessages: (nextMessages: any[]) => {
				messages.splice(0, messages.length, ...nextMessages);
			},
			getSystemPrompt: () => systemPrompt,
			setSystemPrompt,
			prompt: vi.fn(),
			continue: vi.fn(),
		};

		const coordinator = new AgentSessionXmlCoordinator({
			agentState,
			sessionManager: {
				appendMessage,
			} as never,
			getActiveToolNames: () => ["edit"],
			getTool: () =>
				({
					name: "edit",
					label: "edit",
					description: "edit",
					parameters: {},
					execute,
				}) as never,
			getExtensionRunner: () => undefined,
			evaluateToolSafety: vi.fn().mockResolvedValue(undefined),
			emit: vi.fn(),
			waitForRetry: vi.fn(),
		});

		const systemPromptBefore = systemPrompt;
		await coordinator.process();

		expect(systemPrompt).toBe(systemPromptBefore);
		expect(setSystemPrompt).not.toHaveBeenCalled();
		expect(agentState.continue).toHaveBeenCalledTimes(1);

		// The recovery instruction rides the turn tail as a hidden custom
		// message appended after the tool results, before continuation.
		const recoveryMessage = appendMessage.mock.calls
			.map((call) => call[0])
			.find((message) => message.role === "custom");
		expect(recoveryMessage).toBeDefined();
		expect(recoveryMessage.customType).toBe("xml-tool-recovery");
		expect(recoveryMessage.display).toBe(false);
		expect(recoveryMessage.content).toContain("<xml-tool-recovery>");
		expect(recoveryMessage.content).toContain("XML fallback recovery mode");
		expect(recoveryMessage.content).toContain("</xml-tool-recovery>");
		expect(messages[messages.length - 1]).toBe(recoveryMessage);
	});
});
