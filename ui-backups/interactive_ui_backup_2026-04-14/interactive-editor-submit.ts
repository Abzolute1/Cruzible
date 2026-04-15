export interface InteractiveEditorSubmitState {
	isBashRunning: boolean;
	isPlanningMode: boolean;
	isCompacting: boolean;
	isStreaming: boolean;
	isExtensionCommand: (text: string) => boolean;
}

export interface InteractiveEditorSubmitActions {
	showWarning: (message: string) => void;
	restoreEditorText: (text: string) => void;
	addToHistory: (text: string) => void;
	clearEditor: () => void;
	handleBashCommand: (command: string, excludeFromContext: boolean) => Promise<void>;
	setBashModeEnabled: (enabled: boolean) => void;
	queueCompactionMessage: (text: string, mode: "steer" | "followUp") => void;
	prompt: (text: string, options?: { streamingBehavior?: "steer" | "followUp" }) => Promise<void>;
	updatePendingMessagesDisplay: () => void;
	requestRender: () => void;
	flushPendingBashComponents: () => void;
	dispatchNormalInput: (text: string) => void;
}

export async function handleInteractiveEditorSubmitAfterBuiltin(
	text: string,
	state: InteractiveEditorSubmitState,
	actions: InteractiveEditorSubmitActions,
): Promise<boolean> {
	if (text.startsWith("!")) {
		if (state.isPlanningMode) {
			actions.showWarning("Bash shortcuts are blocked in planning mode. Switch to interactive or autonomous mode to execute shell commands.");
			actions.restoreEditorText(text);
			return true;
		}
		const isExcluded = text.startsWith("!!");
		const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
		if (command) {
			if (state.isBashRunning) {
				actions.showWarning("A bash command is already running. Press Esc to cancel it first.");
				actions.restoreEditorText(text);
				return true;
			}
			actions.addToHistory(text);
			await actions.handleBashCommand(command, isExcluded);
			actions.setBashModeEnabled(false);
			return true;
		}
	}

	if (state.isCompacting) {
		if (state.isExtensionCommand(text)) {
			actions.addToHistory(text);
			actions.clearEditor();
			await actions.prompt(text);
		} else {
			actions.queueCompactionMessage(text, "steer");
		}
		return true;
	}

	if (state.isStreaming) {
		actions.addToHistory(text);
		actions.clearEditor();
		await actions.prompt(text, { streamingBehavior: "steer" });
		actions.updatePendingMessagesDisplay();
		actions.requestRender();
		return true;
	}

	actions.flushPendingBashComponents();
	actions.dispatchNormalInput(text);
	actions.addToHistory(text);
	return false;
}
