import { isContainedPath, resolveToCwd } from "./tools/path-utils.js";

export type SafetyMode = "disabled" | "interactive" | "planning" | "autonomous" | "headless";
export type SafetyRisk = "low" | "medium" | "high" | "critical";

export interface ToolApprovalRequest {
	mode: Exclude<SafetyMode, "disabled">;
	toolName: string;
	risk: SafetyRisk;
	summary: string;
	details: string;
}

export type ToolApprovalHandler = (request: ToolApprovalRequest) => Promise<boolean>;

export interface ToolSafetyPolicy {
	mode: SafetyMode;
	cwd: string;
	approvalHandler?: ToolApprovalHandler;
	planningReadOnlyTools?: "allow" | "block";
}

export interface ToolSafetyDecision {
	allow: boolean;
	reason?: string;
	approvalRequest?: ToolApprovalRequest;
}

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const PLANNING_EXPLORATION_TOOLS = new Set(["read", "grep", "find", "ls", "webSearch", "webFetch"]);
const FILE_MUTATION_TOOLS = new Set(["write", "edit", "notebook_edit", "NotebookEdit"]);
const BRACED_HOME_TOKEN = "$" + "{HOME}";

const FORBIDDEN_SHELL_RULES: Array<{ pattern: RegExp; reason: string }> = [
	{
		pattern: /\b(?:sudo|doas)\b|\bsu\s+-c\b/i,
		reason: "Privileged shell commands are not allowed.",
	},
	{
		pattern: /\brm\s+-[^\n;&|]*[rf][^\n;&|]*\s+(?:--\s+)?\/(?:\s|$)/i,
		reason: "Refusing to run rm -rf against the filesystem root.",
	},
	{
		pattern: /\brm\s+-[^\n;&|]*[rf][^\n;&|]*\s+(?:--\s+)?\/\*(?:\s|$)/i,
		reason: "Refusing to run rm -rf against the root filesystem contents.",
	},
	{
		pattern: /\brm\s+-[^\n;&|]*[rf][^\n;&|]*\s+(?:--\s+)?(~|\$HOME|\$\{HOME\})(?:\/|\s|$)/i,
		reason: "Refusing to run rm -rf against the home directory.",
	},
	{
		pattern: /\bmkfs(?:\.[a-z0-9_+-]+)?\b|\b(?:fdisk|parted|sfdisk)\b/i,
		reason: "Disk formatting and partitioning commands are not allowed.",
	},
	{
		pattern: /\bdd\b[^\n]*(?:\sof=(?:\/dev\/|[A-Za-z]:))/i,
		reason: "Raw disk writes are not allowed.",
	},
	{
		pattern: /\b(?:shutdown|reboot|poweroff|halt|init\s+0)\b/i,
		reason: "Host shutdown commands are not allowed.",
	},
	{
		pattern: /:\(\)\s*\{\s*:\|:\s*&\s*};\s*:/,
		reason: "Fork bombs are not allowed.",
	},
];
const ALLOWED_SYSTEM_PATH_PREFIXES = [
	"/bin/",
	"/usr/bin/",
	"/usr/local/bin/",
	"/nix/store/",
	"/opt/homebrew/bin/",
	"/snap/bin/",
];
const HEADLESS_READ_ONLY_GUIDANCE = "Use read, grep, find, ls, webSearch, or webFetch instead.";

function trimForDisplay(value: string, max = 240): string {
	const trimmed = value.trim();
	if (trimmed.length <= max) {
		return trimmed;
	}
	return `${trimmed.slice(0, max - 3)}...`;
}

function getToolPath(args: unknown): string | undefined {
	if (!args || typeof args !== "object") {
		return undefined;
	}
	const maybePath =
		(args as { path?: unknown; file_path?: unknown }).path ?? (args as { file_path?: unknown }).file_path;
	return typeof maybePath === "string" ? maybePath : undefined;
}

function getBashCommand(args: unknown): string | undefined {
	if (!args || typeof args !== "object") {
		return undefined;
	}
	const command = (args as { command?: unknown }).command;
	return typeof command === "string" ? command : undefined;
}

function buildApprovalRequest(
	policy: ToolSafetyPolicy,
	toolName: string,
	risk: SafetyRisk,
	summary: string,
	details: string,
): ToolApprovalRequest {
	return {
		mode: policy.mode as Exclude<SafetyMode, "disabled">,
		toolName,
		risk,
		summary,
		details,
	};
}

function normalizeShellPathToken(token: string): string {
	return token.replace(/^[("'`]+/, "").replace(/[)"'`,:;]+$/, "");
}

function findOutOfWorkspaceShellPath(command: string, cwd: string): string | undefined {
	const pathTokenPattern =
		/(?:^|[\s=:(['"`])((?:\/|~(?:\/|$)|(?:\$HOME|\$\{HOME\})(?:\/|$)|(?:\.\.\/)+)[^\s"'`|&;<>)]*)/g;

	for (const match of command.matchAll(pathTokenPattern)) {
		const rawToken = match[1];
		if (!rawToken) continue;

		const token = normalizeShellPathToken(rawToken);
		if (!token || token === "/") continue;

		if (
			token === "~" ||
			token.startsWith("~/") ||
			token === "$HOME" ||
			token === BRACED_HOME_TOKEN ||
			token.startsWith("$HOME/") ||
			token.startsWith(`${BRACED_HOME_TOKEN}/`)
		) {
			return token;
		}

		if (token.startsWith("/")) {
			if (ALLOWED_SYSTEM_PATH_PREFIXES.some((prefix) => token.startsWith(prefix))) {
				continue;
			}
			if (!isContainedPath(token, cwd, { allowMissing: true })) {
				return token;
			}
			continue;
		}

		if (token.startsWith("../")) {
			if (!isContainedPath(token, cwd, { allowMissing: true })) {
				return token;
			}
		}
	}

	return undefined;
}

function evaluateFileMutationTool(toolName: string, args: unknown, policy: ToolSafetyPolicy): ToolSafetyDecision {
	const targetPath = getToolPath(args);
	const absolutePath = targetPath ? resolveToCwd(targetPath, policy.cwd) : undefined;
	const outsideWorkspace = targetPath ? !isContainedPath(targetPath, policy.cwd, { allowMissing: true }) : false;

	if (outsideWorkspace) {
		if (policy.mode === "interactive") {
			return {
				allow: true,
				approvalRequest: buildApprovalRequest(
					policy,
					toolName,
					"critical",
					`Approve ${toolName} outside the session workspace?`,
					`Tool: ${toolName}\nRequested path: ${targetPath}\nResolved path: ${absolutePath}\nWorkspace root: ${policy.cwd}\n\nThis writes outside the active project workspace.`,
				),
			};
		}

		return {
			allow: false,
			reason: `Blocking ${toolName} outside the session workspace in ${policy.mode} mode: ${absolutePath}`,
		};
	}

	if (policy.mode === "autonomous") {
		return { allow: true };
	}

	if (policy.mode === "interactive") {
		return {
			allow: true,
			approvalRequest: buildApprovalRequest(
				policy,
				toolName,
				"high",
				`Approve ${toolName} in the workspace?`,
				`Tool: ${toolName}\nPath: ${targetPath ?? "(unknown)"}\nResolved path: ${absolutePath ?? "(unknown)"}\nWorkspace root: ${policy.cwd}`,
			),
		};
	}

	if (policy.mode === "planning") {
		return {
			allow: false,
			reason: `${toolName} is blocked in planning mode. Planning mode is read-only and does not allow file edits.`,
		};
	}

	return {
		allow: false,
		reason: `${toolName} requires interactive approval and is blocked in headless mode. ${HEADLESS_READ_ONLY_GUIDANCE}`,
	};
}

function evaluateBashTool(args: unknown, policy: ToolSafetyPolicy): ToolSafetyDecision {
	const command = getBashCommand(args);
	if (!command) {
		return { allow: true };
	}

	for (const rule of FORBIDDEN_SHELL_RULES) {
		if (rule.pattern.test(command)) {
			return { allow: false, reason: rule.reason };
		}
	}

	if (policy.mode === "autonomous" || policy.mode === "headless") {
		const outsideWorkspacePath = findOutOfWorkspaceShellPath(command, policy.cwd);
		if (outsideWorkspacePath) {
			return {
				allow: false,
				reason: `Blocking bash access outside the session workspace in ${policy.mode} mode: ${outsideWorkspacePath}`,
			};
		}
	}

	if (policy.mode === "autonomous") {
		return { allow: true };
	}

	if (policy.mode === "interactive") {
		return {
			allow: true,
			approvalRequest: buildApprovalRequest(
				policy,
				"bash",
				"high",
				"Unrestricted shell execution",
				`Command:\n${trimForDisplay(command, 600)}\n\nWorking directory: ${policy.cwd}\n\nBash is unrestricted and may modify files, install packages, or invoke external programs.`,
			),
		};
	}

	if (policy.mode === "planning") {
		return {
			allow: false,
			reason:
				"Bash execution is blocked in planning mode. Planning mode is read-only and should produce a plan, not execute commands.",
		};
	}

	return {
		allow: false,
		reason: `Bash execution requires interactive approval and is blocked in headless mode. ${HEADLESS_READ_ONLY_GUIDANCE}`,
	};
}

/**
 * Evaluate whether a tool call should be allowed, blocked, or approved first.
 *
 * The policy is intentionally conservative:
 * - Read-only tools are always allowed.
 * - File mutation tools require explicit approval in interactive mode.
 * - Bash is always approval-gated in interactive mode and blocked in headless mode.
 * - A small set of catastrophic shell commands is blocked everywhere.
 * - Autonomous mode skips per-tool prompts but still inherits the hard block list.
 */
export function evaluateToolSafety(toolName: string, args: unknown, policy: ToolSafetyPolicy): ToolSafetyDecision {
	if (policy.mode === "disabled") {
		return { allow: true };
	}

	if (
		policy.mode === "planning" &&
		policy.planningReadOnlyTools === "block" &&
		PLANNING_EXPLORATION_TOOLS.has(toolName)
	) {
		return {
			allow: false,
			reason: `${toolName} is blocked for this planning turn. Planning must clarify or plan first before exploring files or the web.`,
		};
	}

	if (READ_ONLY_TOOLS.has(toolName)) {
		return { allow: true };
	}

	if (FILE_MUTATION_TOOLS.has(toolName)) {
		return evaluateFileMutationTool(toolName, args, policy);
	}

	if (toolName === "bash") {
		return evaluateBashTool(args, policy);
	}

	return { allow: true };
}
