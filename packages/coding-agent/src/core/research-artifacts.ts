import type { SessionEntry } from "./session-manager.js";

export const RESEARCH_ARTIFACT_ENTRY_TYPE = "research_artifact";
const MAX_FETCH_ARTIFACT_CHARS = 12_000;

export interface ResearchArtifactSnapshot {
	version: 1;
	savedAt: string;
	kind: "search" | "fetch";
	query?: string;
	url?: string;
	title?: string;
	contentType?: string;
	compressionMode?: string;
	cacheHit?: boolean;
	resultCount?: number;
	sourceUrls?: string[];
	results?: Array<{ title?: string; url?: string; snippet?: string }>;
	facts?: string[];
	preview?: string;
	contentExcerpt?: string;
	truncated?: boolean;
}

export function createResearchArtifactSnapshot(
	artifact: Omit<ResearchArtifactSnapshot, "version" | "savedAt" | "contentExcerpt"> & { contentExcerpt?: string },
): ResearchArtifactSnapshot {
	return {
		version: 1,
		savedAt: new Date().toISOString(),
		...artifact,
		contentExcerpt:
			typeof artifact.contentExcerpt === "string"
				? artifact.contentExcerpt.slice(0, MAX_FETCH_ARTIFACT_CHARS)
				: undefined,
	};
}

export function appendResearchArtifact(
	ctx: { appendEntry?: (customType: string, data?: unknown) => void } | undefined,
	artifact: Omit<ResearchArtifactSnapshot, "version" | "savedAt">,
): void {
	if (!ctx?.appendEntry) return;
	ctx.appendEntry(RESEARCH_ARTIFACT_ENTRY_TYPE, createResearchArtifactSnapshot(artifact));
}

export function appendResearchArtifactFromToolResult(
	sessionManager: { appendCustomEntry: (customType: string, data?: unknown) => string },
	toolName: string,
	details: unknown,
): boolean {
	const artifact = createResearchArtifactFromToolResult(toolName, details);
	if (!artifact) return false;
	sessionManager.appendCustomEntry(RESEARCH_ARTIFACT_ENTRY_TYPE, createResearchArtifactSnapshot(artifact));
	return true;
}

export function getRecentResearchArtifacts(entries: SessionEntry[], limit = 5): ResearchArtifactSnapshot[] {
	const artifacts: ResearchArtifactSnapshot[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== RESEARCH_ARTIFACT_ENTRY_TYPE) continue;
		if (!isResearchArtifactSnapshot(entry.data)) continue;
		artifacts.push(entry.data);
		if (artifacts.length >= limit) break;
	}
	return artifacts.reverse();
}

function isResearchArtifactSnapshot(value: unknown): value is ResearchArtifactSnapshot {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ResearchArtifactSnapshot>;
	return candidate.version === 1 && typeof candidate.savedAt === "string" && typeof candidate.kind === "string";
}

function createResearchArtifactFromToolResult(
	toolName: string,
	details: unknown,
): Omit<ResearchArtifactSnapshot, "version" | "savedAt"> | undefined {
	if (!details || typeof details !== "object") return undefined;
	const candidate = details as Record<string, unknown>;
	const normalizedTool = toolName.toLowerCase();

	if (normalizedTool === "websearch") {
		const query = typeof candidate.query === "string" ? candidate.query : undefined;
		const results = Array.isArray(candidate.results)
			? candidate.results.flatMap((result) => {
					if (!result || typeof result !== "object") return [];
					const entry = result as Record<string, unknown>;
					return [
						{
							title: typeof entry.title === "string" ? entry.title : undefined,
							url: typeof entry.url === "string" ? entry.url : undefined,
							snippet: typeof entry.snippet === "string" ? entry.snippet : undefined,
						},
					];
				})
			: undefined;
		const sourceUrls = Array.isArray(candidate.sourceUrls)
			? candidate.sourceUrls.filter((value): value is string => typeof value === "string")
			: results?.flatMap((result) => (result.url ? [result.url] : []));
		if (!query && (!results || results.length === 0) && (!sourceUrls || sourceUrls.length === 0)) return undefined;
		return {
			kind: "search",
			query,
			resultCount: typeof candidate.resultCount === "number" ? candidate.resultCount : results?.length,
			compressionMode: typeof candidate.compressionMode === "string" ? candidate.compressionMode : undefined,
			cacheHit: candidate.cacheHit === true,
			sourceUrls,
			results,
		};
	}

	if (normalizedTool === "webfetch") {
		const url = typeof candidate.url === "string" ? candidate.url : undefined;
		const title = typeof candidate.title === "string" ? candidate.title : undefined;
		const facts = Array.isArray(candidate.facts)
			? candidate.facts.filter((value): value is string => typeof value === "string").slice(0, 6)
			: undefined;
		const preview = typeof candidate.preview === "string" ? candidate.preview : undefined;
		if (!url && !title && !preview && (!facts || facts.length === 0)) return undefined;
		return {
			kind: "fetch",
			url,
			title,
			contentType: typeof candidate.contentType === "string" ? candidate.contentType : undefined,
			compressionMode: typeof candidate.compressionMode === "string" ? candidate.compressionMode : undefined,
			cacheHit: candidate.cacheHit === true,
			facts,
			preview,
			contentExcerpt: typeof candidate.contentExcerpt === "string" ? candidate.contentExcerpt : preview,
			truncated: candidate.truncated === true,
			sourceUrls: url ? [url] : undefined,
		};
	}

	return undefined;
}
