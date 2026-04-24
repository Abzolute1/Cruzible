import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "child_process";
import type { Component } from "@ag1/tui";
import { copyToClipboard } from "../../utils/clipboard.js";
import { getShareViewerUrl } from "../../config.js";
import { BorderedLoader } from "./components/bordered-loader.js";
import {
	restoreEditorHost,
	showEditorHostComponent,
	type InteractiveEditorHostUi,
	type InteractiveEditorHostContainer,
} from "./interactive-editor-host.js";
import { theme } from "./theme/theme.js";

export interface InteractiveReloadActions {
	isStreaming: boolean;
	isCompacting: boolean;
	resetExtensionUI: () => void;
	ui: InteractiveEditorHostUi;
	editorContainer: InteractiveEditorHostContainer;
	editor: Component;
	showWarning: (message: string) => void;
	showError: (message: string) => void;
	showStatus: (message: string) => void;
	reload: () => Promise<void>;
}

export async function performInteractiveReload(options: InteractiveReloadActions): Promise<boolean> {
	if (options.isStreaming) {
		options.showWarning("Wait for the current response to finish before reloading.");
		return false;
	}
	if (options.isCompacting) {
		options.showWarning("Wait for compaction to finish before reloading.");
		return false;
	}

	options.resetExtensionUI();

	const loader = new BorderedLoader(
		options.ui as ConstructorParameters<typeof BorderedLoader>[0],
		theme,
		"Reloading keybindings, extensions, skills, prompts, themes...",
		{
			cancellable: false,
		},
	);
	const previousEditor = options.editor;
	showEditorHostComponent({
		container: options.editorContainer,
		ui: options.ui,
		component: loader,
	});

	const dismissLoader = (editor: Component) => {
		loader.dispose();
		restoreEditorHost({
			container: options.editorContainer,
			ui: options.ui,
			editor,
		});
	};

	try {
		await options.reload();
		dismissLoader(options.editor);
		options.showStatus("Reloaded keybindings, extensions, skills, prompts, themes");
		return true;
	} catch (error) {
		dismissLoader(previousEditor);
		options.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

export interface InteractiveSessionExportActions {
	exportToJsonl: (outputPath?: string) => string;
	exportToHtml: (outputPath?: string) => Promise<string>;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
}

export async function performInteractiveSessionExport(
	text: string,
	actions: InteractiveSessionExportActions,
): Promise<void> {
	const parts = text.split(/\s+/);
	const outputPath = parts.length > 1 ? parts[1] : undefined;

	try {
		if (outputPath?.endsWith(".jsonl")) {
			const filePath = actions.exportToJsonl(outputPath);
			actions.showStatus(`Session exported to: ${filePath}`);
			return;
		}
		const filePath = await actions.exportToHtml(outputPath);
		actions.showStatus(`Session exported to: ${filePath}`);
	} catch (error: unknown) {
		actions.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
	}
}

export interface InteractiveSessionShareActions {
	ui: InteractiveEditorHostUi;
	editorContainer: InteractiveEditorHostContainer;
	editor: Component;
	exportToHtml: (outputPath?: string) => Promise<string>;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	spawnSyncImpl?: typeof spawnSync;
	spawnImpl?: typeof spawn;
	unlinkSyncImpl?: typeof fs.unlinkSync;
	tmpDir?: string;
}

export async function performInteractiveSessionShare(actions: InteractiveSessionShareActions): Promise<void> {
	const runSpawnSync = actions.spawnSyncImpl ?? spawnSync;
	const runSpawn = actions.spawnImpl ?? spawn;
	const unlinkSync = actions.unlinkSyncImpl ?? fs.unlinkSync;
	const tmpFile = path.join(actions.tmpDir ?? os.tmpdir(), "session.html");

	try {
		const authResult = runSpawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
		if (authResult.status !== 0) {
			actions.showError("GitHub CLI is not logged in. Run 'gh auth login' first.");
			return;
		}
	} catch {
		actions.showError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
		return;
	}

	try {
		await actions.exportToHtml(tmpFile);
	} catch (error: unknown) {
		actions.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		return;
	}

	const loader = new BorderedLoader(actions.ui as ConstructorParameters<typeof BorderedLoader>[0], theme, "Creating gist...");
	showEditorHostComponent({
		container: actions.editorContainer,
		ui: actions.ui,
		component: loader,
	});

	const restoreEditor = () => {
		loader.dispose();
		restoreEditorHost({
			container: actions.editorContainer,
			ui: actions.ui,
			editor: actions.editor,
		});
		try {
			unlinkSync(tmpFile);
		} catch {
			// Ignore cleanup errors
		}
	};

	let proc: ReturnType<typeof spawn> | null = null;
	loader.onAbort = () => {
		proc?.kill();
		restoreEditor();
		actions.showStatus("Share cancelled");
	};

	try {
		const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
			proc = runSpawn("gh", ["gist", "create", "--public=false", tmpFile]);
			let stdout = "";
			let stderr = "";
			proc.stdout?.on("data", (data) => {
				stdout += data.toString();
			});
			proc.stderr?.on("data", (data) => {
				stderr += data.toString();
			});
			proc.on("close", (code) => resolve({ stdout, stderr, code }));
		});

		if (loader.signal.aborted) return;

		restoreEditor();

		if (result.code !== 0) {
			const errorMsg = result.stderr?.trim() || "Unknown error";
			actions.showError(`Failed to create gist: ${errorMsg}`);
			return;
		}

		const gistUrl = result.stdout?.trim();
		const gistId = gistUrl?.split("/").pop();
		if (!gistId) {
			actions.showError("Failed to parse gist ID from gh output");
			return;
		}

		const previewUrl = getShareViewerUrl(gistId);
		actions.showStatus(`Share URL: ${previewUrl}\nGist: ${gistUrl}`);
	} catch (error: unknown) {
		if (!loader.signal.aborted) {
			restoreEditor();
			actions.showError(`Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}
}

export interface InteractiveCopyActions {
	getLastAssistantText: () => string | undefined;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	copyToClipboardImpl?: typeof copyToClipboard;
}

export async function performInteractiveCopyLastAssistantMessage(actions: InteractiveCopyActions): Promise<void> {
	const text = actions.getLastAssistantText();
	if (!text) {
		actions.showError("No agent messages to copy yet.");
		return;
	}

	try {
		await (actions.copyToClipboardImpl ?? copyToClipboard)(text);
		actions.showStatus("Copied last agent message to clipboard");
	} catch (error) {
		actions.showError(error instanceof Error ? error.message : String(error));
	}
}
