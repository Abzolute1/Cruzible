// Auton — Verify Tool
// Auto-detects test/build/lint commands from project files and runs them.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { execCommand } from "../../exec.js";
import type { ToolDefinition } from "../../extensions/types.js";

export interface VerifyResult {
	passed: boolean;
	commands: VerifyCommandResult[];
	summary: string;
}

export interface VerifyCommandResult {
	command: string;
	type: "test" | "build" | "lint";
	exitCode: number;
	stdout: string;
	stderr: string;
	passed: boolean;
	summary?: string;
}

const MAX_OUTPUT_CHARS = 10000;

function truncateOutput(output: string): string {
	if (output.length <= MAX_OUTPUT_CHARS) return output;
	return (
		output.slice(0, MAX_OUTPUT_CHARS) +
		`\n\n[Output truncated: ${output.length - MAX_OUTPUT_CHARS} more characters omitted]`
	);
}

function extractTestSummary(output: string): string | undefined {
	const testMatch = output.match(/(\d+)\s+(passed|failed|skipped)/gi);
	if (testMatch) return testMatch.join(", ");

	const jestMatch = output.match(/Tests:\s+(\d+)\s+passed/i);
	if (jestMatch) return jestMatch[0];

	return undefined;
}

interface ProjectConfig {
	type: "test" | "build" | "lint";
	command: string;
	cwd: string;
}

function detectProjectCommands(cwd: string): ProjectConfig[] {
	const commands: ProjectConfig[] = [];

	// Node.js / npm
	const packageJsonPath = join(cwd, "package.json");
	if (existsSync(packageJsonPath)) {
		try {
			const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
			const scripts = pkg.scripts || {};

			if (scripts.test) {
				commands.push({ type: "test", command: `npm test`, cwd });
			}
			if (scripts["test:unit"] || scripts.unit) {
				commands.push({ type: "test", command: `npm run ${scripts["test:unit"] ? "test:unit" : "unit"}`, cwd });
			}
			if (scripts.lint) {
				commands.push({ type: "lint", command: `npm run lint`, cwd });
			}
			if (scripts.build || scripts.compile) {
				commands.push({ type: "build", command: `npm run ${scripts.build ? "build" : "compile"}`, cwd });
			}
			// Default: if no test script but has jest/vitest/mocha dependency
			const deps = { ...pkg.dependencies, ...pkg.devDependencies };
			if (!scripts.test && (deps.jest || deps.vitest || deps.mocha || deps["jest-cli"] || deps["@jest/core"])) {
				commands.push({ type: "test", command: "npx jest --passWithNoTests", cwd });
			}
		} catch {
			/* ignore */
		}
	}

	// Cargo / Rust
	const cargoPath = join(cwd, "Cargo.toml");
	if (existsSync(cargoPath)) {
		commands.push({ type: "build", command: "cargo build", cwd });
		commands.push({ type: "test", command: "cargo test", cwd });
	}

	// Go
	const goModPath = join(cwd, "go.mod");
	if (existsSync(goModPath)) {
		commands.push({ type: "build", command: "go build ./...", cwd });
		commands.push({ type: "test", command: "go test ./...", cwd });
	}

	// Makefile
	const makefilePath = join(cwd, "Makefile");
	if (existsSync(makefilePath)) {
		commands.push({ type: "build", command: "make", cwd });
		if (existsSync(join(cwd, "Makefile"))) {
			// Check if Makefile has test target
			try {
				const makefile = readFileSync(makefilePath, "utf-8");
				if (/^test\s*:/m.test(makefile)) {
					commands.push({ type: "test", command: "make test", cwd });
				}
			} catch {
				/* ignore */
			}
		}
	}

	// Python (pyproject.toml)
	const pyprojectPath = join(cwd, "pyproject.toml");
	if (existsSync(pyprojectPath)) {
		try {
			const pyproject = readFileSync(pyprojectPath, "utf-8");
			if (pyproject.includes("pytest") || pyproject.includes("unittest")) {
				commands.push({ type: "test", command: "python -m pytest", cwd });
			}
			if (pyproject.includes("ruff") || pyproject.includes("flake8") || pyproject.includes("pylint")) {
				commands.push({ type: "lint", command: "ruff check . || flake8 || pylint .", cwd });
			}
		} catch {
			/* ignore */
		}
	}

	// If no commands detected, return empty
	return commands;
}

async function runCommand(command: string, cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	try {
		const result = await execCommand("bash", ["-c", command], cwd, { timeout: 120000 });
		return {
			exitCode: result.code,
			stdout: result.stdout || "",
			stderr: result.stderr || "",
		};
	} catch (err: any) {
		return {
			exitCode: err.code ?? 1,
			stdout: err.stdout || "",
			stderr: err.stderr || err.message || "",
		};
	}
}

const verifyParamsSchema = Type.Object({
	cwd: Type.Optional(Type.String({ description: "Working directory (defaults to project root)" })),
	command: Type.Optional(Type.String({ description: "Specific command to run instead of auto-detecting" })),
});
type VerifyParams = Static<typeof verifyParamsSchema>;

export const verifyToolDefinition: ToolDefinition<typeof verifyParamsSchema, undefined, undefined> = {
	name: "Verify",
	label: "Verify",
	description:
		"Auto-detects and runs test/build/lint commands for the current project. Returns structured pass/fail results.",
	parameters: verifyParamsSchema,
	execute: async (
		_toolCallId: string,
		params: VerifyParams,
		_signal: AbortSignal | undefined,
		_onUpdate: (update: unknown) => Promise<void>,
		_ctx: unknown,
	) => {
		const cwd = params.cwd || process.cwd();
		const specificCommand = params.command;

		let commands: ProjectConfig[];

		if (specificCommand) {
			commands = [{ type: "test", command: specificCommand, cwd }];
		} else {
			commands = detectProjectCommands(cwd);
		}

		if (commands.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `No test/build/lint commands detected for this project.

Supported project types and what to add:
- npm/Node.js (package.json): Add "test", "lint", or "build" scripts
- Cargo/Rust (Cargo.toml): Ensure Cargo.toml exists — runs "cargo build" and "cargo test"
- Go (go.mod): Ensure go.mod exists — runs "go build ./..." and "go test ./..."
- Makefile: Add "test" target — runs "make" and "make test"
- Python (pyproject.toml): Add pytest/ruff dependencies

Quick start for npm projects:
  npm pkg set scripts.test="vitest run"
  npm pkg set scripts.lint="biome check ."
  npm pkg set scripts.build="tsc"`,
					},
				],
				details: undefined,
			};
		}

		const results: VerifyCommandResult[] = [];
		let allPassed = true;

		for (const cmd of commands) {
			const { exitCode, stdout, stderr } = await runCommand(cmd.command, cmd.cwd);
			const passed = exitCode === 0;
			if (!passed) allPassed = false;

			results.push({
				command: cmd.command,
				type: cmd.type,
				exitCode,
				stdout: truncateOutput(stdout),
				stderr: truncateOutput(stderr),
				passed,
				summary: cmd.type === "test" ? extractTestSummary(stdout + stderr) : undefined,
			});
		}

		const passedCount = results.filter((r) => r.passed).length;
		const totalCount = results.length;

		const summary = allPassed
			? `✓ All ${totalCount} command(s) passed.`
			: `✗ ${passedCount}/${totalCount} command(s) passed.`;

		const output = [
			`## Verify Results: ${summary}`,
			"",
			...results.map((r) =>
				[
					`### ${r.passed ? "✓" : "✗"} ${r.command}`,
					`Type: ${r.type} | Exit code: ${r.exitCode}`,
					r.summary ? `Summary: ${r.summary}` : "",
					r.stderr && !r.passed ? `\nStderr:\n\`\`\`\n${r.stderr.slice(0, 2000)}\n\`\`\`` : "",
					r.stdout && !r.passed ? `\nStdout:\n\`\`\`\n${r.stdout.slice(0, 2000)}\n\`\`\`` : "",
				]
					.filter(Boolean)
					.join("\n"),
			),
		].join("\n");

		return {
			content: [{ type: "text", text: output }],
			details: undefined,
		};
	},
};
