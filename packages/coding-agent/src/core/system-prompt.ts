/**
 * System prompt construction and project context loading
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

/**
 * Render a stable top-level listing of the workspace for system-prompt grounding.
 * Directories first (trailing slash), `.git` skipped, capped with a "+N more" marker.
 * Returns "" when the directory can't be read (grounding is best-effort).
 */
export function buildWorkspaceSnapshot(cwd: string, maxEntries = 100): string {
	const entries: Array<{ name: string; isDir: boolean }> = [];
	try {
		for (const name of readdirSync(cwd)) {
			if (name === ".git") continue;
			let isDir = false;
			try {
				isDir = statSync(join(cwd, name)).isDirectory();
			} catch {
				// broken symlink or unreadable entry — list it as a file
			}
			entries.push({ name, isDir });
		}
	} catch {
		return "";
	}
	entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
	const shown = entries.slice(0, maxEntries);
	const lines = shown.map((entry) => (entry.isDir ? `${entry.name}/` : entry.name));
	if (entries.length > shown.length) {
		lines.push(`… +${entries.length - shown.length} more`);
	}
	return lines.join("\n");
}

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Pre-rendered top-level workspace listing (stable snapshot taken at session start). */
	workspaceSnapshot?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
	/** Optional active model provider for prompt-shape tuning. */
	modelProvider?: string;
	/** Optional active model context window for prompt-shape tuning. */
	contextWindow?: number;
}

function appendContextFiles(prompt: string, contextFiles: Array<{ path: string; content: string }>): string {
	if (contextFiles.length === 0) return prompt;
	let next = `${prompt}\n\n# Project Context\n\nLoaded context files:\n\n`;
	for (const { path: filePath, content } of contextFiles) {
		next += `## ${filePath}\n\n${content}\n\n`;
	}
	return next;
}

function buildAg1DocsSection(readmePath: string, docsPath: string, examplesPath: string): string {
	return [
		"AG1 docs: only for AG1-specific work.",
		`README ${readmePath}`,
		`Docs ${docsPath}`,
		`Examples ${examplesPath}`,
		"Follow markdown cross-references before implementing.",
	].join("\n");
}

function buildCompactAg1DocsSection(readmePath: string, docsPath: string, examplesPath: string): string {
	return `AG1 docs only for AG1-specific work: README ${readmePath} | Docs ${docsPath} | Examples ${examplesPath}`;
}

/**
 * The AG1-docs pointer section is only useful when the workspace IS AG1 development
 * (the repo or an @ag1 package). Everywhere else it's dead tokens on every turn.
 * Deterministic check: the workspace package.json name is "ag1*" or "@ag1/*".
 */
function isAg1Workspace(cwd: string): boolean {
	try {
		const pkgPath = join(cwd, "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string };
		return (
			typeof pkg.name === "string" &&
			(pkg.name === "ag1" || pkg.name.startsWith("ag1-") || pkg.name.startsWith("@ag1/"))
		);
	} catch {
		return false;
	}
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
		modelProvider,
		contextWindow,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const date = new Date().toISOString().slice(0, 10);

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	// Stable grounding block: lets the model skip the ls/pwd discovery turns. Must be
	// byte-identical across turns within a session (prompt-cache friendly), so callers
	// pass a memoized snapshot rather than a live listing.
	const workspaceSection = options.workspaceSnapshot
		? `\nTop-level workspace entries (snapshot at session start):\n${options.workspaceSnapshot}`
		: "";

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		prompt = appendContextFiles(prompt, contextFiles);

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date and working directory last
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;
		prompt += workspaceSection;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();
	const compactPromptProfile =
		modelProvider === "local" || ((contextWindow ?? 0) > 0 && (contextWindow ?? 0) <= 64_000);

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");
	const hasWebSearch = tools.includes("webSearch");
	const hasWebFetch = tools.includes("webFetch");
	const hasMutatingTools = hasBash || tools.includes("edit") || tools.includes("write");
	const hasReadOnlyExploration = hasRead || hasGrep || hasFind || hasLs || hasWebSearch || hasWebFetch;

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations such as ls, rg, and find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}
	if (hasWebSearch && hasWebFetch) {
		addGuideline("For online research, use webSearch for candidate sources and webFetch for the best URL");
		addGuideline("Prefer authoritative sources such as official docs, vendor docs, specs, and release notes");
		addGuideline("Keep source URLs available when online information affects the answer");
	} else if (hasWebSearch) {
		addGuideline("Use webSearch when the task depends on current online information instead of guessing");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	const roleLine = compactPromptProfile
		? hasMutatingTools
			? "You are a coding assistant inside AG1. Use tools sparingly, inspect evidence carefully, and answer precisely."
			: hasReadOnlyExploration
				? "You are a coding assistant inside AG1. Use the available read-only/research tools sparingly and answer precisely."
				: "You are a coding assistant inside AG1. Answer precisely using only the available context."
		: hasMutatingTools
			? "You are an expert coding assistant inside AG1. Use the available tools to inspect code, run commands, edit files, and answer precisely."
			: hasReadOnlyExploration
				? "You are an expert coding assistant inside AG1. Use the available read-only and research tools to inspect evidence and answer precisely."
				: "You are an expert coding assistant inside AG1. Answer precisely using only the available context.";

	let prompt = `${roleLine}

Available tools:
${toolsList}

Guidelines:
${guidelines}`;

	// AG1-docs pointer only earns its tokens in AG1 workspaces (see isAg1Workspace).
	if (isAg1Workspace(resolvedCwd)) {
		prompt += `\n\n${compactPromptProfile ? buildCompactAg1DocsSection(readmePath, docsPath, examplesPath) : buildAg1DocsSection(readmePath, docsPath, examplesPath)}`;
	}

	if (appendSection) {
		prompt += appendSection;
	}

	prompt = appendContextFiles(prompt, contextFiles);

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Add date and working directory last
	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;
	prompt += workspaceSection;

	return prompt;
}
