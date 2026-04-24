import { Container, type Focusable, getKeybindings, Input, Text, type TUI } from "@ag1/tui";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

/**
 * Simple input dialog for setting the context window size.
 */
export class ContextInputDialog extends Container implements Focusable {
	private input: Input;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		private tui: TUI,
		private onDone: (rawValue: string | undefined) => void,
	) {
		super();

		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("warning", "Set Context Window"), 1, 0));

		this.input = new Input();
		this.input.onEscape = () => this.onDone(undefined);
		this.input.onSubmit = (value: string) => {
			const trimmed = value.trim();
			this.onDone(trimmed || undefined);
		};
		this.addChild(this.input);

		this.addChild(new Text(theme.fg("dim", "(Enter number of tokens, e.g. 44000 — Esc to cancel)"), 1, 0));

		this.addChild(new DynamicBorder());
	}

	show(): void {
		this.input.setValue("");
		this.tui.requestRender();
	}

	cancel(): void {
		this.onDone(undefined);
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}

		this.input.handleInput(data);
	}
}
