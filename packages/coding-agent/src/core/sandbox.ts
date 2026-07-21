import { spawnSync } from "node:child_process";

/**
 * OS-level execution sandboxing for bash commands via bubblewrap (`bwrap`).
 *
 * String-level command filtering (allowlists, forbidden-command regexes) can
 * always be bypassed by shell trickery; real containment has to come from the
 * kernel. When enabled, commands run inside a bubblewrap sandbox that sees the
 * host filesystem read-only, gets a writable bind-mount only for the working
 * directory, a private /tmp, and — in "strict" mode — no network access.
 */

/** Sandboxing level for spawned bash commands. */
export type SandboxMode = "workspace" | "strict";
/** Sandbox selection including the disabled state. */
export type SandboxSetting = SandboxMode | "off";

export interface SandboxOptions {
	/** Working directory; the only host path bind-mounted read-write. */
	cwd: string;
	mode: SandboxMode;
	/** Network access. "strict" always drops it; "workspace" keeps it unless false. */
	network?: boolean;
}

/** One-line note prefixed to command output when sandboxing was requested but bwrap is missing. */
export const SANDBOX_UNAVAILABLE_NOTE = "sandbox unavailable: running without bubblewrap containment";

const BWRAP_BIN = "bwrap";
/** Minimal PATH inside the sandbox (the host PATH may contain workspace entries). */
const SANDBOX_PATH_ENV = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

let cachedAvailability: boolean | undefined;

/** Check (once, then cached) whether bubblewrap can run on this host. */
export function isBubblewrapAvailable(): boolean {
	if (cachedAvailability !== undefined) {
		return cachedAvailability;
	}
	cachedAvailability = probeBubblewrap();
	return cachedAvailability;
}

function probeBubblewrap(): boolean {
	if (process.platform !== "linux") {
		return false;
	}
	try {
		const result = spawnSync(BWRAP_BIN, ["--version"], { encoding: "utf-8", timeout: 5000 });
		return !result.error && result.status === 0;
	} catch {
		return false;
	}
}

/** Clear the cached availability probe. Exported for tests. */
export function resetBubblewrapAvailabilityCache(): void {
	cachedAvailability = undefined;
}

/** Normalize a sandbox setting from an option or env value; undefined when unset/invalid. */
export function parseSandboxMode(value: string | undefined | null): SandboxSetting | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "off" || normalized === "workspace" || normalized === "strict") {
		return normalized;
	}
	return undefined;
}

/**
 * Build the bubblewrap argument vector (everything after `bwrap` itself).
 * Arguments are returned as an array so no shell parsing is involved; paths
 * with spaces or shell metacharacters stay a single argv element.
 */
export function buildBubblewrapArgs(options: SandboxOptions): string[] {
	const { cwd, mode } = options;
	const dropNetwork = mode === "strict" || options.network === false;
	// bwrap always creates a fresh mount namespace to assemble the binds, so
	// there is no --unshare-mount flag; we unshare ipc/pid/user explicitly.
	const args = ["--unshare-ipc", "--unshare-pid", "--unshare-user"];
	if (dropNetwork) {
		args.push("--unshare-net");
	}
	args.push(
		"--die-with-parent",
		// Whole host filesystem read-only...
		"--ro-bind",
		"/",
		"/",
		// ...except for private volatile mounts...
		"--tmpfs",
		"/tmp",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		// ...and the working directory itself, mounted last so it still works
		// when cwd lives under /tmp (the tmpfs above would shadow it otherwise).
		"--bind",
		cwd,
		cwd,
		"--setenv",
		"PATH",
		SANDBOX_PATH_ENV,
		"--setenv",
		"HOME",
		cwd,
		"--chdir",
		cwd,
	);
	return args;
}

/** Full sandbox argv: `bwrap <args> -- sh -lc <command>`. */
export function buildSandboxArgv(command: string, options: SandboxOptions): string[] {
	return [BWRAP_BIN, ...buildBubblewrapArgs(options), "--", "sh", "-lc", command];
}

// Characters safe to pass through a shell command line unquoted.
const SAFE_SHELL_CHARS = /^[A-Za-z0-9_@%+=:,./-]+$/;

function shellQuoteArg(value: string): string {
	if (value.length > 0 && SAFE_SHELL_CHARS.test(value)) {
		return value;
	}
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Render the sandbox argv as a single shell command line, quoting every
 * argument that needs it. The result is meant to be handed to `sh -c`.
 */
export function wrapInSandbox(command: string, options: SandboxOptions): string {
	return buildSandboxArgv(command, options).map(shellQuoteArg).join(" ");
}
