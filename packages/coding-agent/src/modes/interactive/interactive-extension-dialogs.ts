import type { Container, EditorComponent, TUI } from "@ag1/tui";
import type { ExtensionUIDialogOptions } from "../../core/extensions/index.js";
import type { KeybindingsManager } from "../../core/keybindings.js";
import { ExtensionEditorComponent } from "./components/extension-editor.js";
import { ExtensionInputComponent } from "./components/extension-input.js";
import { ExtensionSelectorComponent } from "./components/extension-selector.js";
import { PlanWorkflowDialogComponent, type PlanWorkflowDialogOption } from "./components/plan-workflow-dialog.js";
import { restoreEditorHost, showEditorHostComponent } from "./interactive-editor-host.js";

export interface ExtensionDialogStackOptions {
	ui: TUI;
	keybindings: KeybindingsManager;
	editorContainer: Container;
	/** Read at call time: the editor component may be swapped by setCustomEditorComponent. */
	getEditor: () => EditorComponent;
	showStatus: (message: string) => void;
	showWarning: (message: string) => void;
	showError: (message: string) => void;
}

export class ExtensionDialogStack {
	private extensionSelector: ExtensionSelectorComponent | undefined = undefined;
	private planWorkflowDialog: PlanWorkflowDialogComponent | undefined = undefined;
	private planWorkflowDialogResolver: ((value: string | undefined) => void) | undefined = undefined;
	private extensionInput: ExtensionInputComponent | undefined = undefined;
	private extensionEditor: ExtensionEditorComponent | undefined = undefined;

	constructor(private readonly options: ExtensionDialogStackOptions) {}

	/**
	 * Show a selector for extensions.
	 */
	showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionSelector();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(option);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(undefined);
				},
				{ tui: this.options.ui, timeout: opts?.timeout },
			);

			showEditorHostComponent({
				container: this.options.editorContainer,
				ui: this.options.ui,
				component: this.extensionSelector,
			});
		});
	}

	showPlanWorkflowDialog(
		title: string,
		lines: string[],
		options: PlanWorkflowDialogOption[],
		dialogOptions?: { accent?: "accent" | "warning" | "success" },
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.planWorkflowDialogResolver = resolve;
			this.planWorkflowDialog = new PlanWorkflowDialogComponent({
				title,
				lines,
				options,
				accent: dialogOptions?.accent,
				onSelect: (option) => {
					this.closePlanWorkflowDialog();
					this.settlePlanWorkflowDialog(option);
				},
				onCancel: () => {
					this.closePlanWorkflowDialog();
					this.settlePlanWorkflowDialog(undefined);
				},
			});

			showEditorHostComponent({
				container: this.options.editorContainer,
				ui: this.options.ui,
				component: this.planWorkflowDialog,
			});
		});
	}

	private settlePlanWorkflowDialog(value: string | undefined): void {
		const resolve = this.planWorkflowDialogResolver;
		this.planWorkflowDialogResolver = undefined;
		resolve?.(value);
	}

	/**
	 * Hide the extension selector.
	 */
	hideExtensionSelector(): void {
		this.extensionSelector?.dispose();
		restoreEditorHost({
			container: this.options.editorContainer,
			ui: this.options.ui,
			editor: this.options.getEditor(),
		});
		this.extensionSelector = undefined;
	}

	private closePlanWorkflowDialog(): void {
		restoreEditorHost({
			container: this.options.editorContainer,
			ui: this.options.ui,
			editor: this.options.getEditor(),
		});
		this.planWorkflowDialog = undefined;
	}

	hidePlanWorkflowDialog(): void {
		this.closePlanWorkflowDialog();
		this.settlePlanWorkflowDialog(undefined);
	}

	/**
	 * Show a confirmation dialog for extensions.
	 */
	async showExtensionConfirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts);
		return result === "Yes";
	}

	/**
	 * Show a text input for extensions.
	 */
	showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions & { initialValue?: string },
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionInput();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionInput = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(value);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(undefined);
				},
				{ tui: this.options.ui, timeout: opts?.timeout, initialValue: opts?.initialValue },
			);

			showEditorHostComponent({
				container: this.options.editorContainer,
				ui: this.options.ui,
				component: this.extensionInput,
			});
		});
	}

	/**
	 * Hide the extension input.
	 */
	hideExtensionInput(): void {
		this.extensionInput?.dispose();
		restoreEditorHost({
			container: this.options.editorContainer,
			ui: this.options.ui,
			editor: this.options.getEditor(),
		});
		this.extensionInput = undefined;
	}

	/**
	 * Show a multi-line editor for extensions (with Ctrl+G support).
	 */
	showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.extensionEditor = new ExtensionEditorComponent(
				this.options.ui,
				this.options.keybindings,
				title,
				prefill,
				(value) => {
					this.hideExtensionEditor();
					resolve(value);
				},
				() => {
					this.hideExtensionEditor();
					resolve(undefined);
				},
			);

			showEditorHostComponent({
				container: this.options.editorContainer,
				ui: this.options.ui,
				component: this.extensionEditor,
			});
		});
	}

	/**
	 * Hide the extension editor.
	 */
	hideExtensionEditor(): void {
		restoreEditorHost({
			container: this.options.editorContainer,
			ui: this.options.ui,
			editor: this.options.getEditor(),
		});
		this.extensionEditor = undefined;
	}

	/**
	 * Show a notification for extensions.
	 */
	showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.options.showError(message);
		} else if (type === "warning") {
			this.options.showWarning(message);
		} else {
			this.options.showStatus(message);
		}
	}

	resetExtensionDialogs(): void {
		if (this.extensionSelector) {
			this.hideExtensionSelector();
		}
		if (this.planWorkflowDialog) {
			this.hidePlanWorkflowDialog();
		}
		if (this.extensionInput) {
			this.hideExtensionInput();
		}
		if (this.extensionEditor) {
			this.hideExtensionEditor();
		}
	}
}
