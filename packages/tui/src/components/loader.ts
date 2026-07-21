import type { TUI } from "../tui.js";
import { Text } from "./text.js";

/**
 * Loader component that updates every 80ms with spinning animation
 */
export class Loader extends Text {
	private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	private currentFrame = 0;
	private intervalId: NodeJS.Timeout | null = null;
	private ui: TUI | null = null;

	constructor(
		ui: TUI,
		private spinnerColorFn: (str: string) => string,
		private messageColorFn: (str: string) => string,
		private message: string = "Loading...",
	) {
		super("", 1, 0);
		this.ui = ui;
		this.start();
	}

	render(width: number): string[] {
		return ["", ...super.render(width)];
	}

	start() {
		this.updateDisplay();
		this.intervalId = setInterval(() => {
			this.currentFrame = (this.currentFrame + 1) % this.frames.length;
			this.updateDisplay();
		}, 80);
		// Don't keep the process alive just for the spinner if stop() is forgotten
		this.intervalId.unref();
	}

	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	setMessage(message: string) {
		this.message = message;
		this.updateDisplay();
	}

	/** Optional live-stats suffix (e.g. generation tokens/rate/silence), appended on every redraw. */
	setStatsProvider(provider: (() => string | undefined) | undefined) {
		this.statsProvider = provider;
		this.updateDisplay();
	}

	private statsProvider: (() => string | undefined) | undefined;

	private updateDisplay() {
		const frame = this.frames[this.currentFrame];
		const stats = this.statsProvider?.();
		this.setText(`${this.spinnerColorFn(frame)} ${this.messageColorFn(this.message)}${stats ? ` ${stats}` : ""}`);
		if (this.ui) {
			this.ui.requestRender();
		}
	}
}
