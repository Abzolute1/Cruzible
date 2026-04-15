import { describe, expect, test, vi } from "vitest";
import {
	getInteractiveAppKeyDisplay,
	getInteractiveEditorKeyDisplay,
	renderInteractiveChangelog,
	renderInteractiveHotkeys,
} from "../src/modes/interactive/interactive-reference-actions.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("interactive-reference-actions", () => {
	test("returns string displays for app and editor key lookups", () => {
		expect(typeof getInteractiveAppKeyDisplay("app.model.select")).toBe("string");
		expect(typeof getInteractiveEditorKeyDisplay("tui.input.submit")).toBe("string");
	});

	test("renders changelog content through the shared presenter", () => {
		initTheme("dark", false);
		const chatContainer = { addChild: vi.fn() };
		const ui = { requestRender: vi.fn() };

		renderInteractiveChangelog({
			chatContainer,
			ui,
			getMarkdownThemeWithSettings: () => ({}) as any,
			entries: [{ content: "## [0.65.2]\n\n- Hardened startup" }],
		});

		expect(chatContainer.addChild).toHaveBeenCalled();
		expect(ui.requestRender).toHaveBeenCalledOnce();
	});

	test("renders hotkeys with extension shortcuts through the shared presenter", () => {
		initTheme("dark", false);
		const chatContainer = { addChild: vi.fn() };
		const ui = { requestRender: vi.fn() };

		renderInteractiveHotkeys({
			chatContainer,
			ui,
			getMarkdownThemeWithSettings: () => ({}) as any,
			platform: "linux",
			extensionShortcuts: [{ key: "ctrl+k", description: "Run custom extension action" }],
		});

		expect(chatContainer.addChild).toHaveBeenCalled();
		expect(ui.requestRender).toHaveBeenCalledOnce();
	});
});
