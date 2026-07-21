// Auton — WebSearch Tool
// Searches the web using DuckDuckGo HTML search.

import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../../extensions/types.js";
import {
	deriveResearchCompressionProfile,
	formatSearchTranscriptContent,
	truncateResearchSnippet,
} from "../../tools/research-output.js";

const DEFAULT_MAX_RESULTS = 3;
const MAX_RESULT_PREVIEW = 5;
const MAX_SNIPPET_CHARS = 140;
const CACHE_TTL_MS = 15 * 60 * 1000;
const searchCache = new Map<
	string,
	{ results: Array<{ title: string; url: string; snippet: string }>; timestamp: number }
>();

function parseDuckDuckgoResults(html: string): Array<{ title: string; url: string; snippet: string }> {
	const results: Array<{ title: string; url: string; snippet: string }> = [];

	// Try a more general approach for DuckDuckGo's HTML format
	const generalResultRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

	let match = generalResultRegex.exec(html);
	while (match !== null) {
		const url = match[1].replace(/^https?:\/\/duckduckgo\.com\/l\/\?uddg=/, "").replace(/&.*/, "");
		const title = match[2].replace(/<[^>]+>/g, "").trim();
		if (title && url.startsWith("http")) {
			results.push({ title, url, snippet: "" });
		}
		match = generalResultRegex.exec(html);
	}

	// If no results found, try alternative parsing
	if (results.length === 0) {
		const altLinkRegex = /<a[^>]*href="(https?:\/\/(?!duckduckgo)[^"]+)"[^>]*>([^<]+)<\/a>/gi;
		let altMatch = altLinkRegex.exec(html);
		while (altMatch !== null) {
			const url = altMatch[1];
			const title = altMatch[2].trim();
			if (title && results.length < 20) {
				results.push({ title, url, snippet: "" });
			}
			altMatch = altLinkRegex.exec(html);
		}
	}

	// Try to extract snippets
	const snippetMatch = html.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi);
	if (snippetMatch) {
		for (let i = 0; i < snippetMatch.length && i < results.length; i++) {
			results[i].snippet = snippetMatch[i].replace(/<[^>]+>/g, "").trim();
		}
	}

	return results.slice(0, 10);
}

const webSearchParamsSchema = Type.Object({
	query: Type.String({ description: "Search query" }),
	maxResults: Type.Optional(
		Type.Number({
			default: DEFAULT_MAX_RESULTS,
			description: `Maximum number of results to return (default ${DEFAULT_MAX_RESULTS})`,
		}),
	),
});
type WebSearchParams = Static<typeof webSearchParamsSchema>;

export const webSearchToolDefinition: ToolDefinition<
	typeof webSearchParamsSchema,
	Record<string, unknown>,
	undefined
> = {
	name: "webSearch",
	label: "webSearch",
	description: "Search the web using DuckDuckGo. Returns search results with titles, URLs, and snippets.",
	parameters: webSearchParamsSchema,
	promptSnippet: "Search the web for current information or external references",
	promptGuidelines: [
		"Use webSearch when the task depends on current online information, references, or documentation outside the repository.",
	],
	execute: async (
		_toolCallId: string,
		params: WebSearchParams,
		signal: AbortSignal | undefined,
		_onUpdate: (update: unknown) => Promise<void>,
		ctx: { getContextUsage?: () => unknown } | undefined,
	) => {
		const query = params.query;
		const maxResults = params.maxResults ?? DEFAULT_MAX_RESULTS;
		const cacheKey = query.trim().toLowerCase();
		const cached = searchCache.get(cacheKey);
		const cacheHit = Boolean(cached && Date.now() - cached.timestamp < CACHE_TTL_MS);

		if (!query || query.trim().length === 0) {
			return {
				content: [{ type: "text", text: "Error: Search query is required." }],
				details: { query: "" },
			};
		}

		const encodedQuery = encodeURIComponent(query.trim());
		const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

		try {
			let results: Array<{ title: string; url: string; snippet: string }>;
			if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
				results = cached.results;
			} else {
				const response = await fetch(url, {
					signal,
					headers: {
						"User-Agent": "Mozilla/5.0 (compatible; AG1-Agent/1.0)",
					},
				});

				if (!response.ok) {
					return {
						content: [
							{
								type: "text",
								text: `Error: DuckDuckGo returned HTTP ${response.status}. The service may be temporarily unavailable.`,
							},
						],
						details: { query, sourceUrls: [] },
					};
				}

				const html = await response.text();

				// Check for rate limiting or CAPTCHA
				if (html.includes("One more step") || html.includes("captcha") || html.includes("verify you are human")) {
					return {
						content: [
							{ type: "text", text: "Error: DuckDuckGo rate limiting detected. Please try again later." },
						],
						details: { query, sourceUrls: [] },
					};
				}

				results = parseDuckDuckgoResults(html);
				searchCache.set(cacheKey, { results, timestamp: Date.now() });
			}
			const limitedResults = results.slice(0, Math.min(maxResults, MAX_RESULT_PREVIEW));
			const compression = deriveResearchCompressionProfile(ctx?.getContextUsage?.() as any);
			const details = {
				query,
				resultCount: limitedResults.length,
				compressionMode: compression.mode,
				cacheHit,
				sourceUrls: limitedResults.map((result) => result.url),
				results: limitedResults.map((result) => ({
					title: result.title,
					url: result.url,
					snippet: result.snippet,
				})),
			};

			if (limitedResults.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No results found for: "${query}"\n\nThe HTML search format may have changed. Try a different query or use WebFetch for direct page access.`,
						},
					],
					details,
				};
			}

			return {
				content: [
					{
						type: "text",
						text: formatSearchTranscriptContent(
							query,
							limitedResults.map((result) => ({
								title: result.title,
								url: result.url,
								snippet: truncateResearchSnippet(result.snippet, MAX_SNIPPET_CHARS),
							})),
							compression,
						),
					},
				],
				details,
			};
		} catch (err: any) {
			return {
				content: [{ type: "text", text: `WebSearch Error: ${err.message || String(err)}` }],
				details: {
					query,
					sourceUrls: [],
					error: err.message || String(err),
				},
			};
		}
	},
};
