// Auton — WebFetch Tool
// Fetches a URL and converts HTML to markdown.

import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../../extensions/types.js";
import {
	getEffectiveFetchCompressionProfile,
	getResearchUrlHint,
	rememberResearchFetchOutcome,
} from "../../tools/research-intent.js";
import {
	assessResearchFetchContent,
	buildResearchPreview,
	deriveResearchCompressionProfile,
	extractResearchDocumentTitle,
	extractResearchFacts,
	extractResearchMetaDescription,
	extractResearchPrimaryHtml,
	formatFetchTranscriptContent,
} from "../../tools/research-output.js";

const MAX_CHARS = 4000;
const MAX_PREVIEW_LINES = 12;
const MAX_LINE_CHARS = 180;
const CACHE_TTL_MS = 15 * 60 * 1000;
const fetchCache = new Map<string, { content: string; contentType: string; timestamp: number }>();

function htmlToMarkdown(html: string): string {
	let text = html;

	// Convert links to markdown format: [text](url)
	text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, linkText: string) => {
		const cleanText = linkText.replace(/<[^>]+>/g, "").trim();
		if (cleanText) {
			return `[${cleanText}](${href})`;
		}
		return href;
	});

	// Convert headings
	for (let i = 6; i >= 1; i--) {
		const tag = `h${i}`;
		const prefix = "#".repeat(i);
		text = text.replace(
			new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"),
			(_match: string, content: string) => {
				return `\n\n${prefix} ${content.replace(/<[^>]+>/g, "").trim()}\n\n`;
			},
		);
	}

	// Convert code blocks
	text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_match: string, content: string) => {
		return `\n\`\`\`\n${content.replace(/<[^>]+>/g, "").trim()}\n\`\`\`\n\n`;
	});
	text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_match: string, content: string) => {
		return `\`${content.replace(/<[^>]+>/g, "").trim()}\``;
	});

	// Convert lists
	text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_match: string, content: string) => {
		return `\n- ${content.replace(/<[^>]+>/g, "").trim()}`;
	});

	// Convert strong/bold
	text = text.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, "**$1**");

	// Convert em/italic
	text = text.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, "*$1*");

	// Convert paragraphs
	text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_match: string, content: string) => {
		return `\n\n${content.replace(/<[^>]+>/g, "").trim()}\n\n`;
	});

	// Convert br
	text = text.replace(/<br\s*\/?>/gi, "\n");

	// Convert hr
	text = text.replace(/<hr\s*\/?>/gi, "\n\n---\n\n");

	// Convert blockquotes
	text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match: string, content: string) => {
		return `\n> ${content
			.replace(/<[^>]+>/g, "")
			.trim()
			.replace(/\n/g, "\n> ")}\n\n`;
	});

	// Remove all remaining HTML tags
	text = text.replace(/<[^>]+>/g, "");

	// Decode common HTML entities
	text = text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 10)));

	// Clean up whitespace
	text = text
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]+/g, " ")
		.replace(/ *\n */g, "\n")
		.trim();

	return text;
}

function buildPreview(markdown: string): string {
	return buildResearchPreview(markdown, MAX_PREVIEW_LINES, MAX_LINE_CHARS);
}

const webFetchParamsSchema = Type.Object({
	url: Type.String({ description: "URL to fetch" }),
});
type WebFetchParams = Static<typeof webFetchParamsSchema>;

export const webFetchToolDefinition: ToolDefinition<typeof webFetchParamsSchema, Record<string, unknown>, undefined> = {
	name: "webFetch",
	label: "webFetch",
	description: "Fetch a URL and convert the HTML content to markdown. Maximum 50,000 characters returned.",
	parameters: webFetchParamsSchema,
	promptSnippet: "Fetch and read a URL directly",
	promptGuidelines: ["Use webFetch after webSearch when you need the contents of a specific online page."],
	execute: async (
		_toolCallId: string,
		params: WebFetchParams,
		signal: AbortSignal | undefined,
		_onUpdate: (update: unknown) => Promise<void>,
		ctx: { getContextUsage?: () => unknown } | undefined,
	) => {
		const url = params.url;

		if (!url || url.trim().length === 0) {
			return {
				content: [{ type: "text", text: "Error: URL is required." }],
				details: { url: "" },
			};
		}

		// Protocol enforcement — only http/https
		let fetchUrl = url.trim();
		if (!fetchUrl.startsWith("http://") && !fetchUrl.startsWith("https://")) {
			fetchUrl = `https://${fetchUrl}`;
		}

		// Parse and validate the URL
		let parsedUrl: URL;
		try {
			parsedUrl = new URL(fetchUrl);
		} catch {
			return { content: [{ type: "text", text: `Error: Invalid URL: ${url}` }], details: { url } };
		}

		// Only allow http/https protocols (reject file://, ftp://, etc.)
		if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
			return {
				content: [{ type: "text", text: `Error: Only http/https allowed. Got: ${parsedUrl.protocol}` }],
				details: { url: fetchUrl },
			};
		}

		// Block private/reserved IP ranges (SSRF prevention)
		const hostname = parsedUrl.hostname.toLowerCase();
		function isPrivateIP(host: string): boolean {
			if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") return true;
			if (host.endsWith(".local") || host.endsWith(".internal")) return true;
			// AWS/GCP/Azure metadata
			if (host === "169.254.169.254" || host === "metadata.google.internal") return true;
			// RFC1918 private ranges
			const parts = host.split(".").map(Number);
			if (parts.length === 4 && !parts.some(Number.isNaN)) {
				if (parts[0] === 10) return true;
				if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
				if (parts[0] === 192 && parts[1] === 168) return true;
				if (parts[0] === 127) return true;
			}
			return false;
		}

		if (isPrivateIP(hostname)) {
			return {
				content: [
					{ type: "text", text: `Error: Fetching from private/internal addresses is not allowed: ${hostname}` },
				],
				details: { url: fetchUrl },
			};
		}

		try {
			const cached = fetchCache.get(fetchUrl);
			const cacheHit = Boolean(cached && Date.now() - cached.timestamp < CACHE_TTL_MS);
			let contentType = "";
			let content: string;
			if (cacheHit && cached) {
				contentType = cached.contentType;
				content = cached.content;
			} else {
				const response = await fetch(fetchUrl, {
					signal,
					headers: {
						"User-Agent": "Mozilla/5.0 (compatible; AG1-Agent/1.0)",
					},
					redirect: "follow",
				});

				if (!response.ok) {
					return {
						content: [
							{ type: "text", text: `Error: HTTP ${response.status} ${response.statusText} for ${fetchUrl}` },
						],
						details: { url: fetchUrl, status: response.status },
					};
				}

				contentType = response.headers.get("content-type") || "";

				if (contentType.includes("text/html") || contentType.includes("text/plain")) {
					content = await response.text();
				} else if (contentType.includes("application/json")) {
					content = await response.text();
					// Try to format JSON nicely
					try {
						content = JSON.stringify(JSON.parse(content), null, 2);
					} catch {
						// keep as-is
					}
				} else {
					content = await response.text();
				}

				fetchCache.set(fetchUrl, { content, contentType, timestamp: Date.now() });
			}

				// Convert HTML to markdown if it looks like HTML
				let markdown: string;
				if (content.trim().startsWith("<") || contentType.includes("html")) {
					markdown = htmlToMarkdown(extractResearchPrimaryHtml(content));
				} else {
					markdown = content;
				}

				// Truncate to max chars
				const truncated = markdown.length > MAX_CHARS;
				const htmlTitle = extractResearchDocumentTitle(content);
				const metaDescription = extractResearchMetaDescription(content);
				const titleMatch = markdown.match(/^#\s+(.+)$/m);
				const hint = getResearchUrlHint(fetchUrl);
				const preview = buildPreview(markdown);
				const compression = getEffectiveFetchCompressionProfile(
					deriveResearchCompressionProfile(ctx?.getContextUsage?.() as any),
					hint,
				);
				const title = htmlTitle ?? titleMatch?.[1]?.trim();
				const facts = extractResearchFacts(markdown, compression.fetchTranscriptFacts + 1, compression.fetchTranscriptLineChars);
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
					title,
					metaDescription,
					intent: hint?.intent,
					coverageKind: hint?.coverageKind,
				});
				rememberResearchFetchOutcome(fetchUrl, assessment.status);

				return {
					content: [
						{
							type: "text",
							text: formatFetchTranscriptContent({
								url: fetchUrl,
								title,
								facts: selectedFacts,
								preview,
								profile: compression,
								truncated,
								metaDescription,
								status: assessment.status,
								statusReason: assessment.reason,
								intent: hint?.intent,
								authoritative: hint?.authoritative === true,
								coverage: assessment.coverage,
							}),
						},
					],
					details: {
						url: fetchUrl,
						contentType,
						title,
						facts: selectedFacts,
						preview,
						truncated,
						compressionMode: compression.mode,
						cacheHit,
						metaDescription,
						status: assessment.status,
						statusReason: assessment.reason,
						intent: hint?.intent,
						authoritative: hint?.authoritative === true,
						coverageKind: hint?.coverageKind,
						coverage: assessment.coverage,
					},
				};
		} catch (err: any) {
			if (err.name === "AbortError") {
				return {
					content: [{ type: "text", text: `WebFetch: Request was cancelled.` }],
					details: { url: fetchUrl, error: "cancelled" },
				};
			}
			return {
				content: [{ type: "text", text: `WebFetch Error: ${err.message || String(err)}` }],
				details: { url: fetchUrl, error: err.message || String(err) },
			};
		}
	},
};
