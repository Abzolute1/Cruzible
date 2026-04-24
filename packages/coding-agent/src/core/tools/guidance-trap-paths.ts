export function looksLikeGuidanceTrapPath(toolPath: string | undefined): boolean {
	if (!toolPath) return false;
	const normalized = toolPath.replace(/\\/g, "/").toLowerCase();
	return normalized.includes("/test/")
		|| normalized.includes("/tests/")
		|| normalized.endsWith("/core/tools/grep.ts")
		|| normalized.endsWith("/core/prompt-intent-steering.ts")
		|| normalized.endsWith("/core/local-evidence-steering.ts")
		|| normalized.endsWith("/core/tools/research-output.ts");
}
