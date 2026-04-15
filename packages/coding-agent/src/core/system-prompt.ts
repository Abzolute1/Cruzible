/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

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
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

function appendContextFiles(prompt: string, contextFiles: Array<{ path: string; content: string }>): string {
	if (contextFiles.length === 0) return prompt;
	let next = `${prompt}\n\n# Project Context\n\nLoaded context files:\n\n`;
	for (const { path: filePath, content } of contextFiles) {
		next += `## ${filePath}\n\n${content}\n\n`;
	}
	return next;
}

function buildPiDocsSection(readmePath: string, docsPath: string, examplesPath: string): string {
	return [
		"Pi docs: only for pi-specific work.",
		`README ${readmePath}`,
		`Docs ${docsPath}`,
		`Examples ${examplesPath}`,
		"Follow markdown cross-references before implementing.",
	].join("\n");
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
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const date = new Date().toISOString().slice(0, 10);

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

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

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

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

	const roleLine = hasMutatingTools
		? "You are an expert coding assistant inside pi. Use the available tools to inspect code, run commands, edit files, and answer precisely."
		: hasReadOnlyExploration
			? "You are an expert coding assistant inside pi. Use the available read-only and research tools to inspect evidence and answer precisely."
			: "You are an expert coding assistant inside pi. Answer precisely using only the available context."

	let prompt = `${roleLine}

Available tools:
${toolsList}

Guidelines:
${guidelines}

${buildPiDocsSection(readmePath, docsPath, examplesPath)}`;

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

	return prompt;
}
