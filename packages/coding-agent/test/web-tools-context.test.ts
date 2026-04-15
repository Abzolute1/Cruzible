import { Text, type TUI } from "@mariozechner/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
	assessResearchFetchContent,
	buildResearchPreview,
	deriveResearchCompressionProfile,
	extractResearchFacts,
	formatFetchTranscriptContent,
	formatSearchTranscriptContent,
} from "../src/core/tools/research-output.js";
import {
	detectResearchQueryIntent,
	getEffectiveFetchCompressionProfile,
	rememberResearchUrlHints,
} from "../src/core/tools/research-intent.js";
import { createWebSearchTool, webFetchToolDefinition, webSearchToolDefinition } from "../src/core/tools/index.js";
import { webFetchToolDefinition as autonWebFetchToolDefinition } from "../src/core/auton/tools/webfetch.js";
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

	test("filters placeholder and navigation lines out of fetch previews", () => {
		const preview = buildResearchPreview(
			[
				"Just a moment...",
				"Enable JavaScript and cookies to continue",
				"Privacy",
				"March 31, 2026 Anthropic accidentally published the complete source code of Claude Code to npm.",
				"The leaked source map exposed internal TypeScript across the CLI package.",
			].join("\n"),
			3,
			140,
		);

		expect(preview).not.toContain("Just a moment");
		expect(preview).not.toContain("Enable JavaScript");
		expect(preview).toContain("March 31, 2026 Anthropic accidentally published");
	});

	test("filters docs scaffolding and copy chrome out of fetch previews", () => {
		const preview = buildResearchPreview(
			[
				"The library for web and native user interfaces",
				"API Reference Hooks Copy pageCopy",
				"# useActionState",
				"`useActionState` is a React Hook that lets you update state with side effects using Actions.",
				"`const [state, dispatchAction, isPending] = useActionState(reducerAction, initialState, permalink?);`",
				"- Reference",
				"- `reducerAction` function",
				"Using with Action props",
			].join("\n"),
			6,
			140,
		);

		expect(preview).not.toContain("The library for web and native user interfaces");
		expect(preview).not.toContain("API Reference Hooks");
		expect(preview).not.toContain("- Reference");
		expect(preview).not.toContain("reducerAction function");
		expect(preview).toContain("useActionState");
		expect(preview).toContain("Using with Action props");
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
		expect(text).toContain("Next step: webFetch https://react.dev/");
		expect(text).not.toContain("Search results are only a compact index");
		expect(text).not.toContain("Do not repeat webSearch");
	});

	test("ranks repo sources above generic docs for code lookup queries", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flearn.microsoft.com%2Fen-us%2Fdotnet%2Fapi%2Fsystem.io.file.writealltext">WriteAllText docs</a>',
					'<a class="result__snippet">Microsoft documentation reference.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fmariozechner%2Fpi-coding-agent%2Fblob%2Fmain%2Fpackages%2Fcoding-agent%2Fsrc%2Fcore%2Ftools%2Fwrite.ts">write.ts</a>',
					'<a class="result__snippet">Source file containing formatWriteSuccess.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fanswers.microsoft.com%2Fen-us">Microsoft Answers</a>',
					'<a class="result__snippet">Community answers.</a>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "formatWriteSuccess write.ts github" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const text = result.content[0]?.text ?? "";
		const details = result.details as Record<string, unknown>;

		expect(text).toContain("1. write.ts");
		expect((details.preferredSourceUrls as string[])[0]).toContain("github.com");
		expect((details.sourceUrls as string[])[0]).toContain("github.com");
	});

	test("ranks news-like sources above docs for current-events queries", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.anthropic.com%2Fen%2Fdocs%2Fclaude-code">Claude Code Docs</a>',
					'<a class="result__snippet">Product documentation.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ftech-insider.org%2Fanthropic-claude-code-source-code-leak-npm-2026%2F">Leak analysis</a>',
					'<a class="result__snippet">Coverage of the March 2026 source code leak.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fanthropics%2Fclaude-code">GitHub repo</a>',
					'<a class="result__snippet">Repository mirror.</a>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "latest claude code leak 2026" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const details = result.details as Record<string, unknown>;
		const sourceUrls = details.sourceUrls as string[];

		expect(sourceUrls[0]).toContain("tech-insider.org");
		expect(sourceUrls[1]).not.toContain("github.com");
	});

	test("ranks matching framework reference pages above generic docs pages", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev%2Freference%2Freact-dom%2Fcomponents%2Fform">form - React</a>',
					'<a class="result__snippet">Reference for the HTML form component in React DOM.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev%2Freference%2Freact%2FuseActionState">useActionState - React</a>',
					'<a class="result__snippet">useActionState lets you update state based on the result of a form action.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev%2Fblog%2F2024%2F12%2F05%2Freact-19">React 19 blog</a>',
					'<a class="result__snippet">Release notes covering actions and forms.</a>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "look up React docs on actions and summarize briefly" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const details = result.details as Record<string, unknown>;
		const sourceUrls = details.sourceUrls as string[];
		const text = result.content[0]?.text ?? "";

		expect(details.intent).toBe("docs_reference");
		expect(sourceUrls[0]).toBe("https://react.dev/reference/react/useActionState");
		expect(text).toContain("1. useActionState - React");
	});

	test("marks rich fetch summaries as sufficient instead of nudging extra fetch churn", () => {
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
			status: "rich",
		});

		expect(text).toContain("Fetched source: https://react.dev/");
		expect(text).toContain("Title: React");
		expect(text).toContain("Key facts:");
		expect(text).toContain("- React builds user interfaces from components.");
		expect(text).toContain("Build user interfaces from components.");
		expect(text).not.toContain("Additional detail that should not survive ultra compression.");
		expect(text).toContain("This source summary is likely sufficient to answer or cite without refetching.");
		expect(text).toContain("Reuse this URL as the source reference");
	});

	test("de-duplicates docs excerpt lines that already appear in title or facts", () => {
		const text = formatFetchTranscriptContent({
			url: "https://react.dev/reference/react/useActionState",
			title: "useActionState – React",
			facts: [
				"`useActionState` is a React Hook that lets you update state with side effects using Actions.",
				"`useActionState(reducerAction, initialState, permalink?)`",
				"Adding state to an Action",
				"Using multiple Action types",
			],
			preview: [
				"# useActionState",
				"`useActionState` is a React Hook that lets you update state with side effects using Actions.",
				"`const [state, dispatchAction, isPending] = useActionState(reducerAction, initialState, permalink?);`",
				"`useActionState(reducerAction, initialState, permalink?)`",
				"Adding state to an Action",
				"- Using multiple Action types",
				"- Using with `useOptimistic`",
				"- Using with Action props",
			].join("\n"),
			profile: deriveResearchCompressionProfile({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			truncated: true,
			status: "rich",
		});

		expect(text).toContain("Key facts:");
		expect(text).toContain("Key excerpt:");
		expect(text).not.toContain("# useActionState");
		expect(text).not.toContain("\n`useActionState(reducerAction, initialState, permalink?)`\n");
		expect(text).not.toContain("\nAdding state to an Action\n");
		expect(text).not.toContain("\n- Using multiple Action types\n");
		expect(text).toContain("`const [state, dispatchAction, isPending] = useActionState(reducerAction, initialState, permalink?);`");
	});

	test("marks placeholder fetches as unusable evidence", () => {
		const text = formatFetchTranscriptContent({
			url: "https://example.com/challenge",
			title: "Just a moment...",
			metaDescription: "Please wait while we verify your browser before accessing the site.",
			profile: deriveResearchCompressionProfile({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			status: "placeholder",
			statusReason: "browser verification interstitial",
		});

		expect(text).toContain("Fetch status: placeholder/interstitial content");
		expect(text).toContain("browser verification interstitial");
		expect(text).toContain("Do not rely on this source as evidence.");
	});

	test("classifies placeholder fetch content distinctly from rich article content", () => {
		expect(
			assessResearchFetchContent({
				title: "Just a moment...",
				metaDescription: "Please wait while we verify your browser before accessing the page.",
				markdown: "Enable JavaScript and cookies to continue",
				facts: [],
				preview: "Just a moment...",
			}),
		).toEqual({
			status: "placeholder",
			reason: "interstitial placeholder content",
		});

		expect(
			assessResearchFetchContent({
				title: "Claude leak recap",
				markdown: [
					"Anthropic accidentally published a source map in March 2026.",
					"The leak exposed internal TypeScript for the Claude Code CLI.",
					"The package was pulled and republished after disclosure.",
				].join("\n"),
				facts: [
					"Anthropic accidentally published a source map in March 2026.",
					"The leak exposed internal TypeScript for the Claude Code CLI.",
				],
				preview: "Anthropic accidentally published a source map in March 2026.\nThe leak exposed internal TypeScript.",
			}).status,
		).toBe("rich");
	});

	test("treats import-heavy raw source extracts as thin evidence", () => {
		expect(
			assessResearchFetchContent({
				title: "write.ts",
				markdown: [
					"import { promises as fs } from \"node:fs\";",
					"import path from \"node:path\";",
					"export function formatWriteSuccess(target: string) {",
					"  return `Wrote ${target}`;",
					"}",
				].join("\n"),
				facts: ["import { promises as fs } from \"node:fs\";", "export function formatWriteSuccess(target: string) {"],
				preview: [
					"import { promises as fs } from \"node:fs\";",
					"import path from \"node:path\";",
					"export function formatWriteSuccess(target: string) {",
				].join("\n"),
			}),
		).toEqual({
			status: "thin",
			reason: "code-heavy extract without enough supporting explanation",
		});
	});

	test("filters docs scaffolding out of extracted facts", () => {
		const facts = extractResearchFacts(
			[
				"The library for web and native user interfaces",
				"API Reference Hooks Copy pageCopy",
				"`useActionState` is a React Hook that lets you update state with side effects using Actions.",
				"`useActionState(reducerAction, initialState, permalink?)`",
				"Using with Action props",
			].join("\n"),
			4,
			160,
		);

		expect(facts).not.toContain("The library for web and native user interfaces");
		expect(facts).not.toContain("API Reference Hooks");
		expect(facts).toContain("`useActionState` is a React Hook that lets you update state with side effects using Actions.");
		expect(facts).toContain("`useActionState(reducerAction, initialState, permalink?)`");
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
		expect(text).toContain("Next step: webFetch https://react.dev/");
		expect((result.details as Record<string, unknown>).compressionMode).toBe("tight");
		expect((result.details as Record<string, unknown>).preferredSourceUrls).toEqual([
			"https://react.dev/",
			"https://react.dev/blog",
		]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("autonomous webFetch includes facts and placeholder status in details", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			headers: new Headers({ "content-type": "text/html" }),
			text: async () =>
				[
					"<html>",
					"<head>",
					'<title>Claude Code leak article</title>',
					'<meta name="description" content="Anthropic accidentally published a source map for Claude Code in March 2026.">',
					"</head>",
					"<body>",
					"<article>",
					"<p>Anthropic accidentally published a source map for Claude Code in March 2026.</p>",
					"<p>The leak exposed internal TypeScript for the CLI package.</p>",
					"<p>The package was pulled and republished shortly after disclosure.</p>",
					"</article>",
					"</body>",
					"</html>",
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const result = await autonWebFetchToolDefinition.execute(
			"tool-auton-web-fetch",
			{ url: "https://example.com/claude-code" },
			undefined,
			async () => {},
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);

		const details = result.details as Record<string, unknown>;
		expect(details.status).toBe("rich");
		expect(details.facts).toEqual(
			expect.arrayContaining([
				expect.stringContaining("Anthropic accidentally published a source map"),
				expect.stringContaining("The leak exposed internal TypeScript"),
			]),
		);
		expect(result.content[0]?.text).toContain("This source summary is likely sufficient");
	});

	test("autonomous webFetch suppresses docs boilerplate in facts for docs-reference urls", async () => {
		rememberResearchUrlHints(["https://react.dev/reference/react/useActionState"], {
			intent: "docs_reference",
			richFetch: false,
		});
		const fetchMock = vi.fn(async () => ({
			ok: true,
			headers: new Headers({ "content-type": "text/html" }),
			text: async () =>
				[
					"<html>",
					"<head>",
					"<title>useActionState – React</title>",
					'<meta name="description" content="The library for web and native user interfaces">',
					"</head>",
					"<body>",
					"<main>",
					"<p>API Reference Hooks Copy pageCopy</p>",
					"<h1>useActionState</h1>",
					"<p><code>useActionState</code> is a React Hook that lets you update state with side effects using Actions.</p>",
					"<p><code>useActionState(reducerAction, initialState, permalink?)</code></p>",
					"<p>Using with Action props</p>",
					"</main>",
					"</body>",
					"</html>",
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const result = await autonWebFetchToolDefinition.execute(
			"tool-auton-web-fetch",
			{ url: "https://react.dev/reference/react/useActionState" },
			undefined,
			async () => {},
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);

		const details = result.details as Record<string, unknown>;
		const facts = details.facts as string[];
		const preview = details.preview as string;
		const transcript = result.content[0]?.text ?? "";

		expect(facts).not.toContain("The library for web and native user interfaces");
		expect(facts).not.toContain("API Reference Hooks Copy pageCopy");
		expect(facts).toEqual(
			expect.arrayContaining([
				expect.stringContaining("`useActionState` is a React Hook"),
				expect.stringContaining("`useActionState(reducerAction, initialState, permalink?)`"),
			]),
		);
		expect(transcript).not.toContain("The library for web and native user interfaces");
		expect(transcript).not.toContain("API Reference Hooks Copy pageCopy");
		expect(transcript).not.toContain("- Reference");
		expect(transcript).not.toContain("reducerAction function");
		expect(transcript).not.toContain("# useActionState");
		expect(transcript).not.toContain("`useActionState(reducerAction, initialState, permalink?)`\n`useActionState(reducerAction, initialState, permalink?)`");
		expect(transcript).toContain("Using with Action props");
		expect(preview).toContain("Using with Action props");
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

	test("widens fetch compression only for remembered research-heavy URLs", () => {
		const baseProfile = deriveResearchCompressionProfile({ tokens: 2_000, contextWindow: 50_000, percent: 4 });
		const intent = detectResearchQueryIntent("research the latest claude code leak and summarize it");
		rememberResearchUrlHints(["https://tech-insider.org/anthropic-claude-code-source-code-leak-npm-2026/"], {
			intent,
			richFetch: true,
		});

		const richerProfile = getEffectiveFetchCompressionProfile(baseProfile, {
			intent,
			richFetch: true,
		});

		expect(richerProfile.fetchTranscriptFacts).toBeGreaterThan(baseProfile.fetchTranscriptFacts);
		expect(richerProfile.fetchTranscriptPreviewLines).toBeGreaterThan(baseProfile.fetchTranscriptPreviewLines);
		expect(getEffectiveFetchCompressionProfile(baseProfile, undefined)).toEqual(baseProfile);
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
		expect(rendered).toContain("WEBSEARCH");
		expect(rendered).toContain("Search returned 4 results");
		expect(rendered).toContain("latest React docs");
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
		expect(rendered).toContain("WEBFETCH");
		expect(rendered).toContain("Fetched React");
		expect(rendered).toContain("https://react.dev/");
		expect(rendered).not.toContain("Install from npm or use a framework.");
	});
});
