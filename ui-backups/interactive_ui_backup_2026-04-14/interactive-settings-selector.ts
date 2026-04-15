import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Transport } from "@mariozechner/pi-ai";
import type { SettingsCallbacks, SettingsConfig } from "./components/settings-selector.js";

export interface InteractiveSettingsSessionLike {
	autoCompactionEnabled: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	thinkingLevel: ThinkingLevel;
	getAvailableThinkingLevels(): ThinkingLevel[];
	setAutoCompactionEnabled(enabled: boolean): void;
	setSteeringMode(mode: "all" | "one-at-a-time"): void;
	setFollowUpMode(mode: "all" | "one-at-a-time"): void;
	setThinkingLevel(level: ThinkingLevel): void;
	agent: { transport: Transport };
}

export interface InteractiveSettingsManagerLike {
	getShowImages(): boolean;
	setShowImages(enabled: boolean): void;
	getImageAutoResize(): boolean;
	setImageAutoResize(enabled: boolean): void;
	getBlockImages(): boolean;
	setBlockImages(enabled: boolean): void;
	getEnableSkillCommands(): boolean;
	setEnableSkillCommands(enabled: boolean): void;
	getTransport(): Transport;
	setTransport(transport: Transport): void;
	getTheme(): string | undefined;
	setTheme(themeName: string): void;
	getCollapseChangelog(): boolean;
	setCollapseChangelog(enabled: boolean): void;
	getDoubleEscapeAction(): "fork" | "tree" | "none";
	setDoubleEscapeAction(action: "fork" | "tree" | "none"): void;
	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void;
	getShowHardwareCursor(): boolean;
	setShowHardwareCursor(enabled: boolean): void;
	getEditorPaddingX(): number;
	setEditorPaddingX(padding: number): void;
	getAutocompleteMaxVisible(): number;
	setAutocompleteMaxVisible(maxVisible: number): void;
	getQuietStartup(): boolean;
	setQuietStartup(enabled: boolean): void;
	getClearOnShrink(): boolean;
	setClearOnShrink(enabled: boolean): void;
	setHideThinkingBlock(hidden: boolean): void;
}

export interface InteractiveSettingsFooterLike {
	setAutoCompactEnabled(enabled: boolean): void;
	invalidate(): void;
}

export interface InteractiveSettingsUiLike {
	invalidate(): void;
	requestRender(): void;
	setShowHardwareCursor(enabled: boolean): void;
	setClearOnShrink(enabled: boolean): void;
}

export interface InteractiveSettingsEditorLike {
	setPaddingX?(padding: number): void;
	setAutocompleteMaxVisible?(maxVisible: number): void;
}

export function buildInteractiveSettingsConfig(options: {
	session: InteractiveSettingsSessionLike;
	settingsManager: InteractiveSettingsManagerLike;
	hideThinkingBlock: boolean;
	availableThemes: string[];
}): SettingsConfig {
	return {
		autoCompact: options.session.autoCompactionEnabled,
		showImages: options.settingsManager.getShowImages(),
		autoResizeImages: options.settingsManager.getImageAutoResize(),
		blockImages: options.settingsManager.getBlockImages(),
		enableSkillCommands: options.settingsManager.getEnableSkillCommands(),
		steeringMode: options.session.steeringMode,
		followUpMode: options.session.followUpMode,
		transport: options.settingsManager.getTransport(),
		thinkingLevel: options.session.thinkingLevel,
		availableThinkingLevels: options.session.getAvailableThinkingLevels(),
		currentTheme: options.settingsManager.getTheme() || "dark",
		availableThemes: options.availableThemes,
		hideThinkingBlock: options.hideThinkingBlock,
		collapseChangelog: options.settingsManager.getCollapseChangelog(),
		doubleEscapeAction: options.settingsManager.getDoubleEscapeAction(),
		treeFilterMode: options.settingsManager.getTreeFilterMode(),
		showHardwareCursor: options.settingsManager.getShowHardwareCursor(),
		editorPaddingX: options.settingsManager.getEditorPaddingX(),
		autocompleteMaxVisible: options.settingsManager.getAutocompleteMaxVisible(),
		quietStartup: options.settingsManager.getQuietStartup(),
		clearOnShrink: options.settingsManager.getClearOnShrink(),
	};
}

export function createInteractiveSettingsCallbacks(options: {
	session: InteractiveSettingsSessionLike;
	settingsManager: InteractiveSettingsManagerLike;
	footer: InteractiveSettingsFooterLike;
	ui: InteractiveSettingsUiLike;
	defaultEditor: InteractiveSettingsEditorLike;
	editor: InteractiveSettingsEditorLike;
	applyTheme: (themeName: string) => { success: boolean; error?: string };
	showError: (message: string) => void;
	setupAutocomplete: () => void;
	updateEditorBorderColor: () => void;
	applyShowImages: (enabled: boolean) => void;
	applyHideThinkingBlock: (hidden: boolean) => void;
	closeSelector: () => void;
}): SettingsCallbacks {
	return {
		onAutoCompactChange: (enabled) => {
			options.session.setAutoCompactionEnabled(enabled);
			options.footer.setAutoCompactEnabled(enabled);
		},
		onShowImagesChange: (enabled) => {
			options.settingsManager.setShowImages(enabled);
			options.applyShowImages(enabled);
		},
		onAutoResizeImagesChange: (enabled) => {
			options.settingsManager.setImageAutoResize(enabled);
		},
		onBlockImagesChange: (blocked) => {
			options.settingsManager.setBlockImages(blocked);
		},
		onEnableSkillCommandsChange: (enabled) => {
			options.settingsManager.setEnableSkillCommands(enabled);
			options.setupAutocomplete();
		},
		onSteeringModeChange: (mode) => {
			options.session.setSteeringMode(mode);
		},
		onFollowUpModeChange: (mode) => {
			options.session.setFollowUpMode(mode);
		},
		onTransportChange: (transport) => {
			options.settingsManager.setTransport(transport);
			options.session.agent.transport = transport;
		},
		onThinkingLevelChange: (level) => {
			options.session.setThinkingLevel(level);
			options.footer.invalidate();
			options.updateEditorBorderColor();
		},
		onThemeChange: (themeName) => {
			const result = options.applyTheme(themeName);
			options.settingsManager.setTheme(themeName);
			options.ui.invalidate();
			if (!result.success) {
				options.showError(`Failed to load theme "${themeName}": ${result.error}\nFell back to dark theme.`);
			}
		},
		onThemePreview: (themeName) => {
			const result = options.applyTheme(themeName);
			if (result.success) {
				options.ui.invalidate();
				options.ui.requestRender();
			}
		},
		onHideThinkingBlockChange: (hidden) => {
			options.settingsManager.setHideThinkingBlock(hidden);
			options.applyHideThinkingBlock(hidden);
		},
		onCollapseChangelogChange: (collapsed) => {
			options.settingsManager.setCollapseChangelog(collapsed);
		},
		onQuietStartupChange: (enabled) => {
			options.settingsManager.setQuietStartup(enabled);
		},
		onDoubleEscapeActionChange: (action) => {
			options.settingsManager.setDoubleEscapeAction(action);
		},
		onTreeFilterModeChange: (mode) => {
			options.settingsManager.setTreeFilterMode(mode);
		},
		onShowHardwareCursorChange: (enabled) => {
			options.settingsManager.setShowHardwareCursor(enabled);
			options.ui.setShowHardwareCursor(enabled);
		},
		onEditorPaddingXChange: (padding) => {
			options.settingsManager.setEditorPaddingX(padding);
			options.defaultEditor.setPaddingX?.(padding);
			if (options.editor !== options.defaultEditor) {
				options.editor.setPaddingX?.(padding);
			}
		},
		onAutocompleteMaxVisibleChange: (maxVisible) => {
			options.settingsManager.setAutocompleteMaxVisible(maxVisible);
			options.defaultEditor.setAutocompleteMaxVisible?.(maxVisible);
			if (options.editor !== options.defaultEditor) {
				options.editor.setAutocompleteMaxVisible?.(maxVisible);
			}
		},
		onClearOnShrinkChange: (enabled) => {
			options.settingsManager.setClearOnShrink(enabled);
			options.ui.setClearOnShrink(enabled);
		},
		onCancel: () => {
			options.closeSelector();
		},
	};
}
