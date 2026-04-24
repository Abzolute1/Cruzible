import path from "node:path";

function normalizeTrackedToolName(toolName: string): string {
	return toolName.trim().toLowerCase();
}

function extractText(result: unknown): string {
	if (!result || typeof result !== "object" || !("content" in result)) return "";
	const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((item) => item && item.type === "text" && typeof item.text === "string")
		.map((item) => item.text ?? "")
		.join("\n");
}

function extractRequestedPath(args: Record<string, unknown> | undefined): string | undefined {
	if (!args) return undefined;
	if (typeof args.filePath === "string") return args.filePath;
	if (typeof args.path === "string") return args.path;
	if (typeof args.file === "string") return args.file;
	return undefined;
}

function extractFirstMatchFromGrep(text: string): string | undefined {
	const followupMatch = text.match(/\[1 match in ([^:\]\n]+):\d+; next: read /);
	if (followupMatch?.[1]) return followupMatch[1];
	const lineMatch = text.match(/^([^:\n]+):\d+:\s/m);
	return lineMatch?.[1];
}

function extractFirstMatchFromFind(text: string): string | undefined {
	const fileFollowup = text.match(/\[1 match; next: read ([^\s\]]+) or grep inside it\]/);
	if (fileFollowup?.[1]) return fileFollowup[1];
	const dirFollowup = text.match(/\[1 directory match; next: ls ([^\]\n]+)\]/);
	if (dirFollowup?.[1]) return dirFollowup[1];

	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && line !== "(no matches)" && !line.startsWith("["));
	if (lines.length === 1) return lines[0];
	return undefined;
}

function isNoMatchText(text: string): boolean {
	return text
		.split("\n")
		.map((line) => line.trim())
		.some((line) => line === "(no matches)" || line.startsWith("(no matches)"));
}

function extractReadLikePath(text: string): string | undefined {
	const pathMatch = text.match(/(?:Read|Edited|Wrote) file[:\s]+([^\s\n]+)/i);
	if (pathMatch?.[1]) return pathMatch[1];
	const firstLine = text.split("\n")[0];
	const readMatch = firstLine?.match(/^(.+?)\s+\(/);
	return readMatch?.[1];
}

function extractResultDetails(result: unknown): Record<string, unknown> | undefined {
	if (!result || typeof result !== "object" || !("details" in result)) return undefined;
	const details = (result as { details?: unknown }).details;
	return details && typeof details === "object" ? (details as Record<string, unknown>) : undefined;
}

function canonicalizeTrackedPath(filePath: string | undefined, cwd?: string): string | undefined {
	if (!filePath || !cwd) return filePath;
	const normalizedFile = filePath.replace(/\\/g, "/");
	const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/$/, "");
	if (!normalizedCwd) return normalizedFile;

	if (normalizedFile === normalizedCwd) return ".";
	if (normalizedFile.startsWith(`${normalizedCwd}/`)) {
		return normalizedFile.slice(normalizedCwd.length + 1);
	}

	const cwdSansLeadingSlash = normalizedCwd.replace(/^\//, "");
	if (normalizedFile === cwdSansLeadingSlash) return ".";
	if (normalizedFile.startsWith(`${cwdSansLeadingSlash}/`)) {
		return normalizedFile.slice(cwdSansLeadingSlash.length + 1);
	}

	if (path.isAbsolute(normalizedFile)) {
		const relative = path.posix.relative(normalizedCwd, normalizedFile);
		if (relative && !relative.startsWith("..")) return relative;
	}

	return normalizedFile;
}

export function extractTrackedFileFromToolResult(
	toolName: string,
	args: Record<string, unknown> | undefined,
	result: unknown,
	cwd?: string,
): string | undefined {
	const normalized = normalizeTrackedToolName(toolName);
	const requestedPath = canonicalizeTrackedPath(extractRequestedPath(args), cwd);
	const textContent = extractText(result);
	const details = extractResultDetails(result);

	if (normalized === "grep") {
		if (isNoMatchText(textContent)) return undefined;
		if (typeof details?.firstMatchPath === "string" && details.firstMatchPath.length > 0) {
			return canonicalizeTrackedPath(details.firstMatchPath, cwd);
		}
		return canonicalizeTrackedPath(extractFirstMatchFromGrep(textContent), cwd)
			?? (requestedPath && requestedPath !== "." ? requestedPath : undefined);
	}

	if (normalized === "find" || normalized === "glob") {
		if (isNoMatchText(textContent)) return undefined;
		if (typeof details?.firstMatchPath === "string" && details.firstMatchPath.length > 0) {
			return canonicalizeTrackedPath(details.firstMatchPath, cwd);
		}
		if (typeof details?.dominantFileDirectory === "string" && details.dominantFileDirectory.length > 0) {
			return canonicalizeTrackedPath(details.dominantFileDirectory, cwd);
		}
		return canonicalizeTrackedPath(extractFirstMatchFromFind(textContent), cwd)
			?? (requestedPath && requestedPath !== "." ? requestedPath : undefined);
	}

	if (normalized === "ls") {
		return requestedPath ?? ".";
	}

	if (
		normalized === "read" ||
		normalized === "read_file" ||
		normalized === "edit" ||
		normalized === "write" ||
		normalized === "str_replace_editor"
	) {
		return requestedPath ?? canonicalizeTrackedPath(extractReadLikePath(textContent), cwd);
	}

	return requestedPath;
}
