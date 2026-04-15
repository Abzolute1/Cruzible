import type { ContextUsage } from "../extensions/types.js";

export type ResearchCompressionMode = "normal" | "tight" | "ultra";
export type ResearchFetchContentStatus = "rich" | "thin" | "placeholder";

export interface ResearchCompressionProfile {
	mode: ResearchCompressionMode;
	searchTranscriptResults: number;
	searchSnippetChars: number;
	fetchTranscriptFacts: number;
	fetchTranscriptPreviewLines: number;
	fetchTranscriptLineChars: number;
}

export interface ResearchResultSummary {
	title: string;
	url: string;
	snippet?: string;
	authoritative?: boolean;
}

export interface ResearchFetchAssessment {
	status: ResearchFetchContentStatus;
	reason?: string;
}

const RESEARCH_PLACEHOLDER_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /\bjust a moment\b/i, reason: "interstitial placeholder content" },
	{ pattern: /\b(enable|turn on)\s+javascript\b/i, reason: "javascript gate detected" },
	{ pattern: /\bchecking your browser\b/i, reason: "browser verification interstitial" },
	{ pattern: /\bverify you are human\b/i, reason: "human verification interstitial" },
	{ pattern: /\bcaptcha\b/i, reason: "captcha page detected" },
	{ pattern: /\baccess denied\b/i, reason: "access denied page" },
	{ pattern: /\bpress and hold\b/i, reason: "bot protection challenge" },
	{ pattern: /\bddos protection\b/i, reason: "bot protection challenge" },
	{ pattern: /\bcloudflare\b.*\b(wait|verify|attention)\b/i, reason: "cloudflare interstitial" },
];

const RESEARCH_NOISE_LINE_PATTERNS = [
	/^(accept|reject|dismiss|close)$/i,
	/^(cookie|cookies|privacy|terms)(\s|$)/i,
	/^(sign in|log in|subscribe|menu|search|skip to content)$/i,
	/^(home|news|business|sports|tech|world)$/i,
	/^(advertisement|sponsored)$/i,
];
const RESEARCH_CODE_LINE_PATTERNS = [
	/^\s*import\s.+from\s+["'][^"']+["'];?$/i,
	/^\s*export\s+(?:default\s+)?(?:const|class|function|type|interface|\{)/i,
	/^\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/,
	/^\s*[A-Za-z_$][\w$]*\([^)]*\)\s*\{/,
	/^\s*return\s+/,
];
const RESEARCH_DOCS_CHROME_LINE_PATTERNS = [
	/^(?:api\s+reference|reference|docs?|documentation|hooks?|components?|learn|guides?|copy|page)(?:\s+(?:api\s+reference|reference|docs?|documentation|hooks?|components?|learn|guides?|copy|page))*$/i,
	/^the library for web and native user interfaces$/i,
];
const RESEARCH_LOW_VALUE_DOCS_PREVIEW_PATTERNS = [
	/^[-*]\s*reference$/i,
	/^[-*]\s*(?:api\s+reference|documentation|docs?)$/i,
	/^[-*]\s*`?[A-Za-z_$][\w$]*`?\s+function$/i,
];

export function deriveResearchCompressionProfile(contextUsage?: ContextUsage): ResearchCompressionProfile {
	const contextWindow = contextUsage?.contextWindow ?? 0;
	const percent = contextUsage?.percent ?? 0;

	if ((contextWindow > 0 && contextWindow <= 32_000) || percent >= 80) {
		return {
			mode: "ultra",
			searchTranscriptResults: 1,
			searchSnippetChars: 70,
			fetchTranscriptFacts: 2,
			fetchTranscriptPreviewLines: 2,
			fetchTranscriptLineChars: 120,
		};
	}

	if ((contextWindow > 0 && contextWindow <= 80_000) || percent >= 35) {
		return {
			mode: "tight",
			searchTranscriptResults: 2,
			searchSnippetChars: 100,
			fetchTranscriptFacts: 3,
			fetchTranscriptPreviewLines: 3,
			fetchTranscriptLineChars: 140,
		};
	}

	return {
		mode: "normal",
		searchTranscriptResults: 2,
		searchSnippetChars: 120,
		fetchTranscriptFacts: 4,
		fetchTranscriptPreviewLines: 4,
		fetchTranscriptLineChars: 160,
	};
}

export function truncateResearchSnippet(text: string, maxChars: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (maxChars <= 0) return "";
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, maxChars - 1)}...`;
}

export function extractResearchPrimaryHtml(html: string): string {
	const candidates = [
		/<article\b[^>]*>([\s\S]*?)<\/article>/i,
		/<main\b[^>]*>([\s\S]*?)<\/main>/i,
		/<body\b[^>]*>([\s\S]*?)<\/body>/i,
	];

	for (const pattern of candidates) {
		const match = html.match(pattern);
		const fragment = match?.[1]?.trim();
		if (fragment) return fragment;
	}

	return html;
}

export function extractResearchDocumentTitle(html: string): string | undefined {
	const candidates = [
		/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
		/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
		/<title[^>]*>([^<]+)<\/title>/i,
	];

	for (const pattern of candidates) {
		const match = html.match(pattern);
		const title = match?.[1]?.trim();
		if (title) return title.replace(/\s+/g, " ").trim();
	}

	return undefined;
}

export function extractResearchMetaDescription(html: string): string | undefined {
	const candidates = [
		/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
		/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
		/<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']+)["']/i,
	];

	for (const pattern of candidates) {
		const match = html.match(pattern);
		const description = match?.[1]?.trim();
		if (description) return description.replace(/\s+/g, " ").trim();
	}

	return undefined;
}

export function limitPreviewLines(preview: string, maxLines: number, maxLineChars: number): string {
	return preview
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.slice(0, maxLines)
		.map((line) => (line.length > maxLineChars ? `${line.slice(0, maxLineChars - 1)}...` : line))
			.join("\n");
}

function canonicalizeResearchComparisonLine(line: string): string {
	return cleanResearchLine(line)
		.replace(/^#{1,6}\s+/, "")
		.replace(/^[-*+]\s+/, "")
		.replace(/^\d+\.\s+/, "")
		.replace(/\s+[–-]\s+[A-Za-z0-9][A-Za-z0-9 ._-]*$/, "")
		.trim()
		.toLowerCase();
}

function shouldDeduplicateFetchExcerpt(title: string | undefined, facts: string[] | undefined, preview: string): boolean {
	const titleText = title ?? "";
	if (/\b(api|reference|hook|hooks|component|components)\b/i.test(titleText)) return true;
	if (preview.split("\n").some((line) => /`[^`]+`/.test(line))) return true;
	if ((facts ?? []).some((fact) => /`[^`]+`/.test(fact))) return true;
	return false;
}

function buildFetchExcerpt(preview: string | undefined, title: string | undefined, facts: string[] | undefined, profile: ResearchCompressionProfile): string {
	if (!preview) return "";
	if (!shouldDeduplicateFetchExcerpt(title, facts, preview)) {
		return limitPreviewLines(preview, profile.fetchTranscriptPreviewLines, profile.fetchTranscriptLineChars);
	}
	const previewLines = preview
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (previewLines.length === 0) return "";

	const omit = new Set<string>();
	if (title) {
		const normalizedTitle = canonicalizeResearchComparisonLine(title);
		if (normalizedTitle) omit.add(normalizedTitle);
		const titleHead = title.split(/[–-]/)[0]?.trim();
		if (titleHead) {
			const normalizedHead = canonicalizeResearchComparisonLine(titleHead);
			if (normalizedHead) omit.add(normalizedHead);
		}
	}
	for (const fact of facts ?? []) {
		const normalizedFact = canonicalizeResearchComparisonLine(fact);
		if (normalizedFact) omit.add(normalizedFact);
	}

	const excerptLines: string[] = [];
	const seen = new Set<string>();
	for (const line of previewLines) {
		const normalized = canonicalizeResearchComparisonLine(line);
		if (!normalized) continue;
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		if (omit.has(normalized)) continue;
		excerptLines.push(line);
		if (excerptLines.length >= profile.fetchTranscriptPreviewLines) break;
	}

	const excerpt = excerptLines.length > 0 ? excerptLines.join("\n") : limitPreviewLines(preview, profile.fetchTranscriptPreviewLines, profile.fetchTranscriptLineChars);
	return limitPreviewLines(excerpt, profile.fetchTranscriptPreviewLines, profile.fetchTranscriptLineChars);
}

function isResearchNoiseLine(line: string): boolean {
	const normalized = line.replace(/\s+/g, " ").trim();
	if (!normalized) return true;
	if (normalized.length < 8) return true;
	if (RESEARCH_PLACEHOLDER_PATTERNS.some((entry) => entry.pattern.test(normalized))) return true;
	if (RESEARCH_NOISE_LINE_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
	return false;
}

function isCodeLikeLine(line: string): boolean {
	const normalized = line.replace(/\s+/g, " ").trim();
	if (!normalized) return false;
	if (RESEARCH_CODE_LINE_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
	if ((/[{};]/.test(normalized) && /[=()]/.test(normalized)) || /=>/.test(normalized)) return true;
	return false;
}

function cleanResearchLine(line: string): string {
	return line
		.replace(/\bpageCopy\b/gi, "page Copy")
		.replace(/\bcopy page\b/gi, " ")
		.replace(/\bcopy\b/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function isDocumentationChromeLine(line: string): boolean {
	const normalized = cleanResearchLine(line);
	if (!normalized) return true;
	return RESEARCH_DOCS_CHROME_LINE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isLowValueDocsPreviewLine(line: string): boolean {
	const normalized = cleanResearchLine(line);
	if (!normalized) return true;
	return RESEARCH_LOW_VALUE_DOCS_PREVIEW_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function buildResearchPreview(markdown: string, maxLines: number, maxLineChars: number): string {
	const previewLines: string[] = [];
	const seen = new Set<string>();

	for (const rawLine of markdown.split("\n")) {
		const line = cleanResearchLine(rawLine);
		if (!line) continue;
		if (isResearchNoiseLine(line)) continue;
		if (isDocumentationChromeLine(line)) continue;
		if (isLowValueDocsPreviewLine(line)) continue;
		const normalized = line.toLowerCase();
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		previewLines.push(line.length > maxLineChars ? `${line.slice(0, maxLineChars - 1)}...` : line);
		if (previewLines.length >= maxLines) break;
	}

	if (previewLines.length === 0) {
		return limitPreviewLines(markdown, maxLines, maxLineChars);
	}

	return previewLines.join("\n");
}

export function assessResearchFetchContent(options: {
	markdown: string;
	facts?: string[];
	preview?: string;
	title?: string;
	metaDescription?: string;
}): ResearchFetchAssessment {
	const combined = [
		options.title,
		options.metaDescription,
		options.preview,
		...(options.facts ?? []),
		options.markdown,
	]
		.filter((value) => typeof value === "string" && value.trim().length > 0)
		.join("\n");

	for (const entry of RESEARCH_PLACEHOLDER_PATTERNS) {
		if (entry.pattern.test(combined)) {
			return {
				status: "placeholder",
				reason: entry.reason,
			};
		}
	}

	const informativePreviewLines = (options.preview ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length >= 40 && !isResearchNoiseLine(line)).length;
	const previewLines = (options.preview ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const codeLikePreviewLines = previewLines.filter((line) => isCodeLikeLine(line)).length;
	const contentLines = options.markdown
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !isResearchNoiseLine(line));
	const codeLikeRatio = contentLines.length > 0 ? contentLines.filter((line) => isCodeLikeLine(line)).length / contentLines.length : 0;
	const factCount = (options.facts ?? []).length;
	const compactLength = combined.replace(/\s+/g, " ").trim().length;
	const proseFactCount = (options.facts ?? []).filter((fact) => !isCodeLikeLine(fact)).length;

	if (((codeLikePreviewLines >= Math.max(2, previewLines.length - 1) && previewLines.length > 0) || codeLikeRatio >= 0.6) && proseFactCount < 2) {
		return {
			status: "thin",
			reason: "code-heavy extract without enough supporting explanation",
		};
	}

	if (factCount >= 2 || informativePreviewLines >= 3 || (compactLength >= 700 && proseFactCount >= 1)) {
		return {
			status: "rich",
		};
	}

	return {
		status: "thin",
		reason: "limited article text extracted",
	};
}

export function extractResearchFacts(markdown: string, maxFacts: number, maxChars: number): string[] {
	if (maxFacts <= 0) return [];
	const facts: string[] = [];
	const seen = new Set<string>();
	const lines = markdown
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	for (const line of lines) {
		let candidate = line
			.replace(/^#{1,6}\s+/, "")
			.replace(/^[-*+]\s+/, "")
			.replace(/^\d+\.\s+/, "")
			.trim();
			candidate = cleanResearchLine(candidate);
			if (candidate.length < 24) continue;
			if (RESEARCH_PLACEHOLDER_PATTERNS.some((entry) => entry.pattern.test(candidate))) continue;
			if (/^[`*_#>\-\d.\s]+$/.test(candidate)) continue;
		if (isDocumentationChromeLine(candidate)) continue;
		if (
			/\b(?:function|window\.|document\.|localStorage|sessionStorage|dataLayer|gtag|addEventListener|querySelector)\b/i.test(
				candidate,
			)
		) {
			continue;
		}
		if (/[{};]/.test(candidate) && /[=()]/.test(candidate)) continue;
		candidate = truncateResearchSnippet(candidate, maxChars);
		const normalized = candidate.toLowerCase();
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		facts.push(candidate);
		if (facts.length >= maxFacts) break;
	}

	return facts;
}

export function formatSearchTranscriptContent(
	query: string,
	results: ResearchResultSummary[],
	profile: ResearchCompressionProfile,
): string {
	const displayedResults = results.slice(0, profile.searchTranscriptResults);
	const lines = [`Web search: ${query}`];

	if (displayedResults.length === 0) {
		lines.push("No results found.");
		return lines.join("\n");
	}

	lines.push("Top sources:");
	for (const [index, result] of displayedResults.entries()) {
		lines.push(`${index + 1}. ${result.title}${result.authoritative ? " [authoritative]" : ""} — ${result.url}`);
		const snippet = result.snippet ? truncateResearchSnippet(result.snippet, profile.searchSnippetChars) : "";
		if (snippet) lines.push(`   ${snippet}`);
	}

	if (results.length > displayedResults.length) {
		lines.push(`[${results.length - displayedResults.length} additional result(s) omitted]`);
	}

	if (displayedResults[0]?.url) {
		lines.push(`Next step: webFetch ${displayedResults[0].url}`);
	}
	return lines.join("\n");
}

export function formatFetchTranscriptContent(options: {
	url: string;
	title?: string;
	facts?: string[];
	preview?: string;
	profile: ResearchCompressionProfile;
	truncated?: boolean;
	metaDescription?: string;
	status?: ResearchFetchContentStatus;
	statusReason?: string;
}): string {
	const lines = [`Fetched source: ${options.url}`];
	if (options.title) lines.push(`Title: ${options.title}`);
	if (options.status === "placeholder") {
		lines.push("Fetch status: placeholder/interstitial content");
		if (options.statusReason) lines.push(`Reason: ${options.statusReason}`);
		if (options.metaDescription) lines.push(`Meta description: ${options.metaDescription}`);
		lines.push("Do not rely on this source as evidence. Choose another URL or source.");
		return lines.join("\n");
	}
	if (options.metaDescription && (!options.facts || options.facts.length === 0)) {
		lines.push(`Summary: ${truncateResearchSnippet(options.metaDescription, options.profile.fetchTranscriptLineChars)}`);
	}
	if (options.facts && options.facts.length > 0) {
		lines.push("Key facts:");
		for (const fact of options.facts.slice(0, options.profile.fetchTranscriptFacts)) {
			lines.push(`- ${fact}`);
		}
	}

	const compactPreview = buildFetchExcerpt(options.preview, options.title, options.facts, options.profile);
	if (compactPreview) {
		lines.push("Key excerpt:");
		lines.push(compactPreview);
	}

	if (options.status === "thin") {
		lines.push(`Fetch status: thin extract${options.statusReason ? ` (${options.statusReason})` : ""}`);
		lines.push("This source yielded limited article text. Use another source if key facts are still missing.");
	} else if (options.status === "rich") {
		lines.push("This source summary is likely sufficient to answer or cite without refetching.");
	} else if (options.truncated || options.profile.mode !== "normal") {
		lines.push("This fetch was compacted to preserve context.");
	}

	lines.push("Reuse this URL as the source reference instead of repeating webSearch.");

	return lines.join("\n");
}
