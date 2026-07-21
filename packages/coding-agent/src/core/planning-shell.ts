/**
 * Read-only shell allowlist for planning mode.
 *
 * The planner may inspect via bash (git log, wc, jq, ...) but must not change
 * anything or execute arbitrary programs. The check is structural:
 *  1. No command substitution (`$(...)`, backticks) — kills evasion nesting.
 *  2. No redirection except to /dev/null or stderr merging (2>&1).
 *  3. No destructive/mutating keywords anywhere in the command.
 *  4. Every pipeline segment (split on |, &&, ||, ;) must start with an
 *     allowlisted read-only command — so `cat x && rm y` is blocked by both
 *     rule 3 and rule 4.
 *
 * This is a productivity guardrail, not a security boundary; autonomous
 * containment (sandbox/workspace isolation) handles adversarial cases.
 */

/** Mutating or dangerous keywords blocked anywhere in the command. */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/\bxargs\b/i,
	/\beval\b/i,
	/\bsource\b/i,
	/\bnpx\b/i,
	/\bnpm\s+(install|uninstall|update|ci|link|publish|run|test|exec|start|build)/i,
	/\byarn\s+(add|remove|install|publish|run|test|start|build)/i,
	/\bpnpm\s+(add|remove|install|publish|run|test|exec|start|build)/i,
	/\bpip\d*\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|stash\s+(?!list\b)|cherry-pick|revert|tag|init|clone|clean|apply|am|bisect\s+(start|good|bad|reset)|worktree\s+(add|remove)|branch\s+-[dD]|branch\s+-m|config\s+(?!--get\b))/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
	/\bcurl\b/i,
	/\bwget\b/i,
	/\b(env|printenv|set|export)\b/i,
];

/** Read-only commands allowed as pipeline segments (anchored to segment start). */
const SAFE_SEGMENT_PATTERNS: RegExp[] = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|blame|grep|describe|remote|branch(\s|$)|config\s+--get\b|stash\s+list\b|ls-|shortlog|tag\s*(--list|$))/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit|prefix)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*pnpm\s+(list|ls|why|outdated|audit)/i,
	/^\s*node\s+(--version|-v)\b/i,
	/^\s*python\d*\s+(--version|-V)\b/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n\b/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*exa\b/,
	/^\s*column\b/,
	/^\s*cut\b/,
	/^\s*tr\b/,
	/^\s*basename\b/,
	/^\s*dirname\b/,
	/^\s*realpath\b/,
	/^\s*readlink\b/,
];

/** Redirections that are harmless: anything to /dev/null, or stderr merging. */
const HARMLESS_REDIRECT = /(?:\d*|&)>\s*(?:&\d+\s*)?\/dev\/null|\d*>\s*&\d+/g;

/**
 * Whether a bash command is read-only and allowed during planning mode.
 */
export function isPlanningSafeShellCommand(command: string): boolean {
	if (!command || !command.trim()) return false;

	// No command substitution — prevents nesting mutating calls inside safe ones.
	if (command.includes("$(") || command.includes("`") || command.includes("${")) {
		return false;
	}

	// No redirection other than to /dev/null or stream merging.
	const withoutHarmlessRedirects = command.replace(HARMLESS_REDIRECT, "");
	if (/>/.test(withoutHarmlessRedirects)) {
		return false;
	}

	// No mutating keywords anywhere.
	if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command))) {
		return false;
	}

	// Every pipeline segment must itself be an allowlisted read-only command.
	const segments = command.split(/&&|\|\||[;|]/).map((segment) => segment.trim());
	if (segments.some((segment) => segment.length === 0)) return false;
	return segments.every((segment) => SAFE_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment)));
}
