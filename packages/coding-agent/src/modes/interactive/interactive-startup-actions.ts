import { spawn } from "node:child_process";
import type { ImageContent } from "@ag1/ai";
import { Markdown, Spacer, Text } from "@ag1/tui";
import { APP_NAME, getAgentDir, VERSION } from "../../config.js";
import { DefaultPackageManager } from "../../core/package-manager.js";
import type { SettingsManager } from "../../core/settings-manager.js";
import { getChangelogPath, getNewEntries, parseChangelog } from "../../utils/changelog.js";
import { DynamicBorder } from "./components/dynamic-border.js";
import { NoticeCardComponent } from "./components/notice-card.js";
import { theme } from "./theme/theme.js";

type ChatContainerLike = {
	children: unknown[];
	addChild(child: unknown): void;
};

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

export function getInteractiveStartupChangelog(
	settingsManager: SettingsLike,
	messageCount: number,
): string | undefined {
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
		options.chatContainer.addChild(
			new Markdown(options.changelogMarkdown.trim(), 1, 0, options.getMarkdownThemeWithSettings()),
		);
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

/**
 * Check npm registry for a newer version of the package.
 * Returns the latest version string if newer, otherwise undefined.
 */
export async function checkForNewVersion(options: { version: string }): Promise<string | undefined> {
	if (process.env.AG1_SKIP_VERSION_CHECK || process.env.AG1_OFFLINE) {
		return undefined;
	}

	try {
		const response = await fetch("https://registry.npmjs.org/@ag1/coding-agent/latest", {
			signal: AbortSignal.timeout(10000),
		});
		if (!response.ok) return undefined;

		const data = (await response.json()) as { version?: string };
		const latestVersion = data.version;

		if (latestVersion && latestVersion !== options.version) {
			return latestVersion;
		}

		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Check for available AG1 package updates via the package manager.
 */
export async function checkForPackageUpdates(options: {
	cwd: string;
	settingsManager: SettingsManager;
}): Promise<string[]> {
	if (process.env.AG1_OFFLINE) {
		return [];
	}

	try {
		const packageManager = new DefaultPackageManager({
			cwd: options.cwd,
			agentDir: getAgentDir(),
			settingsManager: options.settingsManager,
		});
		const updates = await packageManager.checkForAvailableUpdates();
		return updates.map((update) => update.displayName);
	} catch {
		return [];
	}
}

/**
 * Check tmux extended-keys configuration (only relevant inside tmux).
 * Returns a warning message if misconfigured in a way that affects AG1 key handling.
 */
export async function checkTmuxKeyboardSetup(): Promise<string | undefined> {
	if (!process.env.TMUX) return undefined;

	const runTmuxShow = (option: string): Promise<string | undefined> => {
		return new Promise((resolve) => {
			const proc = spawn("tmux", ["show", "-gv", option], {
				stdio: ["ignore", "pipe", "ignore"],
			});
			let stdout = "";
			const timer = setTimeout(() => {
				proc.kill();
				resolve(undefined);
			}, 2000);

			proc.stdout?.on("data", (data) => {
				stdout += data.toString();
			});
			proc.on("error", () => {
				clearTimeout(timer);
				resolve(undefined);
			});
			proc.on("close", (code) => {
				clearTimeout(timer);
				resolve(code === 0 ? stdout.trim() : undefined);
			});
		});
	};

	const [extendedKeys, extendedKeysFormat] = await Promise.all([
		runTmuxShow("extended-keys"),
		runTmuxShow("extended-keys-format"),
	]);

	// If we couldn't query tmux (timeout, sandbox, etc.), don't warn
	if (extendedKeys === undefined) return undefined;

	if (extendedKeys !== "on" && extendedKeys !== "always") {
		return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
	}

	if (extendedKeysFormat === "xterm") {
		return "tmux extended-keys-format is xterm. AG1 works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.";
	}

	return undefined;
}

export function renderPackageUpdateNotification(options: {
	chatContainer: { addChild(child: unknown): void; requestRender?(): void };
	ui?: { requestRender(): void };
	packages: string[];
}): void {
	const action = theme.fg("accent", `${APP_NAME} update`);
	const updateInstruction = theme.fg("muted", "Package updates are available. Run ") + action;
	const packageLines = options.packages.map((pkg) => theme.fg("text", `- ${pkg}`));

	options.chatContainer.addChild(
		new NoticeCardComponent({
			badge: "update",
			badgeColor: "warning",
			title: "Package Updates Available",
			lines: [updateInstruction, "", theme.fg("muted", "Packages:"), ...packageLines],
			tone: "warning",
		}),
	);
	if (options.ui) {
		options.ui.requestRender();
	} else if ("requestRender" in options.chatContainer && typeof options.chatContainer.requestRender === "function") {
		options.chatContainer.requestRender();
	}
}
