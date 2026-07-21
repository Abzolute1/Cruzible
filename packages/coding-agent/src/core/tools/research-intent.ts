import type { ResearchCompressionProfile, ResearchCoverageKind } from "./research-output.js";

export type ResearchQueryIntent = "code_lookup" | "current_events" | "docs_reference" | "general";

export interface ResearchUrlHint {
	intent: ResearchQueryIntent;
	richFetch: boolean;
	authoritative?: boolean;
	focusTerms?: string[];
	coverageKind?: ResearchCoverageKind;
}

const URL_HINT_TTL_MS = 15 * 60 * 1000;
const urlHints = new Map<string, { hint: ResearchUrlHint; timestamp: number }>();
const fetchOutcomeHints = new Map<string, { status: "rich" | "thin" | "placeholder"; timestamp: number }>();

function hasExplicitCodeSourceSignal(query: string): boolean {
	return /(?:[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)|(?:^|[\s/])(src|packages|app|lib|test|tests)\b|(?:\.[cm]?[jt]sx?\b)|(?:site:github)|(?:github)|(?:gitlab)|(?:raw\.githubusercontent)/i.test(
		query,
	);
}

function hasApiReferenceShapeSignal(query: string): boolean {
	return /\b(parameter|parameters|option|options|argument|arguments|returns?|signature|hook|api|endpoint|pricing|model id|provider|what it does|when .* useful|when to use)\b/i.test(
		query,
	);
}

export function isCodeLookupQuery(query: string): boolean {
	return (
		hasExplicitCodeSourceSignal(query) ||
		(/\b[a-z][A-Za-z0-9]+[A-Z][A-Za-z0-9]*\b/.test(query) && !hasApiReferenceShapeSignal(query))
	);
}

export function detectResearchQueryIntent(query: string): ResearchQueryIntent {
	const hasDocsSignal = /\b(api|docs?|documentation|reference|manual|guide|spec|tutorial)\b/i.test(query);
	const hasApiSignal = hasApiReferenceShapeSignal(query);
	const hasStrongCurrentEventSignal = /\b(news|incident|leak|announcement|security advisory|outage|breach)\b/i.test(
		query,
	);
	const hasWeakCurrentSignal = /\b(latest|recent|today|current|update|released?|\d{4})\b/i.test(query);
	if (hasStrongCurrentEventSignal || (hasWeakCurrentSignal && !hasDocsSignal && !hasApiSignal)) {
		return "current_events";
	}
	if ((hasDocsSignal || hasApiSignal) && !hasExplicitCodeSourceSignal(query)) {
		return "docs_reference";
	}
	if (isCodeLookupQuery(query)) return "code_lookup";
	if (hasDocsSignal) {
		return "docs_reference";
	}
	return "general";
}

export function shouldUseRichResearchFetch(query: string, intent: ResearchQueryIntent): boolean {
	if (intent === "current_events") return true;
	return /\b(research|summari[sz]e|everything|surrounding|comprehensive|deep dive|investigate)\b/i.test(query);
}

export function rememberResearchUrlHints(
	urls: string[],
	hint: ResearchUrlHint | ((url: string) => ResearchUrlHint),
): void {
	const timestamp = Date.now();
	for (const url of urls) {
		urlHints.set(url, { hint: typeof hint === "function" ? hint(url) : hint, timestamp });
	}
}

export function getResearchUrlHint(url: string): ResearchUrlHint | undefined {
	const cached = urlHints.get(url);
	if (!cached) return undefined;
	if (Date.now() - cached.timestamp >= URL_HINT_TTL_MS) {
		urlHints.delete(url);
		return undefined;
	}
	return cached.hint;
}

export function rememberResearchFetchOutcome(url: string, status: "rich" | "thin" | "placeholder"): void {
	fetchOutcomeHints.set(url, { status, timestamp: Date.now() });
}

export function getResearchFetchOutcome(url: string): "rich" | "thin" | "placeholder" | undefined {
	const cached = fetchOutcomeHints.get(url);
	if (!cached) return undefined;
	if (Date.now() - cached.timestamp >= URL_HINT_TTL_MS) {
		fetchOutcomeHints.delete(url);
		return undefined;
	}
	return cached.status;
}

export function resetResearchHintMemoryForTests(): void {
	urlHints.clear();
	fetchOutcomeHints.clear();
}

export function getEffectiveFetchCompressionProfile(
	baseProfile: ResearchCompressionProfile,
	hint: ResearchUrlHint | undefined,
): ResearchCompressionProfile {
	if (!hint?.richFetch) {
		return baseProfile;
	}
	return {
		...baseProfile,
		fetchTranscriptFacts: Math.min(baseProfile.fetchTranscriptFacts + 2, 6),
		fetchTranscriptPreviewLines: Math.min(baseProfile.fetchTranscriptPreviewLines + 2, 6),
		fetchTranscriptLineChars: Math.min(baseProfile.fetchTranscriptLineChars + 20, 220),
	};
}
