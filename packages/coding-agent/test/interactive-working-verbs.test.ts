import { describe, expect, test } from "vitest";
import {
	classifyWorkingPhase,
	describeWorkingActivity,
	describeWorkingPhaseActivity,
	formatWorkingActivityText,
	pickVerb,
} from "../src/modes/interactive/interactive-working-verbs.js";

describe("interactive working verbs", () => {
	test("uses stable deterministic verb selection for the same seed", () => {
		const first = pickVerb("bash", "bash|ls -la /tmp");
		const second = pickVerb("bash", "bash|ls -la /tmp");
		expect(second).toBe(first);
	});

	test("classifies read tool calls as file-reading activity", () => {
		const activity = describeWorkingActivity({
			toolName: "read",
			args: { path: "/repo/src/app.ts" },
		});

		expect(activity.context).toBe("read_file");
		expect(activity.target).toBe("/repo/src/app.ts");
	});

	test("classifies directory-oriented bash commands separately", () => {
		const activity = describeWorkingActivity({
			toolName: "bash",
			args: { command: "cd /home/alex && ls -la ~/Downloads/" },
		});

		expect(activity.context).toBe("list_dir");
		expect(activity.target).toContain("~/Downloads/");
	});

	test("classifies grep-style bash commands separately", () => {
		const activity = describeWorkingActivity({
			toolName: "bash",
			args: { command: "rg \"handleBashCommand\" packages/coding-agent/src" },
		});

		expect(activity.context).toBe("grep_search");
		expect(activity.target).toBe("handleBashCommand");
	});

	test("formats thinking activity from prompt text", () => {
		const activity = describeWorkingActivity({
			promptText: "fix the footer alignment and reduce visual noise",
		});

		expect(activity.context).toBe("thinking");
		expect(activity.target).toBeUndefined();
		expect(formatWorkingActivityText({ promptText: "fix the footer alignment and reduce visual noise" }).length).toBeGreaterThan(0);
	});

	test("groups web search and web fetch into the same research phase", () => {
		expect(classifyWorkingPhase({ toolName: "webSearch", args: { query: "claude code leak" } })).toBe("research");
		expect(classifyWorkingPhase({ toolName: "webFetch", args: { url: "https://example.com" } })).toBe("research");
	});

	test("keeps the verb stable across different tools in the same phase", () => {
		const seedHint = "research the latest claude code leak";
		const search = describeWorkingPhaseActivity(
			"research",
			{ toolName: "webSearch", args: { query: "claude code leak" } },
			seedHint,
		);
		const fetch = describeWorkingPhaseActivity(
			"research",
			{ toolName: "webFetch", args: { url: "https://example.com/claude-code-leak" } },
			seedHint,
		);

		expect(search.verb).toBe(fetch.verb);
		expect(search.target).not.toBe(fetch.target);
	});
});
