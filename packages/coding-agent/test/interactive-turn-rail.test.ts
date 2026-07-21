import { Container } from "@ag1/tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.js";

function makeFakeThis() {
	const proto = InteractiveMode.prototype as any;
	const fakeThis: any = {
		isInitialized: true,
		init: async () => {},
		footer: { invalidate() {}, setWarning() {} },
		generationStats: { handleEvent() {} },
		settingsManager: { getVerboseMode: () => false, getShowImages: () => false },
		shouldSuppressPlanningToolUi: () => false,
		shouldSuppressAssistantToolRendering: () => false,
		setToolAwareLoadingMessage() {},
		pendingToolArgs: new Map(),
		pendingTools: new Map(),
		getRegisteredToolDefinition: () => undefined,
		ui: { requestRender() {} },
		sessionManager: { getCwd: () => "/tmp" },
		toolOutputExpanded: false,
		chatContainer: new Container(),
		currentTurnRail: undefined,
		hideThinkingBlock: false,
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		hiddenThinkingLabel: "Thinking...",
		shouldSuppressAssistantMessage: () => false,
		streamingComponent: undefined,
		streamingMessage: undefined,
		session: { retryAttempt: 0, recordToolOutcome: () => {} },
		lastNudgeOutputTokens: 0,
		formatRequestFailureWarning: () => undefined,
		assistantContentTarget: proto.assistantContentTarget,
		handleEvent: proto.handleEvent,
		addMessageToChat: () => {},
		updatePendingMessagesDisplay() {},
		retryEscapeHandler: undefined,
		defaultEditor: {},
		retryLoader: undefined,
		loadingAnimation: undefined,
		stopWorkingVerbAnimation() {},
		activeWorkingVerb: undefined,
		managedWorkingMessageEnabled: false,
		workingVerbAnimator: { setState() {} },
		statusContainer: { clear() {}, addChild() {} },
		pendingWorkingMessage: undefined,
		currentTurnToolCallHistory: [],
		currentTurnFileAccessHistory: [],
		nudgeToolCallHistory: [],
		nudgeFileAccessHistory: [],
		resetLoadingAnimationMessage() {},
		evaluateAndShowNudgeWarnings() {},
		checkShutdownRequested: () => false,
	};
	fakeThis.getDefaultWorkingMessage = () => "Working...";
	return fakeThis;
}

const thinkingMsg = (text: string) => ({
	role: "assistant",
	content: [{ type: "thinking", thinking: text }],
	stopReason: "toolUse",
	timestamp: 1,
});
const textMsg = (text: string) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	stopReason: "stop",
	timestamp: 1,
});
const result = { content: [{ type: "text", text: "some result" }], isError: false };

async function driveTurn(fakeThis: any) {
	const h = (e: any) => fakeThis.handleEvent(e);
	await h({ type: "message_start", message: thinkingMsg("think one") });
	await h({ type: "message_update", message: thinkingMsg("think one") });
	await h({ type: "tool_execution_start", toolCallId: "t1", toolName: "webSearch", args: { query: "q1" } });
	await h({ type: "tool_execution_end", toolCallId: "t1", toolName: "webSearch", result, isError: false });
	await h({ type: "message_end", message: thinkingMsg("think one") });

	await h({ type: "message_start", message: thinkingMsg("think two") });
	await h({ type: "message_update", message: thinkingMsg("think two") });
	await h({ type: "tool_execution_start", toolCallId: "t2", toolName: "webFetch", args: { url: "https://x" } });
	await h({ type: "tool_execution_end", toolCallId: "t2", toolName: "webFetch", result, isError: false });
	await h({ type: "message_end", message: thinkingMsg("think two") });

	await h({ type: "message_start", message: textMsg("the answer") });
	await h({ type: "message_update", message: textMsg("the answer") });
	await h({ type: "message_end", message: textMsg("the answer") });
	await h({ type: "agent_end", messages: [] });
}

describe("InteractiveMode turn rail + render-time grouping", () => {
	beforeAll(() => initTheme("dark"));

	test("turn content lands in one rail in chronological order; same-family runs collapse at render time", async () => {
		const fakeThis = makeFakeThis();
		await driveTurn(fakeThis);

		expect(fakeThis.chatContainer.children).toHaveLength(1);
		const rail = fakeThis.chatContainer.children[0]!;
		expect(rail.constructor.name).toBe("TurnRail");

		// Nothing is moved or re-parented: components stay in event order.
		const order = (rail as any).children.map((child: any) => child.constructor.name);
		expect(order).toEqual([
			"AssistantMessageComponent",
			"ToolExecutionComponent",
			"AssistantMessageComponent",
			"ToolExecutionComponent",
			"AssistantMessageComponent",
		]);

		// Rendered, the consecutive research tools collapse into one summary line.
		const text = stripAnsi(rail.render(120).join("\n"));
		expect(text).toContain("webSearch ×1");
		expect(text).toContain("webFetch ×1");
		expect(text).not.toContain("● WEBSEARCH");
		expect(text).not.toContain("● WEBFETCH");
	});

	test("expanding the rail reveals the individual tool calls", async () => {
		const fakeThis = makeFakeThis();
		await driveTurn(fakeThis);
		const rail = fakeThis.chatContainer.children[0] as any;
		rail.setExpanded(true);
		const text = stripAnsi(rail.render(120).join("\n"));
		expect(text).toContain("● WEBSEARCH");
		expect(text).toContain("● WEBFETCH");
	});
});
