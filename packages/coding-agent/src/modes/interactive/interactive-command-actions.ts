import type { InteractiveBuiltinCommand } from "./interactive-command-parser.js";
import { resolveInteractiveContextWindowCommand } from "./interactive-context-window.js";

export interface InteractiveBuiltinCommandActions {
	clearEditor: () => void;
	showSettingsSelector: () => void;
	showModelsSelector: () => Promise<void>;
	handleModelCommand: (searchTerm?: string) => Promise<void>;
	handleExportCommand: (text: string) => Promise<void>;
	handleImportCommand: (text: string) => Promise<void>;
	handleShareCommand: () => Promise<void>;
	handleCopyCommand: () => Promise<void>;
	handleNameCommand: (text: string) => void;
	handleSessionCommand: () => void;
	handlePlanCommand: (command: Extract<InteractiveBuiltinCommand, { kind: "plan" }>) => Promise<void> | void;
	handleResearchCommand: (text: string) => void;
	handleDebugCommand: () => void;
	handleWorkspaceCommand: (text: string) => void;
	handleChangelogCommand: () => void;
	handleHotkeysCommand: () => void;
	handleTodoCommand: () => void;
	showUserMessageSelector: () => void;
	showTreeSelector: () => void;
	showOAuthSelector: (mode: "login" | "logout") => void | Promise<void>;
	handleClearCommand: () => Promise<void>;
	handleCompactCommand: (customInstructions?: string) => Promise<void>;
	showContextDialog: () => void;
	clearCustomContextWindow: () => void;
	setCustomContextWindow: (value: number) => void;
	showWarning: (message: string) => void;
	handleReloadCommand: () => Promise<void>;
	handleArminSaysHi: () => void;
	showSessionSelector: () => void;
	toggleVerboseMode: () => void;
	shutdown: () => Promise<void>;
}

export async function dispatchInteractiveBuiltinCommand(
	command: InteractiveBuiltinCommand,
	actions: InteractiveBuiltinCommandActions,
): Promise<void> {
	switch (command.kind) {
		case "settings":
			actions.showSettingsSelector();
			actions.clearEditor();
			return;
		case "scoped-models":
			actions.clearEditor();
			await actions.showModelsSelector();
			return;
		case "model":
			actions.clearEditor();
			await actions.handleModelCommand(command.searchTerm);
			return;
		case "export":
			await actions.handleExportCommand(command.text);
			actions.clearEditor();
			return;
		case "import":
			await actions.handleImportCommand(command.text);
			actions.clearEditor();
			return;
		case "share":
			await actions.handleShareCommand();
			actions.clearEditor();
			return;
		case "copy":
			await actions.handleCopyCommand();
			actions.clearEditor();
			return;
		case "name":
			actions.handleNameCommand(command.text);
			actions.clearEditor();
			return;
		case "session":
			actions.handleSessionCommand();
			actions.clearEditor();
			return;
		case "plan":
			await actions.handlePlanCommand(command);
			actions.clearEditor();
			return;
		case "research":
			actions.handleResearchCommand(command.text);
			actions.clearEditor();
			return;
		case "debug":
			actions.handleDebugCommand();
			actions.clearEditor();
			return;
		case "workspace":
			actions.handleWorkspaceCommand(command.text);
			actions.clearEditor();
			return;
		case "changelog":
			actions.handleChangelogCommand();
			actions.clearEditor();
			return;
		case "hotkeys":
			actions.handleHotkeysCommand();
			actions.clearEditor();
			return;
		case "todo":
			actions.handleTodoCommand();
			actions.clearEditor();
			return;
		case "fork":
			actions.showUserMessageSelector();
			actions.clearEditor();
			return;
		case "tree":
			actions.showTreeSelector();
			actions.clearEditor();
			return;
		case "login":
			await actions.showOAuthSelector("login");
			actions.clearEditor();
			return;
		case "logout":
			await actions.showOAuthSelector("logout");
			actions.clearEditor();
			return;
		case "new":
			actions.clearEditor();
			await actions.handleClearCommand();
			return;
		case "compact":
			actions.clearEditor();
			await actions.handleCompactCommand(command.customInstructions);
			return;
		case "set-context": {
			const action = resolveInteractiveContextWindowCommand(command.arg);
			if (action.type === "show-dialog") {
				actions.showContextDialog();
				return;
			}
			if (action.type === "clear") {
				actions.clearCustomContextWindow();
				actions.clearEditor();
				return;
			}
			if (action.type === "invalid") {
				actions.showWarning(action.message);
				actions.clearEditor();
				return;
			}
			actions.setCustomContextWindow(action.value);
			return;
		}
		case "reload":
			actions.clearEditor();
			await actions.handleReloadCommand();
			return;
		case "arminsayshi":
			actions.handleArminSaysHi();
			actions.clearEditor();
			return;
		case "resume":
			actions.showSessionSelector();
			actions.clearEditor();
			return;
		case "verbose":
			actions.toggleVerboseMode();
			actions.clearEditor();
			return;
		case "quit":
			actions.clearEditor();
			await actions.shutdown();
			return;
	}
}
