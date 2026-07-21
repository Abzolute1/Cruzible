import type { BashOperations } from "./bash.js";

export type BashSandboxBackendKind = "local" | "command-template";

export interface BashSandboxBackendConfig {
	kind: BashSandboxBackendKind;
	template?: string;
}

const SANDBOX_TEMPLATE_ENV = "AG1_BASH_SANDBOX_COMMAND";

export function resolveBashSandboxBackendFromEnv(env: NodeJS.ProcessEnv = process.env): BashSandboxBackendConfig {
	const template = env[SANDBOX_TEMPLATE_ENV]?.trim();
	if (!template) {
		return { kind: "local" };
	}
	return { kind: "command-template", template };
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function renderBashSandboxCommand(template: string, command: string, cwd: string): string {
	const replacements = new Map([
		["{command}", shellQuote(command)],
		["{cwd}", shellQuote(cwd)],
	]);
	let rendered = template;
	for (const [placeholder, value] of replacements) {
		rendered = rendered.replaceAll(placeholder, value);
	}
	if (!template.includes("{command}")) {
		rendered = `${rendered} ${shellQuote(command)}`;
	}
	return rendered;
}

export function describeBashSandboxBackend(config: BashSandboxBackendConfig): string {
	if (config.kind === "local") {
		return "local";
	}
	return "command-template";
}

export function createSandboxedBashOperations(
	operations: BashOperations,
	config: BashSandboxBackendConfig = resolveBashSandboxBackendFromEnv(),
): BashOperations {
	if (config.kind === "local") {
		return operations;
	}
	const template = config.template;
	if (!template) {
		return operations;
	}
	return {
		exec: (command, cwd, options) => operations.exec(renderBashSandboxCommand(template, command, cwd), cwd, options),
	};
}
