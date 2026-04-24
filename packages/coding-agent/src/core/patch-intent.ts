import { normalize } from "node:path";

export type PatchReplacement = {
	oldText: string;
	newText: string;
};

export type PatchIntent = {
	path: string;
	replacements: PatchReplacement[];
};

type PatchLikeRecord = Record<string, unknown>;

function isRecord(value: unknown): value is PatchLikeRecord {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeRelativePath(path: string): string {
	return normalize(path).split("\\").join("/");
}

function getString(record: PatchLikeRecord, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

function getPath(record: PatchLikeRecord): string | undefined {
	const path = getString(record, ["path", "filePath", "file_path", "filename", "file"]);
	return path ? normalizeRelativePath(path) : undefined;
}

function replacementFromRecord(record: PatchLikeRecord): PatchReplacement | undefined {
	const oldText = getString(record, ["oldText", "old_text", "search", "find", "before", "old"]);
	const newText = getString(record, ["newText", "new_text", "replace", "replacement", "after", "new"]);
	if (oldText === undefined || newText === undefined) return undefined;
	return { oldText, newText };
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return undefined;
	}
}

function parseReplacementArray(value: unknown): PatchReplacement[] | undefined {
	const parsed = typeof value === "string" ? parseJson(value.trim()) : value;
	const values = Array.isArray(parsed) ? parsed : isRecord(parsed) ? [parsed] : undefined;
	if (!values) return undefined;
	const replacements = values.map((entry) => (isRecord(entry) ? replacementFromRecord(entry) : undefined));
	if (replacements.some((entry) => !entry)) return undefined;
	return replacements as PatchReplacement[];
}

function parseSearchReplaceBlocks(value: string): PatchReplacement[] | undefined {
	const replacements: PatchReplacement[] = [];
	const pattern = /<{5,}\s*SEARCH\s*\n([\s\S]*?)\n={5,}\s*\n([\s\S]*?)\n>{5,}\s*REPLACE/g;
	for (const match of value.matchAll(pattern)) {
		replacements.push({ oldText: match[1] ?? "", newText: match[2] ?? "" });
	}
	return replacements.length > 0 ? replacements : undefined;
}

function cleanDiffPath(value: string): string {
	return normalizeRelativePath(value.replace(/^[ab]\//, "").trim());
}

function parseUnifiedDiff(value: string, fallbackPath?: string): PatchIntent | undefined {
	const lines = value.split(/\r?\n/);
	const plusPathLine = lines.find((line) => line.startsWith("+++ "));
	const diffPath = plusPathLine?.replace(/^\+\+\+\s+/, "").trim();
	const path = diffPath && diffPath !== "/dev/null" ? cleanDiffPath(diffPath) : fallbackPath;
	if (!path) return undefined;

	const replacements: PatchReplacement[] = [];
	let inHunk = false;
	let oldLines: string[] = [];
	let newLines: string[] = [];
	const flush = () => {
		if (!inHunk) return;
		const oldText = oldLines.join("\n");
		const newText = newLines.join("\n");
		if (oldText !== newText && oldText.length > 0) replacements.push({ oldText, newText });
		oldLines = [];
		newLines = [];
	};

	for (const line of lines) {
		if (line.startsWith("@@")) {
			flush();
			inHunk = true;
			continue;
		}
		if (!inHunk || line.startsWith("\\ No newline")) continue;
		if (line.startsWith(" ")) {
			oldLines.push(line.slice(1));
			newLines.push(line.slice(1));
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			oldLines.push(line.slice(1));
		} else if (line.startsWith("+") && !line.startsWith("+++")) {
			newLines.push(line.slice(1));
		}
	}
	flush();

	return replacements.length > 0 ? { path, replacements } : undefined;
}

export function normalizePatchIntent(input: unknown): PatchIntent | undefined {
	if (!isRecord(input)) return undefined;
	const path = getPath(input);

	const directReplacement = replacementFromRecord(input);
	if (path && directReplacement) return { path, replacements: [directReplacement] };

	for (const key of ["edits", "replacements", "changes"]) {
		const replacements = parseReplacementArray(input[key]);
		if (path && replacements && replacements.length > 0) return { path, replacements };
	}

	const patchText = getString(input, ["patch", "diff"]);
	if (patchText) {
		const searchReplace = parseSearchReplaceBlocks(patchText);
		if (path && searchReplace) return { path, replacements: searchReplace };
		const diff = parseUnifiedDiff(patchText, path);
		if (diff) return diff;
	}

	return undefined;
}
