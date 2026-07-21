import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { execCommandMock } = vi.hoisted(() => ({
	execCommandMock: vi.fn(),
}));

vi.mock("../src/core/exec.js", () => ({
	execCommand: execCommandMock,
}));

import {
	activateAutonomousWorkspace,
	diffAutonomousWorkspace,
	prepareAutonomousWorkspace,
	promoteAutonomousWorkspace,
} from "../src/core/auton/workspace.js";

describe("autonomous workspace isolation", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "auton-workspace-"));
		execCommandMock.mockReset();
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("uses a git worktree when the source repo is clean", async () => {
		const sourceRoot = join(tempDir, "source");
		const nestedCwd = join(sourceRoot, "packages", "app");
		const agentDir = join(tempDir, "agent");
		mkdirSync(nestedCwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		execCommandMock.mockImplementation(async (_command: string, args: string[]) => {
			if (args[0] === "rev-parse") {
				return { stdout: `${sourceRoot}\n`, stderr: "", code: 0, killed: false };
			}
			if (args[0] === "status") {
				return { stdout: "", stderr: "", code: 0, killed: false };
			}
			if (args[0] === "worktree") {
				mkdirSync(args[3], { recursive: true });
				mkdirSync(join(args[3], "packages", "app"), { recursive: true });
				return { stdout: "", stderr: "", code: 0, killed: false };
			}
			return { stdout: "", stderr: "unexpected", code: 1, killed: false };
		});

		const prepared = await prepareAutonomousWorkspace({
			sourceCwd: nestedCwd,
			agentDir,
		});

		expect(prepared.strategy).toBe("git-worktree");
		expect(prepared.activeCwd).toBe(join(prepared.workspaceRoot, "packages", "app"));
		expect(existsSync(join(prepared.workspaceRoot, ".ag1-autonomous-workspace.json"))).toBe(true);
	});

	test("falls back to a filesystem copy when the git workspace is dirty", async () => {
		const sourceRoot = join(tempDir, "source");
		const agentDir = join(tempDir, "agent");
		mkdirSync(sourceRoot, { recursive: true });
		mkdirSync(join(sourceRoot, ".git"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(sourceRoot, "README.md"), "hello");
		writeFileSync(join(sourceRoot, ".git", "config"), "[core]\n");

		execCommandMock.mockImplementation(async (_command: string, args: string[]) => {
			if (args[0] === "rev-parse") {
				return { stdout: `${sourceRoot}\n`, stderr: "", code: 0, killed: false };
			}
			if (args[0] === "status") {
				return { stdout: " M README.md\n", stderr: "", code: 0, killed: false };
			}
			return { stdout: "", stderr: "unexpected", code: 1, killed: false };
		});

		const prepared = await prepareAutonomousWorkspace({
			sourceCwd: sourceRoot,
			agentDir,
		});

		expect(prepared.strategy).toBe("copy");
		expect(readFileSync(join(prepared.workspaceRoot, "README.md"), "utf8")).toBe("hello");
		expect(existsSync(join(prepared.workspaceRoot, ".git"))).toBe(false);
	});

	test("uses a temp workspace root when agentDir is inside the source tree", async () => {
		const sourceRoot = join(tempDir, "home", "alex");
		const agentDir = join(sourceRoot, ".ag1", "agent");
		mkdirSync(sourceRoot, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(sourceRoot, "README.md"), "hello");

		execCommandMock.mockResolvedValue({ stdout: "", stderr: "not git", code: 1, killed: false });

		const prepared = await prepareAutonomousWorkspace({
			sourceCwd: sourceRoot,
			agentDir,
		});

		expect(prepared.strategy).toBe("copy");
		expect(prepared.workspaceRoot.startsWith(sourceRoot)).toBe(false);
		expect(readFileSync(join(prepared.workspaceRoot, "README.md"), "utf8")).toBe("hello");
	});

	test("excludes the agent state tree from copy-based autonomous workspaces", async () => {
		const sourceRoot = join(tempDir, "home", "alex");
		const agentDir = join(sourceRoot, ".ag1", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(sourceRoot, "README.md"), "hello");
		writeFileSync(join(agentDir, "session.jsonl"), "sensitive harness state");

		execCommandMock.mockResolvedValue({ stdout: "", stderr: "not git", code: 1, killed: false });

		const prepared = await prepareAutonomousWorkspace({
			sourceCwd: sourceRoot,
			agentDir,
		});

		expect(readFileSync(join(prepared.workspaceRoot, "README.md"), "utf8")).toBe("hello");
		expect(existsSync(join(prepared.workspaceRoot, ".ag1"))).toBe(false);
	});

	test("preserves file mode bits in copy-based workspaces", async () => {
		const sourceRoot = join(tempDir, "source");
		const agentDir = join(tempDir, "agent");
		mkdirSync(sourceRoot, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const scriptPath = join(sourceRoot, "run.sh");
		writeFileSync(scriptPath, "#!/bin/sh\necho hi\n");
		chmodSync(scriptPath, 0o755);
		writeFileSync(join(sourceRoot, "notes.txt"), "plain");
		chmodSync(join(sourceRoot, "notes.txt"), 0o640);

		execCommandMock.mockResolvedValue({ stdout: "", stderr: "not git", code: 1, killed: false });

		const prepared = await prepareAutonomousWorkspace({ sourceCwd: sourceRoot, agentDir });

		expect(lstatSync(join(prepared.workspaceRoot, "run.sh")).mode & 0o777).toBe(0o755);
		expect(lstatSync(join(prepared.workspaceRoot, "notes.txt")).mode & 0o777).toBe(0o640);
	});

	test("hardlinked source files are copied as independent inodes", async () => {
		const sourceRoot = join(tempDir, "source");
		const agentDir = join(tempDir, "agent");
		mkdirSync(sourceRoot, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const original = join(sourceRoot, "original.txt");
		writeFileSync(original, "shared content");
		linkSync(original, join(sourceRoot, "hardlink.txt"));

		execCommandMock.mockResolvedValue({ stdout: "", stderr: "not git", code: 1, killed: false });

		const prepared = await prepareAutonomousWorkspace({ sourceCwd: sourceRoot, agentDir });

		// Editing the workspace copy must not propagate through the old link.
		writeFileSync(join(prepared.workspaceRoot, "hardlink.txt"), "mutated in workspace");
		expect(readFileSync(original, "utf8")).toBe("shared content");
		expect(lstatSync(join(prepared.workspaceRoot, "hardlink.txt")).nlink).toBe(1);
	});

	test("diffs by size and content hash, including files larger than the hash chunk", async () => {
		const sourceRoot = join(tempDir, "source");
		const agentDir = join(tempDir, "agent");
		mkdirSync(sourceRoot, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(sourceRoot, "keep.txt"), "unchanged");
		writeFileSync(join(sourceRoot, "change-me.txt"), "before");

		execCommandMock.mockResolvedValue({ stdout: "", stderr: "not git", code: 1, killed: false });

		const prepared = await prepareAutonomousWorkspace({ sourceCwd: sourceRoot, agentDir });

		writeFileSync(join(prepared.workspaceRoot, "change-me.txt"), "after");
		writeFileSync(join(prepared.workspaceRoot, "big-asset.bin"), Buffer.alloc(10 * 1024 * 1024, 7));
		rmSync(join(prepared.workspaceRoot, "keep.txt"));

		const diff = diffAutonomousWorkspace(prepared);
		expect(diff.added).toEqual(["big-asset.bin"]);
		expect(diff.modified).toEqual(["change-me.txt"]);
		expect(diff.deleted).toEqual(["keep.txt"]);
	});

	test("copies safe in-tree file symlinks as regular files", async () => {
		const sourceRoot = join(tempDir, "home", "alex");
		const agentDir = join(tempDir, "agent");
		mkdirSync(sourceRoot, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(sourceRoot, "README.md"), "hello");
		symlinkSync(join(sourceRoot, "README.md"), join(sourceRoot, "README-link.md"));

		execCommandMock.mockResolvedValue({ stdout: "", stderr: "not git", code: 1, killed: false });

		const prepared = await prepareAutonomousWorkspace({
			sourceCwd: sourceRoot,
			agentDir,
		});

		expect(readFileSync(join(prepared.workspaceRoot, "README.md"), "utf8")).toBe("hello");
		expect(readFileSync(join(prepared.workspaceRoot, "README-link.md"), "utf8")).toBe("hello");
		expect(lstatSync(join(prepared.workspaceRoot, "README-link.md")).isSymbolicLink()).toBe(false);
	});

	test("rejects symlinks that resolve outside the source tree", async () => {
		const sourceRoot = join(tempDir, "home", "alex");
		const agentDir = join(tempDir, "agent");
		const outsideDir = join(tempDir, "outside");
		mkdirSync(sourceRoot, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(outsideDir, { recursive: true });
		writeFileSync(join(outsideDir, "secret.txt"), "secret");
		symlinkSync(join(outsideDir, "secret.txt"), join(sourceRoot, "secret-link.txt"));

		execCommandMock.mockResolvedValue({ stdout: "", stderr: "not git", code: 1, killed: false });

		await expect(
			prepareAutonomousWorkspace({
				sourceCwd: sourceRoot,
				agentDir,
			}),
		).rejects.toThrow(/resolves outside the source tree/i);
	});

	test("rejects directory symlinks during copy-based workspace preparation", async () => {
		const sourceRoot = join(tempDir, "home", "alex");
		const agentDir = join(tempDir, "agent");
		mkdirSync(sourceRoot, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		symlinkSync(sourceRoot, join(sourceRoot, "loop"));

		execCommandMock.mockResolvedValue({ stdout: "", stderr: "not git", code: 1, killed: false });

		await expect(
			prepareAutonomousWorkspace({
				sourceCwd: sourceRoot,
				agentDir,
			}),
		).rejects.toThrow(/directory symlink/i);
	});

	test("activates the isolated workspace through the runtime and restores it afterward", async () => {
		const sourceRoot = join(tempDir, "source");
		const agentDir = join(tempDir, "agent");
		mkdirSync(sourceRoot, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(sourceRoot, "file.txt"), "content");

		execCommandMock.mockResolvedValue({ stdout: "", stderr: "not git", code: 1, killed: false });

		const switchSession = vi.fn(async () => ({ cancelled: false }));
		const runtimeHost = {
			session: {
				sessionFile: join(tempDir, "session.jsonl"),
				sessionManager: {
					getCwd: () => sourceRoot,
				},
			},
			switchSession,
		} as any;

		const activated = await activateAutonomousWorkspace(runtimeHost, { agentDir });

		expect(switchSession).toHaveBeenCalledWith(runtimeHost.session.sessionFile, activated.activeCwd);
		expect(existsSync(join(activated.workspaceRoot, "file.txt"))).toBe(true);

		await activated.restore();

		expect(switchSession).toHaveBeenLastCalledWith(runtimeHost.session.sessionFile, sourceRoot);
	});

	test("promotes a preserved workspace back into the source tree as an overlay", () => {
		const sourceRoot = join(tempDir, "source");
		const workspaceRoot = join(tempDir, "sandbox");
		const activeCwd = join(workspaceRoot, "app");
		mkdirSync(sourceRoot, { recursive: true });
		mkdirSync(activeCwd, { recursive: true });
		writeFileSync(join(sourceRoot, "keep.txt"), "keep");
		writeFileSync(join(activeCwd, "updated.txt"), "updated");
		writeFileSync(join(activeCwd, "keep.txt"), "overlaid");

		const promoted = promoteAutonomousWorkspace({
			sourceCwd: sourceRoot,
			workspaceRoot,
			activeCwd,
			strategy: "copy",
			description: "filesystem copy fallback",
		});

		expect(readFileSync(join(sourceRoot, "updated.txt"), "utf8")).toBe("updated");
		expect(readFileSync(join(sourceRoot, "keep.txt"), "utf8")).toBe("overlaid");
		expect(promoted.copiedEntries.sort()).toEqual(["keep.txt", "updated.txt"]);
	});

	test("computes added, modified, and deleted workspace diffs", () => {
		const sourceRoot = join(tempDir, "source");
		const workspaceRoot = join(tempDir, "sandbox");
		const activeCwd = join(workspaceRoot, "app");
		mkdirSync(join(sourceRoot, "dir"), { recursive: true });
		mkdirSync(join(activeCwd, "dir"), { recursive: true });
		writeFileSync(join(sourceRoot, "same.txt"), "same");
		writeFileSync(join(activeCwd, "same.txt"), "same");
		writeFileSync(join(sourceRoot, "mod.txt"), "old");
		writeFileSync(join(activeCwd, "mod.txt"), "new");
		writeFileSync(join(sourceRoot, "gone.txt"), "gone");
		writeFileSync(join(activeCwd, "new.txt"), "new");

		const diff = diffAutonomousWorkspace({
			sourceCwd: sourceRoot,
			workspaceRoot,
			activeCwd,
			strategy: "copy",
			description: "filesystem copy fallback",
		});

		expect(diff.added).toEqual(["new.txt"]);
		expect(diff.modified).toEqual(["mod.txt"]);
		expect(diff.deleted).toEqual(["gone.txt"]);
	});

	test("refuses to diff workspaces that contain symlinked entries", () => {
		const sourceRoot = join(tempDir, "source");
		const workspaceRoot = join(tempDir, "sandbox");
		const activeCwd = join(workspaceRoot, "app");
		const outsideDir = join(tempDir, "outside");
		mkdirSync(sourceRoot, { recursive: true });
		mkdirSync(activeCwd, { recursive: true });
		mkdirSync(outsideDir, { recursive: true });
		writeFileSync(join(outsideDir, "secret.txt"), "secret");
		symlinkSync(join(outsideDir, "secret.txt"), join(sourceRoot, "secret-link.txt"));

		expect(() =>
			diffAutonomousWorkspace({
				sourceCwd: sourceRoot,
				workspaceRoot,
				activeCwd,
				strategy: "copy",
				description: "filesystem copy fallback",
			}),
		).toThrow(/symlinked entries/i);
	});

	test("promote can delete entries missing from the sandbox when requested", () => {
		const sourceRoot = join(tempDir, "source");
		const workspaceRoot = join(tempDir, "sandbox");
		const activeCwd = join(workspaceRoot, "app");
		mkdirSync(sourceRoot, { recursive: true });
		mkdirSync(activeCwd, { recursive: true });
		writeFileSync(join(sourceRoot, "gone.txt"), "gone");
		writeFileSync(join(activeCwd, "keep.txt"), "keep");

		const promoted = promoteAutonomousWorkspace(
			{
				sourceCwd: sourceRoot,
				workspaceRoot,
				activeCwd,
				strategy: "copy",
				description: "filesystem copy fallback",
			},
			{ deleteMissing: true },
		);

		expect(existsSync(join(sourceRoot, "gone.txt"))).toBe(false);
		expect(readFileSync(join(sourceRoot, "keep.txt"), "utf8")).toBe("keep");
		expect(promoted.deletedEntries).toEqual(["gone.txt"]);
	});
});
