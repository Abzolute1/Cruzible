import { describe, expect, test, vi } from "vitest";
import {
	dispatchInteractiveBuiltinCommand,
	type InteractiveBuiltinCommandActions,
} from "../src/modes/interactive/interactive-command-actions.js";

function createActions(): InteractiveBuiltinCommandActions {
	return {
		clearEditor: vi.fn(),
		showSettingsSelector: vi.fn(),
		showModelsSelector: vi.fn(async () => {}),
		handleModelCommand: vi.fn(async () => {}),
		handleExportCommand: vi.fn(async () => {}),
		handleImportCommand: vi.fn(async () => {}),
		handleShareCommand: vi.fn(async () => {}),
		handleCopyCommand: vi.fn(async () => {}),
		handleNameCommand: vi.fn(),
		handleSessionCommand: vi.fn(),
		handlePlanCommand: vi.fn(async () => {}),
		handleResearchCommand: vi.fn(),
		handleDebugCommand: vi.fn(),
		handleWorkspaceCommand: vi.fn(),
		handleChangelogCommand: vi.fn(),
		handleHotkeysCommand: vi.fn(),
		handleTodoCommand: vi.fn(),
		showUserMessageSelector: vi.fn(),
		showTreeSelector: vi.fn(),
		showOAuthSelector: vi.fn(async () => {}),
		handleClearCommand: vi.fn(async () => {}),
		handleCompactCommand: vi.fn(async () => {}),
		showContextDialog: vi.fn(),
		clearCustomContextWindow: vi.fn(),
		setCustomContextWindow: vi.fn(),
		showWarning: vi.fn(),
		handleReloadCommand: vi.fn(async () => {}),
		handleArminSaysHi: vi.fn(),
		showSessionSelector: vi.fn(),
		toggleVerboseMode: vi.fn(),
		shutdown: vi.fn(async () => {}),
	};
}

describe("interactive-command-actions", () => {
	test("dispatches async command handlers and clears the editor", async () => {
		const actions = createActions();

		await dispatchInteractiveBuiltinCommand({ kind: "share" }, actions);

		expect(actions.handleShareCommand).toHaveBeenCalledOnce();
		expect(actions.clearEditor).toHaveBeenCalledOnce();
	});

	test("routes set-context dialog, clear, invalid, and set states correctly", async () => {
		const actions = createActions();

		await dispatchInteractiveBuiltinCommand({ kind: "set-context", arg: undefined }, actions);
		expect(actions.showContextDialog).toHaveBeenCalledOnce();

		await dispatchInteractiveBuiltinCommand({ kind: "set-context", arg: "reset" }, actions);
		expect(actions.clearCustomContextWindow).toHaveBeenCalledOnce();
		expect(actions.clearEditor).toHaveBeenCalledTimes(1);

		await dispatchInteractiveBuiltinCommand({ kind: "set-context", arg: "bad" }, actions);
		expect(actions.showWarning).toHaveBeenCalledOnce();
		expect(actions.clearEditor).toHaveBeenCalledTimes(2);

		await dispatchInteractiveBuiltinCommand({ kind: "set-context", arg: "44000" }, actions);
		expect(actions.setCustomContextWindow).toHaveBeenCalledWith(44000);
	});

	test("dispatches quit through shutdown after clearing the editor", async () => {
		const actions = createActions();

		await dispatchInteractiveBuiltinCommand({ kind: "quit" }, actions);

		expect(actions.clearEditor).toHaveBeenCalledOnce();
		expect(actions.shutdown).toHaveBeenCalledOnce();
	});

	test("dispatches plan through the dedicated plan handler", async () => {
		const actions = createActions();

		await dispatchInteractiveBuiltinCommand({ kind: "plan", action: "show" }, actions);

		expect(actions.handlePlanCommand).toHaveBeenCalledWith({ kind: "plan", action: "show" });
		expect(actions.clearEditor).toHaveBeenCalledOnce();
	});

	test("dispatches todo through the dedicated todo handler", async () => {
		const actions = createActions();

		await dispatchInteractiveBuiltinCommand({ kind: "todo" }, actions);

		expect(actions.handleTodoCommand).toHaveBeenCalledOnce();
		expect(actions.clearEditor).toHaveBeenCalledOnce();
	});
});
