import { type SpawnOptions, spawn } from "child_process";

export interface SSHResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Execute an SSH command and return the result
 */
export const sshExec = async (
	sshCmd: string,
	command: string,
	options?: { keepAlive?: boolean; input?: string },
): Promise<SSHResult> => {
	return new Promise((resolve) => {
		// Parse SSH command (e.g., "ssh root@1.2.3.4" or "ssh -p 22 root@1.2.3.4")
		const sshParts = sshCmd.split(" ").filter((p) => p);
		const sshBinary = sshParts[0];
		let sshArgs = [...sshParts.slice(1)];

		// Add SSH keepalive options for long-running commands
		if (options?.keepAlive) {
			// ServerAliveInterval=30 sends keepalive every 30 seconds
			// ServerAliveCountMax=120 allows up to 120 failures (60 minutes total)
			sshArgs = ["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=120", ...sshArgs];
		}

		sshArgs.push(command);

		const proc = spawn(sshBinary, sshArgs, {
			stdio: [options?.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
		});

		// Pipe input to stdin (e.g., secrets that must not appear in argv/ps)
		if (options?.input !== undefined) {
			proc.stdin?.on("error", () => {}); // Ignore EPIPE if remote closes early
			proc.stdin?.write(options.input);
			proc.stdin?.end();
		}

		let stdout = "";
		let stderr = "";

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			resolve({
				stdout,
				stderr,
				exitCode: code || 0,
			});
		});

		proc.on("error", (err) => {
			resolve({
				stdout,
				stderr: err.message,
				exitCode: 1,
			});
		});
	});
};

/**
 * Execute an SSH command with streaming output to console
 */
export const sshExecStream = async (
	sshCmd: string,
	command: string,
	options?: { silent?: boolean; forceTTY?: boolean; keepAlive?: boolean },
): Promise<number> => {
	return new Promise((resolve) => {
		const sshParts = sshCmd.split(" ").filter((p) => p);
		const sshBinary = sshParts[0];

		// Build SSH args
		let sshArgs = [...sshParts.slice(1)];

		// Add -t flag if requested and not already present
		if (options?.forceTTY && !sshParts.includes("-t")) {
			sshArgs = ["-t", ...sshArgs];
		}

		// Add SSH keepalive options for long-running commands
		if (options?.keepAlive) {
			// ServerAliveInterval=30 sends keepalive every 30 seconds
			// ServerAliveCountMax=120 allows up to 120 failures (60 minutes total)
			sshArgs = ["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=120", ...sshArgs];
		}

		sshArgs.push(command);

		const spawnOptions: SpawnOptions = options?.silent
			? { stdio: ["ignore", "ignore", "ignore"] }
			: { stdio: "inherit" };

		const proc = spawn(sshBinary, sshArgs, spawnOptions);

		proc.on("close", (code) => {
			resolve(code || 0);
		});

		proc.on("error", () => {
			resolve(1);
		});
	});
};

export interface SSHTarget {
	/** Host token as given in the SSH command, e.g. "user@host" or "host" */
	target: string;
	/** Hostname with any "user@" prefix stripped */
	host: string;
	port: string;
	/** Flags (and their values) to forward to scp so both stay in sync */
	passthrough: string[];
}

// Flags that consume the next token as their value
const sshFlagsWithArg = new Set(["-i", "-o", "-l", "-F", "-J", "-L", "-R", "-D", "-W", "-b", "-c", "-m", "-S"]);

/**
 * Parse the target host/port out of an SSH command string
 * (e.g., "ssh root@1.2.3.4" or "ssh -p 2222 -i key user@host")
 */
export const parseSshTarget = (sshCmd: string): SSHTarget | null => {
	const sshParts = sshCmd.split(" ").filter((p) => p);
	let target = "";
	let port = "22";
	const passthrough: string[] = [];
	let i = 1; // Skip 'ssh'

	while (i < sshParts.length) {
		if (sshParts[i] === "-p" && i + 1 < sshParts.length) {
			port = sshParts[i + 1];
			i += 2;
		} else if (sshParts[i].startsWith("-") && sshFlagsWithArg.has(sshParts[i]) && i + 1 < sshParts.length) {
			passthrough.push(sshParts[i], sshParts[i + 1]);
			i += 2;
		} else if (!sshParts[i].startsWith("-")) {
			target = sshParts[i];
			break;
		} else {
			passthrough.push(sshParts[i]);
			i++;
		}
	}

	if (!target) {
		return null;
	}

	return { target, host: target.split("@").pop() || target, port, passthrough };
};

/**
 * Copy a file to remote via SCP
 */
export const scpFile = async (sshCmd: string, localPath: string, remotePath: string): Promise<boolean> => {
	// Extract host from SSH command (passthrough forwards flags like identity
	// files to scp so both stay in sync)
	const parsed = parseSshTarget(sshCmd);
	if (!parsed) {
		console.error("Could not parse host from SSH command");
		return false;
	}

	// Build SCP command
	const scpArgs = ["-P", parsed.port, ...parsed.passthrough, localPath, `${parsed.target}:${remotePath}`];

	return new Promise((resolve) => {
		const proc = spawn("scp", scpArgs, { stdio: "inherit" });

		proc.on("close", (code) => {
			resolve(code === 0);
		});

		proc.on("error", () => {
			resolve(false);
		});
	});
};
