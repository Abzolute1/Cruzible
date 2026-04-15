import { spawn } from "node:child_process";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { ContextUsage, ExtensionContext, ToolRenderResultOptions } from "../extensions/types.js";
import { getEffectiveFetchCompressionProfile, getResearchUrlHint } from "./research-intent.js";
import {
	assessResearchFetchContent,
	buildResearchPreview,
	deriveResearchCompressionProfile,
	extractResearchFacts,
	extractResearchDocumentTitle,
	extractResearchMetaDescription,
	extractResearchPrimaryHtml,
	formatFetchTranscriptContent,
	limitPreviewLines,
} from "./research-output.js";

export interface WebFetchToolOptions {
	cwd: string;
}

const MAX_CONTENT_SIZE = 4000;
const MAX_PREVIEW_LINES = 12;
const MAX_LINE_CHARS = 180;
const COLLAPSED_PREVIEW_LINES = 3;
const EXPANDED_PREVIEW_LINES = 6;
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { content: string; timestamp: number }>();

function isBinaryContent(contentType?: string): boolean {
	if (!contentType) return false;
	const binaryTypes = ["image/", "application/pdf", "application/octet-stream", "video/", "audio/"];
	return binaryTypes.some((t) => contentType.startsWith(t));
}

function htmlToMarkdown(html: string): string {
	let md = html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, " ")
		.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ");
	md = md.replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gis, (_, level, content) => {
		const prefix = "#".repeat(parseInt(level, 10));
		return `\n\n${prefix} ${content.trim()}\n\n`;
	});
	md = md.replace(/<p[^>]*>(.*?)<\/p>/gis, "\n\n$1\n\n");
	md = md.replace(/<a[^>]*>(.*?)<\/a>/gis, "$1");
	md = md.replace(/<(ul|ol)[^>]*>/gi, "\n");
	md = md.replace(/<\/(ul|ol)[^>]*>/gi, "\n");
	md = md.replace(/<li[^>]*>(.*?)<\/li>/gis, "- $1\n");
	md = md.replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`");
	md = md.replace(/<pre[^>]*><code[^>]*>(.*?)<\/code><\/pre>/gis, "\n```\n$1\n```\n");
	md = md.replace(/<[^>]+>/g, "");
	md = md.replace(/&nbsp;/g, " ");
	md = md.replace(/&amp;/g, "&");
	md = md.replace(/&lt;/g, "<");
	md = md.replace(/&gt;/g, ">");
	md = md.replace(/&#39;/g, "'");
	md = md.replace(/&quot;/g, '"');
	md = md.replace(/\n{3,}/g, "\n\n");
	return md.trim();
}

function renderWebFetchResult(
	result: {
		details?: {
			url?: string;
			title?: string;
			facts?: string[];
			contentType?: string;
			preview?: string;
			truncated?: boolean;
			cacheHit?: boolean;
			status?: string;
			statusReason?: string;
			metaDescription?: string;
		};
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): Text {
	const details = result.details ?? {};
	let text = `${theme.fg("toolTitle", theme.bold("webFetch"))}`;
	if (details.title) {
		text += ` ${theme.fg("toolOutput", details.title)}`;
	}
	if (details.cacheHit) {
		text += ` ${theme.fg("muted", "[cached]")}`;
	}
	if (details.url) {
		text += `\n${theme.fg("accent", details.url)}`;
	}
	if (details.contentType) {
		text += `\n${theme.fg("muted", details.contentType)}`;
	}
	if (Array.isArray(details.facts) && details.facts.length > 0) {
		text += `\n${theme.fg("muted", "facts:")}`;
		for (const fact of details.facts.slice(0, options.expanded ? 4 : 2)) {
			text += `\n${theme.fg("toolOutput", `- ${fact}`)}`;
		}
	} else if (details.metaDescription) {
		text += `\n${theme.fg("toolOutput", details.metaDescription)}`;
	}
	if (details.preview) {
		const preview = limitPreviewLines(
			details.preview,
			options.expanded ? EXPANDED_PREVIEW_LINES : COLLAPSED_PREVIEW_LINES,
			MAX_LINE_CHARS,
		);
		text += `\n${theme.fg("toolOutput", preview)}`;
	}
	if (details.truncated) {
		text += `\n${theme.fg("muted", "Preview truncated to keep context usage low")}`;
	}
	if (details.status === "placeholder") {
		text += `\n${theme.fg("warning", "placeholder/interstitial page detected")}`;
	} else if (details.status === "thin") {
		text += `\n${theme.fg("muted", "thin article extract")}`;
	}
	if (details.statusReason) {
		text += `\n${theme.fg("muted", details.statusReason)}`;
	}
	return new Text(text, 0, 0);
}

function getResearchCompressionProfile(ctx?: Pick<ExtensionContext, "getContextUsage">): ReturnType<typeof deriveResearchCompressionProfile> {
	const contextUsage: ContextUsage | undefined = ctx?.getContextUsage?.();
	return deriveResearchCompressionProfile(contextUsage);
}

async function fetchURL(url: string): Promise<{ content: string; contentType?: string; cacheHit: boolean }> {
	// Check cache
	const cached = cache.get(url);
	if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
		return { content: cached.content, cacheHit: true };
	}

	return new Promise((resolve) => {
		const proc = spawn("curl", ["-s", "-L", "--max-time", "30", "-w", "\n\n%{content_type}", url]);
		let stdout = "";
		let contentType: string | undefined;

		proc.stdout.on("data", (chunk) => {
			const text = chunk.toString();
			// Extract content type from curl's write-out
			const ctMatch = text.match(/content_type:\s*(.+)$/m);
			if (ctMatch) contentType = ctMatch[1].trim();
			stdout += text;
		});

		proc.on("close", () => {
			// Remove the write-out footer
			const content = stdout.replace(/\n\n\w+\/[\w+.-]+$/, "");
			cache.set(url, { content, timestamp: Date.now() });
			resolve({ content, contentType, cacheHit: false });
		});

		proc.on("error", () => resolve({ content: "", contentType, cacheHit: false }));
	});
}

async function executeWebFetch(
	params: unknown,
	ctx?: Pick<ExtensionContext, "getContextUsage">,
): Promise<AgentToolResult<unknown>> {
	const { url } = params as Record<string, any>;

	if (!url || typeof url !== "string") {
		return {
			details: {},
			content: [{ type: "text" as const, text: "Error: 'url' parameter is required." }],
		};
	}

	try {
		const { content, contentType, cacheHit } = await fetchURL(url);
		const details: Record<string, unknown> = {
			url,
			contentType,
			cacheHit,
		};

		if (isBinaryContent(contentType)) {
			return {
				details,
				content: [
					{
						type: "text" as const,
						text: `Binary content detected (${contentType}). WebFetch only supports text/HTML content.`,
					},
				],
			};
		}

			const metaDescription = extractResearchMetaDescription(content);
			const markdown = htmlToMarkdown(extractResearchPrimaryHtml(content));
			const hint = getResearchUrlHint(url);
			const preview = buildResearchPreview(markdown, MAX_PREVIEW_LINES, MAX_LINE_CHARS);
			const compression = getEffectiveFetchCompressionProfile(getResearchCompressionProfile(ctx), hint);
			const facts = extractResearchFacts(markdown, compression.fetchTranscriptFacts + 1, compression.fetchTranscriptLineChars);
			const htmlTitle = extractResearchDocumentTitle(content);
			const titleMatch = markdown.match(/^#\s+(.+)$/m);
			if (htmlTitle) details.title = htmlTitle;
			else if (titleMatch?.[1]) details.title = titleMatch[1].trim();
			const enrichedFacts = [...facts];
			if (
				metaDescription &&
				metaDescription.length >= 40 &&
				hint?.intent !== "docs_reference" &&
				!enrichedFacts.some((fact) => fact.toLowerCase() === metaDescription.toLowerCase())
			) {
				enrichedFacts.unshift(metaDescription);
			}
			const selectedFacts = enrichedFacts.slice(0, compression.fetchTranscriptFacts);
			const assessment = assessResearchFetchContent({
				markdown,
				facts: selectedFacts,
				preview,
				title: typeof details.title === "string" ? details.title : undefined,
				metaDescription,
			});
			details.facts = selectedFacts;
			details.preview = preview;
			details.truncated = markdown.length > MAX_CONTENT_SIZE;
			details.compressionMode = compression.mode;
			details.metaDescription = metaDescription;
			details.status = assessment.status;
			details.statusReason = assessment.reason;

			return {
				details,
				content: [
					{
						type: "text" as const,
						text: formatFetchTranscriptContent({
							url,
							title: typeof details.title === "string" ? details.title : undefined,
							facts: selectedFacts,
							preview,
							profile: compression,
							truncated: details.truncated === true,
							metaDescription,
							status: assessment.status,
							statusReason: assessment.reason,
						}),
					},
				],
		};
	} catch (err) {
		return {
			details: {
				url,
				error: (err as Error).message,
			},
			content: [{ type: "text" as const, text: `Fetch Error: ${(err as Error).message}` }],
		};
	}
}

export const webFetchToolDefinition = {
	name: "webFetch",
	label: "webFetch",
	description:
		"Fetch a URL and convert HTML to markdown. Useful for reading documentation, API docs, and web pages. Returns a compact preview to preserve context and caches results for 15 minutes.",
	parameters: Type.Object({
		url: Type.String({ description: "URL to fetch" }),
	}),
	promptSnippet: "Fetch and read a URL directly",
	guidelines: [
		"Use for reading documentation, API docs, web pages.",
		"Results are cached for 15 minutes.",
		"Large outputs are truncated.",
	],
	promptGuidelines: ["Use webFetch after webSearch when you need the contents of a specific result URL."],
	renderResult: (
		result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: unknown },
		options: ToolRenderResultOptions,
		theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	) => renderWebFetchResult(result as any, options, theme),
	execute: async (
		_toolCallId: string,
		params: unknown,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<unknown>> => executeWebFetch(params, ctx),
};

export function createWebFetchTool(_options: WebFetchToolOptions) {
	return {
		name: "webFetch",
		label: "webFetch",
		description: webFetchToolDefinition.description,
		parameters: webFetchToolDefinition.parameters,
		execute: async (
			_toolCallId: string,
			params: unknown,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx?: ExtensionContext,
		): Promise<AgentToolResult<unknown>> => executeWebFetch(params, ctx),
	};
}
