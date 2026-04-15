import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { ContextUsage, ExtensionContext, ToolRenderResultOptions } from "../extensions/types.js";
import {
	detectResearchQueryIntent,
	rememberResearchUrlHints,
	type ResearchQueryIntent,
	shouldUseRichResearchFetch,
} from "./research-intent.js";
import {
	deriveResearchCompressionProfile,
	formatSearchTranscriptContent,
	truncateResearchSnippet,
} from "./research-output.js";

const DEFAULT_MAX_RESULTS = 3;
const MAX_SNIPPET_CHARS = 140;
const COLLAPSED_RESULTS = 2;
const EXPANDED_RESULTS = 4;
const CACHE_TTL_MS = 15 * 60 * 1000;
const searchCache = new Map<string, { results: Array<{ title: string; url: string; snippet: string }>; timestamp: number }>();
const DOCS_QUERY_STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"api",
	"brief",
	"briefly",
	"current",
	"doc",
	"docs",
	"documentation",
	"find",
	"for",
	"guide",
	"help",
	"how",
	"latest",
	"look",
	"lookup",
	"manual",
	"on",
	"overview",
	"quickly",
	"react",
	"reference",
	"summarize",
	"summary",
	"the",
	"to",
	"tutorial",
	"up",
	"use",
	"what",
]);

function scoreResearchSource(url: string, intent: ResearchQueryIntent): number {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase();
		const path = parsed.pathname.toLowerCase();
		let score = 0;
		if (host.startsWith("docs.") || host.startsWith("developer.") || host.startsWith("api.") || host.startsWith("learn.")) {
			score += 5;
		}
		if (/(^|\.)(readthedocs\.io|mozilla\.org|react\.dev|nodejs\.org|python\.org|golang\.org|rust-lang\.org)$/.test(host)) {
			score += 5;
		}
		if (/(docs|doc|reference|manual|guide|api|spec|specification|changelog|release)/.test(path)) {
			score += 3;
		}
		if (/(stackoverflow\.com|reddit\.com|medium\.com|dev\.to|hashnode\.com|youtube\.com|x\.com|twitter\.com)/.test(host)) {
			score -= 4;
		}
		if (/(duckduckgo\.com|google\.com|bing\.com)/.test(host)) {
			score -= 6;
		}
		if (intent === "code_lookup") {
			if (/(^|\.)(github\.com|raw\.githubusercontent\.com|gitlab\.com|bitbucket\.org)$/.test(host)) {
				score += 8;
			}
			if (/(\/blob\/|\/raw\/|\/tree\/|\/src\/|\/packages\/|\/commits?\/|\/pull\/)/.test(path)) {
				score += 4;
			}
			if (host.startsWith("docs.") || host.startsWith("learn.") || host.startsWith("developer.")) {
				score -= 3;
			}
			if (/(microsoft\.com|learn\.microsoft\.com|answers\.microsoft\.com)/.test(host)) {
				score -= 4;
			}
		}
		if (intent === "current_events") {
			if (/(\/news\/|\/blog\/|\/release|\/releases\/|\/announcement|\/announcements\/|\/press\/|\/security\/|\/incident|\/advisory)/.test(path)) {
				score += 4;
			}
			if (/(leak|incident|breach|outage|security|advisory|analysis|report|202\d)/.test(path)) {
				score += 4;
			}
			if (/(\bnews\b|\bblog\b|\bpress\b|\bsecurity\b|\bincident\b|\badvisory\b)/.test(host)) {
				score += 2;
			}
			if (host.startsWith("docs.") || host.startsWith("learn.") || host.startsWith("developer.") || /(docs|reference|manual|guide|api|spec)/.test(path)) {
				score -= 4;
			}
			if (/(^|\.)(github\.com|raw\.githubusercontent\.com|gitlab\.com|bitbucket\.org)$/.test(host)) {
				score -= 5;
			}
		}
		if (intent === "docs_reference") {
			if (/(\/news\/|\/blog\/|\/announcement|\/press\/)/.test(path)) {
				score -= 3;
			}
			if (/(^|\.)(github\.com|raw\.githubusercontent\.com|gitlab\.com|bitbucket\.org)$/.test(host)) {
				score -= 2;
			}
		}
		return score;
	} catch {
		return -10;
	}
}

function isLikelyAuthoritativeSource(url: string, intent: ResearchQueryIntent): boolean {
	return scoreResearchSource(url, intent) >= 3;
}

function normalizeDocsToken(token: string): string {
	return token.endsWith("s") && token.length > 4 ? token.slice(0, -1) : token;
}

function extractDocsQueryTerms(query: string): string[] {
	const terms = query
		.toLowerCase()
		.match(/[a-z][a-z0-9]*/g)
		?.map((term) => normalizeDocsToken(term))
		.filter((term) => term.length >= 4 && !DOCS_QUERY_STOPWORDS.has(term));
	return Array.from(new Set(terms ?? []));
}

function scoreDocsReferenceResultContent(
	result: { title: string; url: string; snippet: string },
	query: string,
): number {
	const queryTerms = extractDocsQueryTerms(query);
	if (queryTerms.length === 0) return 0;
	const title = result.title.toLowerCase();
	const snippet = result.snippet.toLowerCase();
	const url = result.url.toLowerCase();
	let score = 0;
	for (const term of queryTerms) {
		if (title.includes(term)) {
			score += 5;
			continue;
		}
		if (url.includes(term)) {
			score += 4;
			continue;
		}
		if (snippet.includes(term)) {
			score += 3;
		}
	}
	if (/\b(hook|hooks|api|reference|action|actions)\b/.test(title)) {
		score += 1;
	}
	return score;
}

function scoreResearchResultContent(
	result: { title: string; url: string; snippet: string },
	intent: ResearchQueryIntent,
	query: string,
): number {
	const text = `${result.title}\n${result.snippet}`.toLowerCase();
	let score = 0;
	if (intent === "current_events") {
		if (/\b(leak|incident|breach|outage|analysis|security|advisory|exposed|published|coverage|report)\b/.test(text)) {
			score += 4;
		}
		if (/\b(202\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/.test(text)) {
			score += 2;
		}
		if (/\b(docs?|reference|manual|guide|tutorial)\b/.test(text)) {
			score -= 3;
		}
		return score;
	}
	if (intent === "docs_reference") {
		return scoreDocsReferenceResultContent(result, query);
	}
	return 0;
}

function rankResearchResults(query: string, results: Array<{ title: string; url: string; snippet: string }>): Array<{
	title: string;
	url: string;
	snippet: string;
	authoritative: boolean;
	score: number;
}> {
	const intent = detectResearchQueryIntent(query);
	return results
		.map((result, index) => {
			const score = scoreResearchSource(result.url, intent) + scoreResearchResultContent(result, intent, query);
			return {
				...result,
				authoritative: isLikelyAuthoritativeSource(result.url, intent),
				score,
				index,
			};
		})
		.sort((left, right) => right.score - left.score || left.index - right.index)
		.map(({ index: _index, ...result }) => result);
}

function renderWebSearchResult(
	result: {
		details?: {
			query?: string;
			resultCount?: number;
			cacheHit?: boolean;
			results?: Array<{ title?: string; url?: string; snippet?: string; authoritative?: boolean }>;
		};
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): Text {
	const details = result.details ?? {};
	const results = Array.isArray(details.results) ? details.results : [];
	const maxResults = options.expanded ? EXPANDED_RESULTS : COLLAPSED_RESULTS;
	let text = `${theme.fg("toolTitle", theme.bold("webSearch"))}`;
	if (details.query) text += ` ${theme.fg("accent", details.query)}`;
	if (typeof details.resultCount === "number") {
		text += theme.fg("toolOutput", ` (${details.resultCount} results)`);
	}
	if (details.cacheHit) {
		text += ` ${theme.fg("muted", "[cached]")}`;
	}
	if (results.length > 0) {
		const displayResults = results.slice(0, maxResults);
		text +=
			"\n" +
			displayResults
				.map((entry, index) => {
					const title = entry.title ?? "Untitled";
					const url = entry.url ?? "";
					const authoritative = entry.authoritative === true ? ` ${theme.fg("muted", "[authoritative]")}` : "";
					const snippet = entry.snippet
						? `\n   ${theme.fg("toolOutput", truncateResearchSnippet(entry.snippet, MAX_SNIPPET_CHARS))}`
						: "";
					return `${theme.fg("toolOutput", `${index + 1}. ${title}`)}${authoritative}\n   ${theme.fg("accent", url)}${snippet}`;
				})
				.join("\n");
		if (results.length > displayResults.length) {
			text += `\n${theme.fg("muted", `... (${results.length - displayResults.length} more results)`)}`
		}
	}
	return new Text(text, 0, 0);
}

function getResearchCompressionProfile(ctx?: Pick<ExtensionContext, "getContextUsage">): ReturnType<typeof deriveResearchCompressionProfile> {
	const contextUsage: ContextUsage | undefined = ctx?.getContextUsage?.();
	return deriveResearchCompressionProfile(contextUsage);
}

export interface WebSearchToolOptions {
	cwd: string;
}

function normalizeSearchResultUrl(url: string): string {
	try {
		const absolute = url.startsWith("//") ? `https:${url}` : url;
		const parsed = new URL(absolute);
		if (parsed.hostname.toLowerCase() !== "duckduckgo.com" || !parsed.pathname.startsWith("/l/")) {
			return absolute;
		}
		const uddg = parsed.searchParams.get("uddg");
		return uddg ? decodeURIComponent(uddg) : absolute;
	} catch {
		return url;
	}
}

async function duckDuckGoSearch(
	query: string,
	maxResults: number = 5,
): Promise<{ title: string; url: string; snippet: string }[]> {
	const cacheKey = query.trim().toLowerCase();
	const cached = searchCache.get(cacheKey);
	if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
		return cached.results.slice(0, maxResults);
	}

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);

		const resp = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
			signal: controller.signal,
			headers: { "User-Agent": "Mozilla/5.0" },
		});
		clearTimeout(timeout);

		if (!resp.ok) return [];

		const html = await resp.text();
		const results: { title: string; url: string; snippet: string }[] = [];

		// Parse DuckDuckGo HTML results
		const resultMatch = html.matchAll(
			/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>.*?<a[^>]*class="result__snippet[^"]*"[^>]*>(.*?)<\/a>/gis,
		);
		for (const match of resultMatch) {
			const normalizedUrl = normalizeSearchResultUrl(match[1]);
			results.push({
				title: match[2].replace(/<[^>]*>/g, "").trim(),
				url: normalizedUrl,
				snippet: match[3].replace(/<[^>]*>/g, "").trim(),
			});
			if (results.length >= maxResults) break;
		}

		searchCache.set(cacheKey, { results, timestamp: Date.now() });
		return results;
	} catch {
		return [];
	}
}

async function executeWebSearch(
	params: unknown,
	ctx?: Pick<ExtensionContext, "getContextUsage">,
): Promise<AgentToolResult<unknown>> {
	const { query, maxResults = DEFAULT_MAX_RESULTS } = params as Record<string, any>;

	if (!query || typeof query !== "string") {
		return {
			details: {},
			content: [{ type: "text" as const, text: "Error: 'query' parameter is required." }],
		};
	}

	const cacheKey = query.trim().toLowerCase();
	const cachedBefore = searchCache.get(cacheKey);
	const cacheHit = Boolean(cachedBefore && Date.now() - cachedBefore.timestamp < CACHE_TTL_MS);
	const rawResults = await duckDuckGoSearch(query, Math.min(maxResults, EXPANDED_RESULTS));
	const rankedResults = rankResearchResults(query, rawResults);
	const intent = detectResearchQueryIntent(query);
	const compression = getResearchCompressionProfile(ctx);
	const details = {
		query,
		intent,
		resultCount: rankedResults.length,
		compressionMode: compression.mode,
		cacheHit,
		sourceUrls: rankedResults.map((result) => result.url),
		preferredSourceUrls: rankedResults.filter((result) => result.authoritative || result.score >= 4).map((result) => result.url),
		results: rankedResults.map((result) => ({
			title: result.title,
			url: result.url,
			snippet: result.snippet,
			authoritative: result.authoritative,
		})),
	};

	if (rankedResults.length === 0) {
		return {
			details,
			content: [{ type: "text" as const, text: `No results found for: ${query}` }],
		};
	}

	rememberResearchUrlHints(
		rankedResults.map((result) => result.url),
		{ intent, richFetch: shouldUseRichResearchFetch(query, intent) },
	);

	return {
		details,
		content: [{ type: "text" as const, text: formatSearchTranscriptContent(query, rankedResults, compression) }],
	};
}

export const webSearchToolDefinition = {
	name: "webSearch",
	label: "webSearch",
	description:
		"Search the web using DuckDuckGo. No API key required. Returns titles, URLs, and snippets. Use to find documentation, APIs, error messages, or current information.",
	parameters: Type.Object({
		query: Type.String({ description: "Search query" }),
		maxResults: Type.Optional(
			Type.Number({ description: `Maximum results to return (default: ${DEFAULT_MAX_RESULTS})`, default: DEFAULT_MAX_RESULTS }),
		),
	}),
	promptSnippet: "Search the web for current information, documentation, or error messages",
	guidelines: [
		"Use for finding documentation, error messages, API references.",
		"Results are from DuckDuckGo HTML search.",
	],
	promptGuidelines: [
		"Use webSearch when the task needs current online information, references, or research beyond the local codebase.",
	],
	renderResult: (
		result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: unknown },
		options: ToolRenderResultOptions,
		theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	) => renderWebSearchResult(result as any, options, theme),
	execute: async (
		_toolCallId: string,
		params: unknown,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<unknown>> => executeWebSearch(params, ctx),
};

export function createWebSearchTool(_options: WebSearchToolOptions) {
	return {
		name: "webSearch",
		label: "webSearch",
		description: webSearchToolDefinition.description,
		parameters: webSearchToolDefinition.parameters,
		execute: async (
			_toolCallId: string,
			params: unknown,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx?: ExtensionContext,
		): Promise<AgentToolResult<unknown>> => executeWebSearch(params, ctx),
	};
}
