import { describe, expect, test, vi } from "vitest";
import { restoreEditorHost, showEditorHostComponent } from "../src/modes/interactive/interactive-editor-host.js";

describe("interactive-editor-host", () => {
	test("showEditorHostComponent mounts the component and focuses it by default", () => {
		const container = {
			clear: vi.fn(),
			addChild: vi.fn(),
		};
		const ui = {
			setFocus: vi.fn(),
			requestRender: vi.fn(),
		};
		const component = {} as any;

		showEditorHostComponent({
			container,
			ui,
			component,
		});

		expect(container.clear).toHaveBeenCalledOnce();
		expect(container.addChild).toHaveBeenCalledWith(component);
		expect(ui.setFocus).toHaveBeenCalledWith(component);
		expect(ui.requestRender).toHaveBeenCalledOnce();
	});

	test("showEditorHostComponent uses an explicit focus target when provided", () => {
		const container = {
			clear: vi.fn(),
			addChild: vi.fn(),
		};
		const ui = {
			setFocus: vi.fn(),
			requestRender: vi.fn(),
		};
		const component = {} as any;
		const focus = {} as any;

		showEditorHostComponent({
			container,
			ui,
			component,
			focus,
		});

		expect(container.addChild).toHaveBeenCalledWith(component);
		expect(ui.setFocus).toHaveBeenCalledWith(focus);
	});

	test("restoreEditorHost remounts the editor, restores text, and focuses it", () => {
		const container = {
			clear: vi.fn(),
			addChild: vi.fn(),
		};
		const ui = {
			setFocus: vi.fn(),
			requestRender: vi.fn(),
		};
		const editor = {} as any;
		const restoreText = vi.fn();

		restoreEditorHost({
			container,
			ui,
			editor,
			restoreText,
		});

		expect(container.clear).toHaveBeenCalledOnce();
		expect(container.addChild).toHaveBeenCalledWith(editor);
		expect(restoreText).toHaveBeenCalledOnce();
		expect(ui.setFocus).toHaveBeenCalledWith(editor);
		expect(ui.requestRender).toHaveBeenCalledOnce();
	});
});
