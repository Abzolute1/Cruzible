import { describe, expect, test, vi } from "vitest";
import { AgentSessionPromptCoordinator } from "../src/core/agent-session-prompt-coordinator.js";

function createCoordinator(guidance?: string) {
	const setSystemPrompt = vi.fn();
	const options: any = {
		agentState: {
			isStreaming: () => false,
			prompt: vi.fn(async () => {}),
			setSystemPrompt,
		},
		getModel: () => undefined,
		hasConfiguredAuth: () => true,
		isUsingOAuth: () => false,
		getExtensionRunner: () => undefined,
		flushPendingBashMessages: () => {},
		findLastAssistantMessage: () => undefined,
		checkCompaction: vi.fn(async () => {}),
		takePendingNextTurnMessages: () => [],
		checkToolFailures: () => ({ message: undefined, warnings: [] }),
		emit: () => {},
		getBaseSystemPrompt: () => "Base system prompt.",
		getControlledRuntimeGuidance: () => guidance,
		tryExecuteExtensionCommand: vi.fn(async () => false),
		expandPromptText: (text: string) => text,
		queueSteer: vi.fn(async () => {}),
		queueFollowUp: vi.fn(async () => {}),
		resetXmlPromptState: () => {},
		waitForRetry: vi.fn(async () => {}),
		waitForEventLoop: vi.fn(async () => {}),
		processXmlToolCalls: vi.fn(async () => {}),
	};
	return { coordinator: new AgentSessionPromptCoordinator(options), setSystemPrompt };
}

describe("controlled runtime guidance injection", () => {
	test("appends a tagged guidance section when controlled runtime is active", async () => {
		const { coordinator, setSystemPrompt } = createCoordinator(
			"Controlled runtime is active: emit exactly one tool call per assistant turn.",
		);
		await (coordinator as any).applyBeforeAgentStart([], "hello", undefined, undefined);

		const prompt = setSystemPrompt.mock.calls[0]?.[0] as string;
		expect(prompt).toContain("Base system prompt.");
		expect(prompt).toContain("<controlled-runtime-guidance>");
		expect(prompt).toContain("emit exactly one tool call per assistant turn");
		expect(prompt).toContain("</controlled-runtime-guidance>");
	});

	test("leaves the prompt untouched when no controlled runtime is active", async () => {
		const { coordinator, setSystemPrompt } = createCoordinator(undefined);
		await (coordinator as any).applyBeforeAgentStart([], "hello", undefined, undefined);

		const prompt = setSystemPrompt.mock.calls[0]?.[0] as string;
		expect(prompt).toBe("Base system prompt.");
		expect(prompt).not.toContain("controlled-runtime-guidance");
	});
});
