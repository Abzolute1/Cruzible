import { accessSync, constants, existsSync, lstatSync, realpathSync } from "node:fs";
import * as os from "node:os";
import { dirname, isAbsolute, relative, resolve as resolvePath } from "node:path";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";
function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./g, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
	// macOS stores filenames in NFD (decomposed) form, try converting user input to NFD
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	// macOS uses U+2019 (right single quotation mark) in screenshot names like "Capture d'écran"
	// Users typically type U+0027 (straight apostrophe)
	return filePath.replace(/'/g, "\u2019");
}

function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function normalizeAtPrefix(filePath: string): string {
	return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

export function expandPath(filePath: string): string {
	const normalized = normalizeUnicodeSpaces(normalizeAtPrefix(filePath));
	if (normalized === "~") {
		return os.homedir();
	}
	if (normalized.startsWith("~/")) {
		return os.homedir() + normalized.slice(1);
	}
	return normalized;
}

/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	const expanded = expandPath(filePath);
	if (isAbsolute(expanded)) {
		return expanded;
	}
	return resolvePath(cwd, expanded);
}

function repairWorkspaceAbsoluteWithoutLeadingSlash(filePath: string, cwd: string): string {
	const normalizedCwd = resolvePath(cwd).replace(/\\/g, "/");
	const cwdSansLeadingSlash = normalizedCwd.replace(/^\//, "");
	const normalizedInput = expandPath(filePath).replace(/\\/g, "/");
	if (
		!isAbsolute(normalizedInput) &&
		(normalizedInput === cwdSansLeadingSlash || normalizedInput.startsWith(`${cwdSansLeadingSlash}/`))
	) {
		return `/${normalizedInput}`;
	}
	return filePath;
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
	const rel = relative(rootPath, targetPath);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function findNearestExistingAncestor(targetPath: string): string | undefined {
	let current = resolvePath(targetPath);
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
	return current;
}

function assertNoSymlinkTraversal(rootPath: string, targetPath: string): void {
	const normalizedRoot = resolvePath(rootPath);
	const normalizedTarget = resolvePath(targetPath);
	const rel = relative(normalizedRoot, normalizedTarget);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`Path escapes the workspace: ${normalizedTarget}`);
	}

	let current = normalizedRoot;
	for (const segment of rel.split(/[/\\]/).filter(Boolean)) {
		current = resolvePath(current, segment);
		if (!existsSync(current)) {
			break;
		}
		if (lstatSync(current).isSymbolicLink()) {
			throw new Error(`Refusing to access symlinked path component: ${current}`);
		}
	}
}

export function resolveContainedPath(
	filePath: string,
	cwd: string,
	options?: { allowMissing?: boolean },
): string {
	const normalizedCwd = resolvePath(cwd);
	const workspaceRoot = realpathSync(normalizedCwd);
	const resolvedPath = resolveToCwd(repairWorkspaceAbsoluteWithoutLeadingSlash(filePath, normalizedCwd), normalizedCwd);

	if (existsSync(resolvedPath)) {
		assertNoSymlinkTraversal(normalizedCwd, resolvedPath);
		if (lstatSync(resolvedPath).isSymbolicLink()) {
			throw new Error(`Refusing to access symlinked path: ${resolvedPath}`);
		}
		const realTarget = realpathSync(resolvedPath);
		if (!isPathInsideRoot(realTarget, workspaceRoot)) {
			throw new Error(`Path resolves outside the workspace: ${resolvedPath}`);
		}
		return realTarget;
	}

	const ancestor = findNearestExistingAncestor(resolvedPath);
	if (!ancestor) {
		throw new Error(`Unable to resolve path inside the workspace: ${resolvedPath}`);
	}
	assertNoSymlinkTraversal(normalizedCwd, ancestor);
	const ancestorReal = realpathSync(ancestor);
	if (!isPathInsideRoot(ancestorReal, workspaceRoot)) {
		throw new Error(`Path resolves outside the workspace: ${resolvedPath}`);
	}
	const suffix = relative(ancestor, resolvedPath);
	const candidate = resolvePath(ancestorReal, suffix);
	if (!isPathInsideRoot(candidate, workspaceRoot)) {
		throw new Error(`Path resolves outside the workspace: ${resolvedPath}`);
	}
	return candidate;
}

export function isContainedPath(
	filePath: string,
	cwd: string,
	options?: { allowMissing?: boolean },
): boolean {
	try {
		resolveContainedPath(filePath, cwd, options);
		return true;
	} catch {
		return false;
	}
}

export function resolveReadPath(filePath: string, cwd: string): string {
	const resolved = resolveContainedPath(filePath, cwd);

	if (fileExists(resolved)) {
		return resolved;
	}

	// Try macOS AM/PM variant (narrow no-break space before AM/PM)
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && fileExists(amPmVariant)) {
		return amPmVariant;
	}

	// Try NFD variant (macOS stores filenames in NFD form)
	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && fileExists(nfdVariant)) {
		return nfdVariant;
	}

	// Try curly quote variant (macOS uses U+2019 in screenshot names)
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && fileExists(curlyVariant)) {
		return curlyVariant;
	}

	// Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) {
		return nfdCurlyVariant;
	}

	return resolved;
}
