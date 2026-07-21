import type { WorkspaceManifest } from "./workspace-index.js";

export type VerificationSelectionOptions = {
	command?: string;
	manifest?: Pick<WorkspaceManifest, "testFiles" | "likelyVerifier">;
};

export type VerificationFailureKind =
	| "assertion"
	| "syntax"
	| "import"
	| "timeout"
	| "environment"
	| "unrelated"
	| "unknown";

export type VerificationFailureClassification = {
	kind: VerificationFailureKind;
	summary: string;
	signature: string;
	paths: string[];
};

export type VerificationFailureClassificationOptions = {
	relevantPaths?: string[];
};

function normalizeCommand(command: string): string {
	return command.replace(/\s+/g, " ").trim();
}

function isSimpleNodeTestCommand(command: string): boolean {
	return normalizeCommand(command) === "node --test";
}

function isRunnableNodeTestFile(path: string): boolean {
	return /\.(mjs|cjs|js)$/i.test(path);
}

export function selectVerificationCommand(options: VerificationSelectionOptions): string | undefined {
	const baseCommand = options.command ?? options.manifest?.likelyVerifier;
	if (!baseCommand) return undefined;
	const normalized = normalizeCommand(baseCommand);
	const testFiles = options.manifest?.testFiles.filter(isRunnableNodeTestFile) ?? [];
	if (isSimpleNodeTestCommand(normalized) && testFiles.length === 1) {
		return `node --test ${testFiles[0]}`;
	}
	return normalized;
}

export function commandMatchesVerifier(command: string, verifier?: string): boolean {
	if (!verifier) return false;
	const normalizedCommand = normalizeCommand(command);
	const normalizedVerifier = normalizeCommand(verifier);
	return (
		normalizedCommand === normalizedVerifier ||
		normalizedCommand.includes(normalizedVerifier) ||
		normalizedVerifier.startsWith(`${normalizedCommand} `)
	);
}

function normalizeOutput(output: string): string {
	return output.replace(/\r/g, "").replace(/\u001b\[[0-9;]*m/g, "");
}

function usefulFailureLines(output: string): string[] {
	return normalizeOutput(output)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((line) => !/^TAP version \d+/i.test(line))
		.filter((line) => !/^---$/.test(line))
		.filter((line) => !/^error:\s*\|-$/i.test(line))
		.filter((line) => !/^#?\s*\d+\.\.\d+$/i.test(line))
		.filter((line) => !/^#?\s*(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/i.test(line));
}

function extractPaths(output: string): string[] {
	const paths = new Set<string>();
	for (const match of normalizeOutput(output).matchAll(
		/(?:^|\s)([A-Za-z0-9_.@/-]+\.(?:mjs|cjs|js|jsx|ts|tsx|json))(?::\d+)?/g,
	)) {
		const path = match[1]?.replace(/^\.\//, "");
		if (path && !path.startsWith("node:")) paths.add(path);
	}
	return [...paths];
}

function pathMatchesAny(path: string, candidates: string[]): boolean {
	return candidates.some(
		(candidate) => path === candidate || path.endsWith(`/${candidate}`) || candidate.endsWith(`/${path}`),
	);
}

function classifyKind(output: string, paths: string[], relevantPaths: string[]): VerificationFailureKind {
	const normalized = output.toLowerCase();
	if (/timed?\s*out|timeout|exceeded.*timeout/i.test(output)) return "timeout";
	if (/err_module_not_found|cannot find module|module not found|failed to resolve|enoent.*(?:open|stat)/i.test(output))
		return "import";
	if (/syntaxerror|unexpected token|unterminated|string literal|missing \)|ts\d{4}/i.test(output)) return "syntax";
	if (/eacces|permission denied|network|connection refused|address already in use|spawn .* enoent/i.test(output))
		return "environment";
	if (paths.length > 0 && relevantPaths.length > 0 && !paths.some((path) => pathMatchesAny(path, relevantPaths)))
		return "unrelated";
	if (/assertionerror|assert\.|expected|actual|not equal|strictEqual|deepStrictEqual|\bnot ok\b/i.test(output))
		return "assertion";
	if (/error|failed|failure/i.test(normalized)) return "unknown";
	return "unknown";
}

function normalizeSignature(text: string): string {
	return text
		.toLowerCase()
		.replace(/\u001b\[[0-9;]*m/g, "")
		.replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
		.replace(/:\d+:\d+/g, ":<n>:<n>")
		.replace(/:\d+/g, ":<n>")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 240);
}

export function classifyVerificationFailure(
	output: string,
	options: VerificationFailureClassificationOptions = {},
): VerificationFailureClassification {
	const lines = usefulFailureLines(output);
	const paths = extractPaths(output);
	const relevantPaths = options.relevantPaths ?? [];
	const kind = classifyKind(output, paths, relevantPaths);
	const importantLine =
		lines.find((line) =>
			/assertionerror|syntaxerror|err_module_not_found|cannot find module|timed?\s*out|timeout|error/i.test(line),
		) ?? lines.find((line) => /\bnot ok\b|expected|actual/i.test(line));
	const summaryLines = [importantLine, ...lines.filter((line) => line !== importantLine)].filter(Boolean).slice(0, 4);
	const summary = summaryLines.join(" | ").slice(0, 500) || "verification failed without a useful textual error";
	return {
		kind,
		summary,
		signature: normalizeSignature(`${kind}:${summary}`),
		paths,
	};
}
