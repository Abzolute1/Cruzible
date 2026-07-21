import { extractTrackedFileFromToolResult } from "../../core/tool-outcome-file.js";

export function extractInteractiveToolFile(options: {
	toolName: string;
	args: Record<string, unknown> | undefined;
	result: { content: Array<{ type: string; text?: string }> };
	cwd: string;
}): string | undefined {
	return extractTrackedFileFromToolResult(options.toolName, options.args, options.result, options.cwd);
}

export function extractInteractiveToolDetail(
	toolName: string,
	args: Record<string, unknown> | undefined,
): string | undefined {
	if (!args) return undefined;
	if (toolName === "task" && typeof args.description === "string") {
		const type = typeof args.type === "string" ? args.type : undefined;
		return type ? `${type}: ${args.description}` : args.description;
	}
	if ((toolName === "bash" || toolName === "verify") && typeof args.command === "string") {
		return args.command;
	}
	if (toolName === "websearch" && typeof args.query === "string") return args.query;
	if (toolName === "webfetch" && typeof args.url === "string") return args.url;
	if (toolName === "read") {
		const path =
			typeof args.filePath === "string" ? args.filePath : typeof args.path === "string" ? args.path : undefined;
		if (!path) return undefined;
		const suffix: string[] = [];
		if (typeof args.offset === "number") suffix.push(`offset=${args.offset}`);
		if (typeof args.limit === "number") suffix.push(`limit=${args.limit}`);
		return suffix.length > 0 ? `${path} (${suffix.join(", ")})` : path;
	}
	if (typeof args.filePath === "string") return args.filePath;
	if (typeof args.path === "string") return args.path;
	return undefined;
}

export function extractInteractiveToolMetadata(result: unknown): Record<string, unknown> | undefined {
	if (!result || typeof result !== "object") return undefined;
	if (!("details" in result)) return undefined;
	const details = (result as { details?: unknown }).details;
	return details && typeof details === "object" ? (details as Record<string, unknown>) : undefined;
}

export function estimateInteractiveToolResultTokens(result: unknown): number | undefined {
	if (!result || typeof result !== "object" || !("content" in result)) return undefined;
	const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((item) => item && item.type === "text" && typeof item.text === "string")
		.map((item) => item.text ?? "")
		.join("\n");
	if (text.length === 0) return undefined;
	return Math.ceil(text.length / 4);
}
