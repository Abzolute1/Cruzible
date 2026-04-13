import { describe, expect, test, vi } from "vitest";
import {
	applyConfiguredTheme,
	applyInteractiveRuntimeSettings,
} from "../src/modes/interactive/interactive-runtime-settings.js";

describe("interactive-runtime-settings", () => {
	test("applies editor and UI settings consistently", () => {
		const settings = {
			getTheme: () => "dark",
			getHideThinkingBlock: () => true,
			getClearOnShrink: () => true,
			getShowHardwareCursor: () => false,
			getEditorPaddingX: () => 4,
			getAutocompleteMaxVisible: () => 9,
		};
		const ui = {
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

		const result = applyInteractiveRuntimeSettings({
			settings,
			ui,
			defaultEditor,
			editor,
		});

		expect(result.hideThinkingBlock).toBe(true);
		expect(result.editorPaddingX).toBe(4);
		expect(result.autocompleteMaxVisible).toBe(9);
		expect(ui.setShowHardwareCursor).toHaveBeenCalledWith(false);
		expect(ui.setClearOnShrink).toHaveBeenCalledWith(true);
		expect(defaultEditor.setPaddingX).toHaveBeenCalledWith(4);
		expect(defaultEditor.setAutocompleteMaxVisible).toHaveBeenCalledWith(9);
		expect(editor.setPaddingX).toHaveBeenCalledWith(4);
		expect(editor.setAutocompleteMaxVisible).toHaveBeenCalledWith(9);
	});

	test("applies configured theme from settings", () => {
		const setTheme = vi.fn().mockReturnValue({ success: true });

		const result = applyConfiguredTheme(
			{
				getTheme: () => "noir",
			},
			setTheme,
		);

		expect(setTheme).toHaveBeenCalledWith("noir", true);
		expect(result).toEqual({
			themeName: "noir",
			success: true,
			error: undefined,
		});
	});
});
