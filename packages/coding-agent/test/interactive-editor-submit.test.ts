import { describe, expect, test, vi } from "vitest";
import { handleInteractiveEditorSubmitAfterBuiltin, type InteractiveEditorSubmitActions, type InteractiveEditorSubmitState } from "../src/modes/interactive/interactive-editor-submit.js";

function createState(overrides: Partial<InteractiveEditorSubmitState> = {}): InteractiveEditorSubmitState {
	return {
		isBashRunning: false,
		isPlanningMode: false,
		isCompacting: false,
		isStreaming: false,
		isExtensionCommand: () => false,
		...overrides,
	};
}

function createActions(): InteractiveEditorSubmitActions {
	return {
		showWarning: vi.fn(),
		restoreEditorText: vi.fn(),
		addToHistory: vi.fn(),
		clearEditor: vi.fn(),
		handleBashCommand: vi.fn(async () => {}),
		setBashModeEnabled: vi.fn(),
		queueCompactionMessage: vi.fn(),
		prompt: vi.fn(async () => {}),
		updatePendingMessagesDisplay: vi.fn(),
		requestRender: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		dispatchNormalInput: vi.fn(),
	};
}

describe("interactive-editor-submit", () => {
	test("warns and restores text when bash is already running", async () => {
		const actions = createActions();

		const handled = await handleInteractiveEditorSubmitAfterBuiltin("!ls", createState({ isBashRunning: true }), actions);

		expect(handled).toBe(true);
		expect(actions.showWarning).toHaveBeenCalledOnce();
		expect(actions.restoreEditorText).toHaveBeenCalledWith("!ls");
		expect(actions.handleBashCommand).not.toHaveBeenCalled();
	});

	test("blocks bash shortcuts in planning mode", async () => {
		const actions = createActions();

		const handled = await handleInteractiveEditorSubmitAfterBuiltin("!ls", createState({ isPlanningMode: true }), actions);

		expect(handled).toBe(true);
		expect(actions.showWarning).toHaveBeenCalledWith(expect.stringContaining("planning mode"));
		expect(actions.restoreEditorText).toHaveBeenCalledWith("!ls");
		expect(actions.handleBashCommand).not.toHaveBeenCalled();
	});

	test("queues compaction prompts unless they are extension commands", async () => {
		const actions = createActions();

		const handled = await handleInteractiveEditorSubmitAfterBuiltin("hello", createState({ isCompacting: true }), actions);

		expect(handled).toBe(true);
		expect(actions.queueCompactionMessage).toHaveBeenCalledWith("hello", "steer");
		expect(actions.prompt).not.toHaveBeenCalled();
	});

	test("prompts immediately during compaction for extension commands", async () => {
		const actions = createActions();

		const handled = await handleInteractiveEditorSubmitAfterBuiltin(
			"/custom",
			createState({ isCompacting: true, isExtensionCommand: () => true }),
			actions,
		);

		expect(handled).toBe(true);
		expect(actions.addToHistory).toHaveBeenCalledWith("/custom");
		expect(actions.clearEditor).toHaveBeenCalledOnce();
		expect(actions.prompt).toHaveBeenCalledWith("/custom");
	});

	test("uses steer prompting while streaming", async () => {
		const actions = createActions();

		const handled = await handleInteractiveEditorSubmitAfterBuiltin("follow up", createState({ isStreaming: true }), actions);

		expect(handled).toBe(true);
		expect(actions.prompt).toHaveBeenCalledWith("follow up", { streamingBehavior: "steer" });
		expect(actions.updatePendingMessagesDisplay).toHaveBeenCalledOnce();
		expect(actions.requestRender).toHaveBeenCalledOnce();
	});

	test("falls back to normal submission flow when no special state applies", async () => {
		const actions = createActions();

		const handled = await handleInteractiveEditorSubmitAfterBuiltin("hello", createState(), actions);

		expect(handled).toBe(false);
		expect(actions.flushPendingBashComponents).toHaveBeenCalledOnce();
		expect(actions.dispatchNormalInput).toHaveBeenCalledWith("hello");
		expect(actions.addToHistory).toHaveBeenCalledWith("hello");
	});
});
