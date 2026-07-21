import { Container, getKeybindings, Spacer, Text } from "@ag1/tui";
import { theme } from "../theme/theme.js";
import { buildConsoleBadge, buildConsoleHeader } from "./console-chrome.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint, rawKeyHint } from "./keybinding-hints.js";

export interface PlanWorkflowDialogOptions {
	title: string;
	lines: string[];
	options: PlanWorkflowDialogOption[];
	accent?: "accent" | "warning" | "success";
	onSelect: (optionId: string) => void;
	onCancel: () => void;
}

export interface PlanWorkflowDialogOption {
	id: string;
	label: string;
	hotkey?: string;
}

export class PlanWorkflowDialogComponent extends Container {
	private readonly options: PlanWorkflowDialogOption[];
	private readonly listContainer: Container;
	private readonly contentContainer: Container;
	private readonly onSelectCallback: (optionId: string) => void;
	private readonly onCancelCallback: () => void;
	private readonly accent: "accent" | "warning" | "success";
	private readonly hotkeys: Map<string, string>;
	private selectedIndex = 0;

	constructor(options: PlanWorkflowDialogOptions) {
		super();
		this.options = options.options;
		this.onSelectCallback = options.onSelect;
		this.onCancelCallback = options.onCancel;
		this.accent = options.accent ?? "accent";
		this.hotkeys = this.buildHotkeys(options.options);

		const color = (text: string) => theme.fg(this.accent, text);

		this.addChild(new DynamicBorder(color));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				buildConsoleHeader({
					badge: "plan",
					badgeColor: this.accent,
					title: options.title,
					meta: ["workflow"],
				}),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));

		this.contentContainer = new Container();
		for (const line of options.lines) {
			this.contentContainer.addChild(new Text(line ? theme.fg("text", line) : "", 1, 0));
		}
		this.addChild(this.contentContainer);
		this.addChild(new Spacer(1));
		this.addChild(new Text(buildConsoleHeader({ badge: "actions", badgeColor: this.accent }), 1, 0));
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					rawKeyHint("1-9", "quick select") +
					"  " +
					rawKeyHint("letters", "action keys") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(color));

		this.updateList();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		const directHotkey = keyData.length === 1 ? this.hotkeys.get(keyData.toLowerCase()) : undefined;
		if (directHotkey) {
			this.onSelectCallback(directHotkey);
			return;
		}
		if (/^[1-9]$/.test(keyData)) {
			const directIndex = Number.parseInt(keyData, 10) - 1;
			const directOption = this.options[directIndex];
			if (directOption) {
				this.onSelectCallback(directOption.id);
				return;
			}
		}
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = this.options[this.selectedIndex];
			if (selected) this.onSelectCallback(selected.id);
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}

	private updateList(): void {
		this.listContainer.clear();
		for (let i = 0; i < this.options.length; i++) {
			const isSelected = i === this.selectedIndex;
			const option = this.options[i]!;
			const numberBadge = buildConsoleBadge(String(i + 1), isSelected ? this.accent : "muted");
			const hotkeyBadge = option.hotkey ? buildConsoleBadge(option.hotkey, isSelected ? this.accent : "muted") : "";
			const text = isSelected ? theme.fg(this.accent, option.label) : theme.fg("text", option.label);
			const selectedBadge = isSelected ? buildConsoleBadge("selected", this.accent) : "";
			this.listContainer.addChild(
				new Text([numberBadge, hotkeyBadge, text, selectedBadge].filter(Boolean).join(" "), 1, 0),
			);
		}
	}

	private buildHotkeys(options: PlanWorkflowDialogOption[]): Map<string, string> {
		const hotkeys = new Map<string, string>();
		for (const option of options) {
			const hotkey = option.hotkey?.toLowerCase();
			if (!hotkey) continue;
			const existing = hotkeys.get(hotkey);
			if (existing) {
				// A collision silently shadows one of the actions — fail loudly so
				// it is caught in tests instead of becoming an unreachable option.
				throw new Error(
					`Plan workflow hotkey collision: "${hotkey}" maps to both "${existing}" and "${option.id}".`,
				);
			}
			hotkeys.set(hotkey, option.id);
		}
		return hotkeys;
	}
}
