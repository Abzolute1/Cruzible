import { existsSync } from "node:fs";
import { isPlanningSafeShellCommand } from "./planning-shell.js";
import { findTestPathShellMutation, isTestPath } from "./test-paths.js";
import { isContainedPath, resolveToCwd } from "./tools/path-utils.js";

/**
 * Whether a test file is protected by the test integrity guard. With a
 * snapshot (existingTestPaths), only test files present at policy install are
 * protected — test files the agent created during the run stay mutable.
 * Without one, every existing test file is protected (legacy conservative).
 */
function isProtectedTestPath(policy: ToolSafetyPolicy, targetPath: string, absolutePath: string): boolean {
	if (!isTestPath(targetPath) || !existsSync(absolutePath)) return false;
	if (!policy.existingTestPaths) return true;
	return policy.existingTestPaths.has(absolutePath.replace(/\\/g, "/"));
}

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
	/**
	 * Additional tools trusted by the embedding runtime.
	 *
	 * Built-in tools are handled by name. Custom tools are blocked in headless
	 * and planning modes unless they are listed here.
	 */
	trustedTools?: string[];
	/**
	 * Names of tools registered through the extension system.
	 *
	 * Extension tools are user-installed code: the user deliberately installed
	 * them, so autonomous mode trusts them BY DEFAULT (blocking them breaks
	 * delegation through user-installed extensions mid-run). Set the env flag
	 * AG1_AUTONOMOUS_UNTRUSTED_EXTENSIONS=1 to opt out and restore the old
	 * block behavior for lock-down runs. Tool names that are neither built in
	 * nor listed here (or trustedTools) remain blocked in autonomous mode.
	 */
	extensionTools?: string[];
	/**
	 * Snapshot of test paths that existed when the policy was installed (see
	 * collectExistingTestPaths). The test integrity guard protects exactly
	 * this set — test files the agent creates DURING the run are its own work
	 * product and stay mutable, or the guard blocks the model from repairing
	 * its own tests. When absent (older callers/tests), the guard falls back
	 * to protecting every existing test file (conservative legacy behavior).
	 */
	existingTestPaths?: ReadonlySet<string>;
}

export interface ToolSafetyDecision {
	allow: boolean;
	reason?: string;
	approvalRequest?: ToolApprovalRequest;
}

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const PLANNING_EXPLORATION_TOOLS = new Set(["read", "grep", "find", "ls", "webSearch", "webFetch"]);
const FILE_MUTATION_TOOLS = new Set(["write", "edit", "notebook_edit", "NotebookEdit"]);
const RESEARCH_TOOLS = new Set(["webSearch", "webFetch"]);
const AUTONOMOUS_SUPPORT_TOOLS = new Set(["verify", "screenshot_url", "interact_then_screenshot"]);
const BRACED_HOME_TOKEN = "$" + "{HOME}";

/**
 * Best-effort shell containment heuristics — defense in depth only, NOT a security
 * boundary. Quoting/whitespace tricks (`s""udo`, `${IFS}`, double spaces) can evade
 * these patterns, and `$VAR`/`$(...)` expansion is deliberately not evaluated (that
 * would require a real shell parser, not more regex). The real containment
 * mechanism is AG1_BASH_SANDBOX_COMMAND (see core/tools/bash-sandbox.ts), which
 * wraps command execution in an external sandbox.
 */
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
	// The approval dialog shows this truncated text but the FULL value still
	// executes — the marker must make that impossible to miss.
	return `${trimmed.slice(0, max - 3)}...\n[truncated — full command will execute]`;
}

function stringifyForDisplay(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return "[unserializable arguments]";
	}
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

export function createToolSafetyPolicy(
	options: Omit<ToolSafetyPolicy, "mode"> & { mode: SafetyMode },
): ToolSafetyPolicy {
	return { ...options };
}

function isTrustedCustomTool(toolName: string, policy: ToolSafetyPolicy): boolean {
	return policy.trustedTools?.includes(toolName) ?? false;
}

function isExtensionRegisteredTool(toolName: string, policy: ToolSafetyPolicy): boolean {
	return policy.extensionTools?.includes(toolName) ?? false;
}

/**
 * Lock-down opt-out: AG1_AUTONOMOUS_UNTRUSTED_EXTENSIONS=1 restores the old
 * behavior where extension-registered tools are blocked in autonomous mode.
 * Read at evaluation time so the flag works for every policy-creation site.
 */
function areAutonomousExtensionToolsUntrusted(): boolean {
	return process.env.AG1_AUTONOMOUS_UNTRUSTED_EXTENSIONS === "1";
}

function evaluateUnmanagedTool(toolName: string, args: unknown, policy: ToolSafetyPolicy): ToolSafetyDecision {
	if (isTrustedCustomTool(toolName, policy)) {
		return { allow: true };
	}

	if (policy.mode === "interactive") {
		return {
			allow: true,
			approvalRequest: buildApprovalRequest(
				policy,
				toolName,
				"high",
				`Approve custom tool ${toolName}?`,
				`Tool: ${toolName}\nArguments: ${trimForDisplay(stringifyForDisplay(args), 800)}\n\nThis tool is not covered by AG1's built-in safety policy.`,
			),
		};
	}

	if (policy.mode === "planning") {
		return {
			allow: false,
			reason: `${toolName} is blocked in planning mode because it is not a built-in read-only planning tool.`,
		};
	}

	if (policy.mode === "headless") {
		return {
			allow: false,
			reason: `${toolName} is not covered by the headless safety policy and is blocked in headless mode. Add it to trustedTools only if the embedding runtime has audited it.`,
		};
	}

	if (policy.mode === "autonomous") {
		// Extension-registered tools are user-installed code and are trusted by
		// default in autonomous mode. Genuinely unknown tools stay blocked.
		if (isExtensionRegisteredTool(toolName, policy) && !areAutonomousExtensionToolsUntrusted()) {
			return { allow: true };
		}
		return {
			allow: false,
			reason: `${toolName} is not covered by the autonomous safety policy and is blocked in autonomous mode. Add it to trustedTools only if the runtime has audited it for autonomous execution.`,
		};
	}

	return { allow: true };
}

function normalizeShellPathToken(token: string): string {
	return token.replace(/^[("'`]+/, "").replace(/[)"'`,:;]+$/, "");
}

function isHomeShellToken(token: string): boolean {
	return (
		token === "~" ||
		token.startsWith("~/") ||
		token === "$HOME" ||
		token === BRACED_HOME_TOKEN ||
		token.startsWith("$HOME/") ||
		token.startsWith(`${BRACED_HOME_TOKEN}/`)
	);
}

/**
 * Best-effort detection of out-of-workspace path access in a shell command
 * (defense in depth — see FORBIDDEN_SHELL_RULES). Known, documented limitations:
 * `$VAR`/`$(...)` expansion is not evaluated, relative `cd` targets are not
 * resolved, and absolute paths inside quoted strings may false-positive. Real
 * containment comes from AG1_BASH_SANDBOX_COMMAND.
 */
function findOutOfWorkspaceShellPath(command: string, cwd: string): string | undefined {
	const pathTokenPattern =
		/(?:^|[\s=:(<>'["`])((?:\/|~(?:\/|$)|(?:\$HOME|\$\{HOME\})(?:\/|$)|(?:\.\.\/)+)[^\s"'`|&;<>)]*)/g;

	for (const match of command.matchAll(pathTokenPattern)) {
		const rawToken = match[1];
		if (!rawToken) continue;

		const token = normalizeShellPathToken(rawToken);
		if (!token || token === "/") continue;

		if (isHomeShellToken(token)) {
			return token;
		}

		if (token.startsWith("/")) {
			// Redirects to /dev/null (`2>/dev/null`) are ubiquitous and harmless.
			if (token === "/dev/null") continue;
			if (ALLOWED_SYSTEM_PATH_PREFIXES.some((prefix) => token.startsWith(prefix))) {
				continue;
			}
			if (!isContainedPath(token, cwd)) {
				return token;
			}
			continue;
		}

		if (token.startsWith("../")) {
			if (!isContainedPath(token, cwd)) {
				return token;
			}
		}
	}

	// `cd <absolute-out-of-workspace>` relocates subsequent relative commands
	// outside the workspace (`cd /etc && cat passwd`). Only absolute targets are
	// checked; relative cd targets remain a documented limitation (see above).
	const cdPattern = /(?:^|[\s;&|])cd\b(?:\s+("[^"]*"|'[^']*'|[^\s;&|"']+))?/g;
	for (const match of command.matchAll(cdPattern)) {
		const rawTarget = match[1];
		if (!rawTarget) {
			return "~"; // bare cd changes to $HOME, outside the workspace
		}
		const target = normalizeShellPathToken(rawTarget);
		if (!target) continue;

		if (isHomeShellToken(target)) {
			return target;
		}

		if (target.startsWith("/")) {
			if (ALLOWED_SYSTEM_PATH_PREFIXES.some((prefix) => target.startsWith(prefix))) {
				continue;
			}
			if (!isContainedPath(target, cwd)) {
				return target;
			}
		}
	}

	return undefined;
}

function evaluateFileMutationTool(toolName: string, args: unknown, policy: ToolSafetyPolicy): ToolSafetyDecision {
	const targetPath = getToolPath(args);
	const absolutePath = targetPath ? resolveToCwd(targetPath, policy.cwd) : undefined;
	const outsideWorkspace = targetPath ? !isContainedPath(targetPath, policy.cwd) : false;

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

	// Test integrity guard: existing test files are the verification anchor.
	// Mutating them is approval-gated in interactive mode and forbidden in
	// unattended autonomous runs — the model must fix the code, not the tests.
	// Creating NEW test files stays allowed everywhere mutations are allowed,
	// and planning/headless fall through to their existing hard blocks.
	if (targetPath && absolutePath && isProtectedTestPath(policy, targetPath, absolutePath)) {
		if (policy.mode === "autonomous") {
			return {
				allow: false,
				reason:
					"Test integrity guard: existing test files are immutable in autonomous mode. Fix the code, not the tests. Ask the user to change tests interactively.",
			};
		}

		if (policy.mode === "interactive") {
			return {
				allow: true,
				approvalRequest: buildApprovalRequest(
					policy,
					toolName,
					"high",
					`Modify existing test file ${targetPath}? Tests are the verification anchor — weakening them makes verification meaningless.`,
					`Tool: ${toolName}\nPath: ${targetPath}\nResolved path: ${absolutePath}\nWorkspace root: ${policy.cwd}`,
				),
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
		// Test integrity guard: unattended runs may not delete, move, or
		// overwrite PROTECTED test paths from the shell either (best-effort
		// heuristic — see test-paths.ts). Interactive mode keeps its approval
		// prompt. Agent-created test files stay mutable (see isProtectedTestPath).
		const testPathMutation = findTestPathShellMutation(command, policy.cwd);
		if (testPathMutation) {
			const absoluteMutation = resolveToCwd(testPathMutation, policy.cwd).replace(/\\/g, "/");
			const protectedPath = !policy.existingTestPaths || policy.existingTestPaths.has(absoluteMutation);
			if (protectedPath) {
				return {
					allow: false,
					reason: `Test integrity guard: refusing to delete/move/overwrite test path in autonomous mode: ${testPathMutation}. Fix the code, not the tests. Ask the user to change tests interactively.`,
				};
			}
		}
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
		if (isPlanningSafeShellCommand(command)) {
			return { allow: true };
		}
		return {
			allow: false,
			reason:
				"Only read-only shell commands are allowed in planning mode (e.g. git status/log/diff, cat, grep, wc, jq). Mutating commands, redirection, and command substitution are blocked.",
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
 * - Test integrity guard: existing test files are approval-gated in interactive
 *   mode and immutable in autonomous mode (file tools and shell mutations).
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

	if (RESEARCH_TOOLS.has(toolName)) {
		return { allow: true };
	}

	if (toolName === "task") {
		// Subagent delegation is allowed in every mode: the nested agent
		// re-evaluates every tool call against this same policy below the
		// boundary (mutations still prompt in interactive mode and stay blocked
		// in headless/planning). The task call itself only spends tokens.
		return { allow: true };
	}

	if (FILE_MUTATION_TOOLS.has(toolName)) {
		return evaluateFileMutationTool(toolName, args, policy);
	}

	if (toolName === "bash") {
		return evaluateBashTool(args, policy);
	}

	if (AUTONOMOUS_SUPPORT_TOOLS.has(toolName) && policy.mode === "autonomous") {
		return { allow: true };
	}

	return evaluateUnmanagedTool(toolName, args, policy);
}
