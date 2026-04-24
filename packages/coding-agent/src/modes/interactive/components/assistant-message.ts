import type { AssistantMessage } from "@ag1/ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@ag1/tui";
import { classifyRequestFailure } from "../../../core/request-failure.js";
import { stripXmlToolCallArtifacts } from "../../../core/xml-tool-parser.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private lastMessage?: AssistantMessage;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;

		this.addChild(new Spacer(1));

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;

		this.clear();
		this.addChild(new Spacer(1));

		const hasVisibleContent = message.content.some(
			(c) =>
				(c.type === "text" && this.getRenderableText(c.text).trim()) ||
				(c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.addChild(new Spacer(1));
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text") {
				const renderableText = this.getRenderableText(content.text);
				if (!renderableText.trim()) {
					continue;
				}
				this.addChild(
					new Markdown(renderableText, 0, 0, this.markdownTheme, {
						color: (text: string) => theme.fg("text", text),
					}),
				);
			} else if (content.type === "thinking" && content.thinking.trim()) {
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some(
						(c) =>
							(c.type === "text" && this.getRenderableText(c.text).trim()) ||
							(c.type === "thinking" && c.thinking.trim()),
					);

				if (this.hideThinkingBlock) {
					this.addChild(new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), 0, 0));
					if (hasVisibleContentAfter) {
						this.addChild(new Spacer(1));
					}
				} else {
					this.addChild(
						new Markdown(content.thinking.trim(), 0, 0, this.markdownTheme, {
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						}),
					);
					if (hasVisibleContentAfter) {
						this.addChild(new Spacer(1));
					}
				}
			}
		}

		// Check if aborted - show after partial content
		// But only if there are no tool calls (tool execution components will show the error)
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.addChild(new Spacer(1));
				this.addChild(new Text(theme.fg("error", abortMessage), 0, 0));
			} else if (message.stopReason === "error") {
				const classifiedFailure = classifyRequestFailure(message);
				const errorMsg = classifiedFailure
					? `${classifiedFailure.message}\n${classifiedFailure.recoveryHint}`
					: `Error: ${message.errorMessage || "Unknown error"}`;
				this.addChild(new Spacer(1));
				this.addChild(new Text(theme.fg("error", errorMsg), 0, 0));
			}
		}
	}

	private getRenderableText(text: string): string {
		return stripXmlToolCallArtifacts(text).trim();
	}

}
