import { Container } from "@ag1/tui";
import { describe, expect, test, vi } from "vitest";
import {
	getInteractiveStartupChangelog,
	renderInteractiveStartupNotices,
	runInteractiveStartupPrompts,
} from "../src/modes/interactive/interactive-startup-actions.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("interactive-startup-actions", () => {
	test("skips changelog display for resumed sessions and records fresh installs", () => {
		const settings = {
			getLastChangelogVersion: vi.fn(() => undefined),
			setLastChangelogVersion: vi.fn(),
		};

		expect(getInteractiveStartupChangelog(settings, 2)).toBeUndefined();
		expect(getInteractiveStartupChangelog(settings, 0)).toBeUndefined();
		expect(settings.setLastChangelogVersion).toHaveBeenCalled();
	});

	test("renders startup changelog notices through the shared presenter", () => {
		initTheme("dark", false);
		const chatContainer = new Container();

		renderInteractiveStartupNotices({
			chatContainer,
			changelogMarkdown: "## [0.65.2]\n\n- Hardened startup",
			version: "0.65.2",
			collapseChangelog: true,
			currentCwd: "/tmp/project",
			getMarkdownThemeWithSettings: () => ({}) as any,
		});

		const output = chatContainer.children.flatMap((child: any) => child.render(140)).join("\n");
		expect(output).toContain("Updated to v0.65.2");
	});

	test("emits warnings/errors and replays initial prompts safely", async () => {
		const prompt = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("follow-up failed"));
		const showWarning = vi.fn();
		const showError = vi.fn();

		await runInteractiveStartupPrompts({
			session: {
				prompt,
				modelRegistry: { getError: () => "broken models" },
				state: { messages: [] },
			},
			showWarning,
			showError,
			migratedProviders: ["openai"],
			modelFallbackMessage: "fallback in use",
			initialMessage: "hello",
			initialMessages: ["second"],
		});

		expect(showWarning).toHaveBeenCalledWith("Migrated credentials to auth.json: openai");
		expect(showWarning).toHaveBeenCalledWith("fallback in use");
		expect(showError).toHaveBeenCalledWith("models.json error: broken models");
		expect(showError).toHaveBeenCalledWith("follow-up failed");
	});
});
