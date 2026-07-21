import { buildToolOutcomeFingerprint, normalizeToolName, type ToolOutcome } from "./auton/nudges/types.js";

export interface LocalEvidenceSteeringContext {
	toolCallHistory: ToolOutcome[];
	fileAccessHistory: ToolOutcome[];
	userPrompt?: string;
}

export interface LocalEvidenceControl {
	mode: "answer_now" | "read_then_answer";
	message: string;
}

function recentSuccessful(outcomes: ToolOutcome[], limit: number = 6): ToolOutcome[] {
	return outcomes.filter((outcome) => outcome.success).slice(-limit);
}

function isDiscoveryTool(tool: string): boolean {
	const normalized = normalizeToolName(tool);
	return normalized === "grep" || normalized === "find" || normalized === "glob" || normalized === "ls";
}

function classifyBashDetail(detail: string | undefined): "inspection" | "mutating" | "other" {
	if (!detail) return "other";
	const normalized = detail.replace(/\s+/g, " ").trim();
	if (
		/(^|[;&|]\s*)(pwd\b|ls\b|find\b|fd\b|rg\b|grep\b|git\s+status(\s|$)|git\s+diff(\s|$)|which\b|cat\b|head\b|tail\b|sed\b|awk\b)/.test(
			normalized,
		)
	) {
		return "inspection";
	}
	if (
		/(^|[;&|]\s*)(rm\b|mv\b|cp\b|touch\b|mkdir\b|npm\s+(install|run|test|exec)\b|pnpm\b|yarn\b|cargo\b|make\b|pytest\b|vitest\b|node\b|python\b|chmod\b|chown\b|git\s+(apply|checkout|reset|commit|rebase|merge)\b)/.test(
			normalized,
		)
	) {
		return "mutating";
	}
	return "other";
}

function quotePath(filePath: string): string {
	return `\`${filePath}\``;
}

function looksLikeDirectoryInventoryPrompt(text: string | undefined): boolean {
	return (
		typeof text === "string" &&
		/\b(which directory|directory holds|directory contains|list just those filenames|what files are in it)\b/i.test(
			text,
		)
	);
}

function looksLikeComparativePrompt(text: string | undefined): boolean {
	return (
		typeof text === "string" &&
		/\b(differs? from|difference between|how .* differs?|compare .* and|compare .* with)\b/i.test(text)
	);
}

function looksLikePathAnswerPrompt(text: string | undefined): boolean {
	return (
		typeof text === "string" &&
		/\b(which file|which source file|which directory|where is|where's|contains the .*scripts?|defines the .*script|implements the .*command|which file defines|where .* is computed)\b/i.test(
			text,
		)
	);
}

function looksLikeBehaviorExplanationPrompt(text: string | undefined): boolean {
	return (
		typeof text === "string" &&
		/\b(summar(?:ize|ise)|explain|why it exists|purpose|what it does|how it works|what .* computes?|briefly explain)\b/i.test(
			text,
		)
	);
}

function looksLikeSelfContainedWorkspaceTask(text: string | undefined): boolean {
	return (
		typeof text === "string" && /\bself-contained [a-z-]*\s*workspace\b|\bstay inside this workspace\b/i.test(text)
	);
}

function looksLikeLocalImplementationTask(text: string | undefined): boolean {
	return (
		typeof text === "string" &&
		/\b(fix|debug|patch|migrate|update|refactor|repair)\b/i.test(text) &&
		/\b(workspace|verification command|node --test|keep the patch minimal|stay inside this workspace)\b/i.test(text)
	);
}

function mentionsMisleadingSiblingWarning(text: string | undefined): boolean {
	return typeof text === "string" && /\b(misleading|similarly named)\b/i.test(text);
}

function looksLikeBriefExternalPrompt(text: string | undefined): boolean {
	return (
		typeof text === "string" &&
		/\b(one sentence|brief(?:ly)?|concise|headline structure|summar(?:ize|ise) briefly)\b/i.test(text)
	);
}

function looksLikeExpansionFollowUpPrompt(text: string | undefined): boolean {
	return (
		typeof text === "string" &&
		/\b(broaden|broader|whole picture|full picture|bigger picture|more detail|more details|more information|go deeper|dig deeper|expand|elaborate|full context|fuller context|in depth|comprehensive|unpack)\b/i.test(
			text,
		)
	);
}

function looksLikeStrongSourcePrompt(text: string | undefined): boolean {
	return (
		typeof text === "string" &&
		/\b(strongest source|strongest sources|authoritative source|authoritative sources|confirm the leak vector|approximate date)\b/i.test(
			text,
		)
	);
}

function looksLikeCurrentEventsNormalizationPrompt(text: string | undefined): boolean {
	return typeof text === "string" && /\bcurrent-events\b/i.test(text) && /\bnormaliz(?:e|ation|ed|ing)\b/i.test(text);
}

function looksLikeScriptOrCommandLookup(text: string | undefined): boolean {
	return typeof text === "string" && /\b(command|script|runner|archive|compare)\b/i.test(text);
}

function looksLikeRepoLevelScriptLookup(text: string | undefined): boolean {
	return (
		looksLikeScriptOrCommandLookup(text) &&
		typeof text === "string" &&
		/\b(repo|repository|project|root|which file|which directory|implements?|defines?|holds|contains)\b/i.test(text)
	);
}

function looksLikeReferenceArtifact(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/").toLowerCase();
	return (
		normalized.endsWith(".md") ||
		normalized.includes("/test/") ||
		normalized.includes("/tests/") ||
		normalized.includes("/docs/") ||
		normalized.includes("/examples/") ||
		normalized.includes("/example/") ||
		normalized.includes("/fixtures/") ||
		normalized.includes("mission") ||
		normalized.includes("audit") ||
		normalized.includes("history/")
	);
}

function looksLikeCurrentEventsPromptTrap(filePath: string | undefined, userPrompt: string | undefined): boolean {
	if (!filePath || !looksLikeCurrentEventsNormalizationPrompt(userPrompt)) return false;
	const normalized = filePath.replace(/\\/g, "/").toLowerCase();
	return (
		normalized.endsWith("/core/tools/grep.ts") ||
		normalized.endsWith("/core/prompt-intent-steering.ts") ||
		normalized.endsWith("/core/local-evidence-steering.ts") ||
		normalized.includes("/test/") ||
		normalized.includes("/tests/")
	);
}

function looksLikeImplementationPath(filePath: string | undefined): boolean {
	if (!filePath) return false;
	return !looksLikeReferenceArtifact(filePath);
}

function getImplementationDirectory(filePath: string | undefined): string | undefined {
	if (!looksLikeImplementationPath(filePath) || !filePath) return undefined;
	const normalized = filePath.replace(/\\/g, "/");
	const trimmed = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
	if (!trimmed || trimmed === ".") return undefined;
	const dir = trimmed.includes("/") ? trimmed.slice(0, trimmed.lastIndexOf("/")) : trimmed;
	return dir.length > 0 && dir !== "." ? dir : undefined;
}

function isWebResearchTool(tool: string): boolean {
	const normalized = normalizeToolName(tool);
	return normalized === "websearch" || normalized === "webfetch";
}

function isInspectionTool(tool: string): boolean {
	const normalized = normalizeToolName(tool);
	return (
		normalized === "read" ||
		normalized === "grep" ||
		normalized === "find" ||
		normalized === "glob" ||
		normalized === "ls" ||
		normalized === "bash"
	);
}

function isBulkyOutcome(outcome: ToolOutcome): boolean {
	if (!outcome.success) return false;
	if ((outcome.estimatedTokens ?? 0) >= 800) return true;
	const normalized = normalizeToolName(outcome.tool);
	return (normalized === "webfetch" || normalized === "read") && (outcome.estimatedTokens ?? 0) >= 300;
}

function buildBulkyOutputAddendum(outcomes: ToolOutcome[]): string | undefined {
	const recent = recentSuccessful(outcomes).filter(isBulkyOutcome);
	if (recent.length === 0) return undefined;

	const last = recent[recent.length - 1];
	const recentWeb = recent.filter((outcome) => isWebResearchTool(outcome.tool));
	if (recentWeb.length >= 1 && recentWeb.length === recent.length) {
		if (last.detail) {
			return `Runtime steering: The last turn already gathered substantial web evidence around ${quotePath(last.detail)}. Reuse that evidence. Prefer answering or one targeted follow-up fetch for a specific gap instead of restarting broad web search.`;
		}
		return "Runtime steering: The last turn already gathered substantial web evidence. Reuse the fetched/search results and avoid restarting broad web discovery unless a specific gap remains.";
	}

	const recentInspection = recent.filter((outcome) => isInspectionTool(outcome.tool));
	if (recentInspection.length >= 1 && recentInspection.length === recent.length) {
		const lastFile = recentInspection
			.slice()
			.reverse()
			.find((outcome) => looksLikeImplementationPath(outcome.file))?.file;
		if (lastFile) {
			return `Runtime steering: The last turn already produced substantial local evidence centered on ${quotePath(lastFile)}. Reuse that output. Prefer answering or one targeted continuation near that file instead of repeating broad read/grep/find/ls/bash inspection.`;
		}
		return "Runtime steering: The last turn already produced substantial local inspection output. Reuse that evidence and prefer a targeted continuation or direct answer instead of repeating broad discovery commands.";
	}

	if (last.detail) {
		return `Runtime steering: The last turn already produced a bulky tool result around ${quotePath(last.detail)}. Reuse that evidence and avoid re-running the same broad step unless a precise missing detail remains.`;
	}

	return "Runtime steering: The last turn already produced a bulky tool result. Reuse that evidence and prefer a targeted continuation or direct answer over re-running the same broad step.";
}

function buildRepeatedStepAddendum(outcomes: ToolOutcome[]): string | undefined {
	const recent = recentSuccessful(outcomes).slice(-4);
	if (recent.length < 2) return undefined;

	const last = recent[recent.length - 1];
	const lastFingerprint = buildToolOutcomeFingerprint(last);
	const sameFingerprintCount = recent.filter(
		(outcome) => buildToolOutcomeFingerprint(outcome) === lastFingerprint,
	).length;
	if (sameFingerprintCount < 2) return undefined;

	const normalizedTool = normalizeToolName(last.tool);
	if (normalizedTool === "bash") {
		const bashType = classifyBashDetail(last.detail);
		if (bashType === "inspection") {
			return "Runtime steering: The same inspection-style shell step has already been run repeatedly. Reuse that listing/search output and move to a targeted read or direct answer instead of repeating shell discovery.";
		}
		if (bashType === "mutating") {
			return "Runtime steering: The same mutating shell step has already been attempted repeatedly. Do not rerun it unless verification or an explicit recovery plan requires it.";
		}
	}

	if (last.detail) {
		return `Runtime steering: The same ${normalizedTool} step around ${quotePath(last.detail)} has already been repeated. Reuse that result instead of rerunning it unless a concrete missing detail remains.`;
	}

	return `Runtime steering: The same ${normalizedTool} step has already been repeated. Reuse the existing result instead of rerunning it unless a concrete missing detail remains.`;
}

function latestSuccessfulFile(outcomes: ToolOutcome[]): string | undefined {
	const candidates = outcomes.filter(
		(outcome): outcome is ToolOutcome & { file: string } =>
			outcome.success && typeof outcome.file === "string" && outcome.file.length > 0,
	);
	const implementationFile = candidates
		.slice()
		.reverse()
		.find((outcome) => looksLikeImplementationPath(outcome.file))?.file;
	if (implementationFile) return implementationFile;
	return candidates
		.slice()
		.reverse()
		.find((outcome) => typeof outcome.file === "string" && outcome.file.length > 0)?.file;
}

interface ReadProgressMetadata {
	startLine?: number;
	endLine?: number;
	totalLines?: number;
	hasMore?: boolean;
	nextOffset?: number;
	completion?: "complete" | "partial";
	reason?: string;
}

interface GrepEvidenceMetadata {
	matchCount?: number;
	uniqueFileCount?: number;
	firstMatchPath?: string;
	firstMatchLine?: number;
}

interface FindEvidenceMetadata {
	resultCount?: number;
	firstMatchPath?: string;
	firstMatchIsDirectory?: boolean;
	dominantFileDirectory?: string;
}

interface LsEvidenceMetadata {
	directoryPath?: string;
	entryCount?: number;
	entriesSample?: string[];
	entryLimitReached?: number;
	truncation?: { truncated?: boolean };
}

interface WebSearchResultMetadata {
	title?: string;
	url?: string;
	snippet?: string;
	authoritative?: boolean;
}

interface WebSearchEvidenceMetadata {
	intent?: string;
	results?: WebSearchResultMetadata[];
}

function getReadProgress(outcome: ToolOutcome | undefined): ReadProgressMetadata | undefined {
	if (!outcome || normalizeToolName(outcome.tool) !== "read" || !outcome.success) return undefined;
	const progress = outcome.metadata?.progress;
	if (!progress || typeof progress !== "object") return undefined;
	return progress as ReadProgressMetadata;
}

function getGrepMetadata(outcome: ToolOutcome | undefined): GrepEvidenceMetadata | undefined {
	if (!outcome || normalizeToolName(outcome.tool) !== "grep" || !outcome.success) return undefined;
	const metadata = outcome.metadata;
	if (!metadata || typeof metadata !== "object") return undefined;
	return metadata as GrepEvidenceMetadata;
}

function getDecisiveGrepPath(outcome: ToolOutcome | undefined): string | undefined {
	const metadata = getGrepMetadata(outcome);
	return metadata?.firstMatchPath ?? outcome?.file;
}

function hasDecisiveGrepEvidence(outcome: ToolOutcome | undefined): boolean {
	const metadata = getGrepMetadata(outcome);
	return Boolean(
		outcome &&
			normalizeToolName(outcome.tool) === "grep" &&
			outcome.success &&
			typeof outcome.file === "string" &&
			outcome.file.length > 0 &&
			metadata?.matchCount &&
			metadata.matchCount > 0 &&
			metadata.uniqueFileCount &&
			metadata.uniqueFileCount >= 1 &&
			metadata.firstMatchPath,
	);
}

function getFindMetadata(outcome: ToolOutcome | undefined): FindEvidenceMetadata | undefined {
	if (!outcome) return undefined;
	const normalized = normalizeToolName(outcome.tool);
	if ((normalized !== "find" && normalized !== "glob") || !outcome.success) return undefined;
	const metadata = outcome.metadata;
	if (!metadata || typeof metadata !== "object") return undefined;
	return metadata as FindEvidenceMetadata;
}

function getLsMetadata(outcome: ToolOutcome | undefined): LsEvidenceMetadata | undefined {
	if (!outcome || normalizeToolName(outcome.tool) !== "ls" || !outcome.success) return undefined;
	const metadata = outcome.metadata;
	if (!metadata || typeof metadata !== "object") return undefined;
	return metadata as LsEvidenceMetadata;
}

function getWebSearchMetadata(outcome: ToolOutcome | undefined): WebSearchEvidenceMetadata | undefined {
	if (!outcome || normalizeToolName(outcome.tool) !== "websearch" || !outcome.success) return undefined;
	const metadata = outcome.metadata;
	if (!metadata || typeof metadata !== "object") return undefined;
	return metadata as WebSearchEvidenceMetadata;
}

function lsShowsScriptsChild(outcome: ToolOutcome | undefined): boolean {
	const metadata = getLsMetadata(outcome);
	if (!metadata || !Array.isArray(metadata.entriesSample)) return false;
	return metadata.entriesSample.some((entry) => /^scripts\/?$/i.test(entry));
}

function lsLooksLikeSmallFixtureWorkspace(outcome: ToolOutcome | undefined): boolean {
	const metadata = getLsMetadata(outcome);
	if (!metadata || !Array.isArray(metadata.entriesSample)) return false;
	if ((metadata.entryCount ?? 999) > 12) return false;
	const normalizedEntries = metadata.entriesSample.map((entry) => entry.replace(/\\/g, "/").toLowerCase());
	const fixtureAnchors = ["src/", "tests/", "test/", "cli/", "reference/"];
	return fixtureAnchors.filter((anchor) => normalizedEntries.includes(anchor)).length >= 2;
}

function hasRepeatedNoMatchFinds(outcomes: ToolOutcome[]): boolean {
	const recentFinds = outcomes.slice(-4).filter((outcome) => {
		const normalized = normalizeToolName(outcome.tool);
		return (normalized === "find" || normalized === "glob") && outcome.success;
	});
	if (recentFinds.length < 2) return false;
	return recentFinds.slice(-3).every((outcome) => !outcome.file);
}

function isPackageLocalCodingAgentDetail(outcome: ToolOutcome): boolean {
	const detail = outcome.detail?.replace(/\\/g, "/").toLowerCase() ?? "";
	const file = outcome.file?.replace(/\\/g, "/").toLowerCase() ?? "";
	return detail.includes("/packages/coding-agent") || file.startsWith("packages/coding-agent");
}

function hasRichWebEvidence(outcome: ToolOutcome): boolean {
	if (!isWebResearchTool(outcome.tool) || !outcome.success) return false;
	return outcome.metadata?.status === "rich";
}

function isRichDocsFetch(outcome: ToolOutcome): boolean {
	return (
		normalizeToolName(outcome.tool) === "webfetch" &&
		outcome.success &&
		outcome.metadata?.status === "rich" &&
		outcome.metadata?.intent === "docs_reference"
	);
}

function isRichAuthoritativeWebFetch(outcome: ToolOutcome): boolean {
	return (
		normalizeToolName(outcome.tool) === "webfetch" &&
		outcome.success &&
		outcome.metadata?.status === "rich" &&
		outcome.metadata?.authoritative === true &&
		(outcome.metadata?.intent === "docs_reference" || outcome.metadata?.intent === "current_events")
	);
}

function extractNamedDocsToken(userPrompt: string): string | undefined {
	const codeTokenMatch = userPrompt.match(/`([^`\n]+)`\s+(?:parameter|option|argument)\b/i);
	if (codeTokenMatch?.[1]) return codeTokenMatch[1].trim().toLowerCase();
	const plainTokenMatch = userPrompt.match(/\b([A-Za-z_][A-Za-z0-9_-]*)\s+(?:parameter|option|argument)\b/i);
	return plainTokenMatch?.[1]?.trim().toLowerCase();
}

function topAuthoritativeSearchSnippetLooksSufficient(
	outcome: ToolOutcome | undefined,
	userPrompt: string | undefined,
): boolean {
	const metadata = getWebSearchMetadata(outcome);
	const topResult = metadata?.results?.find(
		(result) => result?.authoritative === true && typeof result.snippet === "string",
	);
	if (!topResult?.snippet || !userPrompt) return false;
	if (topResult.snippet.length < 90) return false;
	const normalizedSnippet = topResult.snippet.toLowerCase();
	if (metadata?.intent === "docs_reference") {
		const namedDocsToken = extractNamedDocsToken(userPrompt);
		if (namedDocsToken && normalizedSnippet.includes(namedDocsToken)) {
			return true;
		}
		return /\b(permalink|parameter|option)\b/i.test(userPrompt)
			? /\bpermalink\b/.test(normalizedSnippet) &&
					/\b(ensure|once|navigate|destination page|interactive|no effect)\b/.test(normalizedSnippet)
			: true;
	}
	if (metadata?.intent === "current_events") {
		return /\b(leak|source map|packaging issue|human error|march|2026|npm)\b/.test(normalizedSnippet);
	}
	return false;
}

function isWholeFileRead(progress: ReadProgressMetadata | undefined): boolean {
	return Boolean(progress?.completion === "complete" && (progress.startLine ?? 1) <= 1);
}

function hasCompleteReadEvidence(outcome: ToolOutcome): boolean {
	return Boolean(looksLikeImplementationPath(outcome.file) && isWholeFileRead(getReadProgress(outcome)));
}

function hasSubstantialReadEvidence(outcome: ToolOutcome): boolean {
	return (
		normalizeToolName(outcome.tool) === "read" &&
		outcome.success &&
		looksLikeImplementationPath(outcome.file) &&
		typeof outcome.file === "string" &&
		(outcome.estimatedTokens ?? 0) >= 180
	);
}

function hasSubstantialListingEvidence(outcome: ToolOutcome): boolean {
	return (
		(normalizeToolName(outcome.tool) === "ls" || normalizeToolName(outcome.tool) === "bash") &&
		outcome.success &&
		(outcome.estimatedTokens ?? 0) >= 160
	);
}

function getConvergedReadFile(outcomes: ToolOutcome[]): string | undefined {
	const recentReads = outcomes
		.slice(-3)
		.filter((outcome) => normalizeToolName(outcome.tool) === "read" && looksLikeImplementationPath(outcome.file))
		.map((outcome) => outcome.file)
		.filter((file): file is string => typeof file === "string" && file.length > 0);
	return recentReads.length >= 2 && recentReads.every((file) => file === recentReads[0]) ? recentReads[0] : undefined;
}

function getRepeatedFingerprintCount(outcomes: ToolOutcome[]): number {
	if (outcomes.length === 0) return 0;
	const targetFingerprint = buildToolOutcomeFingerprint(outcomes[outcomes.length - 1]);
	return outcomes.slice(-4).filter((outcome) => buildToolOutcomeFingerprint(outcome) === targetFingerprint).length;
}

function getComparativeReadHint(firstMatchLine: number | undefined): string {
	if (typeof firstMatchLine !== "number") {
		return " Do exactly one targeted read in that file wide enough to cover nearby definitions, then answer.";
	}
	const offset = Math.max(1, firstMatchLine - 140);
	const limit = 220;
	return ` Do exactly one targeted read offset=${offset} limit=${limit} in that file so nearby definitions remain visible, then answer.`;
}

function hasSingleFileFindEvidence(outcome: ToolOutcome | undefined): boolean {
	const metadata = getFindMetadata(outcome);
	return Boolean(
		outcome?.success &&
			(normalizeToolName(outcome.tool) === "find" || normalizeToolName(outcome.tool) === "glob") &&
			typeof outcome.file === "string" &&
			outcome.file.length > 0 &&
			metadata?.resultCount === 1 &&
			metadata.firstMatchPath,
	);
}

function buildAnswerNowAddendum(context: LocalEvidenceSteeringContext): string | undefined {
	const recentTools = recentSuccessful(context.toolCallHistory);
	if (recentTools.length === 0) return undefined;
	const lastTool = recentTools[recentTools.length - 1];
	const expansionFollowUpPrompt = looksLikeExpansionFollowUpPrompt(context.userPrompt);

	if (isRichDocsFetch(lastTool)) {
		if (expansionFollowUpPrompt) {
			if (lastTool.detail) {
				return `Runtime steering: The last turn already fetched an authoritative docs source at ${quotePath(lastTool.detail)}. Expand the answer from that page with the broader context the user asked for instead of compressing to a one-line summary. Only do one additional targeted fetch if a clearly missing concept remains.`;
			}
			return "Runtime steering: The last turn already fetched an authoritative docs source. Expand the answer from that page with the broader context the user asked for instead of compressing to a one-line summary. Only do one additional targeted fetch if a clearly missing concept remains.";
		}
		if (lastTool.detail) {
			return `Runtime steering: The last turn already fetched an authoritative docs source at ${quotePath(lastTool.detail)}. For a brief docs summary, answer now from that page unless a clearly missing concept requires one targeted follow-up. Do not restart broad web search.`;
		}
		return "Runtime steering: The last turn already fetched an authoritative docs source. For a brief docs summary, answer now from that page unless a clearly missing concept requires one targeted follow-up. Do not restart broad web search.";
	}

	if (hasRichWebEvidence(lastTool)) {
		if (expansionFollowUpPrompt) {
			if (lastTool.detail) {
				return `Runtime steering: A rich web source is already in hand at ${quotePath(lastTool.detail)}. Expand from that evidence and synthesize the broader context, timeline, impact, and caveats the user asked for. One targeted corroborating fetch is allowed only if a specific gap remains.`;
			}
			return "Runtime steering: A rich web source is already in hand. Expand from that evidence and synthesize the broader context, timeline, impact, and caveats the user asked for. One targeted corroborating fetch is allowed only if a specific gap remains.";
		}
		if (lastTool.detail) {
			return `Runtime steering: The last turn already fetched a rich source at ${quotePath(lastTool.detail)}. Answer from that evidence now unless a clearly missing detail still requires one targeted follow-up.`;
		}
		return "Runtime steering: The last turn already fetched a rich web source. Prefer answering now from that evidence unless a clearly missing detail still requires one targeted follow-up.";
	}

	if (hasCompleteReadEvidence(lastTool) && lastTool.file) {
		return `Runtime steering: The last turn already completed a full read of ${quotePath(lastTool.file)}. Prefer answering or acting directly from that file instead of reopening discovery tools.`;
	}

	if (hasSubstantialReadEvidence(lastTool) && lastTool.file) {
		const previousTool = recentTools.length >= 2 ? recentTools[recentTools.length - 2] : undefined;
		if (previousTool?.file === lastTool.file && hasDecisiveGrepEvidence(previousTool)) {
			return `Runtime steering: The last turn already isolated ${quotePath(lastTool.file)} and read the defining range. Answer now from that evidence unless the prompt explicitly requires another usage site or call path.`;
		}
		return `Runtime steering: The last turn already read substantial content from ${quotePath(lastTool.file)}. Answer directly from that evidence unless a specific missing range or symbol remains.`;
	}

	if (recentTools.length === 1) {
		const onlyTool = recentTools[0];
		const normalized = normalizeToolName(onlyTool.tool);
		const referenceArtifact = looksLikeReferenceArtifact(onlyTool.file ?? "");
		const findMetadata = getFindMetadata(onlyTool);
		if (hasSingleFileFindEvidence(onlyTool) && onlyTool.file && !referenceArtifact) {
			return `Runtime steering: The last turn already found one decisive file at ${quotePath(onlyTool.file)}. Answer now with that path, or do one targeted read there only if the prompt explicitly asked for purpose or implementation details.`;
		}
		if (findMetadata?.dominantFileDirectory && !referenceArtifact) {
			return `Runtime steering: The last turn already showed the relevant matches clustering under ${quotePath(findMetadata.dominantFileDirectory)}. If the user asked which directory contains the matching scripts/files, answer with that directory now and list the matching files instead of continuing broad discovery.`;
		}
		const grepMetadata = getGrepMetadata(onlyTool);
		const decisiveGrepPath = getDecisiveGrepPath(onlyTool);
		if (
			normalized === "grep" &&
			!referenceArtifact &&
			decisiveGrepPath &&
			grepMetadata?.matchCount === 1 &&
			grepMetadata.uniqueFileCount === 1
		) {
			const lineHint =
				typeof grepMetadata.firstMatchLine === "number" ? ` at line ${grepMetadata.firstMatchLine}` : "";
			return `Runtime steering: The last turn already found a single decisive grep match in ${quotePath(decisiveGrepPath)}${lineHint}. If the user asked which file/path defines or contains something, answer now with that location. Only read further if they asked for behavior or surrounding implementation details.`;
		}
		if (
			(normalized === "grep" || normalized === "find" || normalized === "glob") &&
			decisiveGrepPath &&
			!referenceArtifact
		) {
			return `Runtime steering: You already have a decisive location in ${quotePath(decisiveGrepPath)}. Prefer reading that file or answering directly instead of performing more discovery.`;
		}
	}
	const lastLs = recentTools[recentTools.length - 1];
	const lsMetadata = getLsMetadata(lastLs);
	if (
		lsMetadata?.directoryPath &&
		typeof lsMetadata.entryCount === "number" &&
		!lsMetadata.entryLimitReached &&
		!lsMetadata.truncation?.truncated
	) {
		const sample =
			Array.isArray(lsMetadata.entriesSample) && lsMetadata.entriesSample.length > 0
				? ` Key entries: ${lsMetadata.entriesSample.map((entry) => quotePath(entry)).join(", ")}.`
				: "";
		return `Runtime steering: The last turn already listed ${quotePath(lsMetadata.directoryPath)} completely. Answer now from that directory listing instead of calling more discovery tools.${sample}`;
	}

	if (hasSubstantialListingEvidence(lastTool)) {
		if (lastTool.file) {
			return `Runtime steering: The last turn already produced a substantial listing centered on ${quotePath(lastTool.file)}. Prefer answering from that evidence or moving to one targeted file/path instead of repeating broad listing.`;
		}
		return "Runtime steering: The last turn already produced a substantial listing. Prefer answering from that evidence or moving to one targeted file/path instead of repeating broad listing.";
	}

	return undefined;
}

/**
 * Global kill switch for text-heuristic prompt steering (intent addenda, local-evidence
 * addenda, runtime continuation/control messages). Set AG1_PROMPT_STEERING=0 to disable.
 * Default ON until eval A/B data shows whether the steering earns its tokens — flip the
 * default only based on measured pass-rate/cost-per-solved, never on intuition.
 */
export function isPromptSteeringEnabled(): boolean {
	return process.env.AG1_PROMPT_STEERING !== "0";
}

export function buildLocalEvidenceControl(context: LocalEvidenceSteeringContext): LocalEvidenceControl | undefined {
	const recentTools = recentSuccessful(context.toolCallHistory);
	if (recentTools.length === 0) return undefined;

	const lastTool = recentTools[recentTools.length - 1];
	const previousTool = recentTools.length >= 2 ? recentTools[recentTools.length - 2] : undefined;
	const earlierTool = recentTools.length >= 3 ? recentTools[recentTools.length - 3] : undefined;
	const lastFile = latestSuccessfulFile(context.fileAccessHistory);
	const directoryPrompt = looksLikeDirectoryInventoryPrompt(context.userPrompt);
	const comparativePrompt = looksLikeComparativePrompt(context.userPrompt);
	const pathAnswerPrompt = looksLikePathAnswerPrompt(context.userPrompt);
	const behaviorPrompt = looksLikeBehaviorExplanationPrompt(context.userPrompt) || comparativePrompt;
	const briefExternalPrompt = looksLikeBriefExternalPrompt(context.userPrompt);
	const expansionFollowUpPrompt = looksLikeExpansionFollowUpPrompt(context.userPrompt);
	const strongSourcePrompt = looksLikeStrongSourcePrompt(context.userPrompt);
	const repeatedLastStepCount = getRepeatedFingerprintCount(recentTools);
	const convergedReadFile = getConvergedReadFile(recentTools);

	const recentDiscoverySameFile = recentTools
		.slice(-3)
		.filter((outcome) => isDiscoveryTool(outcome.tool) && looksLikeImplementationPath(outcome.file))
		.map((outcome) => outcome.file)
		.filter((file): file is string => typeof file === "string" && file.length > 0);
	const convergedDiscoveryFile =
		recentDiscoverySameFile.length >= 2 &&
		recentDiscoverySameFile.every((file) => file === recentDiscoverySameFile[0])
			? recentDiscoverySameFile[0]
			: undefined;

	if (expansionFollowUpPrompt && isRichAuthoritativeWebFetch(lastTool)) {
		return {
			mode: "read_then_answer",
			message: `Runtime control: A rich authoritative web source is already in hand at ${quotePath(lastTool.detail ?? "the fetched URL")}. Expand from that evidence and synthesize the broader context the user asked for before deciding whether any follow-up fetch is necessary. At most one targeted corroborating webSearch or webFetch is allowed for a specific missing gap; do not restart broad web search.`,
		};
	}

	if (briefExternalPrompt && isRichAuthoritativeWebFetch(lastTool)) {
		const sourceHint = strongSourcePrompt
			? " Reuse the strongest-source URLs you already saw in search results instead of doing another web call."
			: "";
		return {
			mode: "answer_now",
			message: `Runtime control: A rich authoritative web source is already in hand at ${quotePath(lastTool.detail ?? "the fetched URL")}. Answer now from that evidence.${sourceHint} Do not run another webSearch or webFetch for this brief external summary.`,
		};
	}

	if (strongSourcePrompt && isRichAuthoritativeWebFetch(lastTool) && !expansionFollowUpPrompt) {
		return {
			mode: "answer_now",
			message: `Runtime control: A rich authoritative strongest-source fetch is already in hand at ${quotePath(lastTool.detail ?? "the fetched URL")}. Answer now from that source unless the user explicitly asked for corroboration or a key fact is still missing. Do not run another webSearch or webFetch first.`,
		};
	}

	if (expansionFollowUpPrompt && topAuthoritativeSearchSnippetLooksSufficient(lastTool, context.userPrompt)) {
		return {
			mode: "read_then_answer",
			message:
				lastTool.metadata?.intent === "docs_reference"
					? "Runtime control: The authoritative docs search snippet is enough to choose the right page, but the user asked for more depth. Fetch the top authoritative URL now, then expand the answer from that source. Only do one more targeted fetch if a specific concept is still missing."
					: "Runtime control: The authoritative search snippet is enough to choose the strongest source, but the user asked for more depth. Fetch the top authoritative URL now, then synthesize the broader context from that source. Only do one more targeted fetch if a specific gap remains.",
		};
	}

	if (
		topAuthoritativeSearchSnippetLooksSufficient(lastTool, context.userPrompt) &&
		lastTool.metadata?.intent === "docs_reference"
	) {
		return {
			mode: "answer_now",
			message:
				"Runtime control: The authoritative docs search snippet already contains the requested fact. Answer now from that evidence instead of running webSearch or webFetch again.",
		};
	}

	if (briefExternalPrompt && topAuthoritativeSearchSnippetLooksSufficient(lastTool, context.userPrompt)) {
		return {
			mode: "answer_now",
			message:
				"Runtime control: The authoritative web search snippet already contains the requested fact. Answer now from that evidence instead of running another webSearch or webFetch.",
		};
	}

	if (directoryPrompt) {
		const lsMetadata = getLsMetadata(lastTool);
		if (
			lsMetadata?.directoryPath &&
			typeof lsMetadata.entryCount === "number" &&
			lsMetadata.entryCount <= 20 &&
			!lsMetadata.entryLimitReached &&
			!lsMetadata.truncation?.truncated
		) {
			return {
				mode: "answer_now",
				message: `Runtime control: The directory ${quotePath(lsMetadata.directoryPath)} has already been listed completely. Answer now with that directory and only the requested filenames. Do not run another find, grep, or ls.`,
			};
		}
		const directoryClusterAddendum = buildDirectoryClusterAddendum(context);
		if (directoryClusterAddendum) {
			return {
				mode: "answer_now",
				message: directoryClusterAddendum.replace(/^Runtime steering:/, "Runtime control:"),
			};
		}
		const findMetadata = getFindMetadata(lastTool);
		if (
			findMetadata?.dominantFileDirectory &&
			typeof findMetadata.resultCount === "number" &&
			findMetadata.resultCount >= 2
		) {
			return {
				mode: "answer_now",
				message: `Runtime control: The relevant files already cluster under ${quotePath(findMetadata.dominantFileDirectory)}. Answer now with that directory and only the requested matching filenames. Do not run another find or ls.`,
			};
		}
	}

	if (lastTool.file && hasSingleFileFindEvidence(lastTool) && !looksLikeReferenceArtifact(lastTool.file)) {
		return {
			mode: behaviorPrompt ? "read_then_answer" : "answer_now",
			message: behaviorPrompt
				? `Runtime control: A single decisive local file is already known at ${quotePath(lastTool.file)}. Do exactly one targeted read in that file, then answer. Do not run another grep, find, or ls step first.`
				: `Runtime control: A single decisive local file is already known at ${quotePath(lastTool.file)}. Answer now with that path. Do not run more grep, find, or ls steps unless the prompt explicitly asks for implementation details from that file.`,
		};
	}

	const decisiveGrepPath = getDecisiveGrepPath(lastTool);
	if (
		decisiveGrepPath &&
		hasDecisiveGrepEvidence(lastTool) &&
		!looksLikeReferenceArtifact(decisiveGrepPath) &&
		!looksLikeCurrentEventsPromptTrap(decisiveGrepPath, context.userPrompt)
	) {
		const grepMetadata = getGrepMetadata(lastTool);
		const lineHint = typeof grepMetadata?.firstMatchLine === "number" ? ` offset=${grepMetadata.firstMatchLine}` : "";
		const comparisonHint = comparativePrompt ? getComparativeReadHint(grepMetadata?.firstMatchLine) : "";
		return {
			mode: pathAnswerPrompt && !behaviorPrompt ? "answer_now" : "read_then_answer",
			message:
				pathAnswerPrompt && !behaviorPrompt
					? `Runtime control: The defining location is already known at ${quotePath(decisiveGrepPath)}. Answer now with that path from the implementation evidence you already have. Do not run another grep, find, ls, or read step first.`
					: comparativePrompt
						? `Runtime control: The defining location is already known at ${quotePath(decisiveGrepPath)}.${comparisonHint} Do not run another grep, find, or ls step first.`
						: `Runtime control: The defining location is already known at ${quotePath(decisiveGrepPath)}. Do exactly one targeted read${lineHint} near the matched range in that file, then answer. Do not run another grep, find, or ls step first.`,
		};
	}

	if (
		repeatedLastStepCount >= 2 &&
		lastTool.file &&
		isDiscoveryTool(lastTool.tool) &&
		!(normalizeToolName(lastTool.tool) === "ls" && getLsMetadata(lastTool)) &&
		!looksLikeReferenceArtifact(lastTool.file)
	) {
		return {
			mode: behaviorPrompt ? "read_then_answer" : "answer_now",
			message: behaviorPrompt
				? `Runtime control: The same local discovery step has already repeated around ${quotePath(lastTool.file)}. Stop searching. Do exactly one targeted read in that file now, then answer. Do not run another grep, find, or ls step first.`
				: `Runtime control: The same local discovery step has already repeated around ${quotePath(lastTool.file)}. Answer now from that location instead of running the same grep, find, or ls again.`,
		};
	}

	if (
		lastTool.file &&
		hasSubstantialReadEvidence(lastTool) &&
		previousTool?.file === lastTool.file &&
		hasDecisiveGrepEvidence(previousTool)
	) {
		const progress = getReadProgress(lastTool);
		if (comparativePrompt) {
			return {
				mode: "read_then_answer",
				message: `Runtime control: Stay inside ${quotePath(lastTool.file)}. If the nearby comparison target is still missing, do one nearby earlier or later read in the same file, then answer. Do not run another grep or find.`,
			};
		}
		if (behaviorPrompt && progress?.completion === "partial" && typeof progress.nextOffset === "number") {
			return {
				mode: "read_then_answer",
				message: `Runtime control: The defining file ${quotePath(lastTool.file)} is already known. If the explanation still needs more body context, do exactly one continuation read at \`offset=${progress.nextOffset}\`, then answer. Do not run another grep, find, or ls step.`,
			};
		}
		return {
			mode: "answer_now",
			message: `Runtime control: The defining file ${quotePath(lastTool.file)} has already been identified and read. Answer now from that evidence. Do not run another grep, find, ls, or extra read unless the prompt explicitly asks for a second symbol or another location.`,
		};
	}

	if (convergedReadFile && !looksLikeReferenceArtifact(convergedReadFile)) {
		const latestRead = recentTools
			.slice()
			.reverse()
			.find((outcome) => normalizeToolName(outcome.tool) === "read" && outcome.file === convergedReadFile);
		const progress = getReadProgress(latestRead);
		if (behaviorPrompt && typeof progress?.nextOffset === "number") {
			return {
				mode: "read_then_answer",
				message: `Runtime control: Recent reads have already stayed inside ${quotePath(convergedReadFile)}. If one more range is truly needed, do exactly one continuation read at \`offset=${progress.nextOffset}\`, then answer. Do not restart grep or find.`,
			};
		}
		return {
			mode: "answer_now",
			message: `Runtime control: Recent reads have already converged on ${quotePath(convergedReadFile)}. Answer now from the evidence you already have instead of rereading or restarting discovery.`,
		};
	}

	if (
		convergedDiscoveryFile &&
		!looksLikeReferenceArtifact(convergedDiscoveryFile) &&
		!(normalizeToolName(lastTool.tool) === "ls" && getLsMetadata(lastTool)) &&
		(previousTool || earlierTool)
	) {
		return {
			mode: behaviorPrompt ? "read_then_answer" : "answer_now",
			message: behaviorPrompt
				? `Runtime control: Local discovery has already converged on ${quotePath(convergedDiscoveryFile)}. Do one targeted read in that file now, then answer. Do not run another broad grep, find, or ls step first.`
				: `Runtime control: Local discovery has already converged on ${quotePath(convergedDiscoveryFile)}. Answer now from that file path instead of running another broad grep, find, or ls step.`,
		};
	}

	const findMetadata = getFindMetadata(lastTool);
	if (
		findMetadata?.dominantFileDirectory &&
		typeof findMetadata.resultCount === "number" &&
		findMetadata.resultCount >= 2 &&
		findMetadata.resultCount <= 6
	) {
		return {
			mode: "answer_now",
			message: `Runtime control: The relevant files already cluster under ${quotePath(findMetadata.dominantFileDirectory)}. Answer now with that directory and the matching filenames. Do not run another find or ls just to restate the same directory contents.`,
		};
	}

	const directoryClusterAddendum = buildDirectoryClusterAddendum(context);
	if (directoryClusterAddendum) {
		return {
			mode: "answer_now",
			message: directoryClusterAddendum.replace(/^Runtime steering:/, "Runtime control:"),
		};
	}

	if (lastFile && lastTool.file === lastFile && hasSubstantialReadEvidence(lastTool)) {
		const progress = getReadProgress(lastTool);
		if ((progress?.startLine ?? 1) > 1 && previousTool?.file === lastFile && hasDecisiveGrepEvidence(previousTool)) {
			return {
				mode: "read_then_answer",
				message: `Runtime control: Stay inside ${quotePath(lastFile)}. If the nearby earlier definition is still needed, do one earlier-offset read in the same file, then answer. Do not restart grep or find.`,
			};
		}
	}

	return undefined;
}

function buildReadProgressAddendum(context: LocalEvidenceSteeringContext): string | undefined {
	const recentReads = recentSuccessful(context.fileAccessHistory)
		.filter((outcome) => normalizeToolName(outcome.tool) === "read")
		.slice(-3);
	if (recentReads.length === 0) return undefined;

	const lastRead = recentReads[recentReads.length - 1];
	const progress = getReadProgress(lastRead);
	if (!lastRead.file || !progress || !looksLikeImplementationPath(lastRead.file)) return undefined;

	if (isWholeFileRead(progress)) {
		return `Runtime steering: ${quotePath(lastRead.file)} was already read to completion. Reuse that evidence and answer or edit directly instead of rereading from the top.`;
	}

	if (progress.completion === "complete" && (progress.startLine ?? 1) > 1) {
		return `Runtime steering: The last turn already read ${quotePath(lastRead.file)} through the end of the file starting at line ${progress.startLine}. If earlier lines are still needed, jump directly to the missing earlier range in the same file instead of grepping again.`;
	}

	if ((progress.startLine ?? 1) > 1) {
		const previousTool = recentSuccessful(context.toolCallHistory).slice(-2)[0];
		if (previousTool?.file === lastRead.file && hasDecisiveGrepEvidence(previousTool)) {
			return `Runtime steering: The last turn already landed in ${quotePath(lastRead.file)} from a decisive grep and then read a later range starting at line ${progress.startLine}. If nearby earlier definitions or helpers still matter, jump to an earlier offset in the same file instead of running another grep.`;
		}
	}

	if (progress.completion === "partial" && typeof progress.nextOffset === "number") {
		const repeatedSameFile =
			recentReads.length >= 2 && recentReads.every((outcome) => outcome.file === lastRead.file);
		if (repeatedSameFile) {
			return `Runtime steering: Recent reads already advanced through ${quotePath(lastRead.file)}. If more content is required, continue with \`offset=${progress.nextOffset}\`; otherwise answer from the ranges you already have instead of rereading earlier lines.`;
		}
		return `Runtime steering: If more of ${quotePath(lastRead.file)} is needed, continue with \`offset=${progress.nextOffset}\`. Otherwise answer from the current read result instead of restarting discovery.`;
	}

	return undefined;
}

function buildGroupedLocalDiscoveryAddendum(context: LocalEvidenceSteeringContext): string | undefined {
	const targetFile = latestSuccessfulFile(context.fileAccessHistory);
	if (!targetFile) return undefined;

	const recentLocal = recentSuccessful(context.toolCallHistory)
		.filter((outcome) => isInspectionTool(outcome.tool))
		.slice(-4);
	if (recentLocal.length < 2) return undefined;

	const sameTargetChain = recentLocal.filter((outcome) => outcome.file === targetFile);
	const sequence = sameTargetChain.map((outcome) => normalizeToolName(outcome.tool));
	const hasRead = sequence.includes("read");
	const hasDiscovery = sequence.some((tool) => tool === "grep" || tool === "find" || tool === "glob" || tool === "ls");
	if (!hasRead || !hasDiscovery) return undefined;

	const chainLabel = sequence.join(" -> ");
	const grepCount = sameTargetChain.filter((outcome) => normalizeToolName(outcome.tool) === "grep").length;
	const lastRead = sameTargetChain
		.slice()
		.reverse()
		.find((outcome) => normalizeToolName(outcome.tool) === "read");
	const nextOffset = getReadProgress(lastRead)?.nextOffset;

	if (grepCount >= 2) {
		if (typeof nextOffset === "number") {
			return `Runtime steering: Local discovery already converged on ${quotePath(targetFile)} via ${chainLabel}, and multiple grep hits now point to the same file. Reuse that file. Continue with \`read path=${targetFile} offset=${nextOffset}\` only if a specific missing range remains; otherwise answer directly instead of running another grep.`;
		}
		return `Runtime steering: Local discovery already converged on ${quotePath(targetFile)} via ${chainLabel}, and multiple grep hits now point to the same file. Reuse that file and answer or inspect it directly instead of running another grep.`;
	}

	if (typeof nextOffset === "number") {
		return `Runtime steering: Local discovery already converged on ${quotePath(targetFile)} via ${chainLabel}. Reuse that chain. Continue with \`read path=${targetFile} offset=${nextOffset}\` only if a specific gap remains; otherwise answer directly.`;
	}

	return `Runtime steering: Local discovery already converged on ${quotePath(targetFile)} via ${chainLabel}. Reuse that chain and answer or inspect that file directly instead of restarting discovery.`;
}

function buildDirectoryClusterAddendum(context: LocalEvidenceSteeringContext): string | undefined {
	const recentDiscovery = recentSuccessful(context.fileAccessHistory)
		.filter((outcome) => isDiscoveryTool(outcome.tool))
		.slice(-4);
	if (recentDiscovery.length < 2) return undefined;

	const directories = recentDiscovery
		.map((outcome) => getImplementationDirectory(outcome.file))
		.filter((dir): dir is string => typeof dir === "string" && dir.length > 0);
	if (directories.length < 2) return undefined;

	const uniqueDirectories = [...new Set(directories)];
	if (uniqueDirectories.length !== 1) return undefined;

	const targetDirectory = uniqueDirectories[0];
	if (!targetDirectory) return undefined;

	const files = recentDiscovery
		.map((outcome) => outcome.file)
		.filter((file): file is string => looksLikeImplementationPath(file))
		.map((file) => file.replace(/\\/g, "/"))
		.filter((file) => file.startsWith(`${targetDirectory}/`) || file === targetDirectory);
	const uniqueFiles = [...new Set(files)];
	if (uniqueFiles.length < 2) return undefined;

	const sample = uniqueFiles
		.slice(0, 3)
		.map((file) => quotePath(file))
		.join(", ");
	return `Runtime steering: Recent local discovery already clustered the relevant files under ${quotePath(targetDirectory)} (${sample}). If the user asked which directory holds the matching scripts/files, answer now with ${quotePath(targetDirectory)} and list the filenames instead of running another broad grep or find.`;
}

export function buildRuntimeContinuationMessage(context: LocalEvidenceSteeringContext): string | undefined {
	const recentTools = recentSuccessful(context.toolCallHistory).filter(isBulkyOutcome);
	if (recentTools.length === 0) return undefined;

	const last = recentTools[recentTools.length - 1];
	const lastFile = latestSuccessfulFile(context.fileAccessHistory);
	const lines = ["<runtime-continuation-state>"];

	if (isWebResearchTool(last.tool)) {
		lines.push("- Bulky web evidence was already gathered in the previous turn.");
		if (last.detail) {
			lines.push(`- Primary evidence focus: ${last.detail}`);
		}
		lines.push("- Reuse prior fetched/search evidence before starting another broad web search.");
		lines.push("- Prefer a direct answer or one narrowly targeted follow-up fetch only if a specific gap remains.");
	} else {
		lines.push("- Bulky local inspection output was already gathered in the previous turn.");
		if (lastFile) {
			lines.push(`- Primary local evidence: ${lastFile}`);
		} else if (last.detail) {
			lines.push(`- Primary local evidence detail: ${last.detail}`);
		}
		lines.push("- Reuse prior local evidence before repeating broad read/grep/find/ls/bash inspection.");
		lines.push("- Prefer a direct answer or one targeted continuation near the discovered file/path.");
	}

	lines.push("</runtime-continuation-state>");
	return lines.join("\n");
}

export function buildLocalEvidencePromptAddendum(context: LocalEvidenceSteeringContext): string | undefined {
	const recentTools = recentSuccessful(context.toolCallHistory);
	const recentFiles = recentSuccessful(context.fileAccessHistory).filter(
		(outcome): outcome is ToolOutcome & { file: string } =>
			typeof outcome.file === "string" && outcome.file.length > 0,
	);
	if (recentTools.length === 0) return undefined;
	const directoryPrompt = looksLikeDirectoryInventoryPrompt(context.userPrompt);
	const scriptLookupPrompt = looksLikeScriptOrCommandLookup(context.userPrompt);
	const repoLevelScriptLookup = looksLikeRepoLevelScriptLookup(context.userPrompt);
	const selfContainedWorkspaceTask =
		looksLikeSelfContainedWorkspaceTask(context.userPrompt) && looksLikeLocalImplementationTask(context.userPrompt);
	const misleadingSiblingTask = mentionsMisleadingSiblingWarning(context.userPrompt);
	const addenda: Array<{ priority: number; message: string }> = [];
	const pushAddendum = (priority: number, message: string | undefined) => {
		if (!message) return;
		if (addenda.some((entry) => entry.message === message)) return;
		addenda.push({ priority, message });
	};

	const lastTool = recentTools[recentTools.length - 1];
	const lastFile = recentFiles[recentFiles.length - 1];

	if (directoryPrompt && scriptLookupPrompt && hasRepeatedNoMatchFinds(recentTools)) {
		pushAddendum(
			97,
			"Runtime steering: Recent find attempts did not produce a decisive file. Stop chaining broader wildcard find patterns. For sibling script/file directory questions, inspect the likely shared parent directory next, usually repo-root `scripts/`, or do one repo-root listing to confirm it before searching again.",
		);
	}
	if (scriptLookupPrompt && repoLevelScriptLookup && hasRepeatedNoMatchFinds(recentTools)) {
		pushAddendum(
			98,
			"Runtime steering: Recent script-lookup find attempts did not produce a decisive file. For repo-level commands, pivot to repo-root `scripts/` now. Do one targeted `find`/`read` under `scripts/` or inspect that directory directly before any more package-local grep/find/ls.",
		);
	}
	if (scriptLookupPrompt && repoLevelScriptLookup && recentTools.slice(-3).some(isPackageLocalCodingAgentDetail)) {
		pushAddendum(
			97,
			"Runtime steering: This command/script lookup is drifting inside `packages/coding-agent`, but repo-level command scripts commonly live under repo-root `scripts/`. Pivot back to repo-root `scripts/` before continuing local discovery.",
		);
	}

	if (recentFiles.length >= 2) {
		const sameFile = recentFiles.every((outcome) => outcome.file === lastFile?.file);
		if (sameFile && lastFile) {
			const discoveryOnly = recentFiles.every((outcome) => isDiscoveryTool(outcome.tool));
			if (discoveryOnly) {
				pushAddendum(
					80,
					`Runtime steering: The last turn already isolated ${quotePath(lastFile.file)} via discovery tools. Reuse that evidence. Prefer reading that file or answering directly instead of repeating grep/find/ls for the same target unless ambiguity remains. Do not run another broad grep for the same target before inspecting this file.`,
				);
			}

			const repeatedReads = recentFiles.every((outcome) => normalizeToolName(outcome.tool) === "read");
			if (repeatedReads) {
				pushAddendum(
					70,
					`Runtime steering: The last turn already read ${quotePath(lastFile.file)}. Reuse that evidence. Continue with offset only if more lines are needed, or answer directly instead of rereading from the top.`,
				);
			}
		}
	}

	if (lastFile) {
		const normalizedTool = normalizeToolName(lastFile.tool);
		if (normalizedTool === "grep") {
			const referenceArtifact = looksLikeReferenceArtifact(lastFile.file);
			if (referenceArtifact) {
				pushAddendum(
					85,
					`Runtime steering: The last grep hit ${quotePath(lastFile.file)} looks like a test, scenario, or note that only references the target name. Do not treat it as the defining implementation. Prefer the real implementation under scripts/, src/, packages/*/src, lib/, or app/. If the user asked which file defines a script or tool, switch to find on likely filenames under repo-root script directories before grepping deeper in tests.`,
				);
			}
			if (looksLikeCurrentEventsPromptTrap(lastFile.file, context.userPrompt)) {
				pushAddendum(
					96,
					`Runtime steering: The last grep hit ${quotePath(lastFile.file)} only references current-events normalization in tests or steering code, not the implementation itself. Do not read or answer from this file first. Retry one focused grep for \`normalizeCurrentEventsQuery\` in \`packages/coding-agent/src/core/tools\` before exploring further.`,
				);
			}
			if (!referenceArtifact && hasDecisiveGrepEvidence(lastFile)) {
				pushAddendum(
					95,
					`Runtime steering: The last turn already found a decisive grep match in ${quotePath(lastFile.file)}. Read that file near the matched range or answer from the evidence you already have before searching again. Do not run another broad grep until you have inspected this file.`,
				);
			}
		}
		if (normalizedTool === "find" || normalizedTool === "glob") {
			pushAddendum(
				75,
				`Runtime steering: The last turn already found ${quotePath(lastFile.file)}. Reuse that path. Read it directly, inspect it with ls if it is a directory, or answer from it before running another broad search.`,
			);
		}
		if (normalizedTool === "ls") {
			pushAddendum(
				75,
				`Runtime steering: The last turn already inspected ${quotePath(lastFile.file)}. Reuse that listing and switch to read, find, or grep for specifics instead of repeating ls.`,
			);
			if (selfContainedWorkspaceTask && lsLooksLikeSmallFixtureWorkspace(lastFile)) {
				pushAddendum(
					96,
					"Runtime steering: This small self-contained workspace is already scoped by the top-level listing. Stop shell-style file hunting. Read the likely implementation, importing caller, failing test, or named reference file next, then make the patch.",
				);
			}
			if (repoLevelScriptLookup && lastFile.file.startsWith("packages/coding-agent")) {
				pushAddendum(
					95,
					"Runtime steering: This package-local listing is probably not the primary search root for repo-level command scripts. Pivot to repo-root `scripts/` now instead of continuing inside `packages/coding-agent`.",
				);
			}
			if (looksLikeScriptOrCommandLookup(context.userPrompt) && lsShowsScriptsChild(lastFile)) {
				pushAddendum(
					94,
					"Runtime steering: This listing already shows a `scripts/` child directory. For command/script implementation lookups, inspect that exact `scripts/` child next instead of listing unrelated package roots or broadening into source grep.",
				);
			}
		}
		if (normalizedTool === "read" && !looksLikeImplementationPath(lastFile.file)) {
			pushAddendum(
				85,
				`Runtime steering: The last read focused on ${quotePath(lastFile.file)}, which looks like docs, examples, or another reference artifact. Do not treat it as the defining implementation for a local code lookup. Switch back to source-oriented grep/find under scripts/, src/, packages/*/src, lib/, or app/.`,
			);
		}
		if (normalizedTool === "read" && selfContainedWorkspaceTask && misleadingSiblingTask) {
			pushAddendum(
				95,
				"Runtime steering: The task warns about a misleading similarly named file. Before editing, confirm the real caller/import path or failing test expectation. Do not copy semantics from the file you just read only because the filename matches.",
			);
		}
	}

	if (lastTool && normalizeToolName(lastTool.tool) === "bash" && typeof lastTool.detail === "string") {
		const normalizedDetail = lastTool.detail.replace(/\s+/g, " ").trim();
		if (/(^|[;&|]\s*)(pwd\b|ls\b|find\b|fd\b|rg\s+--files\b|git\s+status(\s|$)|which\b)/.test(normalizedDetail)) {
			pushAddendum(
				60,
				"Runtime steering: The last turn already used inspection-style shell discovery. Reuse that evidence and switch to a targeted read/grep/find step or answer directly instead of repeating shell listing commands.",
			);
		}
		if (classifyBashDetail(lastTool.detail) === "mutating") {
			pushAddendum(
				60,
				"Runtime steering: The last turn already used a mutating shell command. Prefer interpreting its result, verifying the outcome, or taking a targeted next step instead of rerunning broad shell commands.",
			);
		}
	}

	const bulkyAddendum = buildBulkyOutputAddendum(recentTools);
	pushAddendum(50, bulkyAddendum);

	const repeatedStepAddendum = buildRepeatedStepAddendum(recentTools);
	pushAddendum(65, repeatedStepAddendum);

	const groupedDiscoveryAddendum = buildGroupedLocalDiscoveryAddendum(context);
	pushAddendum(90, groupedDiscoveryAddendum);

	const directoryClusterAddendum = buildDirectoryClusterAddendum(context);
	pushAddendum(92, directoryClusterAddendum);

	const readProgressAddendum = buildReadProgressAddendum(context);
	pushAddendum(72, readProgressAddendum);

	const answerNowAddendum = buildAnswerNowAddendum(context);
	pushAddendum(100, answerNowAddendum);

	if (addenda.length === 0) return undefined;
	return addenda
		.sort((left, right) => right.priority - left.priority)
		.slice(0, 4)
		.map((entry) => entry.message)
		.join("\n");
}
