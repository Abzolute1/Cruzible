import type { ImageContent } from "@ag1/ai";
import { Markdown, Spacer, Text } from "@ag1/tui";
import { VERSION } from "../../config.js";
import { getChangelogPath, getNewEntries, parseChangelog } from "../../utils/changelog.js";
import { DynamicBorder } from "./components/dynamic-border.js";
import { theme } from "./theme/theme.js";

type ChatContainerLike = {
	children: unknown[];
	addChild(child: unknown): void;
};

type UiLike = { requestRender(): void };

type SettingsLike = {
	getCollapseChangelog(): boolean;
	getLastChangelogVersion(): string | undefined;
	setLastChangelogVersion(version: string): void;
};

type PromptSessionLike = {
	prompt(message: string, options?: { images?: ImageContent[] }): Promise<void>;
	modelRegistry: { getError(): string | undefined };
	state: { messages: unknown[] };
};

export function getInteractiveStartupChangelog(settingsManager: SettingsLike, messageCount: number): string | undefined {
	if (messageCount > 0) {
		return undefined;
	}

	const lastVersion = settingsManager.getLastChangelogVersion();
	const entries = parseChangelog(getChangelogPath());
	if (!lastVersion) {
		settingsManager.setLastChangelogVersion(VERSION);
		return undefined;
	}

	const newEntries = getNewEntries(entries, lastVersion);
	if (newEntries.length === 0) {
		return undefined;
	}

	settingsManager.setLastChangelogVersion(VERSION);
	return newEntries.map((entry) => entry.content).join("\n\n");
}

export function renderInteractiveStartupNotices(options: {
	chatContainer: ChatContainerLike;
	changelogMarkdown?: string;
	version: string;
	collapseChangelog: boolean;
	currentCwd: string;
	getMarkdownThemeWithSettings(): any;
	renderEarendilAnnouncement?(): void;
}): void {
	if (options.renderEarendilAnnouncement) {
		options.renderEarendilAnnouncement();
	}

	if (!options.changelogMarkdown) {
		return;
	}

	if (options.chatContainer.children.length > 0) {
		options.chatContainer.addChild(new Spacer(1));
	}
	options.chatContainer.addChild(new Spacer(1));
	options.chatContainer.addChild(new DynamicBorder());
	if (options.collapseChangelog) {
		const versionMatch = options.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
		const latestVersion = versionMatch ? versionMatch[1] : options.version;
		options.chatContainer.addChild(
			new Text(`Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`, 1, 0),
		);
	} else {
		options.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
		options.chatContainer.addChild(new Spacer(1));
		options.chatContainer.addChild(new Markdown(options.changelogMarkdown.trim(), 1, 0, options.getMarkdownThemeWithSettings()));
		options.chatContainer.addChild(new Spacer(1));
	}
	options.chatContainer.addChild(new DynamicBorder());
}

export async function runInteractiveStartupPrompts(options: {
	session: PromptSessionLike;
	showWarning(message: string): void;
	showError(message: string): void;
	migratedProviders?: string[];
	modelFallbackMessage?: string;
	initialMessage?: string;
	initialImages?: ImageContent[];
	initialMessages?: string[];
}): Promise<void> {
	if (options.migratedProviders && options.migratedProviders.length > 0) {
		options.showWarning(`Migrated credentials to auth.json: ${options.migratedProviders.join(", ")}`);
	}

	const modelsJsonError = options.session.modelRegistry.getError();
	if (modelsJsonError) {
		options.showError(`models.json error: ${modelsJsonError}`);
	}

	if (options.modelFallbackMessage) {
		options.showWarning(options.modelFallbackMessage);
	}

	if (options.initialMessage) {
		try {
			await options.session.prompt(options.initialMessage, { images: options.initialImages });
		} catch (error: unknown) {
			options.showError(error instanceof Error ? error.message : "Unknown error occurred");
		}
	}

	for (const message of options.initialMessages ?? []) {
		try {
			await options.session.prompt(message);
		} catch (error: unknown) {
			options.showError(error instanceof Error ? error.message : "Unknown error occurred");
		}
	}
}
