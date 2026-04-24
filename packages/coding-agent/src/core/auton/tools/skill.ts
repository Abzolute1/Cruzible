// Auton — Skill Tool
// Finds and executes SKILL.md files.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { execCommand } from "../../exec.js";
import type { ToolDefinition } from "../../extensions/types.js";

const MAX_OUTPUT_CHARS = 20000;

function truncateOutput(output: string): string {
	if (output.length <= MAX_OUTPUT_CHARS) return output;
	return (
		output.slice(0, MAX_OUTPUT_CHARS) +
		`\n\n[Output truncated: ${output.length - MAX_OUTPUT_CHARS} more characters omitted]`
	);
}

interface SkillInfo {
	name: string;
	path: string;
	description: string;
	content: string;
}

function findSkillDirectories(cwd: string): string[] {
	const skills: string[] = [];

	// Search in common skill locations:
	// 1. .ag1/skills/ in the project
	// 2. .skills/ in the project
	// 3. .ag1/skills/ in home directory
	// 4. Any directory containing a SKILL.md file

	const candidates = [
		join(cwd, ".ag1", "skills"),
		join(cwd, ".skills"),
		join(process.env.HOME || "", ".ag1", "skills"),
		join(cwd, "skills"),
	];

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			try {
				const entries = readdirSync(candidate);
				for (const entry of entries) {
					const fullPath = join(candidate, entry);
					if (statSync(fullPath).isDirectory()) {
						const skillMdPath = join(fullPath, "SKILL.md");
						if (existsSync(skillMdPath)) {
							skills.push(fullPath);
						}
					}
				}
			} catch {
				// ignore
			}
		}
	}

	// Also search for any SKILL.md in the project root
	const rootSkillMd = join(cwd, "SKILL.md");
	if (existsSync(rootSkillMd)) {
		skills.push(cwd);
	}

	// Deduplicate
	return [...new Set(skills)];
}

function loadSkill(skillDir: string): SkillInfo | null {
	// SKILL.md can be directly in the directory or the directory name is the skill name
	const skillMdPath = join(skillDir, "SKILL.md");
	if (!existsSync(skillMdPath)) {
		return null;
	}

	try {
		const content = readFileSync(skillMdPath, "utf-8");
		const name = dirname(skillDir) === skillDir ? "skill" : dirname(skillDir).split("/").pop() || "skill";

		// Extract description from first line if it's a heading
		let description = "";
		const lines = content.split("\n");
		for (const line of lines) {
			if (line.startsWith("# ")) {
				description = line.slice(2).trim();
				break;
			} else if (line.trim().length > 0) {
				description = line.trim().slice(0, 200);
				break;
			}
		}

		return { name, path: skillMdPath, description, content };
	} catch {
		return null;
	}
}

function findAllSkills(cwd: string): SkillInfo[] {
	const skillDirs = findSkillDirectories(cwd);
	const skills: SkillInfo[] = [];

	for (const dir of skillDirs) {
		const skill = loadSkill(dir);
		if (skill) {
			skills.push(skill);
		}
	}

	// Also do a broader search for any SKILL.md in the project
	const broaderDirs = searchForSkillMd(cwd);
	for (const dir of broaderDirs) {
		if (!skills.some((s) => s.path === join(dir, "SKILL.md"))) {
			const skill = loadSkill(dir);
			if (skill) {
				skills.push(skill);
			}
		}
	}

	return skills;
}

function searchForSkillMd(startDir: string): string[] {
	const results: string[] = [];
	const maxDepth = 5;
	const maxDirs = 500; // Hard cap to prevent runaway filesystem walks
	let dirsVisited = 0;

	const skipDirs = new Set([
		"node_modules",
		".git",
		".next",
		".nuxt",
		"dist",
		"build",
		"__pycache__",
		".venv",
		"venv",
		"target",
	]);

	function search(dir: string, depth: number) {
		if (depth > maxDepth || dirsVisited >= maxDirs) return;

		try {
			const entries = readdirSync(dir);
			for (const entry of entries) {
				// Skip hidden dirs (except AG1/legacy skill directories) and known large/irrelevant directories
				if (entry.startsWith(".") && entry !== ".ag1") continue;
				if (skipDirs.has(entry)) continue;

				const fullPath = join(dir, entry);
				try {
					const stat = statSync(fullPath);
					if (stat.isDirectory()) {
						const skillMdPath = join(fullPath, "SKILL.md");
						if (existsSync(skillMdPath)) {
							results.push(fullPath);
						} else {
							dirsVisited++;
							search(fullPath, depth + 1);
						}
					}
				} catch {
					// ignore
				}
			}
		} catch {
			// ignore
		}
	}

	search(startDir, 0);
	return results;
}

async function executeSkill(
	skill: SkillInfo,
	args: string | undefined,
	_cwd: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	// Check if the skill has a run script
	const runScriptPath = join(dirname(skill.path), "run.sh");
	const runPyPath = join(dirname(skill.path), "run.py");
	const indexJsPath = join(dirname(skill.path), "index.js");

	try {
		if (existsSync(runScriptPath)) {
			// Sanitize args: reject anything with shell metacharacters
			const parsedArgs = args ? safeParseArgs(args) : [];
			const result = await execCommand("bash", [runScriptPath, ...parsedArgs], dirname(skill.path), {
				signal,
				timeout: 120000,
			});

			let output = `## Skill: ${skill.name}\n\n`;
			if (result.stdout) output += truncateOutput(result.stdout);
			if (result.stderr) output += `\n\nStderr:\n${truncateOutput(result.stderr)}`;
			return output;
		}

		if (existsSync(runPyPath)) {
			const parsedArgs = args ? safeParseArgs(args) : [];
			const result = await execCommand("python3", [runPyPath, ...parsedArgs], dirname(skill.path), {
				signal,
				timeout: 120000,
			});

			let output = `## Skill: ${skill.name}\n\n`;
			if (result.stdout) output += truncateOutput(result.stdout);
			if (result.stderr) output += `\n\nStderr:\n${truncateOutput(result.stderr)}`;
			return output;
		}

		if (existsSync(indexJsPath)) {
			const parsedArgs = args ? safeParseArgs(args) : [];
			const result = await execCommand("node", [indexJsPath, ...parsedArgs], dirname(skill.path), {
				signal,
				timeout: 120000,
			});

			let output = `## Skill: ${skill.name}\n\n`;
			if (result.stdout) output += truncateOutput(result.stdout);
			if (result.stderr) output += `\n\nStderr:\n${truncateOutput(result.stderr)}`;
			return output;
		}

		// No executable found, return the SKILL.md content as instructions
		return `## Skill: ${skill.name}\n\n**Path:** ${skill.path}\n\n**Instructions:**\n\n${skill.content.slice(0, MAX_OUTPUT_CHARS)}`;
	} catch (err: any) {
		return `## Skill: ${skill.name}\n\n**Error executing skill:** ${err.message || String(err)}\n\n**SKILL.md content:**\n\n${skill.content.slice(0, MAX_OUTPUT_CHARS)}`;
	}
}

/**
 * Safely parse a space-separated argument string, respecting quoted substrings.
 * Replaces the naive `args.split(" ")` which broke on quoted arguments and
 * allowed shell metacharacter injection.
 */
function safeParseArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let inSingleQuote = false;
	let inDoubleQuote = false;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];

		// Reject dangerous shell metacharacters (except space, quote, dash, dot, slash, underscore, hyphen)
		if (/[;|&$`\\!#<>{}()]/.test(ch) && !inSingleQuote && !inDoubleQuote) {
			// Skip dangerous characters silently to prevent injection
			continue;
		}

		if (ch === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
			continue;
		}
		if (ch === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
			continue;
		}
		if (ch === " " && !inSingleQuote && !inDoubleQuote) {
			if (current.length > 0) {
				args.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current.length > 0) {
		args.push(current);
	}
	return args;
}

const skillParamsSchema = Type.Object({
	action: Type.Enum(
		{
			execute: "execute",
			list: "list",
		},
		{ description: "Action to perform" },
	),
	name: Type.Optional(Type.String({ description: "Skill name (required for execute)" })),
	args: Type.Optional(Type.String({ description: "Arguments to pass to the skill (optional)" })),
});
type SkillParams = Static<typeof skillParamsSchema>;

export const skillToolDefinition: ToolDefinition<typeof skillParamsSchema, undefined, undefined> = {
	name: "Skill",
	label: "Skill",
	description:
		"Find and execute skills. Skills are defined in SKILL.md files in skill directories. Supports execute and list actions.",
	parameters: skillParamsSchema,
	execute: async (
		_toolCallId: string,
		params: SkillParams,
		signal: AbortSignal | undefined,
		_onUpdate: (update: unknown) => Promise<void>,
		ctx: { cwd?: string } | undefined,
	) => {
		const action = params.action;
		const name = params.name;
		const args = params.args;
		const cwd = ctx?.cwd || process.cwd();

		try {
			switch (action) {
				case "list": {
					const skills = findAllSkills(cwd);

					if (skills.length === 0) {
						return {
							content: [
								{
									type: "text",
									text: "No skills found.\n\nSkills are defined in SKILL.md files.\nPlace them in:\n- .ag1/skills/<name>/SKILL.md\n- .skills/<name>/SKILL.md\n- skills/<name>/SKILL.md\n- Or any subdirectory containing SKILL.md",
								},
							],
							details: undefined,
						};
					}

					const output = [
						`## Available Skills (${skills.length})`,
						"",
						...skills.map(
							(s, i) =>
								`${i + 1}. **${s.name}**\n   Path: ${s.path}\n   ${s.description ? `Description: ${s.description}` : ""}`,
						),
					].join("\n");

					return {
						content: [{ type: "text", text: truncateOutput(output) }],
						details: undefined,
					};
				}

				case "execute": {
					if (!name) {
						return {
							content: [{ type: "text", text: "Error: 'name' is required for execute action." }],
							details: undefined,
						};
					}

					const skills = findAllSkills(cwd);
					const skill = skills.find((s) => s.name.toLowerCase() === name.toLowerCase());

					if (!skill) {
						const skillNames = skills.map((s) => s.name);
						return {
							content: [
								{
									type: "text",
									text: `Skill not found: "${name}"\n\nAvailable skills: ${skillNames.length > 0 ? skillNames.join(", ") : "none"}`,
								},
							],
							details: undefined,
						};
					}

					const result = await executeSkill(skill, args, cwd, signal);
					return {
						content: [{ type: "text", text: truncateOutput(result) }],
						details: undefined,
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Error: Unknown action "${action}". Supported: execute, list.` }],
						details: undefined,
					};
			}
		} catch (err: any) {
			return {
				content: [{ type: "text", text: `Skill Error: ${err.message || String(err)}` }],
				details: undefined,
			};
		}
	},
};
