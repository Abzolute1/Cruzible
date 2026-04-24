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
							"<parameter=edits>[{\"oldText\":\"before\",\"newText\":\"after\"}]</parameter>",
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
				getSystemPrompt: () => "system",
				setSystemPrompt: vi.fn(),
				prompt: vi.fn(),
				continue: vi.fn(),
			},
			sessionManager: {
				appendMessage: vi.fn(),
			} as never,
			getActiveToolNames: () => ["edit"],
			getTool: () => ({
				name: "edit",
				label: "edit",
				description: "edit",
				parameters: {},
				prepareArguments: (args: any) => ({
					...args,
					edits: JSON.parse(args.edits),
				}),
				execute,
			}),
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
		expect(execute).toHaveBeenCalledWith("xml-call-0", preparedArgs, undefined);
		expect(emit).toHaveBeenCalledWith(expect.objectContaining({
			type: "tool_execution_start",
			args: preparedArgs,
		}));
	});
});
