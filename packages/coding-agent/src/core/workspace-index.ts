import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, normalize, relative, resolve } from "node:path";

const DEFAULT_MAX_FILES = 1000;
const DEFAULT_MANIFEST_FILE_LIMIT = 24;
const NOISE_DIRS = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".next",
	".turbo",
	".cache",
	"Debug",
]);
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);
const PACKAGE_MANAGER_FILES = new Set([
	"package.json",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lockb",
	"deno.json",
	"deno.jsonc",
	"pyproject.toml",
	"requirements.txt",
	"Cargo.toml",
	"go.mod",
]);
const WORKSPACE_INDEX_CACHE_TTL_MS = 30_000;

export type WorkspaceImportEdge = {
	from: string;
	to: string;
	specifier: string;
};

export type WorkspaceIndexFile = {
	path: string;
	size: number;
	extension: string;
};

export type WorkspaceIndex = {
	rootDir: string;
	files: WorkspaceIndexFile[];
	testFiles: string[];
	packageManagerFiles: string[];
	packageScripts: Record<string, string>;
	importEdges: WorkspaceImportEdge[];
};

export type BuildWorkspaceIndexOptions = {
	rootDir: string;
	maxFiles?: number;
	useCache?: boolean;
};

export type WorkspaceManifestOptions = {
	prompt?: string;
	maxFiles?: number;
};

export type WorkspaceManifest = {
	files: string[];
	testFiles: string[];
	packageScripts: Record<string, string>;
	likelyVerifier?: string;
	importEdges: WorkspaceImportEdge[];
	repoMap?: WorkspaceRepoMap;
};

export type WorkspaceRepoMap = {
	rootDir: string;
	topDirectories: string[];
	entrypoints: string[];
	topExtensions: Array<{ extension: string; count: number }>;
	packageManagerFiles: string[];
	testFileCount: number;
};

type IgnoreMatcher = (path: string, isDirectory: boolean) => boolean;
type CachedWorkspaceIndex = {
	index: WorkspaceIndex;
	fingerprint: string;
	createdAt: number;
};

const workspaceIndexCache = new Map<string, CachedWorkspaceIndex>();

function normalizeRelativePath(path: string): string {
	return path.split("\\").join("/");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createGlobMatcher(pattern: string): RegExp {
	const escaped = pattern.split("*").map(escapeRegExp).join("[^/]*");
	return new RegExp(`(^|/)${escaped}($|/)`);
}

function createIgnoreMatchers(rootDir: string): IgnoreMatcher[] {
	const gitignorePath = join(rootDir, ".gitignore");
	if (!existsSync(gitignorePath)) return [];
	const lines = readFileSync(gitignorePath, "utf8")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#") && !line.startsWith("!"));

	return lines.map((line) => {
		const directoryOnly = line.endsWith("/");
		const pattern = directoryOnly ? line.slice(0, -1) : line;
		const normalized = normalizeRelativePath(pattern).replace(/^\//, "");
		const hasSlash = normalized.includes("/");
		const hasGlob = normalized.includes("*");
		const glob = hasGlob ? createGlobMatcher(normalized) : undefined;
		return (path: string, isDirectory: boolean) => {
			if (directoryOnly && !isDirectory && !path.startsWith(`${normalized}/`)) return false;
			if (glob) return glob.test(path);
			if (hasSlash) return path === normalized || path.startsWith(`${normalized}/`);
			return path.split("/").includes(normalized);
		};
	});
}

function shouldIgnorePath(path: string, isDirectory: boolean, ignoreMatchers: IgnoreMatcher[]): boolean {
	const parts = path.split("/").filter(Boolean);
	if (parts.some((part) => NOISE_DIRS.has(part))) return true;
	return ignoreMatchers.some((matcher) => matcher(path, isDirectory));
}

function isTestFile(path: string): boolean {
	return (
		/(^|\/)(test|tests|__tests__)\/.+\.[cm]?[jt]sx?$/i.test(path) ||
		/\.(test|spec)\.[cm]?[jt]sx?$/i.test(path) ||
		/(^|\/)[^/]+[-_.]test\.[cm]?[jt]sx?$/i.test(path)
	);
}

function collectFiles(rootDir: string, maxFiles: number, ignoreMatchers: IgnoreMatcher[]): WorkspaceIndexFile[] {
	const files: WorkspaceIndexFile[] = [];
	const walk = (dir: string) => {
		if (files.length >= maxFiles) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const fullPath = join(dir, entry.name);
			const relPath = normalizeRelativePath(relative(rootDir, fullPath));
			if (shouldIgnorePath(relPath, entry.isDirectory(), ignoreMatchers)) continue;
			if (entry.isDirectory()) {
				walk(fullPath);
				continue;
			}
			if (!entry.isFile()) continue;
			const stat = statSync(fullPath);
			files.push({
				path: relPath,
				size: stat.size,
				extension: extname(entry.name).toLowerCase(),
			});
			if (files.length >= maxFiles) return;
		}
	};
	walk(rootDir);
	return files.sort((a, b) => a.path.localeCompare(b.path));
}

function parsePackageScripts(rootDir: string): Record<string, string> {
	const packageJsonPath = join(rootDir, "package.json");
	if (!existsSync(packageJsonPath)) return {};
	try {
		const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts?: unknown };
		if (!parsed.scripts || typeof parsed.scripts !== "object" || Array.isArray(parsed.scripts)) return {};
		const scripts: Record<string, string> = {};
		for (const [name, command] of Object.entries(parsed.scripts)) {
			if (typeof command === "string") scripts[name] = command;
		}
		return scripts;
	} catch {
		return {};
	}
}

function extractImportSpecifiers(source: string): string[] {
	const specifiers = new Set<string>();
	const patterns = [
		/\bimport\s+(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g,
		/\bexport\s+[^'"]+\s+from\s+["']([^"']+)["']/g,
		/\brequire\(\s*["']([^"']+)["']\s*\)/g,
		/\bimport\(\s*["']([^"']+)["']\s*\)/g,
	];
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) {
			if (match[1]) specifiers.add(match[1]);
		}
	}
	return [...specifiers];
}

function resolveImportSpecifier(fromPath: string, specifier: string, fileSet: Set<string>): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const base = normalizeRelativePath(normalize(join(dirname(fromPath), specifier)));
	const candidates = [
		base,
		...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map((extension) => `${base}${extension}`),
		...["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs", "index.cjs"].map(
			(indexFile) => `${base}/${indexFile}`,
		),
	];
	return candidates.find((candidate) => fileSet.has(candidate));
}

function buildImportEdges(rootDir: string, files: WorkspaceIndexFile[]): WorkspaceImportEdge[] {
	const sourceFiles = files.filter((file) => SOURCE_EXTENSIONS.has(file.extension));
	const fileSet = new Set(files.map((file) => file.path));
	const edges: WorkspaceImportEdge[] = [];
	for (const file of sourceFiles) {
		const fullPath = join(rootDir, file.path);
		let source = "";
		try {
			source = readFileSync(fullPath, "utf8");
		} catch {
			continue;
		}
		for (const specifier of extractImportSpecifiers(source)) {
			const resolved = resolveImportSpecifier(file.path, specifier, fileSet);
			if (resolved) edges.push({ from: file.path, to: resolved, specifier });
		}
	}
	return edges.sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`));
}

export function buildWorkspaceIndex(options: BuildWorkspaceIndexOptions): WorkspaceIndex {
	const rootDir = resolve(options.rootDir);
	const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
	if (options.useCache !== false) {
		const cacheKey = `${rootDir}:${maxFiles}`;
		const fingerprint = workspaceIndexFingerprint(rootDir, maxFiles);
		const cached = workspaceIndexCache.get(cacheKey);
		if (
			cached &&
			cached.fingerprint === fingerprint &&
			Date.now() - cached.createdAt < WORKSPACE_INDEX_CACHE_TTL_MS
		) {
			return cached.index;
		}
		const index = buildWorkspaceIndexUncached(rootDir, maxFiles);
		workspaceIndexCache.set(cacheKey, { index, fingerprint, createdAt: Date.now() });
		return index;
	}
	return buildWorkspaceIndexUncached(rootDir, maxFiles);
}

export function clearWorkspaceIndexCache(rootDir?: string): void {
	if (!rootDir) {
		workspaceIndexCache.clear();
		return;
	}
	const normalizedRoot = resolve(rootDir);
	for (const key of workspaceIndexCache.keys()) {
		if (key.startsWith(`${normalizedRoot}:`)) workspaceIndexCache.delete(key);
	}
}

function buildWorkspaceIndexUncached(rootDir: string, maxFiles: number): WorkspaceIndex {
	const ignoreMatchers = createIgnoreMatchers(rootDir);
	const files = collectFiles(rootDir, maxFiles, ignoreMatchers);
	return {
		rootDir,
		files,
		testFiles: files.map((file) => file.path).filter(isTestFile),
		packageManagerFiles: files.map((file) => file.path).filter((path) => PACKAGE_MANAGER_FILES.has(basename(path))),
		packageScripts: parsePackageScripts(rootDir),
		importEdges: buildImportEdges(rootDir, files),
	};
}

function workspaceIndexFingerprint(rootDir: string, maxFiles: number): string {
	const trackedFiles = [".gitignore", "package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb"];
	const parts = [`max=${maxFiles}`];
	for (const file of trackedFiles) {
		const filePath = join(rootDir, file);
		if (!existsSync(filePath)) continue;
		try {
			const stat = statSync(filePath);
			parts.push(`${file}:${stat.size}:${stat.mtimeMs}`);
		} catch {
			parts.push(`${file}:unreadable`);
		}
	}
	return parts.join("|");
}

function promptTerms(prompt: string): Set<string> {
	return new Set(
		prompt
			.toLowerCase()
			.replace(/[`"'.,:;()[\]{}]/g, " ")
			.split(/[^a-z0-9]+/g)
			.map((term) => term.trim())
			.filter((term) => term.length >= 3),
	);
}

function scorePathForPrompt(path: string, terms: Set<string>): number {
	const normalizedPath = path.toLowerCase();
	const pathTerms = new Set(normalizedPath.split(/[^a-z0-9]+/g).filter(Boolean));
	let score = 0;
	for (const term of terms) {
		if (pathTerms.has(term)) score += 8;
		else if (normalizedPath.includes(term)) score += 3;
	}
	if (isTestFile(path)) score += 2;
	if (/\/src\//.test(`/${normalizedPath}`)) score += 1;
	if (/\/(generated|snapshot|fixtures?)\//.test(`/${normalizedPath}`)) score -= 4;
	return score;
}

function likelyVerifierFromIndex(index: WorkspaceIndex): string | undefined {
	if (index.packageScripts.test) return "npm test";
	if (index.packageScripts.check) return "npm run check";
	if (index.testFiles.some((file) => /\.(mjs|cjs|js)$/.test(file))) return "node --test";
	return undefined;
}

function expandImportNeighborhood(files: string[], index: WorkspaceIndex): string[] {
	const selected = new Set(files);
	let changed = true;
	while (changed) {
		changed = false;
		for (const edge of index.importEdges) {
			if (selected.has(edge.from) && !selected.has(edge.to)) {
				selected.add(edge.to);
				changed = true;
			}
			if (selected.has(edge.to) && isTestFile(edge.from) && !selected.has(edge.from)) {
				selected.add(edge.from);
				changed = true;
			}
		}
	}
	return [...selected].sort();
}

export function buildWorkspaceManifest(
	index: WorkspaceIndex,
	options: WorkspaceManifestOptions = {},
): WorkspaceManifest {
	const maxFiles = options.maxFiles ?? DEFAULT_MANIFEST_FILE_LIMIT;
	const terms = promptTerms(options.prompt ?? "");
	const scored = index.files
		.map((file) => ({ path: file.path, score: scorePathForPrompt(file.path, terms) }))
		.filter((file) => file.score > 0)
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	const seedFiles =
		scored.length > 0
			? scored.slice(0, maxFiles).map((file) => file.path)
			: index.files.slice(0, maxFiles).map((file) => file.path);
	const files = expandImportNeighborhood(seedFiles, index).slice(0, maxFiles);
	const fileSet = new Set(files);
	return {
		files,
		testFiles: index.testFiles.filter((file) => fileSet.has(file)),
		packageScripts: index.packageScripts,
		likelyVerifier: likelyVerifierFromIndex(index),
		importEdges: index.importEdges.filter((edge) => fileSet.has(edge.from) && fileSet.has(edge.to)),
		repoMap: buildWorkspaceRepoMap(index),
	};
}

export function buildWorkspaceRepoMap(index: WorkspaceIndex): WorkspaceRepoMap {
	const directoryCounts = new Map<string, number>();
	const extensionCounts = new Map<string, number>();
	for (const file of index.files) {
		const firstSegment = file.path.includes("/") ? file.path.slice(0, file.path.indexOf("/")) : ".";
		directoryCounts.set(firstSegment, (directoryCounts.get(firstSegment) ?? 0) + 1);
		const extension = file.extension || "(none)";
		extensionCounts.set(extension, (extensionCounts.get(extension) ?? 0) + 1);
	}
	const topDirectories = [...directoryCounts.entries()]
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		.slice(0, 8)
		.map(([directory]) => directory);
	const topExtensions = [...extensionCounts.entries()]
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		.slice(0, 8)
		.map(([extension, count]) => ({ extension, count }));
	const entrypoints = index.files
		.map((file) => file.path)
		.filter((file) => /(^|\/)(main|index|cli|app|server)\.[cm]?[jt]sx?$/i.test(file))
		.slice(0, 12);
	return {
		rootDir: index.rootDir,
		topDirectories,
		entrypoints,
		topExtensions,
		packageManagerFiles: index.packageManagerFiles,
		testFileCount: index.testFiles.length,
	};
}

export function formatWorkspaceManifest(manifest: WorkspaceManifest): string {
	const lines = ["", "Controlled workspace manifest:"];
	if (manifest.repoMap) {
		lines.push(formatWorkspaceRepoMap(manifest.repoMap));
	}
	if (manifest.files.length > 0) {
		lines.push("Relevant files:");
		for (const file of manifest.files) lines.push(`- ${file}`);
	}
	if (manifest.testFiles.length > 0) {
		lines.push("Relevant tests:");
		for (const file of manifest.testFiles) lines.push(`- ${file}`);
	}
	if (manifest.likelyVerifier) lines.push(`Likely verifier: ${manifest.likelyVerifier}`);
	const scriptEntries = Object.entries(manifest.packageScripts).slice(0, 5);
	if (scriptEntries.length > 0) {
		lines.push("Package scripts:");
		for (const [name, command] of scriptEntries) lines.push(`- ${name}: ${command}`);
	}
	if (manifest.importEdges.length > 0) {
		lines.push("Import edges:");
		for (const edge of manifest.importEdges.slice(0, 12)) lines.push(`- ${edge.from} -> ${edge.to}`);
	}
	lines.push("Use these exact relative paths when possible. Prefer direct reads over broad discovery.");
	return lines.join("\n");
}

export function formatWorkspaceRepoMap(repoMap: WorkspaceRepoMap): string {
	const lines = ["Repo map:"];
	if (repoMap.topDirectories.length > 0) lines.push(`- top directories: ${repoMap.topDirectories.join(", ")}`);
	if (repoMap.entrypoints.length > 0) lines.push(`- entrypoints: ${repoMap.entrypoints.join(", ")}`);
	if (repoMap.packageManagerFiles.length > 0) {
		lines.push(`- package files: ${repoMap.packageManagerFiles.slice(0, 6).join(", ")}`);
	}
	if (repoMap.topExtensions.length > 0) {
		lines.push(`- file types: ${repoMap.topExtensions.map((item) => `${item.extension}=${item.count}`).join(", ")}`);
	}
	lines.push(`- test files: ${repoMap.testFileCount}`);
	return lines.join("\n");
}
