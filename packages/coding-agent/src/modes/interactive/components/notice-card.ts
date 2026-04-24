import { Box, Container, Spacer, Text } from "@ag1/tui";
import type { ThemeColor } from "../theme/theme.js";
import { theme } from "../theme/theme.js";
import { buildConsoleHeader } from "./console-chrome.js";

export interface NoticeCardOptions {
	badge: string;
	badgeColor?: ThemeColor;
	title?: string;
	meta?: string[];
	lines: string[];
	tone?: "info" | "warning" | "error" | "success";
	includeLeadingSpacer?: boolean;
	paddedHeader?: boolean;
}

export class NoticeCardComponent extends Container {
	private readonly box: Box;
	private options: NoticeCardOptions;

	constructor(options: NoticeCardOptions) {
		super();
		this.options = options;
		this.box = new Box(1, 1, this.getBackground(options.tone));
		if (options.includeLeadingSpacer ?? true) {
			this.addChild(new Spacer(1));
		}
		this.addChild(this.box);
		this.rebuild();
	}

	setLines(lines: string[]): void {
		this.options = { ...this.options, lines };
		this.rebuild();
	}

	setOptions(options: Partial<NoticeCardOptions>): void {
		this.options = { ...this.options, ...options };
		this.rebuild();
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		this.box.setBgFn(this.getBackground(this.options.tone));
		this.box.clear();
		if (this.options.paddedHeader) {
			this.box.addChild(new Spacer(1));
		}
		this.box.addChild(
			new Text(
				buildConsoleHeader({
					badge: this.options.badge,
					badgeColor: this.options.badgeColor ?? this.getBadgeColor(this.options.tone),
					title: this.options.title,
					meta: this.options.meta,
				}),
				0,
				0,
			),
		);
		if (this.options.paddedHeader) {
			this.box.addChild(new Spacer(1));
		}

		if (this.options.lines.length > 0) {
			this.box.addChild(new Spacer(1));
		}

		for (const line of this.options.lines) {
			if (line === "") {
				this.box.addChild(new Spacer(1));
				continue;
			}
			this.box.addChild(new Text(line, 0, 0));
		}
	}

	private getBackground(tone: NoticeCardOptions["tone"]): (text: string) => string {
		switch (tone) {
			case "warning":
				return (text) => theme.bg("toolPendingBg", text);
			case "error":
				return (text) => theme.bg("toolErrorBg", text);
			case "success":
				return (text) => theme.bg("toolSuccessBg", text);
			default:
				return (text) => theme.bg("customMessageBg", text);
		}
	}

	private getBadgeColor(tone: NoticeCardOptions["tone"]): ThemeColor {
		switch (tone) {
			case "warning":
				return "warning";
			case "error":
				return "error";
			case "success":
				return "success";
			default:
				return "accent";
		}
	}
}
