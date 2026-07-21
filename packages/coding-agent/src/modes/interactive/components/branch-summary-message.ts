import { Box, Markdown, type MarkdownTheme, Spacer, Text } from "@ag1/tui";
import type { BranchSummaryMessage } from "../../../core/messages.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { buildConsoleBadge, buildConsoleHeader } from "./console-chrome.js";
import { keyText } from "./keybinding-hints.js";

/**
 * Component that renders a branch summary message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 */
export class BranchSummaryMessageComponent extends Box {
	private expanded = false;
	private message: BranchSummaryMessage;
	private markdownTheme: MarkdownTheme;

	constructor(message: BranchSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();

		this.addChild(
			new Text(
				buildConsoleHeader({
					badge: "branch",
					badgeColor: "accent",
					meta: [this.expanded ? "expanded" : "collapsed"],
				}),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		if (this.expanded) {
			this.addChild(new Text(buildConsoleBadge("summary", "accent"), 0, 0));
			this.addChild(new Spacer(1));
			const header = "**Branch Summary**\n\n";
			this.addChild(
				new Markdown(header + this.message.summary, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			this.addChild(
				new Text(
					theme.fg("customMessageText", "Branch summary ready.") +
						" " +
						buildConsoleBadge(keyText("app.tools.expand"), "muted") +
						" " +
						theme.fg("dim", "to expand"),
					0,
					0,
				),
			);
		}
	}
}
