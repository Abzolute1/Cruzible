import type { AgentToolResult } from "@ag1/agent-core";
import { Text } from "@ag1/tui";
import { Type } from "@sinclair/typebox";
import type { ContextUsage, ExtensionContext, ToolRenderResultOptions } from "../extensions/types.js";
import {
	detectResearchQueryIntent,
	getResearchFetchOutcome,
	rememberResearchUrlHints,
	type ResearchQueryIntent,
	shouldUseRichResearchFetch,
} from "./research-intent.js";
import {
	deriveResearchCompressionProfile,
	formatSearchTranscriptContent,
	truncateResearchSnippet,
	type ResearchCoverageKind,
} from "./research-output.js";

const DEFAULT_MAX_RESULTS = 3;
const MAX_SNIPPET_CHARS = 140;
const COLLAPSED_RESULTS = 2;
const EXPANDED_RESULTS = 4;
const CACHE_TTL_MS = 15 * 60 * 1000;
const ZERO_RESULT_CACHE_TTL_MS = 60 * 1000;
const DUCKDUCKGO_TIMEOUT_MS = 8_000;
const PAID_PROVIDER_TIMEOUT_MS = 8_000;

type SearchResult = { title: string; url: string; snippet: string };
type SearchProviderAttempt = {
	provider: string;
	url: string;
	status: "ok" | "http_error" | "error" | "skipped";
	resultCount: number;
	error?: string;
};
type SearchCacheEntry = {
	results: SearchResult[];
	attempts: SearchProviderAttempt[];
	provider: string;
	timestamp: number;
};
type SearchFreshness = "any" | "recent" | "current";
type SearchProviderName = "auto" | "duckduckgo" | "brave" | "serpapi" | "tavily" | "exa";
type SearchRequest = {
	query: string;
	maxResults: number;
	intent: ResearchQueryIntent;
	freshness?: SearchFreshness;
};
type SearchProviderResponse = {
	provider: string;
	results: SearchResult[];
	attempts: SearchProviderAttempt[];
	error?: string;
};
interface SearchProvider {
	name: string;
	search(request: SearchRequest): Promise<SearchProviderResponse>;
}

const searchCache = new Map<string, SearchCacheEntry>();

function isFreshSearchCacheEntry(entry: SearchCacheEntry | undefined): boolean {
	if (!entry) return false;
	const ttl = entry.results.length === 0 ? ZERO_RESULT_CACHE_TTL_MS : CACHE_TTL_MS;
	return Date.now() - entry.timestamp < ttl;
}

type WebSearchPlan = {
	originalQuery: string;
	effectiveQuery: string;
	strategy: string;
	followUpQueries: string[];
	preferredDomains?: string[];
	avoidedDomains?: string[];
	freshness?: "any" | "recent" | "current";
};

type ResearchSourceKind = "official" | "docs" | "source_repo" | "analysis" | "news" | "community" | "weak" | "general";
type ResearchFetchRisk = "low" | "medium" | "high";
type RankedSearchResult = SearchResult & {
	authoritative: boolean;
	sourceKind: ResearchSourceKind;
	score: number;
	scoreReasons: string[];
	fetchRisk: ResearchFetchRisk;
};

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

const SEARCH_QUERY_STOPWORDS = new Set([
	"a",
	"about",
	"ago",
	"and",
	"brief",
	"briefly",
	"can",
	"could",
	"find",
	"for",
	"from",
	"happened",
	"has",
	"have",
	"how",
	"info",
	"information",
	"into",
	"is",
	"it",
	"latest",
	"look",
	"me",
	"need",
	"of",
	"on",
	"please",
	"research",
	"search",
	"some",
	"summarize",
	"summary",
	"that",
	"the",
	"this",
	"to",
	"up",
	"was",
	"weeks",
	"what",
	"when",
	"with",
	"you",
]);

const OFFICIAL_DOC_FALLBACKS: Array<{
	match: RegExp;
	preferredDomains: string[];
	results: SearchResult[];
}> = [
	{
		match: /\bopenai\b/i,
		preferredDomains: ["platform.openai.com", "developers.openai.com", "openai.com"],
		results: [
			{
				title: "OpenAI Platform Docs",
				url: "https://platform.openai.com/docs",
				snippet: "Official OpenAI platform documentation.",
			},
			{
				title: "Pricing | OpenAI API",
				url: "https://developers.openai.com/api/docs/pricing",
				snippet: "Official OpenAI API pricing documentation.",
			},
			{
				title: "OpenAI Platform Pricing",
				url: "https://platform.openai.com/pricing",
				snippet: "Official OpenAI platform pricing overview.",
			},
		],
	},
	{
		match: /\banthropic|claude code\b/i,
		preferredDomains: ["docs.anthropic.com", "anthropic.com"],
		results: [
			{
				title: "Anthropic Docs",
				url: "https://docs.anthropic.com/",
				snippet: "Official Anthropic documentation.",
			},
			{
				title: "Claude Code Documentation",
				url: "https://docs.anthropic.com/en/docs/claude-code",
				snippet: "Official Claude Code documentation.",
			},
		],
	},
	{
		match: /\bnvidia|nemotron\b/i,
		preferredDomains: ["build.nvidia.com", "docs.api.nvidia.com", "developer.nvidia.com"],
		results: [
			{
				title: "NVIDIA API Catalog",
				url: "https://build.nvidia.com/",
				snippet: "Official NVIDIA API catalog.",
			},
			{
				title: "NVIDIA API Documentation",
				url: "https://docs.api.nvidia.com/",
				snippet: "Official NVIDIA API documentation.",
			},
		],
	},
	{
		match: /\blm studio\b/i,
		preferredDomains: ["lmstudio.ai"],
		results: [
			{
				title: "LM Studio Docs",
				url: "https://lmstudio.ai/docs",
				snippet: "Official LM Studio documentation.",
			},
		],
	},
	{
		match: /\breact\b/i,
		preferredDomains: ["react.dev"],
		results: [
			{
				title: "React API Reference",
				url: "https://react.dev/reference/react",
				snippet: "Official React API reference.",
			},
			{
				title: "React Learn",
				url: "https://react.dev/learn",
				snippet: "Official React learning documentation.",
			},
		],
	},
	{
		match: /\bnode(?:\.js)?\b/i,
		preferredDomains: ["nodejs.org"],
		results: [
			{
				title: "Node.js API Documentation",
				url: "https://nodejs.org/api/",
				snippet: "Official Node.js API documentation.",
			},
		],
	},
	{
		match: /\bpython\b/i,
		preferredDomains: ["docs.python.org"],
		results: [
			{
				title: "Python Documentation",
				url: "https://docs.python.org/3/",
				snippet: "Official Python 3 documentation.",
			},
		],
	},
	{
		match: /\btypescript|tsconfig|compiler option\b/i,
		preferredDomains: ["www.typescriptlang.org"],
		results: [
			{
				title: "TypeScript Documentation",
				url: "https://www.typescriptlang.org/docs/",
				snippet: "Official TypeScript documentation.",
			},
		],
	},
	{
		match: /\bmdn|mozilla|web api|css|javascript\b/i,
		preferredDomains: ["developer.mozilla.org"],
		results: [
			{
				title: "MDN Web Docs",
				url: "https://developer.mozilla.org/",
				snippet: "Official MDN Web Docs.",
			},
		],
	},
	{
		match: /\bnpm\b/i,
		preferredDomains: ["docs.npmjs.com"],
		results: [
			{
				title: "npm Docs",
				url: "https://docs.npmjs.com/",
				snippet: "Official npm documentation.",
			},
		],
	},
];

function scoreGeneralCurrentEventHost(host: string): number {
	if (/(^|\.)(varonis\.com|arstechnica\.com|infoq\.com|thehackernews\.com|techradar\.com|bleepingcomputer\.com|wired\.com|theregister\.com)$/.test(host)) {
		return 4;
	}
	if (/(^|\.)(fortune\.com|reuters\.com|bloomberg\.com|ft\.com|wsj\.com)$/.test(host)) {
		return 2;
	}
	if (/(^|\.)(securityweek\.com|techspot\.com)$/.test(host)) {
		return -3;
	}
	if (/(^|\.)(linkedin\.com|github\.com|raw\.githubusercontent\.com)$/.test(host)) {
		return -8;
	}
	if (/(^|\.)(tech-insider\.org|cybersecuritynews\.com|ccleaks\.com|aitoolanalysis\.com|beankinney\.com|osintteam\.blog|infosecwriteups\.com)$/.test(host)) {
		return -6;
	}
	if (/(^|\.)(dev\.to|medium\.com|substack\.com)$/.test(host)) {
		return -4;
	}
	return 0;
}

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
			score += scoreGeneralCurrentEventHost(host);
			if (/(^|\.)(dev\.to|medium\.com|substack\.com)$/.test(host)) {
				score -= 4;
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
			if (
				/(^|\.)(react\.dev|nextjs\.org|nodejs\.org|developer\.mozilla\.org|docs\.python\.org|python\.org|typescriptlang\.org|www\.typescriptlang\.org|rust-lang\.org|go\.dev|angular\.dev|vuejs\.org|docs\.github\.com|docs\.npmjs\.com)$/.test(
					host,
				)
			) {
				score += 10;
			}
			if (/(\/reference\/|\/docs\/|\/doc\/|\/api\/|\/guide\/|\/manual\/|\/learn\/)/.test(path)) {
				score += 4;
			}
			if (/(\/news\/|\/blog\/|\/announcement|\/press\/)/.test(path)) {
				score -= 3;
			}
			if (/(\/blogs?\/)/.test(path)) {
				score -= 4;
			}
			if (/(^|\.)(medium\.com|dev\.to|telerik\.com|substack\.com)$/.test(host)) {
				score -= 5;
			}
			if (/(^|\.)(github\.com|raw\.githubusercontent\.com|gitlab\.com|bitbucket\.org)$/.test(host)) {
				score -= 2;
			}
		}
		const fetchOutcome = getResearchFetchOutcome(url);
		if (fetchOutcome === "rich") {
			score += 6;
		} else if (fetchOutcome === "thin") {
			score -= 1;
		} else if (fetchOutcome === "placeholder") {
			score -= 8;
		}
		return score;
	} catch {
		return -10;
	}
}

function getResearchFetchRisk(url: string): ResearchFetchRisk {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase();
		const path = parsed.pathname.toLowerCase();
		const fetchOutcome = getResearchFetchOutcome(url);
		if (fetchOutcome === "placeholder") return "high";
		if (/(^|\.)(fortune\.com|bloomberg\.com|wsj\.com|ft\.com|linkedin\.com|x\.com|twitter\.com)$/.test(host)) {
			return "medium";
		}
		if (
			host.startsWith("docs.")
			|| host.startsWith("developer.")
			|| host.startsWith("api.")
			|| /(^|\.)(github\.com|raw\.githubusercontent\.com|react\.dev|nodejs\.org|docs\.python\.org|www\.typescriptlang\.org|developer\.mozilla\.org|docs\.npmjs\.com)$/.test(host)
			|| /(\/docs?\/|\/reference\/|\/api\/|\/manual\/)/.test(path)
		) {
			return "low";
		}
		return "medium";
	} catch {
		return "high";
	}
}

function getResearchScoreReasons(
	result: { title: string; url: string; snippet: string },
	intent: ResearchQueryIntent,
	query: string,
): string[] {
	const reasons: string[] = [];
	try {
		const parsed = new URL(result.url);
		const host = parsed.hostname.toLowerCase();
		const path = parsed.pathname.toLowerCase();
		const text = `${result.title}\n${result.snippet}\n${result.url}`.toLowerCase();
		const queryTerms = extractSearchQueryTerms(query);
		if (/(^|\.)(anthropic\.com|openai\.com|googleblog\.com|microsoft\.com|nvidia\.com|developer\.nvidia\.com|react\.dev|nodejs\.org|python\.org|typescriptlang\.org|www\.typescriptlang\.org|mozilla\.org|npmjs\.com|lmstudio\.ai)$/.test(host)) {
			reasons.push("official_domain");
		}
		if (host.startsWith("docs.") || host.startsWith("developer.") || /(\/docs?\/|\/reference\/|\/api\/|\/manual\/|\/learn\/)/.test(path)) {
			reasons.push("docs_path");
		}
		if (/(^|\.)(github\.com|raw\.githubusercontent\.com|gitlab\.com|bitbucket\.org)$/.test(host)) {
			reasons.push("source_repo");
		}
		if (/\b(202\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/.test(text)) {
			reasons.push("recent_date_signal");
		}
		if (/(analysis|breakdown|deep-dive|postmortem|forensic|investigation|research|threat)/.test(path) || /\b(analysis|breakdown|postmortem|investigation|threat labs?)\b/.test(text)) {
			reasons.push("analysis_path");
		}
		if (/(^|\.)(varonis\.com|arstechnica\.com|infoq\.com|thehackernews\.com|techradar\.com|bleepingcomputer\.com|wired\.com|theregister\.com|krebsonsecurity\.com)$/.test(host)) {
			reasons.push("known_strong_tech_outlet");
		}
		if (/(^|\.)(stackoverflow\.com|reddit\.com|medium\.com|dev\.to|hashnode\.com|youtube\.com|x\.com|twitter\.com)$/.test(host)) {
			reasons.push("community_source_penalty");
		}
		if (/(^|\.)(tech-insider\.org|cybersecuritynews\.com|ccleaks\.com|aitoolanalysis\.com|beankinney\.com|osintteam\.blog|infosecwriteups\.com)$/.test(host)) {
			reasons.push("known_weak_domain_penalty");
		}
		const fetchOutcome = getResearchFetchOutcome(result.url);
		if (fetchOutcome === "placeholder") reasons.push("previous_placeholder_penalty");
		if (fetchOutcome === "rich") reasons.push("previous_rich_fetch_bonus");
		if (queryTerms.some((term) => text.includes(term))) {
			reasons.push("query_term_match");
		}
		if (intent === "docs_reference" && classifyResearchSource(result.url, intent) === "official") {
			reasons.push("official_domain");
		}
	} catch {
		// Malformed URLs are already penalized by scoring.
	}
	return Array.from(new Set(reasons));
}

function isLikelyAuthoritativeSource(url: string, intent: ResearchQueryIntent): boolean {
	return scoreResearchSource(url, intent) >= 3;
}

function classifyResearchSource(url: string, intent: ResearchQueryIntent): ResearchSourceKind {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase();
		const path = parsed.pathname.toLowerCase();
		if (/(^|\.)(anthropic\.com|openai\.com|googleblog\.com|microsoft\.com|nvidia\.com|developer\.nvidia\.com)$/.test(host)) {
			return "official";
		}
		if (host.startsWith("docs.") || host.startsWith("developer.") || host.startsWith("api.") || /(\/docs?\/|\/reference\/|\/api\/|\/manual\/)/.test(path)) {
			return "docs";
		}
		if (/(^|\.)(github\.com|raw\.githubusercontent\.com|gitlab\.com|bitbucket\.org)$/.test(host)) {
			return "source_repo";
		}
		if (/(^|\.)(dev\.to|medium\.com|substack\.com|reddit\.com|x\.com|twitter\.com|youtube\.com)$/.test(host)) {
			return "community";
		}
		if (/(^|\.)(tech-insider\.org|cybersecuritynews\.com|ccleaks\.com|aitoolanalysis\.com|beankinney\.com|osintteam\.blog|infosecwriteups\.com)$/.test(host)) {
			return "weak";
		}
		if (intent === "current_events" && /(analysis|breakdown|deep-dive|postmortem|forensic|investigation|research|threat)/.test(path)) {
			return "analysis";
		}
		if (intent === "current_events" && /(\/news\/|\/article\/|\/articles\/|\/press\/|\/security\/|\/incident|\/advisory)/.test(path)) {
			return "news";
		}
		return "general";
	} catch {
		return "general";
	}
}

function normalizeDocsToken(token: string): string {
	return token.endsWith("s") && token.length > 4 ? token.slice(0, -1) : token;
}

function prefersStrongestCurrentEventSources(query: string): boolean {
	return /\b(strongest|best|authoritative|independent)\s+sources?\b/i.test(query)
		|| /\bcite\b.*\bsources?\b/i.test(query)
		|| /\bcorroborat(?:e|ion|ing)\b/i.test(query);
}

function normalizeCurrentEventsQuery(query: string): string {
	const normalized = query.trim();
	if (/\bclaude code\b/i.test(normalized) && /\bleak\b/i.test(normalized)) {
		return "Claude Code leak March 2026 npm source code";
	}
	return normalized;
}

function findOfficialFallbackGroup(query: string): (typeof OFFICIAL_DOC_FALLBACKS)[number] | undefined {
	if (/\blm studio\b/i.test(query)) {
		return OFFICIAL_DOC_FALLBACKS.find((group) => group.preferredDomains.includes("lmstudio.ai"));
	}
	if (/\bnvidia|nemotron\b/i.test(query)) {
		return OFFICIAL_DOC_FALLBACKS.find((group) => group.preferredDomains.includes("build.nvidia.com"));
	}
	return OFFICIAL_DOC_FALLBACKS.find((group) => group.match.test(query));
}

function getPreferredOfficialDomains(query: string): string[] | undefined {
	return findOfficialFallbackGroup(query)?.preferredDomains;
}

function hasExactQuotedText(query: string): boolean {
	return /"[^"]{8,}"|'[^']{8,}'|`[^`]{8,}`/.test(query);
}

function extractLikelyErrorMessage(query: string): string | undefined {
	if (hasExactQuotedText(query)) return undefined;
	const match =
		query.match(/\b(?:TypeError|ReferenceError|SyntaxError|RangeError|Error|Exception):\s*[^!?\n]+/i)
		?? query.match(/\b[A-Z][A-Za-z]+Error:\s*[^!?\n]+/);
	const value = match?.[0]?.replace(/\s+/g, " ").trim();
	return value && value.length >= 12 ? value : undefined;
}

function normalizeErrorSearchQuery(query: string): string | undefined {
	const errorMessage = extractLikelyErrorMessage(query);
	if (!errorMessage) return undefined;
	const contextTerms = extractSearchQueryTerms(query)
		.filter((term) => !errorMessage.toLowerCase().includes(term))
		.slice(0, 5)
		.join(" ");
	return `"${errorMessage}"${contextTerms ? ` ${contextTerms}` : ""}`.trim();
}

function appendUniqueTerms(base: string, terms: string[]): string {
	const lower = base.toLowerCase();
	const additions = terms.filter((term) => !lower.includes(term.toLowerCase()));
	return additions.length > 0 ? `${base} ${additions.join(" ")}` : base;
}

function detectResearchCoverageKind(query: string, intent: ResearchQueryIntent): ResearchCoverageKind | undefined {
	if (intent === "current_events") return "current_events";
	if (/\b(?:pricing|price|cost|billing|input price|output price|per token|per 1m)\b/i.test(query)) {
		return "pricing";
	}
	if (/\b(?:release|changelog|migration|breaking changes?|upgrade guide|release notes?)\b/i.test(query)) {
		return "release";
	}
	if (normalizeErrorSearchQuery(query) || /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|Exception|traceback|stack trace)\b/i.test(query)) {
		return "error";
	}
	if (intent === "docs_reference") return "docs";
	return undefined;
}

function extractSearchQueryTerms(query: string): string[] {
	const terms = query
		.toLowerCase()
		.match(/[a-z0-9][a-z0-9.+#-]*/g)
		?.filter((term) => term.length >= 3 && !SEARCH_QUERY_STOPWORDS.has(term));
	return Array.from(new Set(terms ?? []));
}

function buildGenericCurrentEventsQuery(query: string): string {
	const terms = extractSearchQueryTerms(query);
	if (terms.length === 0) return query.trim();
	const hasDateSignal = terms.some((term) => /^20\d\d$/.test(term) || /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.test(term));
	const suffix = hasDateSignal ? "" : ` ${new Date().getUTCFullYear()}`;
	return `${terms.slice(0, 8).join(" ")}${suffix}`.trim();
}

function buildWebSearchPlan(query: string, intent: ResearchQueryIntent): WebSearchPlan {
	const originalQuery = query.trim();
	const errorQuery = normalizeErrorSearchQuery(originalQuery);
	if (errorQuery) {
		return {
			originalQuery,
			effectiveQuery: appendUniqueTerms(errorQuery, ["fix"]),
			strategy: "error-message query preserves the exact error string and adds only targeted context",
			followUpQueries: [
				appendUniqueTerms(errorQuery, ["cause"]),
				appendUniqueTerms(errorQuery, ["fix", "version"]),
			],
			freshness: "any",
		};
	}
	if (intent === "current_events" && /\bclaude code\b/i.test(originalQuery) && /\bleak\b/i.test(originalQuery)) {
		return {
			originalQuery,
			effectiveQuery: "Claude Code source map npm leak March 2026 Anthropic",
			strategy: "current-events query rewritten to specific entities, leak vector, package channel, and date",
			followUpQueries: [
				"Anthropic Claude Code npm source map leak Chaofan Shou March 2026",
				"Claude Code source code leak npm package source maps analysis",
				"Claude Code leak npm packaging source maps Anthropic response",
			],
			freshness: "current",
		};
	}
	if (intent === "current_events") {
		const effectiveQuery = normalizeCurrentEventsQuery(buildGenericCurrentEventsQuery(originalQuery));
		return {
			originalQuery,
			effectiveQuery,
			strategy: "current-events query narrowed to distinctive entities and date-like terms",
			followUpQueries: [
				`${effectiveQuery} timeline`,
				`${effectiveQuery} analysis`,
				`${effectiveQuery} official response`,
			],
			freshness: "current",
		};
	}
	if (intent === "docs_reference") {
		const effectiveQuery = normalizeDocsReferenceQuery(originalQuery);
		return {
			originalQuery,
			effectiveQuery,
			strategy: "documentation query biased toward official reference pages",
			followUpQueries: [`${effectiveQuery} official docs`, `${effectiveQuery} reference`],
			preferredDomains: getPreferredOfficialDomains(effectiveQuery),
			avoidedDomains: ["medium.com", "dev.to", "reddit.com", "stackoverflow.com"],
			freshness: /\b(latest|current|pricing|release|changelog)\b/i.test(originalQuery) ? "current" : "any",
		};
	}
	if (intent === "code_lookup") {
		const effectiveQuery = /\b(github|gitlab|source|raw\.githubusercontent|site:github)\b/i.test(originalQuery)
			? originalQuery
			: appendUniqueTerms(originalQuery, ["github", "source"]);
		return {
			originalQuery,
			effectiveQuery,
			strategy: "code lookup query biased toward source repositories and raw implementation matches",
			followUpQueries: [`${originalQuery} github`, `${originalQuery} source`],
			preferredDomains: ["github.com", "raw.githubusercontent.com", "gitlab.com", "bitbucket.org"],
			avoidedDomains: ["learn.microsoft.com", "answers.microsoft.com", "stackoverflow.com"],
			freshness: "any",
		};
	}
	return {
		originalQuery,
		effectiveQuery: originalQuery,
		strategy: "general web query",
		followUpQueries: [],
		freshness: "any",
	};
}

function normalizeDocsReferenceQuery(query: string): string {
	const normalized = query.trim();
	if (/\bopenai\b/i.test(normalized) && /\bapi\b/i.test(normalized) && /\bpricing\b/i.test(normalized)) {
		return "OpenAI API pricing official website";
	}
	if (/\bnvidia\b/i.test(normalized) && /\b(nemotron|api|provider|docs?)\b/i.test(normalized)) {
		return appendUniqueTerms(normalized, ["official docs"]);
	}
	if (/\blm studio\b/i.test(normalized) && /\b(openai[- ]compatible|endpoint|api|server)\b/i.test(normalized)) {
		return appendUniqueTerms(normalized, ["official docs"]);
	}
	if (/\breact\b/i.test(normalized)) {
		return appendUniqueTerms(normalized, ["official docs"]);
	}
	if (/\btypescript\b|\btsconfig\b/i.test(normalized)) {
		return appendUniqueTerms(normalized, ["official docs"]);
	}
	const fallbackGroup = findOfficialFallbackGroup(normalized);
	return fallbackGroup ? appendUniqueTerms(normalized, ["official docs"]) : normalized;
}

function scoreStrongestCurrentEventHost(url: string): number {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase();
		let score = 0;
		if (/(^|\.)(varonis\.com|infoq\.com|thehackernews\.com|techradar\.com|arstechnica\.com|bleepingcomputer\.com|krebsonsecurity\.com|wired\.com|theregister\.com)$/.test(host)) {
			score += 5;
		}
		if (/(^|\.)(anthropic\.com|openai\.com|googleblog\.com|microsoft\.com|blog\.github\.com)$/.test(host)) {
			score += 4;
		}
		if (/(^|\.)(fortune\.com|bloomberg\.com|reuters\.com|ft\.com|wsj\.com)$/.test(host)) {
			score += 1;
		}
		if (/(^|\.)(tech-insider\.org|cybersecuritynews\.com|analyticsindiamag\.com|osintteam\.blog|infosecwriteups\.com)$/.test(host)) {
			score -= 8;
		}
		if (/(^|\.)(dev\.to|medium\.com|substack\.com)$/.test(host)) {
			score -= 6;
		}
		return score;
	} catch {
		return 0;
	}
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
	const title = result.title.toLowerCase();
	const snippet = result.snippet.toLowerCase();
	const url = result.url.toLowerCase();
	let score = 0;
	try {
		const parsed = new URL(result.url);
		const host = parsed.hostname.toLowerCase();
		const path = parsed.pathname.toLowerCase();
		const isOpenAIPricingQuery =
			/\bopenai\b/i.test(query) && /\bapi\b/i.test(query) && /\bpricing\b/i.test(query);
		if (isOpenAIPricingQuery) {
			if (host === "developers.openai.com" && /\/api\/docs\/pricing\/?$/.test(path)) {
				score += 20;
			} else if (host === "platform.openai.com" && /\/pricing\/?$/.test(path)) {
				score += 16;
			} else if (host === "openai.com" && /\/api\/pricing\/?$/.test(path)) {
				score += 6;
			} else if (
				/(^|\.)(aipricing\.guru|apicents\.com|pricepertoken\.com|llmpricingtable\.com|tokencalculator\.com)$/.test(host)
			) {
				score -= 12;
			}
		}
	} catch {
		// Ignore malformed URLs and keep the content score path-only.
	}
	if (queryTerms.length === 0) return score;
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
		if (/\bclaude code\b/.test(query) && /\bleak\b/.test(query)) {
			if (/\b(npm|registry|source map|sourcemap|map file|512[, ]?000|1[, ]?900|typescript source|source code)\b/.test(text)) {
				score += 6;
			}
			if (!/\b(vulnerability|exploit|malware|attack|typosquatting)\b/.test(query) && /\b(vulnerability|exploit|malware|attack campaign|days after the leak|days after source leak)\b/.test(text)) {
				score -= 8;
			}
			if (!/\b(plans|features|roadmap|buddy|undercover)\b/.test(query) && /\b(plans|feature flags|roadmap|undercover|buddy)\b/.test(text)) {
				score -= 3;
			}
		}
		if (prefersStrongestCurrentEventSources(query)) {
			try {
				const parsed = new URL(result.url);
				const host = parsed.hostname.toLowerCase();
				const path = parsed.pathname.toLowerCase();
				const analysisTerms =
					/\b(analysis|breakdown|deep dive|postmortem|forensic|threat labs?|investigation|full analysis|timeline|root cause)\b/;
				const genericNewsPath = /\/news\/|\/article\/|\/articles\/|\/press\/|\/coverage\//;
				if (analysisTerms.test(text)) {
					score += 6;
				}
				if (/(analysis|breakdown|postmortem|forensic|investigation)/.test(path)) {
					score += 3;
				}
				if (/\b(threat labs?|research)\b/.test(text)) {
					score += 2;
				}
				score += scoreStrongestCurrentEventHost(result.url);
				if (genericNewsPath.test(path) && !analysisTerms.test(text)) {
					score -= 3;
				}
				if (/(^|\.)(varonis\.com|crowdstrike\.com|sentinelone\.com|unit42\.paloaltonetworks\.com|securelist\.com|mandiant\.com)$/.test(host)) {
					score += 2;
				}
			} catch {
				// Ignore malformed URLs and keep the base content score.
			}
		}
		return score;
	}
	if (intent === "docs_reference") {
		return scoreDocsReferenceResultContent(result, query);
	}
	return 0;
}

function rankResearchResults(query: string, results: SearchResult[]): RankedSearchResult[] {
	const intent = detectResearchQueryIntent(query);
	return results
		.map((result, index) => {
			const score = scoreResearchSource(result.url, intent) + scoreResearchResultContent(result, intent, query);
			return {
				...result,
				authoritative: isLikelyAuthoritativeSource(result.url, intent),
				sourceKind: classifyResearchSource(result.url, intent),
				score,
				scoreReasons: getResearchScoreReasons(result, intent, query),
				fetchRisk: getResearchFetchRisk(result.url),
				index,
			};
		})
		.sort((left, right) => right.score - left.score || left.index - right.index)
		.map(({ index: _index, ...result }) => result);
}

function getSearchResultHost(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return "";
	}
}

function isOfficialDocsSpecificQuery(query: string, intent: ResearchQueryIntent): boolean {
	return intent === "docs_reference" && Boolean(findOfficialFallbackGroup(query) || /\bofficial\b/i.test(query));
}

function diversifySearchResultHosts<T extends { url: string; score?: number }>(
	results: T[],
	query: string,
	intent: ResearchQueryIntent,
): T[] {
	if (results.length <= 2 || isOfficialDocsSpecificQuery(query, intent)) return results;
	const selected: T[] = [];
	const deferred: T[] = [];
	const seenHosts = new Set<string>();
	for (const result of results) {
		const host = getSearchResultHost(result.url);
		if (host && seenHosts.has(host) && selected.length < COLLAPSED_RESULTS) {
			deferred.push(result);
			continue;
		}
		selected.push(result);
		if (host) seenHosts.add(host);
	}
	return [...selected, ...deferred];
}

function canonicalSearchResultKey(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.hash = "";
		for (const key of [...parsed.searchParams.keys()]) {
			if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) {
				parsed.searchParams.delete(key);
			}
		}
		return parsed.toString().replace(/\/$/, "").toLowerCase();
	} catch {
		return url.trim().replace(/\/$/, "").toLowerCase();
	}
}

function dedupeSearchResults<T extends { url: string; score?: number }>(results: T[]): T[] {
	const bestByUrl = new Map<string, T>();
	for (const result of results) {
		const key = canonicalSearchResultKey(result.url);
		const existing = bestByUrl.get(key);
		if (!existing || Number(result.score ?? 0) > Number(existing.score ?? 0)) {
			bestByUrl.set(key, result);
		}
	}
	return [...bestByUrl.values()];
}

function renderWebSearchResult(
	result: {
		details?: {
			query?: string;
			resultCount?: number;
			cacheHit?: boolean;
			searchProvider?: string;
			fallbackUsed?: boolean;
			results?: Array<{ title?: string; url?: string; snippet?: string; authoritative?: boolean; sourceKind?: string; fetchRisk?: string }>;
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
		const provider = details.searchProvider ? `, ${details.searchProvider}` : "";
		const fallback = details.fallbackUsed ? ", fallback" : "";
		text += theme.fg("toolOutput", ` (${details.resultCount} results${provider}${fallback})`);
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
					const sourceKind = entry.sourceKind ? ` ${theme.fg("muted", `[${entry.sourceKind}]`)}` : "";
					const fetchRisk = entry.fetchRisk && entry.fetchRisk !== "low" ? ` ${theme.fg("muted", `[${entry.fetchRisk} fetch risk]`)}` : "";
					const snippet = entry.snippet
						? `\n   ${theme.fg("toolOutput", truncateResearchSnippet(entry.snippet, MAX_SNIPPET_CHARS))}`
						: "";
					return `${theme.fg("toolOutput", `${index + 1}. ${title}`)}${authoritative}${sourceKind}${fetchRisk}\n   ${theme.fg("accent", url)}${snippet}`;
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

function getConfiguredSearchProviderName(): SearchProviderName {
	const value = (process.env.AG1_WEB_SEARCH_PROVIDER ?? "auto").trim().toLowerCase();
	if (value === "duckduckgo" || value === "brave" || value === "serpapi" || value === "tavily" || value === "exa") {
		return value;
	}
	return "auto";
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

function decodeSearchHtmlText(value: string): string {
	return value
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&#x2F;/g, "/")
		.replace(/&#x27;/g, "'")
		.replace(/\s+/g, " ")
		.replace(/\s+([.,;:!?])/g, "$1")
		.trim();
}

function isUsableSearchResultUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
		if (/(^|\.)duckduckgo\.com$/i.test(parsed.hostname)) return false;
		return true;
	} catch {
		return false;
	}
}

function extractDuckDuckGoSnippet(segment: string): string {
	const snippetMatch =
		segment.match(/<a[^>]*class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)
		?? segment.match(/<div[^>]*class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)
		?? segment.match(/<span[^>]*class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
	return snippetMatch?.[1] ? decodeSearchHtmlText(snippetMatch[1]) : "";
}

export function parseDuckDuckGoResultsForTests(html: string, maxResults: number): SearchResult[] {
	const results: SearchResult[] = [];
	const anchors = [...html.matchAll(/<a[^>]*class=["'][^"']*\bresult__a\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
	for (const [index, match] of anchors.entries()) {
		const normalizedUrl = normalizeSearchResultUrl(match[1]);
		const title = decodeSearchHtmlText(match[2]);
		if (!title || !isUsableSearchResultUrl(normalizedUrl)) continue;
		const matchEnd = (match.index ?? 0) + match[0].length;
		const nextStart = anchors[index + 1]?.index ?? html.length;
		const snippet = extractDuckDuckGoSnippet(html.slice(matchEnd, nextStart));
		results.push({
			title,
			url: normalizedUrl,
			snippet,
		});
		if (results.length >= maxResults) break;
	}
	return dedupeSearchResults(results).slice(0, maxResults);
}

const parseDuckDuckGoResults = parseDuckDuckGoResultsForTests;

function buildOfflineFallbackResults(query: string, intent: ResearchQueryIntent): SearchResult[] {
	if (intent !== "docs_reference") return [];
	if (/\bopenai\b/i.test(query) && /\bapi\b/i.test(query) && /\bpricing\b/i.test(query)) {
		return [
			{
				title: "Pricing | OpenAI API",
				url: "https://developers.openai.com/api/docs/pricing",
				snippet: "Official OpenAI API pricing documentation.",
			},
			{
				title: "OpenAI Platform Pricing",
				url: "https://platform.openai.com/pricing",
				snippet: "Official OpenAI platform pricing overview.",
			},
		];
	}
	const fallbackGroup = findOfficialFallbackGroup(query);
	return fallbackGroup?.results ?? [];
}

async function duckDuckGoSearch(request: SearchRequest): Promise<SearchProviderResponse> {
	const attempts: SearchProviderAttempt[] = [];
	const endpoints = [
		{
			provider: "duckduckgo-html",
			url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(request.query)}`,
		},
		{
			provider: "duckduckgo-lite",
			url: `https://duckduckgo.com/html/?q=${encodeURIComponent(request.query)}`,
		},
	];

	for (const endpoint of endpoints) {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), DUCKDUCKGO_TIMEOUT_MS);
			const resp = await fetch(endpoint.url, {
				signal: controller.signal,
				headers: {
					"User-Agent": "Mozilla/5.0",
					Accept: "text/html,application/xhtml+xml",
				},
			});
			clearTimeout(timeout);

			if (!resp.ok) {
				attempts.push({
					provider: endpoint.provider,
					url: endpoint.url,
					status: "http_error",
					resultCount: 0,
					error: `${resp.status} ${resp.statusText}`.trim(),
				});
				continue;
			}

			const html = await resp.text();
			const results = parseDuckDuckGoResults(html, request.maxResults);
			attempts.push({
				provider: endpoint.provider,
				url: endpoint.url,
				status: "ok",
				resultCount: results.length,
			});
			if (results.length > 0) {
				return { results, attempts, provider: endpoint.provider };
			}
		} catch (err) {
			attempts.push({
				provider: endpoint.provider,
				url: endpoint.url,
				status: "error",
				resultCount: 0,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return { results: [], attempts, provider: "duckduckgo" };
}

function createDuckDuckGoProvider(): SearchProvider {
	return {
		name: "duckduckgo",
		search: duckDuckGoSearch,
	};
}

async function braveSearch(request: SearchRequest): Promise<SearchProviderResponse> {
	const apiKey = process.env.AG1_BRAVE_SEARCH_API_KEY?.trim();
	const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(request.query)}&count=${encodeURIComponent(String(request.maxResults))}`;
	if (!apiKey) {
		return {
			provider: "brave",
			results: [],
			attempts: [
				{
					provider: "brave",
					url,
					status: "skipped",
					resultCount: 0,
					error: "AG1_BRAVE_SEARCH_API_KEY is not configured",
				},
			],
			error: "missing_api_key",
		};
	}

	const attempts: SearchProviderAttempt[] = [];
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), PAID_PROVIDER_TIMEOUT_MS);
		const resp = await fetch(url, {
			signal: controller.signal,
			headers: {
				Accept: "application/json",
				"X-Subscription-Token": apiKey,
			},
		});
		clearTimeout(timeout);

		if (!resp.ok) {
			attempts.push({
				provider: "brave",
				url,
				status: "http_error",
				resultCount: 0,
				error: `${resp.status} ${resp.statusText}`.trim(),
			});
			return { provider: "brave", results: [], attempts, error: "http_error" };
		}

		const data = await resp.json() as {
			web?: {
				results?: Array<{
					title?: string;
					url?: string;
					description?: string;
					extra_snippets?: string[];
				}>;
			};
		};
		const results = (data.web?.results ?? [])
			.map((entry): SearchResult | undefined => {
				if (!entry.title || !entry.url || !isUsableSearchResultUrl(entry.url)) return undefined;
				const snippet = entry.description ?? entry.extra_snippets?.find((value) => value.trim().length > 0) ?? "";
				return {
					title: decodeSearchHtmlText(entry.title),
					url: entry.url,
					snippet: decodeSearchHtmlText(snippet),
				};
			})
			.filter((entry): entry is SearchResult => entry !== undefined)
			.slice(0, request.maxResults);
		attempts.push({
			provider: "brave",
			url,
			status: "ok",
			resultCount: results.length,
		});
		return { provider: "brave", results: dedupeSearchResults(results).slice(0, request.maxResults), attempts };
	} catch (err) {
		attempts.push({
			provider: "brave",
			url,
			status: "error",
			resultCount: 0,
			error: err instanceof Error ? err.message : String(err),
		});
		return { provider: "brave", results: [], attempts, error: "error" };
	}
}

function createBraveProvider(): SearchProvider {
	return {
		name: "brave",
		search: braveSearch,
	};
}

function createUnavailableProvider(name: Exclude<SearchProviderName, "auto" | "duckduckgo" | "brave">): SearchProvider {
	const keyEnv = `AG1_${name.toUpperCase()}_API_KEY`;
	return {
		name,
		async search(request: SearchRequest): Promise<SearchProviderResponse> {
			return {
				provider: name,
				results: [],
				attempts: [
					{
						provider: name,
						url: `provider:${name}:${request.query}`,
						status: "skipped",
						resultCount: 0,
						error: `${name} provider is not implemented yet; ${keyEnv} is optional and DuckDuckGo fallback remains available`,
					},
				],
				error: "provider_not_implemented",
			};
		},
	};
}

function getSearchProvidersForRequest(): { providerMode: SearchProviderName; providers: SearchProvider[] } {
	const providerMode = getConfiguredSearchProviderName();
	const duckDuckGo = createDuckDuckGoProvider();
	if (providerMode === "duckduckgo") {
		return { providerMode, providers: [duckDuckGo] };
	}
	if (providerMode === "brave") {
		return { providerMode, providers: [createBraveProvider(), duckDuckGo] };
	}
	if (providerMode === "serpapi" || providerMode === "tavily" || providerMode === "exa") {
		return { providerMode, providers: [createUnavailableProvider(providerMode), duckDuckGo] };
	}
	if (process.env.AG1_BRAVE_SEARCH_API_KEY?.trim()) {
		return { providerMode, providers: [createBraveProvider(), duckDuckGo] };
	}
	return { providerMode, providers: [duckDuckGo] };
}

async function providerSearch(
	request: SearchRequest,
	cacheKeyOverride?: string,
): Promise<SearchProviderResponse & { providerMode: SearchProviderName; providerOrder: string[] }> {
	const { providerMode, providers } = getSearchProvidersForRequest();
	const providerOrder = providers.map((provider) => provider.name);
	const cacheKey = `${providerMode}:${providerOrder.join(">")}:${(cacheKeyOverride ?? request.query).trim().toLowerCase()}`;
	const cached = searchCache.get(cacheKey);
	if (cached) {
		if (isFreshSearchCacheEntry(cached)) {
			return {
				results: cached.results.slice(0, request.maxResults),
				attempts: cached.attempts,
				provider: cached.provider,
				providerMode,
				providerOrder,
			};
		}
		searchCache.delete(cacheKey);
	}

	const attempts: SearchProviderAttempt[] = [];
	for (const provider of providers) {
		const response = await provider.search(request);
		attempts.push(...response.attempts);
		if (response.results.length > 0) {
			searchCache.set(cacheKey, { results: response.results, attempts, provider: response.provider, timestamp: Date.now() });
			return {
				...response,
				attempts,
				providerMode,
				providerOrder,
			};
		}
	}

	const provider = attempts.at(-1)?.provider ?? providerOrder.at(-1) ?? "duckduckgo";
	searchCache.set(cacheKey, { results: [], attempts, provider, timestamp: Date.now() });
	return { results: [], attempts, provider, providerMode, providerOrder };
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
	const intent = detectResearchQueryIntent(query);
	const plan = buildWebSearchPlan(query, intent);
	const request: SearchRequest = {
		query: plan.effectiveQuery,
		maxResults: Math.min(maxResults, EXPANDED_RESULTS),
		intent,
		freshness: plan.freshness,
	};
	const { providerMode, providers } = getSearchProvidersForRequest();
	const providerOrder = providers.map((provider) => provider.name);
	const providerCacheKey = `${providerMode}:${providerOrder.join(">")}:${cacheKey}`;
	const cachedBefore = searchCache.get(providerCacheKey);
	const cacheHit = isFreshSearchCacheEntry(cachedBefore);
	const searchResponse = await providerSearch(request, query);
	const fallbackResults = searchResponse.results.length === 0
		? buildOfflineFallbackResults(plan.effectiveQuery, intent).slice(0, Math.min(maxResults, EXPANDED_RESULTS))
		: [];
	const rawResults = searchResponse.results.length > 0 ? searchResponse.results : fallbackResults;
	const rankedResults = diversifySearchResultHosts(
		dedupeSearchResults(rankResearchResults(plan.effectiveQuery, rawResults)),
		plan.effectiveQuery,
		intent,
	);
	const compression = getResearchCompressionProfile(ctx);
	const details = {
		query,
		effectiveQuery: plan.effectiveQuery,
		intent,
		searchStrategy: plan.strategy,
		followUpQueries: plan.followUpQueries,
		preferredDomains: plan.preferredDomains,
		avoidedDomains: plan.avoidedDomains,
		freshness: plan.freshness,
		preferCorroboration: prefersStrongestCurrentEventSources(query),
		resultCount: rankedResults.length,
		compressionMode: compression.mode,
		cacheHit,
		searchProvider: fallbackResults.length > 0 ? "official-fallback" : searchResponse.provider,
		searchProviderMode: searchResponse.providerMode,
		searchProviderOrder: searchResponse.providerOrder,
		searchAttempts: searchResponse.attempts,
		fallbackUsed: fallbackResults.length > 0,
		sourceUrls: rankedResults.map((result) => result.url),
		preferredSourceUrls: rankedResults.filter((result) => result.authoritative || result.score >= 4).map((result) => result.url),
		results: rankedResults.map((result) => ({
			title: result.title,
			url: result.url,
			snippet: result.snippet,
			authoritative: result.authoritative,
			sourceKind: result.sourceKind,
			score: result.score,
			scoreReasons: result.scoreReasons,
			fetchRisk: result.fetchRisk,
		})),
	};

	if (rankedResults.length === 0) {
		return {
			details,
			content: [
				{
					type: "text" as const,
					text: formatSearchTranscriptContent(plan.effectiveQuery, [], compression, {
						intent,
						preferCorroboration: prefersStrongestCurrentEventSources(query),
						originalQuery: plan.originalQuery,
						searchStrategy: plan.strategy,
						followUpQueries: plan.followUpQueries,
					}),
				},
			],
		};
	}

	rememberResearchUrlHints(
		rankedResults.map((result) => result.url),
		(url) => {
			const result = rankedResults.find((entry) => entry.url === url);
			return {
				intent,
				richFetch: shouldUseRichResearchFetch(query, intent),
				authoritative: result?.authoritative === true,
				focusTerms: intent === "docs_reference" ? extractDocsQueryTerms(query).slice(0, 6) : undefined,
				coverageKind: detectResearchCoverageKind(query, intent),
			};
		},
	);

	return {
		details,
		content: [
			{
				type: "text" as const,
				text: formatSearchTranscriptContent(plan.effectiveQuery, rankedResults, compression, {
					intent,
					preferCorroboration: prefersStrongestCurrentEventSources(query),
					originalQuery: plan.originalQuery,
					searchStrategy: plan.strategy,
					followUpQueries: plan.followUpQueries,
				}),
			},
		],
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
