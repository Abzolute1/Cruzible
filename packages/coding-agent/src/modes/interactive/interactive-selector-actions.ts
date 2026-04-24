import type { Model } from "@ag1/ai";
import { SessionManager } from "../../core/session-manager.js";

export async function performInteractiveModelSwitch(options: {
	model: Model<any>;
	setModel: (model: Model<any>) => Promise<void>;
	invalidateFooter: () => void;
	updateEditorBorderColor: () => void;
	closeSelector: () => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	onModelSelected?: (model: Model<any>) => void;
}): Promise<void> {
	try {
		await options.setModel(options.model);
		options.invalidateFooter();
		options.updateEditorBorderColor();
		options.closeSelector();
		options.showStatus(`Model: ${options.model.id}`);
		options.onModelSelected?.(options.model);
	} catch (error) {
		options.closeSelector();
		options.showError(error instanceof Error ? error.message : String(error));
	}
}

export async function renameInteractiveSession(sessionFilePath: string, nextName: string | undefined): Promise<void> {
	const next = (nextName ?? "").trim();
	if (!next) return;
	const manager = SessionManager.open(sessionFilePath);
	manager.appendSessionInfo(next);
}
