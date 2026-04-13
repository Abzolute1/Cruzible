import { Text, type TUI } from "@mariozechner/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
	deriveResearchCompressionProfile,
	extractResearchFacts,
	formatFetchTranscriptContent,
	formatSearchTranscriptContent,
} from "../src/core/tools/research-output.js";
import { createWebSearchTool, webFetchToolDefinition, webSearchToolDefinition } from "../src/core/tools/index.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

describe("web research tool context efficiency", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	test("uses ultra compression for very small-context models", () => {
		const profile = deriveResearchCompressionProfile({
			tokens: 2_000,
			contextWindow: 32_000,
			percent: 4,
		});

		expect(profile.mode).toBe("ultra");
		expect(profile.searchTranscriptResults).toBe(1);
		expect(profile.searchSnippetChars).toBe(70);
		expect(profile.fetchTranscriptFacts).toBe(2);
		expect(profile.fetchTranscriptPreviewLines).toBe(2);
	});

	test("uses tight compression for 50k-context models", () => {
		const profile = deriveResearchCompressionProfile({
			tokens: 2_000,
			contextWindow: 50_000,
			percent: 4,
		});

		expect(profile.mode).toBe("tight");
		expect(profile.searchTranscriptResults).toBe(2);
		expect(profile.fetchTranscriptFacts).toBe(3);
		expect(profile.fetchTranscriptPreviewLines).toBe(3);
	});

	test("extracts a compact fact block from fetched markdown", () => {
		const facts = extractResearchFacts(
			[
				"# React 19",
				"",
				"React 19 improves server actions and developer ergonomics for modern apps.",
				"",
				"- Actions simplify async mutations and pending states in forms.",
				"- New APIs improve metadata handling and resource loading.",
			].join("\n"),
			3,
			120,
		);

		expect(facts).toEqual([
			"React 19 improves server actions and developer ergonomics for modern apps.",
			"Actions simplify async mutations and pending states in forms.",
			"New APIs improve metadata handling and resource loading.",
		]);
	});

	test("ignores script-like noise when extracting fetched facts", () => {
		const facts = extractResearchFacts(
			[
				"window.dataLayer = window.dataLayer || []; function gtag(){dataLayer.push(arguments);}",
				"localStorage.setItem('uwu', true); document.documentElement.classList.add('uwu');",
				"React 19 improves actions, metadata handling, and asset loading for modern applications.",
				"Actions simplify async mutations and pending UI states in forms.",
			].join("\n"),
			3,
			120,
		);

		expect(facts).toEqual([
			"React 19 improves actions, metadata handling, and asset loading for modern applications.",
			"Actions simplify async mutations and pending UI states in forms.",
		]);
	});

	test("keeps search transcript output source-oriented and compact", () => {
		const text = formatSearchTranscriptContent(
			"latest React docs",
			[
				{
					title: "React Docs",
					url: "https://react.dev/",
					snippet: "Official React documentation and guides for current releases.",
					authoritative: true,
				},
				{
					title: "React Blog",
					url: "https://react.dev/blog",
					snippet: "Release posts and announcements.",
				},
			],
			deriveResearchCompressionProfile({ tokens: 2_000, contextWindow: 32_000, percent: 4 }),
		);

		expect(text).toContain("Web search: latest React docs");
		expect(text).toContain("1. React Docs [authoritative]");
		expect(text).not.toContain("2. React Blog");
		expect(text).toContain("Best next step: use webFetch on https://react.dev/");
		expect(text).toContain("Search results are only a compact index");
		expect(text).toContain("Do not repeat webSearch");
	});

	test("keeps fetch transcript output to a compact preview", () => {
		const text = formatFetchTranscriptContent({
			url: "https://react.dev/",
			title: "React",
			facts: [
				"React builds user interfaces from components.",
				"Create interactive UIs using declarative code.",
			],
			preview: [
				"# React",
				"Build user interfaces from components.",
				"Create interactive UIs using declarative code.",
				"Additional detail that should not survive ultra compression.",
			].join("\n"),
			profile: deriveResearchCompressionProfile({ tokens: 2_000, contextWindow: 32_000, percent: 4 }),
			truncated: true,
		});

		expect(text).toContain("Fetched source: https://react.dev/");
		expect(text).toContain("Title: React");
		expect(text).toContain("Key facts:");
		expect(text).toContain("- React builds user interfaces from components.");
		expect(text).toContain("Build user interfaces from components.");
		expect(text).not.toContain("Additional detail that should not survive ultra compression.");
		expect(text).toContain("Only a compact source preview is included here to preserve context.");
		expect(text).toContain("keep using this URL as the reference instead of repeating webSearch");
	});

	test("applies tight compression to live webSearch tool output on 50k-context sessions", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev%2F">React Docs</a>',
					'<a class="result__snippet">Official React documentation</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev%2Fblog">React Blog</a>',
					'<a class="result__snippet">Release posts</a>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "latest React docs" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const text = result.content[0]?.text ?? "";

		expect(text).toContain("1. React Docs [authoritative] — https://react.dev/");
		expect(text).toContain("2. React Blog");
		expect(text).toContain("Best next step: use webFetch on https://react.dev/");
		expect((result.details as Record<string, unknown>).compressionMode).toBe("tight");
		expect((result.details as Record<string, unknown>).preferredSourceUrls).toEqual([
			"https://react.dev/",
			"https://react.dev/blog",
		]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("normalizes DuckDuckGo redirect URLs to direct source URLs", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev%2Freference%2Freact">React API</a>',
					'<a class="result__snippet">API reference</a>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "react api reference redirects" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);

		const details = result.details as Record<string, unknown>;
		expect((details.sourceUrls as string[])[0]).toBe("https://react.dev/reference/react");
		expect((details.preferredSourceUrls as string[])[0]).toBe("https://react.dev/reference/react");
		expect(result.content[0]?.text).toContain("https://react.dev/reference/react");
	});

	test("reuses cached search results for repeated queries", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="https://react.dev/">React Docs</a>',
					'<a class="result__snippet">Official React documentation</a>',
					'<a class="result__a" href="https://react.dev/blog">React Blog</a>',
					'<a class="result__snippet">Release posts</a>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const ctx = {
			getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
		} as any;

		const first = await tool.execute("tool-web-search-1", { query: "latest React docs cache" }, undefined, undefined, ctx);
		const second = await tool.execute("tool-web-search-2", { query: "latest React docs cache" }, undefined, undefined, ctx);

		expect((first.details as Record<string, unknown>).cacheHit).toBe(false);
		expect((second.details as Record<string, unknown>).cacheHit).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("renders webSearch results as a few rows by default", () => {
		const component = new ToolExecutionComponent(
			"webSearch",
			"tool-search",
			{ query: "latest React docs" },
			{},
			webSearchToolDefinition as any,
			createFakeTui(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "compact" }],
				details: {
					query: "latest React docs",
					resultCount: 4,
					results: [
						{ title: "React Docs", url: "https://react.dev/", snippet: "Official docs", authoritative: true },
						{ title: "React Blog", url: "https://react.dev/blog", snippet: "Release posts" },
						{ title: "React API", url: "https://react.dev/reference", snippet: "API reference" },
					],
				},
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("1. React Docs");
		expect(rendered).toContain("[authoritative]");
		expect(rendered).toContain("2. React Blog");
		expect(rendered).not.toContain("3. React API");
	});

	test("renders webFetch preview compactly by default", () => {
		const component = new ToolExecutionComponent(
			"webFetch",
			"tool-fetch",
			{ url: "https://react.dev/" },
			{},
			webFetchToolDefinition as any,
			createFakeTui(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "compact" }],
				details: {
					url: "https://react.dev/",
					title: "React",
					contentType: "text/html",
					cacheHit: true,
					facts: [
						"React builds user interfaces from components.",
						"Create interactive UIs using declarative code.",
					],
					preview: [
						"# React",
						"Build user interfaces from components.",
						"Create interactive UIs using declarative code.",
						"Install from npm or use a framework.",
					].join("\n"),
					truncated: true,
				},
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("[cached]");
		expect(rendered).toContain("facts:");
		expect(rendered).toContain("React builds user interfaces from components.");
		expect(rendered).toContain("# React");
		expect(rendered).toContain("Build user interfaces from components.");
		expect(rendered).toContain("Create interactive UIs using declarative code.");
		expect(rendered).not.toContain("Install from npm or use a framework.");
	});
});
