import type { ContextUsage } from "../extensions/types.js";

export type ResearchCompressionMode = "normal" | "tight" | "ultra";

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

export function limitPreviewLines(preview: string, maxLines: number, maxLineChars: number): string {
	return preview
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.slice(0, maxLines)
		.map((line) => (line.length > maxLineChars ? `${line.slice(0, maxLineChars - 1)}...` : line))
		.join("\n");
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
		if (candidate.length < 24) continue;
		if (/^[`*_#>\-\d.\s]+$/.test(candidate)) continue;
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
		lines.push(`[${results.length - displayedResults.length} additional result(s) omitted to preserve context]`);
	}

	lines.push("Search results are only a compact index of candidate sources, not full page contents.");
	if (displayedResults[0]?.url) {
		lines.push(`Best next step: use webFetch on ${displayedResults[0].url} before searching again.`);
	}
	lines.push("Do not repeat webSearch just to read omitted results from the same search. Use webFetch on one of the URLs above.");
	return lines.join("\n");
}

export function formatFetchTranscriptContent(options: {
	url: string;
	title?: string;
	facts?: string[];
	preview?: string;
	profile: ResearchCompressionProfile;
	truncated?: boolean;
}): string {
	const lines = [`Fetched source: ${options.url}`];
	if (options.title) lines.push(`Title: ${options.title}`);
	if (options.facts && options.facts.length > 0) {
		lines.push("Key facts:");
		for (const fact of options.facts.slice(0, options.profile.fetchTranscriptFacts)) {
			lines.push(`- ${fact}`);
		}
	}

	const compactPreview = options.preview
		? limitPreviewLines(
				options.preview,
				options.profile.fetchTranscriptPreviewLines,
				options.profile.fetchTranscriptLineChars,
			)
		: "";
	if (compactPreview) {
		lines.push("Key excerpt:");
		lines.push(compactPreview);
	}

	if (options.truncated || options.profile.mode !== "normal") {
		lines.push("Only a compact source preview is included here to preserve context.");
	}

	lines.push("If you need more detail from this same source, keep using this URL as the reference instead of repeating webSearch.");

	return lines.join("\n");
}
