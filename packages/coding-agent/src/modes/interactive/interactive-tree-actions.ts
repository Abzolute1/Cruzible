export interface InteractiveTreeNavigationResult {
	editorText?: string;
	cancelled: boolean;
	aborted?: boolean;
}

export function applyInteractiveTreeNavigationSuccess(options: {
	result: Pick<InteractiveTreeNavigationResult, "editorText">;
	clearChat: () => void;
	renderInitialMessages: () => void;
	getEditorText: () => string;
	setEditorText: (text: string) => void;
	showStatus: (message: string) => void;
}): void {
	options.clearChat();
	options.renderInitialMessages();
	if (options.result.editorText && !options.getEditorText().trim()) {
		options.setEditorText(options.result.editorText);
	}
	options.showStatus("Navigated to selected point");
}

export async function performInteractiveTreeNavigation(options: {
	navigateTree: () => Promise<InteractiveTreeNavigationResult>;
	enableSummaryUi?: () => () => void;
	applySuccess: (result: InteractiveTreeNavigationResult) => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	onAborted?: () => void;
}): Promise<void> {
	const cleanup = options.enableSummaryUi?.() ?? (() => {});

	try {
		const result = await options.navigateTree();
		if (result.aborted) {
			options.showStatus("Branch summarization cancelled");
			options.onAborted?.();
			return;
		}
		if (result.cancelled) {
			options.showStatus("Navigation cancelled");
			return;
		}

		options.applySuccess(result);
	} catch (error) {
		options.showError(error instanceof Error ? error.message : String(error));
	} finally {
		cleanup();
	}
}
