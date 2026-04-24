import type { MarkdownTheme, Keybinding } from "@ag1/tui";
import { Markdown, Spacer, Text } from "@ag1/tui";
import type { AppKeybinding } from "../../core/keybindings.js";
import { keyText } from "./components/keybinding-hints.js";
import { DynamicBorder } from "./components/dynamic-border.js";
import { theme } from "./theme/theme.js";

type ChatContainerLike = { addChild(child: unknown): void };
type UiLike = { requestRender(): void };

type ChangelogEntry = { content: string };
type ExtensionShortcutSummary = { key: string; description: string };

function capitalizeInteractiveKey(key: string): string {
	return key
		.split("/")
		.map((k) =>
			k
				.split("+")
				.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
				.join("+"),
		)
		.join("/");
}

export function getInteractiveAppKeyDisplay(action: AppKeybinding): string {
	return capitalizeInteractiveKey(keyText(action));
}

export function getInteractiveEditorKeyDisplay(action: Keybinding): string {
	return capitalizeInteractiveKey(keyText(action));
}

export function renderInteractiveChangelog(options: {
	chatContainer: ChatContainerLike;
	ui: UiLike;
	getMarkdownThemeWithSettings(): MarkdownTheme;
	entries: ChangelogEntry[];
}): void {
	const changelogMarkdown =
		options.entries.length > 0
			? [...options.entries]
					.reverse()
					.map((entry) => entry.content)
					.join("\n\n")
			: "No changelog entries found.";

	options.chatContainer.addChild(new Spacer(1));
	options.chatContainer.addChild(new DynamicBorder());
	options.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
	options.chatContainer.addChild(new Spacer(1));
	options.chatContainer.addChild(new Markdown(changelogMarkdown, 1, 1, options.getMarkdownThemeWithSettings()));
	options.chatContainer.addChild(new DynamicBorder());
	options.ui.requestRender();
}

export function renderInteractiveHotkeys(options: {
	chatContainer: ChatContainerLike;
	ui: UiLike;
	getMarkdownThemeWithSettings(): MarkdownTheme;
	platform: NodeJS.Platform;
	extensionShortcuts: ExtensionShortcutSummary[];
}): void {
	const cursorUp = getInteractiveEditorKeyDisplay("tui.editor.cursorUp");
	const cursorDown = getInteractiveEditorKeyDisplay("tui.editor.cursorDown");
	const cursorLeft = getInteractiveEditorKeyDisplay("tui.editor.cursorLeft");
	const cursorRight = getInteractiveEditorKeyDisplay("tui.editor.cursorRight");
	const cursorWordLeft = getInteractiveEditorKeyDisplay("tui.editor.cursorWordLeft");
	const cursorWordRight = getInteractiveEditorKeyDisplay("tui.editor.cursorWordRight");
	const cursorLineStart = getInteractiveEditorKeyDisplay("tui.editor.cursorLineStart");
	const cursorLineEnd = getInteractiveEditorKeyDisplay("tui.editor.cursorLineEnd");
	const jumpForward = getInteractiveEditorKeyDisplay("tui.editor.jumpForward");
	const jumpBackward = getInteractiveEditorKeyDisplay("tui.editor.jumpBackward");
	const pageUp = getInteractiveEditorKeyDisplay("tui.editor.pageUp");
	const pageDown = getInteractiveEditorKeyDisplay("tui.editor.pageDown");
	const submit = getInteractiveEditorKeyDisplay("tui.input.submit");
	const newLine = getInteractiveEditorKeyDisplay("tui.input.newLine");
	const deleteWordBackward = getInteractiveEditorKeyDisplay("tui.editor.deleteWordBackward");
	const deleteWordForward = getInteractiveEditorKeyDisplay("tui.editor.deleteWordForward");
	const deleteToLineStart = getInteractiveEditorKeyDisplay("tui.editor.deleteToLineStart");
	const deleteToLineEnd = getInteractiveEditorKeyDisplay("tui.editor.deleteToLineEnd");
	const yank = getInteractiveEditorKeyDisplay("tui.editor.yank");
	const yankPop = getInteractiveEditorKeyDisplay("tui.editor.yankPop");
	const undo = getInteractiveEditorKeyDisplay("tui.editor.undo");
	const tab = getInteractiveEditorKeyDisplay("tui.input.tab");
	const interrupt = getInteractiveAppKeyDisplay("app.interrupt");
	const clear = getInteractiveAppKeyDisplay("app.clear");
	const exit = getInteractiveAppKeyDisplay("app.exit");
	const suspend = getInteractiveAppKeyDisplay("app.suspend");
	const cycleThinkingLevel = getInteractiveAppKeyDisplay("app.thinking.cycle");
	const cycleModelForward = getInteractiveAppKeyDisplay("app.model.cycleForward");
	const cycleMode = getInteractiveAppKeyDisplay("app.mode.cycle");
	const selectModel = getInteractiveAppKeyDisplay("app.model.select");
	const expandTools = getInteractiveAppKeyDisplay("app.tools.expand");
	const toggleThinking = getInteractiveAppKeyDisplay("app.thinking.toggle");
	const externalEditor = getInteractiveAppKeyDisplay("app.editor.external");
	const cycleModelBackward = getInteractiveAppKeyDisplay("app.model.cycleBackward");
	const followUp = getInteractiveAppKeyDisplay("app.message.followUp");
	const dequeue = getInteractiveAppKeyDisplay("app.message.dequeue");
	const pasteImage = getInteractiveAppKeyDisplay("app.clipboard.pasteImage");
	const reviewPlan = getInteractiveAppKeyDisplay("app.plan.review");
	const nextPlanStep = getInteractiveAppKeyDisplay("app.plan.nextStep");

	let hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`${cursorUp}\` / \`${cursorDown}\` / \`${cursorLeft}\` / \`${cursorRight}\` | Move cursor / browse history (Up when empty) |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | Move by word |
| \`${cursorLineStart}\` | Start of line |
| \`${cursorLineEnd}\` | End of line |
| \`${jumpForward}\` | Jump forward to character |
| \`${jumpBackward}\` | Jump backward to character |
| \`${pageUp}\` / \`${pageDown}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${submit}\` | Send message |
| \`${newLine}\` | New line${options.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""} |
| \`${deleteWordBackward}\` | Delete word backwards |
| \`${deleteWordForward}\` | Delete word forwards |
| \`${deleteToLineStart}\` | Delete to start of line |
| \`${deleteToLineEnd}\` | Delete to end of line |
| \`${yank}\` | Paste the most-recently-deleted text |
| \`${yankPop}\` | Cycle through the deleted text after pasting |
| \`${undo}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${tab}\` | Path completion / accept autocomplete |
| \`${interrupt}\` | Cancel autocomplete / abort streaming |
| \`${clear}\` | Clear editor (first) / exit (second) |
| \`${exit}\` | Exit (when editor is empty) |
| \`${suspend}\` | Suspend to background |
| \`${cycleThinkingLevel}\` | Cycle thinking level |
| \`${cycleMode}\` | Cycle interactive / planning / autonomous mode |
| \`${cycleModelForward}\` / \`${cycleModelBackward}\` | Cycle models |
| \`${selectModel}\` | Open model selector |
| \`${expandTools}\` | Toggle tool output expansion |
| \`${toggleThinking}\` | Toggle thinking block visibility |
| \`${externalEditor}\` | Edit message in external editor |
| \`${followUp}\` | Queue follow-up message |
| \`${dequeue}\` | Restore queued messages |
| \`${pasteImage}\` | Paste image from clipboard |
| \`${reviewPlan}\` | Review the latest saved plan |
| \`${nextPlanStep}\` | Execute the next incomplete plan step |
| \`/\` | Slash commands |
| \`!\` | Run bash command |
| \`!!\` | Run bash command (excluded from context) |
`;

	if (options.extensionShortcuts.length > 0) {
		hotkeys += `
**Extensions**
| Key | Action |
|-----|--------|
`;
		for (const shortcut of options.extensionShortcuts) {
			hotkeys += `| \`${capitalizeInteractiveKey(shortcut.key)}\` | ${shortcut.description} |\n`;
		}
	}

	options.chatContainer.addChild(new Spacer(1));
	options.chatContainer.addChild(new DynamicBorder());
	options.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "Keyboard Shortcuts")), 1, 0));
	options.chatContainer.addChild(new Spacer(1));
	options.chatContainer.addChild(new Markdown(hotkeys.trim(), 1, 1, options.getMarkdownThemeWithSettings()));
	options.chatContainer.addChild(new DynamicBorder());
	options.ui.requestRender();
}
