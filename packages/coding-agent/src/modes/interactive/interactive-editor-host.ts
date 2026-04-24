import type { Component } from "@ag1/tui";

export interface InteractiveEditorHostContainer {
	clear(): void;
	addChild(component: Component): void;
}

export interface InteractiveEditorHostUi {
	setFocus(component: Component): void;
	requestRender(): void;
}

export function showEditorHostComponent(options: {
	container: InteractiveEditorHostContainer;
	ui: InteractiveEditorHostUi;
	component: Component;
	focus?: Component;
}): void {
	options.container.clear();
	options.container.addChild(options.component);
	options.ui.setFocus(options.focus ?? options.component);
	options.ui.requestRender();
}

export function restoreEditorHost(options: {
	container: InteractiveEditorHostContainer;
	ui: InteractiveEditorHostUi;
	editor: Component;
	restoreText?: () => void;
}): void {
	options.container.clear();
	options.container.addChild(options.editor);
	options.restoreText?.();
	options.ui.setFocus(options.editor);
	options.ui.requestRender();
}
