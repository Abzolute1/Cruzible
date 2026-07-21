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
	coverage?: ResearchCoverageAssessment;
}

export type ResearchCoverageKind = "current_events" | "docs" | "pricing" | "release" | "error";
export type ResearchCoverageSlot =
	| "date"
	| "actor"
	| "mechanism"
	| "impact"
	| "response"
	| "signature"
	| "parameter"
	| "behavior"
	| "example"
	| "version"
	| "model"
	| "input_price"
	| "output_price"
	| "currency"
	| "effective_date"
	| "changes"
	| "migration_notes"
	| "exact_error"
	| "cause"
	| "fix"
	| "affected_version";

export interface ResearchCoverageAssessment {
	kind?: ResearchCoverageKind;
	present: ResearchCoverageSlot[];
	missing: ResearchCoverageSlot[];
	score: number;
}

const CURRENT_EVENTS_COVERAGE_SLOTS: Array<{ slot: ResearchCoverageSlot; pattern: RegExp }> = [
	{
		slot: "date",
		pattern:
			/\b(?:20\d{2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|today|yesterday|last\s+(?:week|month|year))\b/i,
	},
	{
		slot: "actor",
		pattern:
			/\b(?:anthropic|openai|google|microsoft|meta|nvidia|apple|amazon|researcher|researchers|security researcher|company|vendor|maintainer|team)\b/i,
	},
	{
		slot: "mechanism",
		pattern:
			/\b(?:via|through|caused by|because|root cause|source map|sourcemap|npm|registry|package|packaging|published|exposed|leaked|breach|incident|vulnerability|outage|advisory)\b/i,
	},
	{
		slot: "impact",
		pattern:
			/\b(?:impact|affected|exposed|revealed|risk|risks|users?|customers?|source code|credentials?|secrets?|supply chain|malware|attack|lines?|files?|internal)\b/i,
	},
	{
		slot: "response",
		pattern:
			/\b(?:confirmed|acknowledged|said|statement|responded|response|removed|pulled|fixed|patched|republished|updated|advised|recommend(?:ed)?|upgrade|mitigat(?:ed|ion))\b/i,
	},
];

const DOCS_COVERAGE_SLOTS: Array<{ slot: ResearchCoverageSlot; pattern: RegExp }> = [
	{ slot: "signature", pattern: /\b(?:signature|syntax|usage)\b|`[^`]*\([^`]*\)`|\b[A-Za-z_$][\w$]*\([^)]*\)/i },
	{
		slot: "parameter",
		pattern: /\b(?:parameter|parameters|option|options|argument|arguments|prop|props)\b|`[A-Za-z_$][\w$?]*`/i,
	},
	{
		slot: "behavior",
		pattern: /\b(?:lets you|allows you|used to|returns?|when|once|if|effect|behavior|does|will)\b/i,
	},
	{ slot: "example", pattern: /\b(?:example|for example|usage|try it|code sample)\b|```|<code\b/i },
	{
		slot: "version",
		pattern:
			/\b(?:version|since|added in|deprecated in|removed in|React\s+\d+|Node(?:\.js)?\s+v?\d+|TypeScript\s+\d+)\b/i,
	},
];

const PRICING_COVERAGE_SLOTS: Array<{ slot: ResearchCoverageSlot; pattern: RegExp }> = [
	{ slot: "model", pattern: /\b(?:model|gpt[-\w.]+|claude[-\w.]+|gemini[-\w.]+|llama[-\w.]+|nemotron[-\w.]+)\b/i },
	{ slot: "input_price", pattern: /\binput\b.{0,80}(?:\$|usd|price|cost|token)|(?:\$|usd).{0,80}\binput\b/i },
	{ slot: "output_price", pattern: /\boutput\b.{0,80}(?:\$|usd|price|cost|token)|(?:\$|usd).{0,80}\boutput\b/i },
	{ slot: "currency", pattern: /\b(?:usd|dollars?|eur|gbp)\b|\$/i },
	{
		slot: "effective_date",
		pattern:
			/\b(?:as of|effective|updated|current|20\d{2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i,
	},
];

const RELEASE_COVERAGE_SLOTS: Array<{ slot: ResearchCoverageSlot; pattern: RegExp }> = [
	{ slot: "version", pattern: /\bv?\d+\.\d+(?:\.\d+)?\b|\bversion\b/i },
	{
		slot: "date",
		pattern:
			/\b(?:20\d{2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i,
	},
	{
		slot: "changes",
		pattern: /\b(?:added|changed|fixed|removed|deprecated|improved|released|security|feature|bug fix|breaking)\b/i,
	},
	{
		slot: "migration_notes",
		pattern: /\b(?:migration|migrate|upgrade|breaking change|codemod|deprecation|compatibility)\b/i,
	},
];

const ERROR_COVERAGE_SLOTS: Array<{ slot: ResearchCoverageSlot; pattern: RegExp }> = [
	{
		slot: "exact_error",
		pattern:
			/\b(?:TypeError|ReferenceError|SyntaxError|RangeError|Error|Exception):\s*[^.!?\n]+|\b[A-Z][A-Za-z]+Error\b/i,
	},
	{ slot: "cause", pattern: /\b(?:cause|caused by|because|due to|occurs when|happens when|root cause|means that)\b/i },
	{
		slot: "fix",
		pattern: /\b(?:fix|fixed|resolve|workaround|solution|upgrade|downgrade|install|set|configure|patch)\b/i,
	},
	{
		slot: "affected_version",
		pattern: /\b(?:version|affected|Node\s+\d+|React\s+\d+|TypeScript\s+\d+|v?\d+\.\d+(?:\.\d+)?)\b/i,
	},
];

const RESEARCH_PLACEHOLDER_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /\bjust a moment\b/i, reason: "interstitial placeholder content" },
	{ pattern: /\b(enable|turn on)\s+javascript\b/i, reason: "javascript gate detected" },
	{
		pattern: /\bjavascript (?:is required|required to continue|required to view this page)\b/i,
		reason: "javascript gate detected",
	},
	{ pattern: /\bthis app works best with javascript enabled\b/i, reason: "javascript gate detected" },
	{ pattern: /\bchecking your browser\b/i, reason: "browser verification interstitial" },
	{ pattern: /\bchecking if the site connection is secure\b/i, reason: "browser verification interstitial" },
	{ pattern: /\bverify you are human\b/i, reason: "human verification interstitial" },
	{ pattern: /\bplease wait while (?:we )?verify\b/i, reason: "browser verification interstitial" },
	{ pattern: /\bcaptcha\b/i, reason: "captcha page detected" },
	{ pattern: /\baccess denied\b/i, reason: "access denied page" },
	{ pattern: /\brequest blocked\b/i, reason: "request blocked page" },
	{ pattern: /\battention required\b/i, reason: "browser verification interstitial" },
	{ pattern: /\bsecurity review\b/i, reason: "security review interstitial" },
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
	/^(?:\d+\s*)?(?:min|minute)\s+read$/i,
	/^listen to this article(?:\s*-\s*\d+:\d+)?$/i,
	/^audio ready to play$/i,
	/^write for [a-z0-9 ._-]+$/i,
	/^[a-z0-9 ._-]+ homepage$/i,
	/^feed your curiosity\.?$/i,
	/^help \d[\d,+kmb]*.*get in touch$/i,
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

function shouldDeduplicateFetchExcerpt(
	title: string | undefined,
	facts: string[] | undefined,
	preview: string,
): boolean {
	const titleText = title ?? "";
	if (/\b(api|reference|hook|hooks|component|components)\b/i.test(titleText)) return true;
	if (preview.split("\n").some((line) => /`[^`]+`/.test(line))) return true;
	if ((facts ?? []).some((fact) => /`[^`]+`/.test(fact))) return true;
	return false;
}

function buildFetchExcerpt(
	preview: string | undefined,
	title: string | undefined,
	facts: string[] | undefined,
	profile: ResearchCompressionProfile,
): string {
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

	const excerpt =
		excerptLines.length > 0
			? excerptLines.join("\n")
			: limitPreviewLines(preview, profile.fetchTranscriptPreviewLines, profile.fetchTranscriptLineChars);
	return limitPreviewLines(excerpt, profile.fetchTranscriptPreviewLines, profile.fetchTranscriptLineChars);
}

function formatCoverageGuidance(coverage: ResearchCoverageAssessment): string[] {
	const lines: string[] = [];
	const kind = coverage.kind;
	lines.push(`Coverage: ${coverage.present.length > 0 ? coverage.present.join(", ") : "none"}`);
	if (coverage.missing.length > 0) {
		lines.push(`Missing: ${coverage.missing.join(", ")}`);
		switch (kind) {
			case "docs":
				lines.push(
					"Only continue docs research for the missing API slot. If signature, parameter, and behavior are present, answer now; examples or version notes are optional unless requested.",
				);
				break;
			case "pricing":
				lines.push(
					"Continue pricing research only if model, input price, output price, or currency is missing. Prefer an official pricing page for any missing price.",
				);
				break;
			case "release":
				lines.push(
					"Continue release research only for missing version, date, change summary, or migration notes. Migration notes are required only when the user asks about upgrading or breaking changes.",
				);
				break;
			case "error":
				lines.push(
					"Answer if cause and fix are present. If either is missing, search the exact error string with the affected version or framework.",
				);
				break;
			default:
				lines.push(
					"Only continue web research for the missing coverage items, not by repeating the same broad query.",
				);
				break;
		}
	} else {
		switch (kind) {
			case "docs":
				lines.push("Coverage complete for a concise docs/API answer.");
				break;
			case "pricing":
				lines.push(
					"Coverage complete for a pricing answer. Reuse this source unless the user requested corroboration.",
				);
				break;
			case "release":
				lines.push("Coverage complete for a release/changelog answer.");
				break;
			case "error":
				lines.push("Coverage complete for an error-cause-and-fix answer.");
				break;
			default:
				lines.push("Coverage complete for a brief current-events answer.");
				break;
		}
	}
	return lines;
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

function normalizeFocusTerms(focusTerms: string[] | undefined): string[] {
	if (!Array.isArray(focusTerms) || focusTerms.length === 0) return [];
	return Array.from(new Set(focusTerms.map((term) => term.trim().toLowerCase()).filter((term) => term.length >= 3)));
}

function scoreFocusMatch(line: string, focusTerms: string[]): number {
	if (focusTerms.length === 0) return 0;
	const normalized = line.toLowerCase();
	let score = 0;
	for (const term of focusTerms) {
		if (normalized.includes(term)) score += 1;
	}
	if (/\b(when|ensure|once|if|because|rather than|so that|lets you|used to|useful)\b/.test(normalized)) {
		score += 1;
	}
	return score;
}

type RankedResearchLine = {
	line: string;
	index: number;
	focusScore: number;
};

function collectRankedResearchLines(markdown: string, focusTerms: string[] | undefined): RankedResearchLine[] {
	const rankedLines: RankedResearchLine[] = [];
	const seen = new Set<string>();
	const normalizedFocusTerms = normalizeFocusTerms(focusTerms);

	for (const [index, rawLine] of markdown.split("\n").entries()) {
		const line = cleanResearchLine(rawLine);
		if (!line) continue;
		if (isResearchNoiseLine(line)) continue;
		if (isDocumentationChromeLine(line)) continue;
		if (isLowValueDocsPreviewLine(line)) continue;
		const normalized = line.toLowerCase();
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		rankedLines.push({
			line,
			index,
			focusScore: scoreFocusMatch(line, normalizedFocusTerms),
		});
	}
	return rankedLines;
}

export function buildResearchPreview(
	markdown: string,
	maxLines: number,
	maxLineChars: number,
	focusTerms?: string[],
): string {
	const previewLines = collectRankedResearchLines(markdown, focusTerms)
		.sort((left, right) => right.focusScore - left.focusScore || left.index - right.index)
		.slice(0, maxLines)
		.map((entry) => (entry.line.length > maxLineChars ? `${entry.line.slice(0, maxLineChars - 1)}...` : entry.line));

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
	intent?: string;
	coverageKind?: ResearchCoverageKind;
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
	const coverage = assessResearchCoverage(combined, {
		intent: options.intent,
		coverageKind: options.coverageKind,
	});

	for (const entry of RESEARCH_PLACEHOLDER_PATTERNS) {
		if (entry.pattern.test(combined)) {
			return {
				status: "placeholder",
				reason: entry.reason,
				coverage,
			};
		}
	}

	const placeholderLikeLines = combined
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.filter((line) => RESEARCH_PLACEHOLDER_PATTERNS.some((entry) => entry.pattern.test(line))).length;
	const informativeLines = combined
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length >= 40 && !isResearchNoiseLine(line)).length;
	if (placeholderLikeLines >= 2 && informativeLines === 0) {
		return {
			status: "placeholder",
			reason: "interstitial or app-shell content without usable article text",
			coverage,
		};
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
	const codeLikeRatio =
		contentLines.length > 0 ? contentLines.filter((line) => isCodeLikeLine(line)).length / contentLines.length : 0;
	const factCount = (options.facts ?? []).length;
	const compactLength = combined.replace(/\s+/g, " ").trim().length;
	const proseFactCount = (options.facts ?? []).filter((fact) => !isCodeLikeLine(fact)).length;

	if (
		((codeLikePreviewLines >= Math.max(2, previewLines.length - 1) && previewLines.length > 0) ||
			codeLikeRatio >= 0.6) &&
		proseFactCount < 2
	) {
		return {
			status: "thin",
			reason: "code-heavy extract without enough supporting explanation",
			coverage,
		};
	}

	if (factCount >= 2 || informativePreviewLines >= 3 || (compactLength >= 700 && proseFactCount >= 1)) {
		return {
			status: "rich",
			coverage,
		};
	}

	return {
		status: "thin",
		reason: "limited article text extracted",
		coverage,
	};
}

export function assessCurrentEventsCoverage(text: string): ResearchCoverageAssessment {
	return assessCoverageSlots(text, CURRENT_EVENTS_COVERAGE_SLOTS);
}

function inferResearchCoverageKind(text: string, intent?: string): ResearchCoverageKind | undefined {
	if (intent === "current_events") return "current_events";
	const normalized = text.replace(/\s+/g, " ").trim();
	if (/\b(?:pricing|price|cost|input price|output price|per\s+(?:1m|million|token)|billing)\b/i.test(normalized)) {
		return "pricing";
	}
	if (/\b(?:changelog|release notes?|released|migration|breaking changes?|upgrade guide)\b/i.test(normalized)) {
		return "release";
	}
	if (
		/\b(?:TypeError|ReferenceError|SyntaxError|RangeError|Error|Exception):\s*[^.!?]+|\btraceback\b|\bworkaround\b/i.test(
			normalized,
		)
	) {
		return "error";
	}
	if (intent === "docs_reference") return "docs";
	return undefined;
}

export function assessResearchCoverage(
	text: string,
	options?: { intent?: string; coverageKind?: ResearchCoverageKind },
): ResearchCoverageAssessment | undefined {
	const kind = options?.coverageKind ?? inferResearchCoverageKind(text, options?.intent);
	if (!kind) return undefined;
	switch (kind) {
		case "current_events":
			return assessCoverageSlots(text, CURRENT_EVENTS_COVERAGE_SLOTS, kind);
		case "docs":
			return assessCoverageSlots(text, DOCS_COVERAGE_SLOTS, kind);
		case "pricing":
			return assessCoverageSlots(text, PRICING_COVERAGE_SLOTS, kind);
		case "release":
			return assessCoverageSlots(text, RELEASE_COVERAGE_SLOTS, kind);
		case "error":
			return assessCoverageSlots(text, ERROR_COVERAGE_SLOTS, kind);
	}
}

function assessCoverageSlots(
	text: string,
	slots: Array<{ slot: ResearchCoverageSlot; pattern: RegExp }>,
	kind?: ResearchCoverageKind,
): ResearchCoverageAssessment {
	const normalized = text.replace(/\s+/g, " ").trim();
	const present: ResearchCoverageSlot[] = [];
	for (const entry of slots) {
		if (entry.pattern.test(normalized)) {
			present.push(entry.slot);
		}
	}
	const presentSet = new Set(present);
	const missing = slots.map((entry) => entry.slot).filter((slot) => !presentSet.has(slot));
	return {
		...(kind ? { kind } : {}),
		present,
		missing,
		score: present.length,
	};
}

export function extractResearchFacts(
	markdown: string,
	maxFacts: number,
	maxChars: number,
	focusTerms?: string[],
): string[] {
	if (maxFacts <= 0) return [];
	const facts: Array<{ text: string; focusScore: number; index: number }> = [];
	const seen = new Set<string>();
	const normalizedFocusTerms = normalizeFocusTerms(focusTerms);
	const lines = markdown
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	for (const [index, line] of lines.entries()) {
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
		facts.push({
			text: candidate,
			focusScore: scoreFocusMatch(candidate, normalizedFocusTerms),
			index,
		});
	}

	return facts
		.sort((left, right) => right.focusScore - left.focusScore || left.index - right.index)
		.slice(0, maxFacts)
		.map((fact) => fact.text);
}

export function formatSearchTranscriptContent(
	query: string,
	results: ResearchResultSummary[],
	profile: ResearchCompressionProfile,
	options?: {
		intent?: string;
		preferCorroboration?: boolean;
		originalQuery?: string;
		searchStrategy?: string;
		followUpQueries?: string[];
	},
): string {
	const topAuthoritativeResult = results[0]?.authoritative === true ? results[0] : undefined;
	const docsParameterLikeQuery =
		/\b(parameter|parameters|option|options|argument|arguments|returns?|signature|hook|api|what it does|when .* useful)\b/i.test(
			query,
		);
	const docsSingleSource = options?.intent === "docs_reference" && topAuthoritativeResult && docsParameterLikeQuery;
	const displayedResults = results.slice(0, docsSingleSource ? 1 : profile.searchTranscriptResults);
	const lines = [`Web search: ${query}`];
	if (options?.originalQuery && options.originalQuery.trim() !== query.trim()) {
		lines.push(`Rewritten from: ${options.originalQuery.trim()}`);
	}
	if (options?.searchStrategy) {
		lines.push(`Search strategy: ${options.searchStrategy}`);
	}

	if (displayedResults.length === 0) {
		lines.push("No results found.");
		if (options?.followUpQueries?.length) {
			lines.push(`Try a narrower query next: ${options.followUpQueries[0]}`);
		}
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
		if (options?.intent === "docs_reference" && displayedResults[0]?.authoritative) {
			if (!docsSingleSource) {
				lines.push(`Only if a key concept is still missing, next step: webFetch ${displayedResults[0].url}`);
			} else {
				lines.push("Only if a key concept is still missing, fetch the top authoritative URL above.");
			}
		} else {
			lines.push(`Next step: webFetch ${displayedResults[0].url}`);
		}
		if (options?.intent === "current_events") {
			if (options.preferCorroboration) {
				lines.push(
					"Fetch the strongest source first. Only fetch one independent corroborating source if the first source is blocked, thin, or still leaves a key fact missing.",
				);
			} else {
				lines.push(
					"Fetch one strongest source first. Do not fetch multiple sources in parallel unless the first source is blocked, thin, or clearly missing a key fact.",
				);
			}
			lines.push(
				"For a brief current-events summary, if the first fetched source is rich and specific, answer from it directly. Treat the other top search results as corroborating candidates unless a key fact still needs confirmation.",
			);
			if (options.followUpQueries?.length) {
				lines.push(
					`If the first source is blocked or thin, do not repeat this broad search. Use a narrower follow-up query such as: ${options.followUpQueries[0]}`,
				);
			}
		}
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
	intent?: string;
	authoritative?: boolean;
	coverage?: ResearchCoverageAssessment;
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
		lines.push(
			`Summary: ${truncateResearchSnippet(options.metaDescription, options.profile.fetchTranscriptLineChars)}`,
		);
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
		if (options.intent === "current_events" && options.authoritative === true) {
			lines.push(
				"This authoritative current-events source is likely sufficient for a brief summary. Answer from it now unless the user explicitly asked for corroboration or a key fact is still missing.",
			);
			lines.push(
				"If the user asked for the strongest source, this fetch is enough. Reuse this source directly instead of fetching another article first.",
			);
		} else if (options.intent === "current_events" && options.authoritative !== true) {
			lines.push(
				"This source summary is usable as a fallback, but corroborate with an authoritative or independent source before treating it as final.",
			);
		} else if (options.intent === "docs_reference" && options.authoritative === true) {
			lines.push(
				"This authoritative docs page is likely sufficient for a brief API or parameter answer. Do not refetch the same URL unless the requested concept is still missing.",
			);
		} else {
			lines.push("This source summary is likely sufficient to answer or cite without refetching.");
		}
	} else if (options.truncated || options.profile.mode !== "normal") {
		lines.push("This fetch was compacted to preserve context.");
	}

	if (options.coverage) {
		lines.push(...formatCoverageGuidance(options.coverage));
	}

	return lines.join("\n");
}
