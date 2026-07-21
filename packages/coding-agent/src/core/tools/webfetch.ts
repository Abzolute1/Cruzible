import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { AgentToolResult } from "@ag1/agent-core";
import { Text } from "@ag1/tui";
import { Type } from "@sinclair/typebox";
import type { ContextUsage, ExtensionContext, ToolRenderResultOptions } from "../extensions/types.js";
import {
	getEffectiveFetchCompressionProfile,
	getResearchUrlHint,
	rememberResearchFetchOutcome,
} from "./research-intent.js";
import {
	assessResearchFetchContent,
	buildResearchPreview,
	deriveResearchCompressionProfile,
	extractResearchDocumentTitle,
	extractResearchFacts,
	extractResearchMetaDescription,
	extractResearchPrimaryHtml,
	formatFetchTranscriptContent,
	limitPreviewLines,
} from "./research-output.js";

export interface WebFetchToolOptions {
	cwd: string;
}

const MAX_CONTENT_SIZE = 4000;
const MAX_FETCH_BYTES = 1_000_000;
const MAX_REDIRECTS = 5;
const MAX_PREVIEW_LINES = 12;
const MAX_LINE_CHARS = 180;
const COLLAPSED_PREVIEW_LINES = 3;
const EXPANDED_PREVIEW_LINES = 6;
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { content: string; contentType?: string; timestamp: number }>();

type FetchPolicyResult = { ok: true; url: URL } | { ok: false; reason: string };
type FetchResponse = { content: string; contentType?: string; cacheHit: boolean; finalUrl: string; statusCode: number };

function isPrivateWebFetchAllowed(): boolean {
	const value = process.env.AG1_ALLOW_PRIVATE_WEBFETCH;
	return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function normalizeHostname(hostname: string): string {
	return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function ipv4ToNumber(ip: string): number | undefined {
	const parts = ip.split(".").map((part) => Number(part));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
		return undefined;
	}
	return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function ipv4InRange(ip: string, base: string, bits: number): boolean {
	const value = ipv4ToNumber(ip);
	const baseValue = ipv4ToNumber(base);
	if (value === undefined || baseValue === undefined) return false;
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	return (value & mask) === (baseValue & mask);
}

/**
 * Convert IPv4-mapped IPv6 addresses to dotted IPv4 so the private-range checks
 * apply (SSRF bypass): handles dotted (`::ffff:127.0.0.1`) and hex
 * (`::ffff:7f00:1`) forms.
 */
function ipv4MappedToIpv4(address: string): string | undefined {
	const dotted = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
	if (dotted?.[1]) {
		return dotted[1];
	}
	const hex = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
	if (hex?.[1] && hex[2]) {
		const hi = Number.parseInt(hex[1], 16);
		const lo = Number.parseInt(hex[2], 16);
		return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
	}
	return undefined;
}

function isBlockedIpAddress(address: string): boolean {
	const normalized = normalizeHostname(address);
	// IPv4-mapped IPv6 must be evaluated as IPv4, otherwise e.g. ::ffff:127.0.0.1
	// sails past the loopback/private checks below.
	const effective = ipv4MappedToIpv4(normalized) ?? normalized;
	const ipVersion = isIP(effective);
	if (ipVersion === 4) {
		return [
			["0.0.0.0", 8],
			["10.0.0.0", 8],
			["100.64.0.0", 10],
			["127.0.0.0", 8],
			["169.254.0.0", 16],
			["172.16.0.0", 12],
			["192.0.0.0", 24],
			["192.0.2.0", 24],
			["192.168.0.0", 16],
			["198.18.0.0", 15],
			["198.51.100.0", 24],
			["203.0.113.0", 24],
			["224.0.0.0", 4],
			["240.0.0.0", 4],
			["255.255.255.255", 32],
		].some(([base, bits]) => ipv4InRange(effective, base as string, bits as number));
	}
	if (ipVersion === 6) {
		const compact = effective.replace(/^0+:/, ":");
		return (
			compact === "::" ||
			compact === "::1" ||
			compact.startsWith("fc") ||
			compact.startsWith("fd") ||
			compact.startsWith("fe80:") ||
			compact.startsWith("ff") ||
			compact.startsWith("64:ff9b:") ||
			compact.startsWith("2001:db8:")
		);
	}
	return false;
}

async function validateWebFetchUrl(rawUrl: string): Promise<FetchPolicyResult> {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return { ok: false, reason: "Invalid URL." };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, reason: "Only http:// and https:// URLs are allowed." };
	}
	const hostname = normalizeHostname(parsed.hostname);
	if (!hostname) return { ok: false, reason: "URL host is required." };
	if (isPrivateWebFetchAllowed()) return { ok: true, url: parsed };
	if (hostname === "localhost" || hostname.endsWith(".localhost") || isBlockedIpAddress(hostname)) {
		return { ok: false, reason: `Fetching from private/internal addresses is not allowed: ${parsed.hostname}` };
	}
	try {
		const records = await lookup(hostname, { all: true, verbatim: true });
		const blocked = records.find((record) => isBlockedIpAddress(record.address));
		if (blocked) {
			return {
				ok: false,
				reason: `DNS for ${hostname} resolves to a private/internal address (${blocked.address}).`,
			};
		}
	} catch (error) {
		return {
			ok: false,
			reason: `Could not resolve ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	return { ok: true, url: parsed };
}

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
			coverage?: { present?: string[]; missing?: string[] };
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
	if (details.coverage?.present?.length) {
		text += `\n${theme.fg("muted", `coverage: ${details.coverage.present.join(", ")}`)}`;
	}
	if (details.coverage?.missing?.length) {
		text += `\n${theme.fg("muted", `missing: ${details.coverage.missing.join(", ")}`)}`;
	}
	return new Text(text, 0, 0);
}

function getResearchCompressionProfile(
	ctx?: Pick<ExtensionContext, "getContextUsage">,
): ReturnType<typeof deriveResearchCompressionProfile> {
	const contextUsage: ContextUsage | undefined = ctx?.getContextUsage?.();
	return deriveResearchCompressionProfile(contextUsage);
}

async function readResponseBody(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > MAX_FETCH_BYTES) {
			await reader.cancel();
			throw new Error(`Response exceeds webFetch size limit (${MAX_FETCH_BYTES} bytes).`);
		}
		chunks.push(value);
	}
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

async function fetchURL(url: string, signal?: AbortSignal): Promise<FetchResponse> {
	// Check cache
	const cached = cache.get(url);
	if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
		return {
			content: cached.content,
			contentType: cached.contentType,
			cacheHit: true,
			finalUrl: url,
			statusCode: 200,
		};
	}

	let currentUrl = url;
	for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
		// Validation (incl. DNS resolution + private-range checks) runs immediately
		// before every fetch and every redirect hop. Residual SSRF risk: a DNS record
		// can still change between the lookup above and fetch()'s own resolution
		// (rebinding TOCTOU). Pinning the connection to the validated IP is not
		// supported by the global fetch stack used here, so this remains a known
		// best-effort gap.
		const validation = await validateWebFetchUrl(currentUrl);
		if (!validation.ok) throw new Error(validation.reason);
		const response = await fetch(validation.url, {
			redirect: "manual",
			signal: signal ?? AbortSignal.timeout(30_000),
			headers: { "User-Agent": "AG1 webFetch" },
		});
		const redirectLocation = response.headers.get("location");
		if (redirectLocation && response.status >= 300 && response.status < 400) {
			currentUrl = new URL(redirectLocation, validation.url).toString();
			continue;
		}
		if (response.status >= 300 && response.status < 400) {
			throw new Error(`Redirect response missing Location header (${response.status}).`);
		}
		if (!response.ok) throw new Error(`HTTP ${response.status} while fetching ${validation.url.toString()}`);
		const contentType = response.headers.get("content-type") ?? undefined;
		const content = await readResponseBody(response);
		cache.set(url, { content, contentType, timestamp: Date.now() });
		return {
			content,
			contentType,
			cacheHit: false,
			finalUrl: validation.url.toString(),
			statusCode: response.status,
		};
	}
	throw new Error(`Too many redirects while fetching ${url}.`);
}

async function executeWebFetch(
	params: unknown,
	signal?: AbortSignal,
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
		const { content, contentType, cacheHit, finalUrl, statusCode } = await fetchURL(url, signal);
		const details: Record<string, unknown> = {
			url,
			finalUrl,
			statusCode,
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
		const preview = buildResearchPreview(markdown, MAX_PREVIEW_LINES, MAX_LINE_CHARS, hint?.focusTerms);
		const compression = getEffectiveFetchCompressionProfile(getResearchCompressionProfile(ctx), hint);
		const facts = extractResearchFacts(
			markdown,
			compression.fetchTranscriptFacts + 1,
			compression.fetchTranscriptLineChars,
			hint?.focusTerms,
		);
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
			intent: hint?.intent,
			coverageKind: hint?.coverageKind,
		});
		details.facts = selectedFacts;
		details.preview = preview;
		details.truncated = markdown.length > MAX_CONTENT_SIZE;
		details.compressionMode = compression.mode;
		details.intent = hint?.intent;
		details.coverageKind = hint?.coverageKind;
		details.authoritative = hint?.authoritative === true;
		details.metaDescription = metaDescription;
		details.status = assessment.status;
		details.statusReason = assessment.reason;
		details.coverage = assessment.coverage;
		rememberResearchFetchOutcome(url, assessment.status);

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
						intent: hint?.intent,
						authoritative: hint?.authoritative === true,
						coverage: assessment.coverage,
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
	): Promise<AgentToolResult<unknown>> => executeWebFetch(params, _signal, ctx),
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
		): Promise<AgentToolResult<unknown>> => executeWebFetch(params, _signal, ctx),
	};
}
