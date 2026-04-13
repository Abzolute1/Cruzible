export interface InteractiveRuntimeSettingsSource {
	getTheme(): string | undefined;
	getHideThinkingBlock(): boolean;
	getClearOnShrink(): boolean;
	getShowHardwareCursor(): boolean;
	getEditorPaddingX(): number;
	getAutocompleteMaxVisible(): number;
}

export interface InteractiveEditorSettingsTarget {
	setPaddingX?(padding: number): void;
	setAutocompleteMaxVisible?(maxVisible: number): void;
}

export interface InteractiveUiSettingsTarget {
	setShowHardwareCursor(enabled: boolean): void;
	setClearOnShrink(enabled: boolean): void;
}

export function applyInteractiveRuntimeSettings(options: {
	settings: InteractiveRuntimeSettingsSource;
	ui: InteractiveUiSettingsTarget;
	defaultEditor: InteractiveEditorSettingsTarget;
	editor: InteractiveEditorSettingsTarget;
}): {
	hideThinkingBlock: boolean;
	editorPaddingX: number;
	autocompleteMaxVisible: number;
} {
	const editorPaddingX = options.settings.getEditorPaddingX();
	const autocompleteMaxVisible = options.settings.getAutocompleteMaxVisible();

	options.ui.setShowHardwareCursor(options.settings.getShowHardwareCursor());
	options.ui.setClearOnShrink(options.settings.getClearOnShrink());
	options.defaultEditor.setPaddingX?.(editorPaddingX);
	options.defaultEditor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);

	if (options.editor !== options.defaultEditor) {
		options.editor.setPaddingX?.(editorPaddingX);
		options.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
	}

	return {
		hideThinkingBlock: options.settings.getHideThinkingBlock(),
		editorPaddingX,
		autocompleteMaxVisible,
	};
}

export function applyConfiguredTheme(
	settings: Pick<InteractiveRuntimeSettingsSource, "getTheme">,
	setThemeFn: (themeName: string, persist?: boolean) => { success: boolean; error?: string },
): { themeName: string | undefined; success: boolean; error?: string } {
	const themeName = settings.getTheme();
	if (!themeName) {
		return { themeName: undefined, success: true };
	}

	const result = setThemeFn(themeName, true);
	return {
		themeName,
		success: result.success,
		error: result.error,
	};
}
