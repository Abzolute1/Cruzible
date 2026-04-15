/**
 * String formatting helpers for session debug logger.
 * Used by session.md, session.compact.md, and timeline.json generation.
 */

/**
 * Format token counts with k/M suffix.
 * Matches the formatTokens function in footer.ts.
 */
export function formatTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
	return `${Math.round(n / 1000000)}M`;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * E.g., "16m 22s", "1m 0s", "45s"
 */
export function formatDurationMs(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}
	return `${seconds}s`;
}

/**
 * Format a cost value as $X.XXX
 */
export function formatCost(cost: number): string {
	return `$${cost.toFixed(3)}`;
}

/**
 * Truncate text to a maximum length, appending "..." if truncated.
 */
export function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength)}...`;
}

/**
 * Summarize tool call arguments for display (first N chars of JSON stringified).
 */
export function summarizeToolArgs(args: Record<string, unknown>, maxLength: number = 30): string {
	const json = JSON.stringify(args);
	return truncate(json, maxLength);
}

/**
 * Format tool for compact file: name(args_summary)✓ or name(args_summary)✗
 */
export function formatToolForCompact(toolName: string, args: Record<string, unknown>, isError: boolean): string {
	const argsSummary = summarizeToolArgs(args, 30);
	const status = isError ? "✗" : "✓";
	return `${toolName}(${argsSummary})${status}`;
}

/**
 * Safely format tool result content for session.md.
 * - Error results: full text (no truncation)
 * - Binary content: [binary content, {size} bytes]
 * - Text results: first 500 chars, truncated with ... if longer
 */
export function formatToolResultContent(content: unknown, isError: boolean): string {
	if (isError) {
		// Full error text — no truncation
		return extractTextFromContent(content);
	}

	const text = extractTextFromContent(content);
	const byteSize = Buffer.byteLength(text, "utf8");

	// Check for binary-like content
	if (isLikelyBinary(text)) {
		return `[binary content, ${byteSize} bytes]`;
	}

	// Large content: truncate
	if (byteSize > 10240) {
		// > 10KB
		return `[truncated, ${byteSize} bytes total]\n${text.slice(0, 500)}...`;
	}

	if (text.length > 500) {
		return `${text.slice(0, 500)}...`;
	}

	return text;
}

/**
 * Extract text from tool result content (handles both string and array formats).
 */
function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((block: any) => block.type === "text" && typeof block.text === "string")
			.map((block: any) => block.text)
			.join("\n");
	}
	return String(content);
}

/**
 * Heuristic check if text looks like binary data.
 */
function isLikelyBinary(text: string): boolean {
	// Check for high ratio of non-printable characters
	let nonPrintable = 0;
	const checkLen = Math.min(text.length, 1000);
	for (let i = 0; i < checkLen; i++) {
		const code = text.charCodeAt(i);
		// Control chars (except common whitespace)
		if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
			nonPrintable++;
		}
	}
	return nonPrintable > checkLen * 0.1;
}

/**
 * Format a model name for display.
 * E.g., "NVIDIA Nemotron 3 Nano 30B A3B (local/lm-studio)"
 */
export function formatModelDisplayName(model: { name?: string; provider: string; id: string }): string {
	const displayName = model.name || model.id;
	return `${displayName} (${model.provider}/${model.id})`;
}

/**
 * Convert model provider + id to a kebab-case folder-safe name.
 * E.g., "local/lm-studio" → "local_lm-studio"
 *      "anthropic/claude-sonnet-4-5" → "anthropic_claude-sonnet-4-5"
 */
export function modelToFolderName(provider: string, id: string): string {
	const combined = `${provider}/${id}`;
	// Replace / with _, remove any remaining special chars that are problematic
	return combined.replace(/[^a-zA-Z0-9/_-]/g, "").replace(/\//g, "_");
}

/**
 * Format an ISO date string to the session folder date portion: YYYY-MM-DD
 */
export function toSessionDateStr(isoOrTimestamp: string | number): string {
	const d = new Date(isoOrTimestamp);
	const year = d.getUTCFullYear();
	const month = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/**
 * Format an ISO date string or timestamp to the session folder timestamp portion: YYYY-MM-DD_HH-MM-SS
 */
export function toSessionDateTimeStr(isoOrTimestamp: string | number): string {
	const d = new Date(isoOrTimestamp);
	const year = d.getUTCFullYear();
	const month = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	const hour = String(d.getUTCHours()).padStart(2, "0");
	const min = String(d.getUTCMinutes()).padStart(2, "0");
	const sec = String(d.getUTCSeconds()).padStart(2, "0");
	return `${year}-${month}-${day}_${hour}-${min}-${sec}`;
}

/**
 * Format a UTC timestamp as "YYYY-MM-DD HH:MM:SS UTC"
 */
export function toUtcTimestamp(timestamp: number): string {
	const d = new Date(timestamp);
	const year = d.getUTCFullYear();
	const month = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	const hour = String(d.getUTCHours()).padStart(2, "0");
	const min = String(d.getUTCMinutes()).padStart(2, "0");
	const sec = String(d.getUTCSeconds()).padStart(2, "0");
	return `${year}-${month}-${day} ${hour}:${min}:${sec} UTC`;
}

/**
 * Right-align a number in a field of given width.
 */
export function padLeft(value: string | number, width: number): string {
	const str = String(value);
	if (str.length >= width) return str;
	return " ".repeat(width - str.length) + str;
}

/**
 * Redact potential API keys/secrets in text.
 * Replaces "sk-..." prefixes and 40+ hex char strings.
 */
export function redactSecrets(text: string): string {
	// Redact sk-... style keys
	text = text.replace(/sk-[a-zA-Z0-9]{20,}/g, "[REDACTED]");
	// Redact long hex strings (likely API keys/tokens)
	text = text.replace(/\b[a-fA-F0-9]{40,}\b/g, "[REDACTED]");
	// Redact Bearer tokens
	text = text.replace(/Bearer\s+[^\s]{10,}/g, "Bearer [REDACTED]");
	return text;
}

/**
 * Escape a string for safe JSON embedding in previews.
 */
export function safeJsonPreview(text: string, maxLength: number = 200): string {
	const truncated = text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
	return truncated;
}
