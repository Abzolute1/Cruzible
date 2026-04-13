import { describe, expect, test, vi } from "vitest";
import {
	buildInteractiveSettingsConfig,
	createInteractiveSettingsCallbacks,
} from "../src/modes/interactive/interactive-settings-selector.js";

describe("interactive-settings-selector", () => {
	test("builds settings config from session and settings state", () => {
		const config = buildInteractiveSettingsConfig({
			session: {
				autoCompactionEnabled: true,
				steeringMode: "all",
				followUpMode: "one-at-a-time",
				thinkingLevel: "medium",
				getAvailableThinkingLevels: () => ["low", "medium", "high"],
				setAutoCompactionEnabled: vi.fn(),
				setSteeringMode: vi.fn(),
				setFollowUpMode: vi.fn(),
				setThinkingLevel: vi.fn(),
				agent: { transport: "auto" },
			},
			settingsManager: {
				getShowImages: () => true,
				setShowImages: vi.fn(),
				getImageAutoResize: () => false,
				setImageAutoResize: vi.fn(),
				getBlockImages: () => false,
				setBlockImages: vi.fn(),
				getEnableSkillCommands: () => true,
				setEnableSkillCommands: vi.fn(),
				getTransport: () => "websocket",
				setTransport: vi.fn(),
				getTheme: () => "ocean",
				setTheme: vi.fn(),
				getCollapseChangelog: () => true,
				setCollapseChangelog: vi.fn(),
				getDoubleEscapeAction: () => "tree",
				setDoubleEscapeAction: vi.fn(),
				getTreeFilterMode: () => "user-only",
				setTreeFilterMode: vi.fn(),
				getShowHardwareCursor: () => true,
				setShowHardwareCursor: vi.fn(),
				getEditorPaddingX: () => 2,
				setEditorPaddingX: vi.fn(),
				getAutocompleteMaxVisible: () => 7,
				setAutocompleteMaxVisible: vi.fn(),
				getQuietStartup: () => false,
				setQuietStartup: vi.fn(),
				getClearOnShrink: () => true,
				setClearOnShrink: vi.fn(),
				setHideThinkingBlock: vi.fn(),
			},
			hideThinkingBlock: false,
			availableThemes: ["dark", "ocean"],
		});

		expect(config).toEqual({
			autoCompact: true,
			showImages: true,
			autoResizeImages: false,
			blockImages: false,
			enableSkillCommands: true,
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			transport: "websocket",
			thinkingLevel: "medium",
			availableThinkingLevels: ["low", "medium", "high"],
			currentTheme: "ocean",
			availableThemes: ["dark", "ocean"],
			hideThinkingBlock: false,
			collapseChangelog: true,
			doubleEscapeAction: "tree",
			treeFilterMode: "user-only",
			showHardwareCursor: true,
			editorPaddingX: 2,
			autocompleteMaxVisible: 7,
			quietStartup: false,
			clearOnShrink: true,
		});
	});

	test("routes callbacks to the expected side effects", () => {
		const session = {
			autoCompactionEnabled: false,
			steeringMode: "one-at-a-time" as const,
			followUpMode: "all" as const,
			thinkingLevel: "low" as const,
			getAvailableThinkingLevels: () => ["low", "medium"] as const,
			setAutoCompactionEnabled: vi.fn(),
			setSteeringMode: vi.fn(),
			setFollowUpMode: vi.fn(),
			setThinkingLevel: vi.fn(),
			agent: { transport: "auto" as const },
		};
		const settingsManager = {
			getShowImages: () => false,
			setShowImages: vi.fn(),
			getImageAutoResize: () => false,
			setImageAutoResize: vi.fn(),
			getBlockImages: () => false,
			setBlockImages: vi.fn(),
			getEnableSkillCommands: () => false,
			setEnableSkillCommands: vi.fn(),
			getTransport: () => "auto" as const,
			setTransport: vi.fn(),
			getTheme: () => undefined,
			setTheme: vi.fn(),
			getCollapseChangelog: () => false,
			setCollapseChangelog: vi.fn(),
			getDoubleEscapeAction: () => "none" as const,
			setDoubleEscapeAction: vi.fn(),
			getTreeFilterMode: () => "default" as const,
			setTreeFilterMode: vi.fn(),
			getShowHardwareCursor: () => false,
			setShowHardwareCursor: vi.fn(),
			getEditorPaddingX: () => 1,
			setEditorPaddingX: vi.fn(),
			getAutocompleteMaxVisible: () => 5,
			setAutocompleteMaxVisible: vi.fn(),
			getQuietStartup: () => false,
			setQuietStartup: vi.fn(),
			getClearOnShrink: () => false,
			setClearOnShrink: vi.fn(),
			setHideThinkingBlock: vi.fn(),
		};
		const footer = { setAutoCompactEnabled: vi.fn(), invalidate: vi.fn() };
		const ui = {
			invalidate: vi.fn(),
			requestRender: vi.fn(),
			setShowHardwareCursor: vi.fn(),
			setClearOnShrink: vi.fn(),
		};
		const defaultEditor = {
			setPaddingX: vi.fn(),
			setAutocompleteMaxVisible: vi.fn(),
		};
		const editor = {
			setPaddingX: vi.fn(),
			setAutocompleteMaxVisible: vi.fn(),
		};
		const applyTheme = vi
			.fn()
			.mockReturnValueOnce({ success: false, error: "boom" })
			.mockReturnValueOnce({ success: true });
		const showError = vi.fn();
		const setupAutocomplete = vi.fn();
		const updateEditorBorderColor = vi.fn();
		const applyShowImages = vi.fn();
		const applyHideThinkingBlock = vi.fn();
		const closeSelector = vi.fn();

		const callbacks = createInteractiveSettingsCallbacks({
			session,
			settingsManager,
			footer,
			ui,
			defaultEditor,
			editor,
			applyTheme,
			showError,
			setupAutocomplete,
			updateEditorBorderColor,
			applyShowImages,
			applyHideThinkingBlock,
			closeSelector,
		});

		callbacks.onAutoCompactChange(true);
		callbacks.onShowImagesChange(true);
		callbacks.onEnableSkillCommandsChange(true);
		callbacks.onThinkingLevelChange("medium");
		callbacks.onThemeChange("dark");
		callbacks.onThemePreview?.("dark");
		callbacks.onHideThinkingBlockChange(true);
		callbacks.onShowHardwareCursorChange(true);
		callbacks.onEditorPaddingXChange(3);
		callbacks.onAutocompleteMaxVisibleChange(10);
		callbacks.onClearOnShrinkChange(true);
		callbacks.onCancel();

		expect(session.setAutoCompactionEnabled).toHaveBeenCalledWith(true);
		expect(footer.setAutoCompactEnabled).toHaveBeenCalledWith(true);
		expect(settingsManager.setShowImages).toHaveBeenCalledWith(true);
		expect(applyShowImages).toHaveBeenCalledWith(true);
		expect(settingsManager.setEnableSkillCommands).toHaveBeenCalledWith(true);
		expect(setupAutocomplete).toHaveBeenCalledOnce();
		expect(session.setThinkingLevel).toHaveBeenCalledWith("medium");
		expect(footer.invalidate).toHaveBeenCalledOnce();
		expect(updateEditorBorderColor).toHaveBeenCalledOnce();
		expect(settingsManager.setTheme).toHaveBeenCalledWith("dark");
		expect(showError).toHaveBeenCalledWith('Failed to load theme "dark": boom\nFell back to dark theme.');
		expect(ui.invalidate).toHaveBeenCalled();
		expect(ui.requestRender).toHaveBeenCalled();
		expect(settingsManager.setHideThinkingBlock).toHaveBeenCalledWith(true);
		expect(applyHideThinkingBlock).toHaveBeenCalledWith(true);
		expect(settingsManager.setShowHardwareCursor).toHaveBeenCalledWith(true);
		expect(ui.setShowHardwareCursor).toHaveBeenCalledWith(true);
		expect(settingsManager.setEditorPaddingX).toHaveBeenCalledWith(3);
		expect(defaultEditor.setPaddingX).toHaveBeenCalledWith(3);
		expect(editor.setPaddingX).toHaveBeenCalledWith(3);
		expect(settingsManager.setAutocompleteMaxVisible).toHaveBeenCalledWith(10);
		expect(defaultEditor.setAutocompleteMaxVisible).toHaveBeenCalledWith(10);
		expect(editor.setAutocompleteMaxVisible).toHaveBeenCalledWith(10);
		expect(settingsManager.setClearOnShrink).toHaveBeenCalledWith(true);
		expect(ui.setClearOnShrink).toHaveBeenCalledWith(true);
		expect(closeSelector).toHaveBeenCalledOnce();
	});
});
