import { createServer, type Server } from "node:http";
import type { AgentToolResult } from "@ag1/agent-core";
import type { TUI } from "@ag1/tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { webFetchToolDefinition as autonWebFetchToolDefinition } from "../src/core/auton/tools/webfetch.js";
import { createWebSearchTool, webFetchToolDefinition, webSearchToolDefinition } from "../src/core/tools/index.js";
import {
	detectResearchQueryIntent,
	getEffectiveFetchCompressionProfile,
	getResearchUrlHint,
	rememberResearchFetchOutcome,
	rememberResearchUrlHints,
	resetResearchHintMemoryForTests,
} from "../src/core/tools/research-intent.js";
import {
	assessCurrentEventsCoverage,
	assessResearchCoverage,
	assessResearchFetchContent,
	buildResearchPreview,
	deriveResearchCompressionProfile,
	extractResearchFacts,
	formatFetchTranscriptContent,
	formatSearchTranscriptContent,
} from "../src/core/tools/research-output.js";
import { parseDuckDuckGoResultsForTests } from "../src/core/tools/websearch.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

function firstBlockText(result: AgentToolResult<unknown>): string {
	const block = result.content[0];
	return block?.type === "text" ? block.text : "";
}

describe("web research tool context efficiency", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		resetResearchHintMemoryForTests();
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

	test("prioritizes focus-term lines in docs previews and facts", () => {
		const markdown = [
			"# useActionState",
			"`useActionState` is a React Hook that lets you update state with side effects using Actions.",
			"Adding state to an Action",
			"Using multiple Action types",
			"When using the permalink option, ensure the same form component is rendered on the destination page so React can pass the state through.",
			"Once the page becomes interactive, this parameter has no effect.",
		].join("\n");

		const preview = buildResearchPreview(markdown, 3, 180, ["useactionstate", "permalink"]);
		const facts = extractResearchFacts(markdown, 2, 180, ["useactionstate", "permalink"]);

		expect(preview).toContain("permalink option");
		expect(facts.some((fact) => fact.includes("permalink option"))).toBe(true);
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

	test("filters article chrome and promo lines out of fetch previews", () => {
		const preview = buildResearchPreview(
			[
				"InfoQ Homepage",
				"Development",
				"Apr 07, 2026",
				"min read",
				"Write for InfoQ",
				"Feed your curiosity.",
				"Help 550k+ global senior developers each month stay ahead.Get in touch",
				"Listen to this article - 0:00",
				"Security researcher Chaofan Shou discovered on March 31 that Anthropic's Claude Code CLI tool had its full TypeScript source code sitting in plain sight on the public npm registry.",
				"Anthropic called it a release packaging issue caused by human error, not a security breach.",
			].join("\n"),
			4,
			160,
		);

		expect(preview).not.toContain("InfoQ Homepage");
		expect(preview).not.toContain("min read");
		expect(preview).not.toContain("Write for InfoQ");
		expect(preview).not.toContain("Get in touch");
		expect(preview).not.toContain("Listen to this article");
		expect(preview).toContain("Security researcher Chaofan Shou discovered");
		expect(preview).toContain("Anthropic called it a release packaging issue");
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
		expect(text).not.toContain("Fetch one strongest source first.");
		expect(text).not.toContain("Search results are only a compact index");
		expect(text).not.toContain("Do not repeat webSearch");
	});

	test("parses DuckDuckGo result snippets across common HTML shapes", () => {
		const results = parseDuckDuckGoResultsForTests(
			[
				'<div class="result">',
				'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev%2Freference%2Freact">React <b>Reference</b></a>',
				'<a class="result__snippet">Official <b>React</b> API reference.</a>',
				"</div>",
				'<div class="result">',
				'<a class="result__a" href="https://www.typescriptlang.org/tsconfig/">TSConfig Reference</a>',
				'<div class="result__snippet">Compiler option docs with <span>nested markup</span>.</div>',
				"</div>",
				'<div class="result">',
				'<a class="result__a" href="https://nodejs.org/api/fs.html">File system | Node.js</a>',
				"</div>",
			].join(""),
			5,
		);

		expect(results).toEqual([
			{
				title: "React Reference",
				url: "https://react.dev/reference/react",
				snippet: "Official React API reference.",
			},
			{
				title: "TSConfig Reference",
				url: "https://www.typescriptlang.org/tsconfig/",
				snippet: "Compiler option docs with nested markup.",
			},
			{
				title: "File system | Node.js",
				url: "https://nodejs.org/api/fs.html",
				snippet: "",
			},
		]);
	});

	test("uses DuckDuckGo as the free default search provider", async () => {
		const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="https://react.dev/reference/react">React Reference</a>',
					'<a class="result__snippet">Official React reference docs.</a>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "React reference default provider unique probe" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const details = result.details as Record<string, unknown>;

		expect(details.searchProviderMode).toBe("auto");
		expect(details.searchProviderOrder).toEqual(["duckduckgo"]);
		expect(details.searchProvider).toBe("duckduckgo-html");
		expect(fetchMock.mock.calls[0]?.[0]).toContain("html.duckduckgo.com");
	});

	test("uses Brave first in auto mode when a Brave key is configured", async () => {
		vi.stubEnv("AG1_BRAVE_SEARCH_API_KEY", "brave-test-key");
		const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => ({
			ok: true,
			json: async () => ({
				web: {
					results: [
						{
							title: "React Reference",
							url: "https://react.dev/reference/react",
							description: "Official <b>React</b> reference docs.",
						},
					],
				},
			}),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "React reference brave provider unique probe" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const details = result.details as Record<string, unknown>;
		const attempts = details.searchAttempts as Array<Record<string, unknown>>;

		expect(details.searchProviderMode).toBe("auto");
		expect(details.searchProviderOrder).toEqual(["brave", "duckduckgo"]);
		expect(details.searchProvider).toBe("brave");
		expect(attempts[0]?.provider).toBe("brave");
		expect((details.sourceUrls as string[])[0]).toBe("https://react.dev/reference/react");
		expect(fetchMock.mock.calls[0]?.[0]).toContain("api.search.brave.com");
		expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
			"X-Subscription-Token": "brave-test-key",
		});
	});

	test("falls back to DuckDuckGo when explicit Brave mode has no key", async () => {
		vi.stubEnv("AG1_WEB_SEARCH_PROVIDER", "brave");
		vi.stubEnv("AG1_BRAVE_SEARCH_API_KEY", "");
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="https://react.dev/reference/react">React Reference</a>',
					'<a class="result__snippet">Official React reference docs.</a>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "React reference brave fallback unique probe" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const details = result.details as Record<string, unknown>;
		const attempts = details.searchAttempts as Array<Record<string, unknown>>;

		expect(details.searchProviderMode).toBe("brave");
		expect(details.searchProviderOrder).toEqual(["brave", "duckduckgo"]);
		expect(details.searchProvider).toBe("duckduckgo-html");
		expect(attempts[0]).toMatchObject({
			provider: "brave",
			status: "skipped",
		});
		expect(attempts[1]?.provider).toBe("duckduckgo-html");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("ranks repo sources above generic docs for code lookup queries", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flearn.microsoft.com%2Fen-us%2Fdotnet%2Fapi%2Fsystem.io.file.writealltext">WriteAllText docs</a>',
					'<a class="result__snippet">Microsoft documentation reference.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fmariozechner%2Fag1-coding-agent%2Fblob%2Fmain%2Fpackages%2Fcoding-agent%2Fsrc%2Fcore%2Ftools%2Fwrite.ts">write.ts</a>',
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
		const text = firstBlockText(result);
		const details = result.details as Record<string, unknown>;

		expect(text).toContain("1. write.ts");
		expect((details.preferredSourceUrls as string[])[0]).toContain("github.com");
		expect((details.sourceUrls as string[])[0]).toContain("github.com");
	});

	test("prefers stable OpenAI developer pricing docs over the marketing pricing page for pricing queries", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fopenai.com%2Fapi%2Fpricing%2F">API Pricing - OpenAI</a>',
					'<a class="result__snippet">Explore OpenAI API pricing for GPT models and tools.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdevelopers.openai.com%2Fapi%2Fdocs%2Fpricing">Pricing | OpenAI API</a>',
					'<a class="result__snippet">Pricing information for the OpenAI platform.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fplatform.openai.com%2Fpricing">OpenAI Platform Pricing</a>',
					'<a class="result__snippet">OpenAI platform pricing overview.</a>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "OpenAI API pricing noresults probe" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const details = result.details as Record<string, unknown>;
		const sourceUrls = details.sourceUrls as string[];

		expect(sourceUrls[0]).toBe("https://developers.openai.com/api/docs/pricing");
		expect(sourceUrls[1]).toBe("https://platform.openai.com/pricing");
		expect(sourceUrls[2]).toBe("https://openai.com/api/pricing/");
	});

	test("demotes third-party pricing aggregators for OpenAI pricing queries even when they include the year", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.aipricing.guru%2Fopenai-pricing%2F">OpenAI API Pricing 2026 | AI Pricing Guru</a>',
					'<a class="result__snippet">Complete OpenAI API pricing for 2026.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fapicents.com%2Fprovider%2Fopenai">OpenAI API Pricing 2026 | APICents</a>',
					'<a class="result__snippet">OpenAI model costs and context windows.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdevelopers.openai.com%2Fapi%2Fdocs%2Fpricing">Pricing | OpenAI API</a>',
					'<a class="result__snippet">Pricing information for the OpenAI platform.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fplatform.openai.com%2Fpricing">OpenAI Platform Pricing</a>',
					'<a class="result__snippet">OpenAI platform pricing overview.</a>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "OpenAI API pricing 2026", maxResults: 4 },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const details = result.details as Record<string, unknown>;
		const sourceUrls = details.sourceUrls as string[];

		expect(sourceUrls[0]).toBe("https://developers.openai.com/api/docs/pricing");
		expect(sourceUrls[1]).toBe("https://platform.openai.com/pricing");
		expect(sourceUrls.slice(2)).toContain("https://www.aipricing.guru/openai-pricing/");
		expect(sourceUrls.slice(2)).toContain("https://apicents.com/provider/openai");
	});

	test("diversifies non-official result hosts while preserving rank diagnostics", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="https://blog.example.com/react-hooks-a">React hooks article A</a>',
					'<a class="result__snippet">Detailed React hooks explanation.</a>',
					'<a class="result__a" href="https://blog.example.com/react-hooks-b">React hooks article B</a>',
					'<a class="result__snippet">Another React hooks explanation.</a>',
					'<a class="result__a" href="https://docs.example.org/react-hooks">React hooks docs</a>',
					'<a class="result__snippet">Reference material with matching React hooks terms.</a>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "React hooks behavior comparison unique diversity probe" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const details = result.details as Record<string, unknown>;
		const sourceUrls = details.sourceUrls as string[];
		const results = details.results as Array<Record<string, unknown>>;

		expect(sourceUrls[0]).toBe("https://docs.example.org/react-hooks");
		expect(sourceUrls[1]).toBe("https://blog.example.com/react-hooks-a");
		expect(sourceUrls[2]).toBe("https://blog.example.com/react-hooks-b");
		expect(results[0]?.scoreReasons).toEqual(expect.arrayContaining(["docs_path", "query_term_match"]));
		expect(results[0]?.fetchRisk).toBe("low");
	});

	test("webFetch preserves content type for explicitly allowed local fetches", async () => {
		vi.stubEnv("AG1_ALLOW_PRIVATE_WEBFETCH", "1");
		let server: Server | undefined;
		const url = await new Promise<string>((resolve) => {
			server = createServer((_request, response) => {
				response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				response.end(
					"<html><head><title>Local Doc</title></head><body><main><p>Useful local fetch content for parsing.</p></main></body></html>",
				);
			});
			server.listen(0, "127.0.0.1", () => {
				const address = server?.address();
				if (typeof address === "object" && address) {
					resolve(`http://127.0.0.1:${address.port}/doc`);
				}
			});
		});

		try {
			const result = await webFetchToolDefinition.execute("tool-web-fetch", { url }, undefined, undefined, {
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any);
			const details = result.details as Record<string, unknown>;
			const text = firstBlockText(result);

			expect(details.contentType).toBe("text/html; charset=utf-8");
			expect(text).toContain("Useful local fetch content");
			expect(text).not.toContain("__CRUCIBLE_CONTENT_TYPE__");
			expect(text).not.toContain("text/html; charset=utf-8");
		} finally {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
		}
	});

	test("webFetch rejects local and non-http URLs before fetching", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const localResult = await webFetchToolDefinition.execute(
			"tool-web-fetch-local",
			{ url: "http://127.0.0.1:1234/private" },
			undefined,
			undefined,
			{} as any,
		);
		const fileResult = await webFetchToolDefinition.execute(
			"tool-web-fetch-file",
			{ url: "file:///etc/passwd" },
			undefined,
			undefined,
			{} as any,
		);

		expect(firstBlockText(localResult)).toContain("private/internal addresses");
		expect(firstBlockText(fileResult)).toContain("Only http:// and https:// URLs are allowed");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("webFetch validates redirect targets before following them", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response("", {
					status: 302,
					headers: { location: "http://127.0.0.1:1234/private" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await webFetchToolDefinition.execute(
			"tool-web-fetch-redirect",
			{ url: "https://93.184.216.34/start" },
			undefined,
			undefined,
			{} as any,
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(firstBlockText(result)).toContain("private/internal addresses");
	});

	test("normalizes OpenAI pricing docs queries toward official-site phrasing", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdevelopers.openai.com%2Fapi%2Fdocs%2Fpricing">Pricing | OpenAI API</a>',
					'<a class="result__snippet">Pricing information for the OpenAI platform.</a>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute("tool-web-search", { query: "OpenAI API pricing" }, undefined, undefined, {
			getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
		} as any);
		const details = result.details as Record<string, unknown>;

		expect(details.query).toBe("OpenAI API pricing");
		expect(details.effectiveQuery).toBe("OpenAI API pricing official website");
	});

	test("plans official docs lookups without dropping exact provider and model identifiers", async () => {
		const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbuild.nvidia.com%2Fnvidia%2Fllama-3_1-nemotron-ultra-253b-v1">NVIDIA Nemotron model</a>',
					'<div class="result__snippet">NVIDIA API model documentation for llama-3.1-nemotron-ultra-253b-v1.</div>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "NVIDIA Nemotron llama-3.1-nemotron-ultra-253b-v1 API provider docs" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const details = result.details as Record<string, unknown>;

		expect(details.intent).toBe("docs_reference");
		expect(details.effectiveQuery).toContain("llama-3.1-nemotron-ultra-253b-v1");
		expect(details.effectiveQuery).toContain("official docs");
		expect(details.preferredDomains).toEqual(["build.nvidia.com", "docs.api.nvidia.com", "developer.nvidia.com"]);
		expect(fetchMock.mock.calls[0]?.[0]).toContain("llama-3.1-nemotron-ultra-253b-v1");
	});

	test("uses official docs fallback for LM Studio OpenAI-compatible endpoint queries", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () => "",
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "LM Studio OpenAI-compatible endpoint docs unique fallback probe" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const details = result.details as Record<string, unknown>;

		expect(details.intent).toBe("docs_reference");
		expect(details.searchProvider).toBe("official-fallback");
		expect(details.fallbackUsed).toBe(true);
		expect((details.sourceUrls as string[])[0]).toBe("https://lmstudio.ai/docs");
		expect(firstBlockText(result)).toContain("LM Studio Docs [authoritative]");
	});

	test("preserves exact error messages in planner queries", async () => {
		const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="https://github.com/vitejs/vite/issues/123">Vite issue</a>',
					'<a class="result__snippet">Discussion of TypeError: crypto.hash is not a function in Node versions.</a>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "Vite build fails TypeError: crypto.hash is not a function on Node 20" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const details = result.details as Record<string, unknown>;

		expect(details.effectiveQuery).toContain('"TypeError: crypto.hash is not a function on Node 20"');
		expect(details.searchStrategy).toContain("exact error string");
		expect(fetchMock.mock.calls[0]?.[0]).toContain(
			"%22TypeError%3A%20crypto.hash%20is%20not%20a%20function%20on%20Node%2020%22",
		);
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
			{ query: "latest claude code leak 2026 remembered-quality probe" },
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

	test("prefers sturdier current-events outlets over flaky niche domains for broad latest-news queries", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ftech-insider.org%2Fanthropic-claude-code-source-code-leak-npm-2026%2F">Anthropic Claude Code Source Code Leak: Full Analysis (2026)</a>',
					'<a class="result__snippet">Anthropic accidentally leaked 512,000 lines of Claude Code source code via npm.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Farstechnica.com%2Fai%2F2026%2F04%2Fheres-what-that-claude-code-source-leak-reveals-about-anthropics-plans%2F">Here&apos;s what that Claude Code source leak reveals about Anthropic&apos;s plans</a>',
					'<a class="result__snippet">Ars Technica coverage of the leak and what it reveals about Claude Code.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.techradar.com%2Fpro%2Fsecurity%2Fanthropic-confirms-it-leaked-512-000-lines-of-claude-code-source-code-spilling-some-of-its-biggest-secrets">Anthropic confirms it leaked 512,000 lines of Claude Code source code</a>',
					'<a class="result__snippet">TechRadar coverage of the Claude Code source code leak.</a>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "Claude code leak 2024 2025 latest news broad latest-news probe" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const details = result.details as Record<string, unknown>;
		const sourceUrls = details.sourceUrls as string[];
		const topTwo = sourceUrls.slice(0, 2);

		expect(topTwo.some((url) => url.includes("arstechnica.com"))).toBe(true);
		expect(topTwo.some((url) => url.includes("techradar.com"))).toBe(true);
		expect(sourceUrls[2]).toContain("tech-insider.org");
	});

	test("demotes blog-style and weak cyber outlets for broad current-events leak queries", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdev.to%2Fvibehackers%2Fi-analyzed-all-512000-lines-of-claude-codes-leaked-source-heres-what-anthropic-was-hiding-4gg8">I Analyzed All 512,000 Lines of Claude Code&apos;s Leaked Source</a>',
					'<a class="result__snippet">A detailed blog-style analysis of the Claude Code leak.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fcybersecuritynews.com%2Fclaude-code-source-code-leaked%2F">Anthropic&apos;s Claude Code Source Code Reportedly Leaked</a>',
					'<a class="result__snippet">Cyber Security News coverage of the leak.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.techradar.com%2Fpro%2Fsecurity%2Fanthropic-confirms-it-leaked-512-000-lines-of-claude-code-source-code-spilling-some-of-its-biggest-secrets">Anthropic confirms it leaked 512,000 lines of Claude Code source code</a>',
					'<a class="result__snippet">TechRadar coverage of the leak and what happened.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.infoq.com%2Fnews%2F2026%2F04%2Fclaude-code-source-leak%2F">Anthropic Accidentally Exposes Claude Code Source via npm Source Map File</a>',
					'<a class="result__snippet">InfoQ coverage with incident details.</a>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "research the latest claude code leak and summarize it broad-quality probe" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const details = result.details as Record<string, unknown>;
		const sourceUrls = details.sourceUrls as string[];

		const topTwo = sourceUrls.slice(0, 2);
		expect(sourceUrls[0]).toContain("techradar.com");
		expect(topTwo.some((url) => url.includes("dev.to"))).toBe(false);
		expect(sourceUrls.slice(2)).toContain(
			"https://dev.to/vibehackers/i-analyzed-all-512000-lines-of-claude-codes-leaked-source-heres-what-anthropic-was-hiding-4gg8",
		);
	});

	test("normalizes claude code leak current-events queries away from generic breach wording", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.techradar.com%2Fpro%2Fsecurity%2Fanthropic-confirms-it-leaked-512-000-lines-of-claude-code-source-code-spilling-some-of-its-biggest-secrets">Anthropic confirms it leaked 512,000 lines of Claude Code source code</a>',
					'<a class="result__snippet">TechRadar coverage of the Claude Code leak.</a>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "Claude Code leak 2024 2025 data breach" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const details = result.details as Record<string, unknown>;

		expect(details.query).toBe("Claude Code leak 2024 2025 data breach");
		expect(details.effectiveQuery).toBe("Claude Code source map npm leak March 2026 Anthropic");
		expect(firstBlockText(result)).toContain("Web search: Claude Code source map npm leak March 2026 Anthropic");
	});

	test("prefers analysis-style sources over generic news when the query asks for strongest sources", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.techspot.com%2Fnews%2F111907-anthropic-accidentally-exposed-claude-code-source-raising-security.html">Anthropic accidentally exposed Claude Code source, raising security ...</a>',
					'<a class="result__snippet">Anthropic confirmed the incident in an emailed statement, characterizing it as a packaging failure rather than a direct breach.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.varonis.com%2Fblog%2Fclaude-code-leak">A Look Inside Claude&apos;s Leaked AI Coding Agent - Varonis</a>',
					'<a class="result__snippet">A Varonis Threat Labs breakdown of Anthropic&apos;s Claude Code leak, uncovering the AI coding agent&apos;s architecture, guardrails, and attack surface.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ftech-insider.org%2Fanthropic-claude-code-source-code-leak-npm-2026%2F">Anthropic Claude Code Source Code Leak: Full Analysis (2026)</a>',
					'<a class="result__snippet">Full analysis of the leak, hidden features, DMCA controversy, and security implications.</a>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{
				query: "research the latest claude code leak, cite the strongest sources, and summarize it briefly unique corroboration probe",
			},
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const details = result.details as Record<string, unknown>;
		const sourceUrls = details.sourceUrls as string[];

		expect(sourceUrls[0]).toBe("https://www.varonis.com/blog/claude-code-leak");
		expect(sourceUrls.slice(1, 3)).toContain(
			"https://tech-insider.org/anthropic-claude-code-source-code-leak-npm-2026/",
		);
		expect(sourceUrls.slice(1, 3).some((url) => url.includes("techspot.com"))).toBe(true);
		expect(firstBlockText(result)).toContain("Fetch the strongest source first.");
		expect(firstBlockText(result)).toContain(
			"if the first fetched source is rich and specific, answer from it directly",
		);
	});

	test("demotes osint-style blogs for strongest-source claude code leak queries", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fosintteam.blog%2Fthe-claude-code-leak-whats-now-publicly-usable-and-abusable-and-why-anthropic-s-containment-023677bb4f42">The Claude Code Leak: What\'s Now Publicly Usable (and Abusable)</a>',
					'<a class="result__snippet">An OSINT-style blog post about the Claude Code leak.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.wired.com%2Fstory%2Fsecurity-news-this-week-hackers-are-posting-the-claude-code-leak-with-bonus-malware%2F">Hackers Are Posting the Claude Code Leak With Bonus Malware</a>',
					'<a class="result__snippet">WIRED coverage of the leak and its aftermath.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.theverge.com%2Fai-artificial-intelligence%2F904776%2Fanthropic-claude-source-code-leak">Claude Code leak exposes a Tamagotchi-style pet</a>',
					'<a class="result__snippet">The Verge report on the Claude Code source leak.</a>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{
				query: "research the latest claude code leak, cite the strongest sources, and summarize it briefly osint probe",
			},
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const details = result.details as Record<string, unknown>;
		const sourceUrls = details.sourceUrls as string[];

		expect(sourceUrls[0]).toContain("wired.com");
		expect(sourceUrls[1]).toContain("theverge.com");
		expect(sourceUrls[2]).toContain("osintteam.blog");
	});

	test("prefers primary leak-mechanics coverage over tangential follow-up angles for Claude Code leak queries", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.securityweek.com%2Fcritical-vulnerability-in-claude-code-emerges-days-after-source-leak%2F">Critical Vulnerability in Claude Code Emerges Days After Source Leak</a>',
					'<a class="result__snippet">Within days of the source leak, researchers found a critical vulnerability in Claude Code.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.techradar.com%2Fpro%2Fsecurity%2Fanthropic-confirms-it-leaked-512-000-lines-of-claude-code-source-code-spilling-some-of-its-biggest-secrets">Anthropic confirms it leaked 512,000 lines of Claude Code source code</a>',
					'<a class="result__snippet">Anthropic employee accidentally leaked Claude Code source via npm map file, exposing 1,900 TypeScript files.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Farstechnica.com%2Fai%2F2026%2F04%2Fheres-what-that-claude-code-source-leak-reveals-about-anthropics-plans%2F">Here&apos;s what that Claude Code source leak reveals about Anthropic&apos;s plans</a>',
					'<a class="result__snippet">The leak reveals upcoming features and product plans including Buddy and Undercover mode.</a>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "Claude code leak 2026 security incident breach" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const details = result.details as Record<string, unknown>;
		const sourceUrls = details.sourceUrls as string[];

		expect(sourceUrls[0]).toContain("techradar.com");
		expect(sourceUrls.slice(1, 3).some((url) => url.includes("securityweek.com"))).toBe(true);
		expect(sourceUrls.slice(1, 3).some((url) => url.includes("arstechnica.com"))).toBe(true);
	});

	test("prefers sturdier corroborating sources over flashy blocked domains for strongest-source queries", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ftech-insider.org%2Fanthropic-claude-code-source-code-leak-npm-2026%2F">Anthropic Claude Code Source Code Leak: Full Analysis (2026)</a>',
					'<a class="result__snippet">Full analysis of the leak, hidden features, DMCA controversy, and security implications.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffortune.com%2F2026%2F03%2F31%2Fanthropic-source-code-claude-code-data-leak-second-security-lapse-days-after-accidentally-revealing-mythos%2F">Anthropic leaks its own AI coding tool source code</a>',
					'<a class="result__snippet">Fortune coverage of the leak and second security lapse.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.infoq.com%2Fnews%2F2026%2F04%2Fclaude-code-source-leak%2F">Anthropic Accidentally Exposes Claude Code Source via npm Source Map File</a>',
					'<a class="result__snippet">InfoQ coverage of the March 2026 source-map leak with technical details and confirmation.</a>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "research the latest claude code leak, cite the strongest sources, and summarize it briefly" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const details = result.details as Record<string, unknown>;
		const sourceUrls = details.sourceUrls as string[];
		const text = firstBlockText(result);

		expect(sourceUrls[0]).toBe("https://www.infoq.com/news/2026/04/claude-code-source-leak/");
		expect(sourceUrls[1]).toContain("fortune.com");
		expect(sourceUrls[2]).toContain("tech-insider.org");
		expect(text).toContain("Fetch the strongest source first. Only fetch one independent corroborating source");
		expect(text).toContain("Treat the other top search results as corroborating candidates");
	});

	test("uses remembered fetch quality to demote placeholder sources and prefer rich ones", async () => {
		rememberResearchFetchOutcome("https://placeholder.example.com/gate", "placeholder");
		rememberResearchFetchOutcome("https://evidence.example.com/report", "rich");

		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fplaceholder.example.com%2Fgate">Blocked page</a>',
					'<a class="result__snippet">Please wait while we verify your browser.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fevidence.example.com%2Freport">Security report</a>',
					'<a class="result__snippet">Detailed analysis of the incident.</a>',
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

		expect(sourceUrls[0]).toBe("https://evidence.example.com/report");
		expect(sourceUrls[1]).toBe("https://placeholder.example.com/gate");
	});

	test("web fetch records docs intent metadata when sourced from a docs query hint", async () => {
		rememberResearchUrlHints(["https://react.dev/reference/react/useActionState"], {
			intent: "docs_reference",
			richFetch: false,
		});
		const fetchMock = vi.fn(async () => ({
			ok: true,
			headers: { get: () => "text/html" },
			text: async () =>
				[
					"<html><head><title>useActionState – React</title></head><body>",
					"<main><h1>useActionState</h1><p>`useActionState` is a React Hook that lets you update state with side effects using Actions.</p></main>",
					"</body></html>",
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const result = await webFetchToolDefinition.execute(
			"tool-web-fetch",
			{ url: "https://react.dev/reference/react/useActionState" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);

		expect((result.details as Record<string, unknown>).intent).toBe("docs_reference");
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
		const text = firstBlockText(result);

		expect(details.intent).toBe("docs_reference");
		expect(sourceUrls[0]).toBe("https://react.dev/reference/react/useActionState");
		expect(text).toContain("1. useActionState - React");
	});

	test("plans TypeScript compiler option queries toward official docs", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="https://www.typescriptlang.org/tsconfig/noUncheckedIndexedAccess.html">noUncheckedIndexedAccess</a>',
					'<a class="result__snippet">Official TSConfig reference for noUncheckedIndexedAccess.</a>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "TypeScript noUncheckedIndexedAccess compiler option" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const details = result.details as Record<string, unknown>;

		expect(details.intent).toBe("docs_reference");
		expect(details.effectiveQuery).toBe("TypeScript noUncheckedIndexedAccess compiler option official docs");
		expect((details.preferredDomains as string[])[0]).toBe("www.typescriptlang.org");
		expect((details.sourceUrls as string[])[0]).toBe(
			"https://www.typescriptlang.org/tsconfig/noUncheckedIndexedAccess.html",
		);
	});

	test("adds source repository terms for implementation lookup queries", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="https://github.com/facebook/react/blob/main/packages/react/src/ReactHooks.js">ReactHooks.js</a>',
					'<a class="result__snippet">Source implementation for useActionState.</a>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "useActionState implementation ReactHooks.js" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const details = result.details as Record<string, unknown>;
		const ranked = details.results as Array<Record<string, unknown>>;

		expect(details.intent).toBe("code_lookup");
		expect(details.effectiveQuery).toBe("useActionState implementation ReactHooks.js github source");
		expect(ranked[0]?.scoreReasons).toEqual(expect.arrayContaining(["source_repo"]));
	});

	test("marks rich fetch summaries as sufficient instead of nudging extra fetch churn", () => {
		const text = formatFetchTranscriptContent({
			url: "https://react.dev/",
			title: "React",
			facts: ["React builds user interfaces from components.", "Create interactive UIs using declarative code."],
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
		expect(text).not.toContain("Reuse this URL as the source reference");
	});

	test("marks non-authoritative current-events fetches as fallback evidence instead of fully sufficient", () => {
		const text = formatFetchTranscriptContent({
			url: "https://secondary.example.com/leak-analysis",
			title: "Leak analysis",
			facts: [
				"Anthropic accidentally exposed internal Claude Code source files in March 2026.",
				"Researchers reported the leak after mirrored package artifacts spread.",
			],
			preview: [
				"# Leak analysis",
				"Anthropic accidentally exposed internal Claude Code source files in March 2026.",
				"Researchers reported the leak after mirrored package artifacts spread.",
			].join("\n"),
			profile: deriveResearchCompressionProfile({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			status: "rich",
			intent: "current_events",
			authoritative: false,
		});

		expect(text).toContain("usable as a fallback");
		expect(text).toContain("corroborate with an authoritative or independent source");
		expect(text).not.toContain("likely sufficient to answer or cite without refetching");
	});

	test("marks authoritative current-events fetches as sufficient for brief summaries", () => {
		const text = formatFetchTranscriptContent({
			url: "https://www.infoq.com/news/2026/04/claude-code-source-leak/",
			title: "Anthropic Accidentally Exposes Claude Code Source via npm Source Map File",
			facts: [
				"Security researcher Chaofan Shou discovered on March 31 that Anthropic's Claude Code CLI tool had its full TypeScript source code exposed on npm.",
				"Anthropic called it a release packaging issue caused by human error, not a security breach.",
			],
			preview: [
				"Security researcher Chaofan Shou discovered on March 31 that Anthropic's Claude Code CLI tool had its full TypeScript source code exposed on npm.",
				"Anthropic called it a release packaging issue caused by human error, not a security breach.",
			].join("\n"),
			profile: deriveResearchCompressionProfile({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			status: "rich",
			intent: "current_events",
			authoritative: true,
		});

		expect(text).toContain("authoritative current-events source is likely sufficient");
		expect(text).toContain("Answer from it now");
	});

	test("marks authoritative docs fetches as sufficient without refetching the same URL", () => {
		const text = formatFetchTranscriptContent({
			url: "https://react.dev/reference/react/useActionState",
			title: "useActionState – React",
			facts: [
				"`useActionState` is a React Hook that lets you update state with side effects using Actions.",
				"`useActionState(reducerAction, initialState, permalink?)`",
			],
			preview: [
				"# useActionState",
				"`useActionState` is a React Hook that lets you update state with side effects using Actions.",
				"`useActionState(reducerAction, initialState, permalink?)`",
			].join("\n"),
			profile: deriveResearchCompressionProfile({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			status: "rich",
			intent: "docs_reference",
			authoritative: true,
		});

		expect(text).toContain("authoritative docs page is likely sufficient");
		expect(text).toContain("Do not refetch the same URL");
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
		expect(text).toContain(
			"`const [state, dispatchAction, isPending] = useActionState(reducerAction, initialState, permalink?);`",
		);
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
				preview:
					"Anthropic accidentally published a source map in March 2026.\nThe leak exposed internal TypeScript.",
			}).status,
		).toBe("rich");
	});

	test("classifies javascript app shells as placeholder content before fetch churn continues", () => {
		expect(
			assessResearchFetchContent({
				title: "App shell",
				metaDescription: "Please wait while we verify your browser",
				markdown: [
					"Please wait while we verify your browser",
					"Checking if the site connection is secure",
					"JavaScript is required to continue",
				].join("\n"),
				facts: [],
				preview: ["Please wait while we verify your browser", "Checking if the site connection is secure"].join(
					"\n",
				),
			}),
		).toEqual({
			status: "placeholder",
			reason: "javascript gate detected",
		});
	});

	test("treats import-heavy raw source extracts as thin evidence", () => {
		expect(
			assessResearchFetchContent({
				title: "write.ts",
				markdown: [
					'import { promises as fs } from "node:fs";',
					'import path from "node:path";',
					"export function formatWriteSuccess(target: string) {",
					"  return `Wrote $" + "{target}`;",
					"}",
				].join("\n"),
				facts: [
					'import { promises as fs } from "node:fs";',
					"export function formatWriteSuccess(target: string) {",
				],
				preview: [
					'import { promises as fs } from "node:fs";',
					'import path from "node:path";',
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
		expect(facts).toContain(
			"`useActionState` is a React Hook that lets you update state with side effects using Actions.",
		);
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
		const result = await tool.execute("tool-web-search", { query: "latest React docs" }, undefined, undefined, {
			getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
		} as any);
		const text = firstBlockText(result);

		expect(text).toContain("1. React Docs [authoritative] — https://react.dev/");
		expect(text).toContain("2. React Blog");
		expect(text).toContain("Only if a key concept is still missing, next step: webFetch https://react.dev/");
		expect((result.details as Record<string, unknown>).compressionMode).toBe("tight");
		expect((result.details as Record<string, unknown>).preferredSourceUrls).toEqual([
			"https://react.dev/",
			"https://react.dev/blog",
		]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("rewrites conversational current-events searches into targeted search plans", async () => {
		const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fthehackernews.com%2F2026%2F04%2Fclaude-code-leaked-via-npm-packaging.html">Claude Code leaked via npm packaging</a>',
					'<a class="result__snippet">Anthropic accidentally published Claude Code source maps to npm in March 2026.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fthehackernews.com%2F2026%2F04%2Fclaude-code-leaked-via-npm-packaging.html%3Futm_source%3Dfeed">Duplicate Claude Code article</a>',
					'<a class="result__snippet">Duplicate tracking URL for the same source.</a>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "Can you research the claude code leak that happened some weeks ago?" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const text = firstBlockText(result);
		const details = result.details as Record<string, unknown>;

		expect(details.effectiveQuery).toBe("Claude Code source map npm leak March 2026 Anthropic");
		expect(details.searchStrategy).toContain("leak vector");
		expect(details.followUpQueries).toEqual(
			expect.arrayContaining([expect.stringContaining("Chaofan Shou"), expect.stringContaining("source maps")]),
		);
		expect(details.sourceUrls).toEqual([
			"https://thehackernews.com/2026/04/claude-code-leaked-via-npm-packaging.html",
		]);
		expect(text).toContain("Rewritten from: Can you research the claude code leak");
		expect(text).toContain("Search strategy: current-events query rewritten");
		expect(text).toContain("If the first source is blocked or thin");
		expect(fetchMock.mock.calls[0]?.[0]).toContain("Claude%20Code%20source%20map%20npm%20leak");
	});

	test("keeps no-result searches actionable after query rewriting", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () => "",
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "Can you research the ag1webzero qxzv incident that happened some weeks ago?" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const text = firstBlockText(result);

		expect(text).toContain("Web search: ag1webzero qxzv incident 2026");
		expect(text).toContain("Rewritten from: Can you research the ag1webzero qxzv incident");
		expect(text).toContain("No results found.");
		expect(text).toContain("Try a narrower query next:");
	});

	test("falls back to second DuckDuckGo endpoint when the first endpoint is empty", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				text: async () => "",
			})
			.mockResolvedValueOnce({
				ok: true,
				text: async () =>
					[
						'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev%2Freference%2Freact">React API Reference</a>',
						'<div class="result__snippet">Official React reference &amp; API docs.</div>',
					].join(""),
			});
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "React API reference fallback probe" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const details = result.details as Record<string, unknown>;
		const attempts = details.searchAttempts as Array<Record<string, unknown>>;

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(details.searchProvider).toBe("duckduckgo-lite");
		expect(attempts[0]?.resultCount).toBe(0);
		expect(attempts[1]?.resultCount).toBe(1);
		expect((details.sourceUrls as string[])[0]).toBe("https://react.dev/reference/react");
		expect(firstBlockText(result)).toContain("Official React reference & API docs.");
	});

	test("uses official docs fallback for OpenAI pricing when search providers return no results", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () => "",
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "OpenAI API pricing official website" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const details = result.details as Record<string, unknown>;
		const sourceUrls = details.sourceUrls as string[];

		expect(details.searchProvider).toBe("official-fallback");
		expect(details.fallbackUsed).toBe(true);
		expect(sourceUrls[0]).toBe("https://developers.openai.com/api/docs/pricing");
		expect(sourceUrls[1]).toBe("https://platform.openai.com/pricing");
		expect(firstBlockText(result)).toContain("Pricing | OpenAI API [authoritative]");
	});

	test("records pricing coverage hints on URLs returned from pricing searches", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="https://developers.openai.com/api/docs/pricing">Pricing | OpenAI API</a>',
					'<a class="result__snippet">Official OpenAI API pricing.</a>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "OpenAI API pricing coverage hint probe" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const url = ((result.details as Record<string, unknown>).sourceUrls as string[])[0];
		const hint = getResearchUrlHint(url);

		expect(hint?.intent).toBe("docs_reference");
		expect(hint?.coverageKind).toBe("pricing");
		expect(hint?.authoritative).toBe(true);
	});

	test("classifies current-events search sources for diagnostics", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () =>
				[
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.infoq.com%2Fnews%2F2026%2F04%2Fclaude-code-source-leak%2F">Anthropic Accidentally Exposes Claude Code Source via npm Source Map File</a>',
					'<a class="result__snippet">InfoQ coverage with incident details.</a>',
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdev.to%2Fvibehackers%2Fi-analyzed-all-512000-lines-of-claude-codes-leaked-source-heres-what-anthropic-was-hiding-4gg8">I Analyzed All 512,000 Lines</a>',
					'<a class="result__snippet">Community analysis of the leaked source.</a>',
				].join(""),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchTool({ cwd: "/tmp" });
		const result = await tool.execute(
			"tool-web-search",
			{ query: "research the claude code leak that happened some weeks ago" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any,
		);
		const results = (result.details as Record<string, unknown>).results as Array<Record<string, unknown>>;

		expect(results[0]?.sourceKind).toBe("news");
		expect(results[1]?.sourceKind).toBe("community");
	});

	test("assesses current-events coverage slots for fetched evidence", () => {
		const coverage = assessCurrentEventsCoverage(
			"On March 31, 2026, Anthropic accidentally published Claude Code source maps to npm. The leak exposed internal TypeScript source code, and Anthropic confirmed it was a packaging issue and republished the package.",
		);

		expect(coverage.present).toEqual(["date", "actor", "mechanism", "impact", "response"]);
		expect(coverage.missing).toEqual([]);
		expect(coverage.score).toBe(5);
	});

	test("assesses docs coverage slots and emits docs-specific guidance", () => {
		const coverage = assessResearchCoverage(
			[
				"`useActionState(action, initialState, permalink?)`",
				"The permalink parameter is an optional string parameter.",
				"It lets React navigate to the permalink before hydration and then pass state through once the page becomes interactive.",
			].join("\n"),
			{ intent: "docs_reference", coverageKind: "docs" },
		);
		const text = formatFetchTranscriptContent({
			url: "https://react.dev/reference/react/useActionState",
			title: "useActionState",
			facts: ["The permalink parameter is an optional string parameter."],
			preview: "`useActionState(action, initialState, permalink?)`",
			profile: deriveResearchCompressionProfile({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			status: "rich",
			intent: "docs_reference",
			authoritative: true,
			coverage,
		});

		expect(coverage?.kind).toBe("docs");
		expect(coverage?.present).toEqual(expect.arrayContaining(["signature", "parameter", "behavior"]));
		expect(coverage?.missing).toEqual(expect.arrayContaining(["example", "version"]));
		expect(text).toContain("Only continue docs research for the missing API slot");
		expect(text).toContain("answer now");
	});

	test("assesses pricing coverage slots and warns when prices are missing", () => {
		const coverage = assessResearchCoverage(
			"GPT-5 mini model pricing is listed in USD. Input: $0.25 per 1M tokens. Updated April 2026.",
			{ coverageKind: "pricing" },
		);
		const text = formatFetchTranscriptContent({
			url: "https://developers.openai.com/api/docs/pricing",
			title: "Pricing | OpenAI API",
			facts: ["GPT-5 mini model pricing is listed in USD. Input: $0.25 per 1M tokens."],
			preview: "Pricing table",
			profile: deriveResearchCompressionProfile({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			status: "rich",
			coverage,
		});

		expect(coverage?.kind).toBe("pricing");
		expect(coverage?.present).toEqual(expect.arrayContaining(["model", "input_price", "currency", "effective_date"]));
		expect(coverage?.missing).toContain("output_price");
		expect(text).toContain(
			"Continue pricing research only if model, input price, output price, or currency is missing",
		);
	});

	test("assesses release coverage slots and treats migration notes as conditional", () => {
		const coverage = assessResearchCoverage(
			"Version 5.4.1 was released on April 10, 2026. It fixed a parser bug and added a new compiler option.",
			{ coverageKind: "release" },
		);
		const text = formatFetchTranscriptContent({
			url: "https://example.com/changelog",
			title: "Release notes",
			facts: ["Version 5.4.1 fixed a parser bug and added a new compiler option."],
			preview: "Release notes",
			profile: deriveResearchCompressionProfile({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			status: "rich",
			coverage,
		});

		expect(coverage?.kind).toBe("release");
		expect(coverage?.present).toEqual(expect.arrayContaining(["version", "date", "changes"]));
		expect(coverage?.missing).toContain("migration_notes");
		expect(text).toContain(
			"Migration notes are required only when the user asks about upgrading or breaking changes",
		);
	});

	test("assesses error coverage slots and asks for exact-error follow-up only when needed", () => {
		const coverage = assessResearchCoverage(
			"TypeError: crypto.hash is not a function happens when Vite runs on an affected Node 20 version. Upgrade Node or Vite to resolve the issue.",
			{ coverageKind: "error" },
		);
		const text = formatFetchTranscriptContent({
			url: "https://github.com/vitejs/vite/issues/123",
			title: "TypeError crypto.hash",
			facts: ["Upgrade Node or Vite to resolve the issue."],
			preview: "TypeError: crypto.hash is not a function",
			profile: deriveResearchCompressionProfile({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			status: "rich",
			coverage,
		});

		expect(coverage?.kind).toBe("error");
		expect(coverage?.present).toEqual(expect.arrayContaining(["exact_error", "cause", "fix", "affected_version"]));
		expect(coverage?.missing).toEqual([]);
		expect(text).toContain("Coverage complete for an error-cause-and-fix answer");
	});

	test("webFetch emits current-events coverage metadata and stop guidance", async () => {
		vi.stubEnv("AG1_ALLOW_PRIVATE_WEBFETCH", "1");
		let server: Server | undefined;
		const url = await new Promise<string>((resolve) => {
			server = createServer((_request, response) => {
				response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				response.end(
					[
						"<html>",
						"<head><title>Claude Code leak article</title></head>",
						"<body><article>",
						"<p>On March 31, 2026, Anthropic accidentally published Claude Code source maps to npm.</p>",
						"<p>The package exposed internal TypeScript source code for the CLI.</p>",
						"<p>Anthropic confirmed the packaging issue and republished a clean package.</p>",
						"</article></body>",
						"</html>",
					].join(""),
				);
			});
			server.listen(0, "127.0.0.1", () => {
				const address = server?.address();
				if (typeof address === "object" && address) {
					resolve(`http://127.0.0.1:${address.port}/claude-code-leak`);
				}
			});
		});
		rememberResearchUrlHints([url], {
			intent: "current_events",
			richFetch: true,
			authoritative: true,
		});

		try {
			const result = await webFetchToolDefinition.execute("tool-web-fetch", { url }, undefined, undefined, {
				getContextUsage: () => ({ tokens: 2_000, contextWindow: 50_000, percent: 4 }),
			} as any);
			const details = result.details as Record<string, unknown>;
			const coverage = details.coverage as Record<string, unknown>;
			const text = firstBlockText(result);

			expect(coverage.present).toEqual(["date", "actor", "mechanism", "impact", "response"]);
			expect(coverage.missing).toEqual([]);
			expect(text).toContain("Coverage complete for a brief current-events answer.");
			expect(text).not.toContain("Reuse this URL as the source reference");
		} finally {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
		}
	});

	test("autonomous webFetch includes facts and placeholder status in details", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			headers: new Headers({ "content-type": "text/html" }),
			text: async () =>
				[
					"<html>",
					"<head>",
					"<title>Claude Code leak article</title>",
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
		expect(firstBlockText(result)).toContain("This source summary is likely sufficient");
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
		const transcript = firstBlockText(result);

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
		expect(transcript).not.toContain(
			"`useActionState(reducerAction, initialState, permalink?)`\n`useActionState(reducerAction, initialState, permalink?)`",
		);
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
		expect(firstBlockText(result)).toContain("https://react.dev/reference/react");
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

	test("classifies camelCase API parameter lookups as docs_reference instead of code_lookup", () => {
		expect(detectResearchQueryIntent("React useActionState permalink parameter explanation what it does")).toBe(
			"docs_reference",
		);
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

		const first = await tool.execute(
			"tool-web-search-1",
			{ query: "latest React docs cache" },
			undefined,
			undefined,
			ctx,
		);
		const second = await tool.execute(
			"tool-web-search-2",
			{ query: "latest React docs cache" },
			undefined,
			undefined,
			ctx,
		);

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
					searchProvider: "duckduckgo-html",
					searchProviderMode: "auto",
					results: [
						{
							title: "React Docs",
							url: "https://react.dev/",
							snippet: "Official docs",
							authoritative: true,
							sourceKind: "docs",
							fetchRisk: "low",
						},
						{
							title: "React Blog",
							url: "https://react.dev/blog",
							snippet: "Release posts",
							sourceKind: "general",
						},
						{
							title: "React API",
							url: "https://react.dev/reference",
							snippet: "API reference",
							sourceKind: "docs",
						},
					],
				},
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("WEBSEARCH");
		expect(rendered).toContain("Search returned 4 results · duckduckgo-html · top docs");
		expect(rendered).toContain("latest React docs");
		expect(rendered).not.toContain("3. React API");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("4 results found · duckduckgo-html");
		expect(expanded).toContain("React Docs [docs, authoritative]");
	});

	test("renders webSearch fallback and medium-risk source diagnostics", () => {
		const component = new ToolExecutionComponent(
			"webSearch",
			"tool-search-fallback",
			{ query: "pricing" },
			{},
			webSearchToolDefinition as any,
			createFakeTui(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "compact" }],
				details: {
					query: "pricing",
					resultCount: 1,
					searchProvider: "official-fallback",
					fallbackUsed: true,
					results: [
						{
							title: "Pricing | OpenAI API",
							url: "https://developers.openai.com/api/docs/pricing",
							sourceKind: "official",
							authoritative: true,
							fetchRisk: "medium",
						},
					],
				},
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("Search returned 1 result · official-fallback · fallback · top official");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("Pricing | OpenAI API [official, authoritative, medium fetch risk]");
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
					status: "rich",
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
					coverage: {
						kind: "docs",
						present: ["signature", "parameter", "behavior"],
						missing: ["example", "version"],
					},
				},
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("WEBFETCH");
		expect(rendered).toContain("Fetched React · rich · coverage 3/5");
		expect(rendered).toContain("https://react.dev/");
		expect(rendered).not.toContain("Install from npm or use a framework.");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("rich source · docs coverage 3/5");
	});

	test("renders expanded webFetch missing coverage and placeholder reason", () => {
		const component = new ToolExecutionComponent(
			"webFetch",
			"tool-fetch-placeholder",
			{ url: "https://blocked.example.com/article" },
			{},
			webFetchToolDefinition as any,
			createFakeTui(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "compact" }],
				details: {
					url: "https://blocked.example.com/article",
					title: "Just a moment...",
					status: "placeholder",
					statusReason: "browser verification interstitial",
					coverage: {
						kind: "current_events",
						present: ["date"],
						missing: ["actor", "mechanism", "impact", "response"],
					},
				},
				isError: false,
			},
			false,
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("Fetched Just a moment... · placeholder · coverage 1/5");

		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("placeholder/interstitial · current_events coverage 1/5");
		expect(rendered).toContain("missing actor, mechanism, impact, response");
		expect(rendered).toMatch(/browser\s+verification interstitial/);
	});
});
