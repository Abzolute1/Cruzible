import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildBubblewrapArgs,
	buildSandboxArgv,
	isBubblewrapAvailable,
	parseSandboxMode,
	resetBubblewrapAvailabilityCache,
	SANDBOX_UNAVAILABLE_NOTE,
	wrapInSandbox,
} from "../src/core/sandbox.js";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.js";

const realSpawnSync = (await vi.importActual<typeof import("node:child_process")>("node:child_process")).spawnSync;

vi.mock("node:child_process", async () => {
	const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
	return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const spawnSyncMock = vi.mocked(spawnSync);

function stubBwrapAvailable() {
	spawnSyncMock.mockReturnValue({ status: 0, stdout: "bubblewrap 0.9.0\n", stderr: "" } as never);
}

function stubBwrapUnavailable() {
	spawnSyncMock.mockReturnValue({ status: null, error: new Error("spawn bwrap ENOENT") } as never);
}

const EXPECTED_WORKSPACE_PREFIX =
	"bwrap --unshare-ipc --unshare-pid --unshare-user --die-with-parent " +
	"--ro-bind / / --tmpfs /tmp --proc /proc --dev /dev";

describe("buildBubblewrapArgs", () => {
	it("builds the workspace-mode filesystem layout", () => {
		const args = buildBubblewrapArgs({ cwd: "/repo", mode: "workspace" });
		expect(args).toContain("--unshare-ipc");
		expect(args).toContain("--unshare-pid");
		expect(args).toContain("--unshare-user");
		expect(args).toContain("--die-with-parent");
		expect(args).not.toContain("--unshare-net");
		// Host filesystem read-only, cwd re-bound read-write at the same path.
		expect(args.join(" ")).toContain("--ro-bind / /");
		expect(pairValue(args, "--bind")).toEqual(["/repo", "/repo"]);
		expect(pairValue(args, "--tmpfs")).toEqual(["/tmp"]);
		expect(pairValue(args, "--proc")).toEqual(["/proc"]);
		expect(pairValue(args, "--dev")).toEqual(["/dev"]);
		expect(pairValue(args, "--setenv")).toEqual([
			"PATH",
			"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		]);
		expect(pairValue(args, "--chdir")).toEqual(["/repo"]);
		// cwd bind must come after the /tmp tmpfs or a cwd under /tmp gets shadowed.
		expect(args.lastIndexOf("--bind")).toBeGreaterThan(args.indexOf("--tmpfs"));
	});

	it("drops the network namespace in strict mode", () => {
		const args = buildBubblewrapArgs({ cwd: "/repo", mode: "strict" });
		expect(args).toContain("--unshare-net");
	});

	it("keeps strict-mode network isolation even when network is requested", () => {
		const args = buildBubblewrapArgs({ cwd: "/repo", mode: "strict", network: true });
		expect(args).toContain("--unshare-net");
	});

	it("drops the network namespace in workspace mode when network is false", () => {
		const args = buildBubblewrapArgs({ cwd: "/repo", mode: "workspace", network: false });
		expect(args).toContain("--unshare-net");
	});

	it("keeps a hostile cwd as single argv elements (no shell splitting)", () => {
		const evil = "/tmp/evil dir'; rm -rf /; echo '";
		const args = buildBubblewrapArgs({ cwd: evil, mode: "workspace" });
		// bind src, bind dest, HOME, chdir — always the exact string, never split.
		expect(args.filter((a) => a === evil)).toHaveLength(4);
		// Any element carrying the payload is the verbatim cwd, never a fragment.
		expect(args.filter((a) => a.includes("rm -rf")).every((a) => a === evil)).toBe(true);
	});
});

function pairValue(args: string[], flag: string): string[] {
	const index = args.indexOf(flag);
	expect(index).toBeGreaterThanOrEqual(0);
	const values: string[] = [];
	for (let i = index + 1; i < args.length && !args[i].startsWith("--"); i++) {
		values.push(args[i]);
	}
	return values;
}

describe("buildSandboxArgv / wrapInSandbox", () => {
	it("produces bwrap <args> -- sh -lc <command> as an argv array", () => {
		const argv = buildSandboxArgv("echo hi", { cwd: "/repo", mode: "workspace" });
		expect(argv[0]).toBe("bwrap");
		expect(argv.slice(-4)).toEqual(["--", "sh", "-lc", "echo hi"]);
	});

	it("renders a shell-safe command line for plain paths", () => {
		expect(wrapInSandbox("echo hi", { cwd: "/repo", mode: "workspace" })).toBe(
			`${EXPECTED_WORKSPACE_PREFIX} --bind /repo /repo --setenv PATH ` +
				"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin --setenv HOME /repo --chdir /repo -- sh -lc 'echo hi'",
		);
	});

	it("quotes cwd and command with spaces", () => {
		const line = wrapInSandbox("touch my file", { cwd: "/tmp/my dir", mode: "workspace" });
		expect(line).toContain("--bind '/tmp/my dir' '/tmp/my dir'");
		expect(line).toContain("--chdir '/tmp/my dir'");
		expect(line.endsWith("-- sh -lc 'touch my file'")).toBe(true);
	});

	it("neutralizes shell metacharacters in cwd and command", () => {
		const evilCwd = "/tmp/x'; rm -rf /; echo '";
		const quotedCwd = "'/tmp/x'\\''; rm -rf /; echo '\\'''";
		const line = wrapInSandbox("echo $(rm -rf /); `id`", { cwd: evilCwd, mode: "strict" });
		expect(line).toBe(
			"bwrap --unshare-ipc --unshare-pid --unshare-user --unshare-net --die-with-parent " +
				`--ro-bind / / --tmpfs /tmp --proc /proc --dev /dev --bind ${quotedCwd} ${quotedCwd} --setenv PATH ` +
				`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin --setenv HOME ${quotedCwd} --chdir ${quotedCwd} ` +
				"-- sh -lc 'echo $(rm -rf /); `id`'",
		);
	});

	it("escapes embedded single quotes", () => {
		const line = wrapInSandbox("printf 'hi'", { cwd: "/repo", mode: "workspace" });
		expect(line.endsWith("-- sh -lc 'printf '\\''hi'\\'''")).toBe(true);
	});
});

describe("isBubblewrapAvailable", () => {
	beforeEach(() => {
		spawnSyncMock.mockClear();
		resetBubblewrapAvailabilityCache();
	});

	afterEach(() => {
		spawnSyncMock.mockClear();
		resetBubblewrapAvailabilityCache();
	});

	it("returns true when bwrap --version succeeds", () => {
		stubBwrapAvailable();
		expect(isBubblewrapAvailable()).toBe(true);
	});

	it("returns false when bwrap is missing or fails", () => {
		stubBwrapUnavailable();
		expect(isBubblewrapAvailable()).toBe(false);
	});

	it("caches the probe result", () => {
		stubBwrapAvailable();
		expect(isBubblewrapAvailable()).toBe(true);
		expect(isBubblewrapAvailable()).toBe(true);
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		// A changed probe result is not observed until the cache is reset.
		stubBwrapUnavailable();
		expect(isBubblewrapAvailable()).toBe(true);
		resetBubblewrapAvailabilityCache();
		expect(isBubblewrapAvailable()).toBe(false);
		expect(spawnSyncMock).toHaveBeenCalledTimes(2);
	});
});

describe("parseSandboxMode", () => {
	it("normalizes valid settings", () => {
		expect(parseSandboxMode("off")).toBe("off");
		expect(parseSandboxMode(" STRICT ")).toBe("strict");
		expect(parseSandboxMode("Workspace")).toBe("workspace");
	});

	it("rejects unset and invalid values", () => {
		expect(parseSandboxMode(undefined)).toBeUndefined();
		expect(parseSandboxMode("")).toBeUndefined();
		expect(parseSandboxMode("bogus")).toBeUndefined();
	});
});

describe("bash tool sandbox integration", () => {
	let savedEnv: string | undefined;

	beforeEach(() => {
		savedEnv = process.env.AG1_BASH_SANDBOX;
		delete process.env.AG1_BASH_SANDBOX;
		spawnSyncMock.mockClear();
		resetBubblewrapAvailabilityCache();
		stubBwrapAvailable();
	});

	afterEach(() => {
		if (savedEnv === undefined) delete process.env.AG1_BASH_SANDBOX;
		else process.env.AG1_BASH_SANDBOX = savedEnv;
		spawnSyncMock.mockClear();
		resetBubblewrapAvailabilityCache();
	});

	function captureTool(cwd: string, options?: Parameters<typeof createBashToolDefinition>[1]) {
		const calls: Array<{ command: string; cwd: string }> = [];
		const operations: BashOperations = {
			exec: async (command, execCwd) => {
				calls.push({ command, cwd: execCwd });
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(cwd, { ...options, operations });
		return { calls, tool };
	}

	async function runCommand(tool: ReturnType<typeof captureTool>["tool"], command: string) {
		const result = await tool.execute("tool-sandbox-test", { command }, undefined, undefined, {} as never);
		const block = result.content[0];
		return block.type === "text" ? block.text : "";
	}

	it("runs unsandboxed by default", async () => {
		const { calls, tool } = captureTool("/repo");
		await runCommand(tool, "echo hi");
		expect(calls[0].command).toBe("echo hi");
	});

	it("wraps the command when sandbox: 'workspace' is set", async () => {
		const { calls, tool } = captureTool("/repo", { sandbox: "workspace" });
		await runCommand(tool, "echo hi");
		expect(calls[0].command).toBe(
			`${EXPECTED_WORKSPACE_PREFIX} --bind /repo /repo --setenv PATH ` +
				"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin --setenv HOME /repo --chdir /repo -- sh -lc 'echo hi'",
		);
		expect(calls[0].cwd).toBe("/repo");
	});

	it("adds --unshare-net when sandbox: 'strict' is set", async () => {
		const { calls, tool } = captureTool("/repo", { sandbox: "strict" });
		await runCommand(tool, "echo hi");
		expect(calls[0].command).toContain("--unshare-net");
		expect(calls[0].command).toContain("-- sh -lc 'echo hi'");
	});

	it("honors AG1_BASH_SANDBOX when no explicit option is set", async () => {
		process.env.AG1_BASH_SANDBOX = "strict";
		const { calls, tool } = captureTool("/repo");
		await runCommand(tool, "echo hi");
		expect(calls[0].command).toContain("--unshare-net");
		expect(calls[0].command).toContain("bwrap");
	});

	it("lets the explicit option override AG1_BASH_SANDBOX", async () => {
		process.env.AG1_BASH_SANDBOX = "strict";
		const { calls, tool } = captureTool("/repo", { sandbox: "off" });
		await runCommand(tool, "echo hi");
		expect(calls[0].command).toBe("echo hi");
	});

	it("ignores an invalid AG1_BASH_SANDBOX value", async () => {
		process.env.AG1_BASH_SANDBOX = "bogus";
		const { calls, tool } = captureTool("/repo");
		await runCommand(tool, "echo hi");
		expect(calls[0].command).toBe("echo hi");
	});

	it("runs unsandboxed with a warning note when bwrap is unavailable", async () => {
		stubBwrapUnavailable();
		const { calls, tool } = captureTool("/repo", { sandbox: "workspace" });
		const text = await runCommand(tool, "echo hi");
		expect(calls[0].command).toBe("echo hi");
		expect(text.startsWith(SANDBOX_UNAVAILABLE_NOTE)).toBe(true);
	});
});

// Verify namespaces actually work on this host before running the real
// containment test (user namespaces can be disabled in CI containers).
function probeRealBwrap(): boolean {
	if (process.platform !== "linux") return false;
	try {
		const version = realSpawnSync("bwrap", ["--version"], { encoding: "utf-8", timeout: 5000 });
		if (version.error || version.status !== 0) return false;
		const run = realSpawnSync("bwrap", ["--unshare-user", "--ro-bind", "/", "/", "--", "true"], {
			encoding: "utf-8",
			timeout: 5000,
		});
		return !run.error && run.status === 0;
	} catch {
		return false;
	}
}

const bwrapReallyAvailable = probeRealBwrap();

describe("real bubblewrap containment", () => {
	it.skipIf(!bwrapReallyAvailable)(
		"confines writes to the workspace and hides /tmp writes from the host",
		async () => {
			// The tool's availability probe goes through the mocked spawnSync.
			resetBubblewrapAvailabilityCache();
			stubBwrapAvailable();
			const workdir = mkdtempSync(path.join(tmpdir(), "ag1-sandbox-test-"));
			const tag = `${process.pid}-${Date.now()}`;
			try {
				const tool = createBashToolDefinition(workdir, { sandbox: "workspace" });
				const run = (command: string) =>
					tool.execute("tool-sandbox-real", { command }, undefined, undefined, {} as never);

				// The host filesystem outside the workspace is read-only.
				await expect(run(`touch /etc/ag1-sandbox-outside-${tag}`)).rejects.toThrow(/exited with code/);
				expect(existsSync(`/etc/ag1-sandbox-outside-${tag}`)).toBe(false);

				// /tmp is a private tmpfs: the write succeeds inside but never reaches the host.
				await run(`touch /tmp/ag1-sandbox-outside-${tag}`);
				expect(existsSync(`/tmp/ag1-sandbox-outside-${tag}`)).toBe(false);

				// The workspace itself is writable and visible on the host.
				await run("touch inside");
				expect(existsSync(path.join(workdir, "inside"))).toBe(true);
			} finally {
				rmSync(workdir, { recursive: true, force: true });
			}
		},
	);
});
