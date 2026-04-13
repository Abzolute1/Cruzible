import { randomUUID } from "node:crypto";
import {
	copyFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readlinkSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import type { AgentSessionRuntime } from "../agent-session-runtime.js";
import { execCommand } from "../exec.js";

export type AutonomousWorkspaceStrategy = "git-worktree" | "copy";

export interface PreparedAutonomousWorkspace {
	sourceCwd: string;
	workspaceRoot: string;
	activeCwd: string;
	strategy: AutonomousWorkspaceStrategy;
	description: string;
}

export interface ActivatedAutonomousWorkspace extends PreparedAutonomousWorkspace {
	restore(): Promise<void>;
}

export interface PromotedAutonomousWorkspace {
	sourceCwd: string;
	workspaceRoot: string;
	activeCwd: string;
	copiedEntries: string[];
	deletedEntries: string[];
}

export interface AutonomousWorkspaceDiff {
	added: string[];
	modified: string[];
	deleted: string[];
}

export async function prepareAutonomousWorkspace(options: {
	sourceCwd: string;
	agentDir: string;
}): Promise<PreparedAutonomousWorkspace> {
	const sourceCwd = resolve(options.sourceCwd);
	const baseDir = resolveAutonomousWorkspaceBaseDir(sourceCwd, resolve(options.agentDir));
	mkdirSync(baseDir, { recursive: true });

	const workspaceId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
	const workspaceRoot = join(baseDir, workspaceId);

	const gitInfo = await detectGitWorkspace(sourceCwd);
	if (gitInfo && !gitInfo.isDirty) {
		await createGitWorktree(gitInfo.repoRoot, workspaceRoot);
		const subdir = relative(gitInfo.repoRoot, sourceCwd);
		const activeCwd = subdir ? join(workspaceRoot, subdir) : workspaceRoot;
		writeWorkspaceMetadata({
			workspaceRoot,
			sourceCwd,
			strategy: "git-worktree",
			referenceRoot: gitInfo.repoRoot,
			activeCwd,
		});
		return {
			sourceCwd,
			workspaceRoot,
			activeCwd,
			strategy: "git-worktree",
			description: `git worktree cloned from ${gitInfo.repoRoot}`,
		};
	}

	const excludedRoots = resolveWorkspaceCopyExcludedRoots(sourceCwd, resolve(options.agentDir));
	copyWorkspaceTree(sourceCwd, workspaceRoot, {
		excludedRoots,
	});
	writeWorkspaceMetadata({
		workspaceRoot,
		sourceCwd,
		strategy: "copy",
		activeCwd: workspaceRoot,
	});
	return {
		sourceCwd,
		workspaceRoot,
		activeCwd: workspaceRoot,
		strategy: "copy",
		description: gitInfo
			? "filesystem copy fallback because the git workspace has uncommitted changes"
			: "filesystem copy fallback because no git workspace was detected",
	};
}

function resolveAutonomousWorkspaceBaseDir(sourceCwd: string, agentDir: string): string {
	const preferredBaseDir = join(agentDir, "autonomous-workspaces", sanitizePathForDir(sourceCwd));
	if (!isNestedWithin(preferredBaseDir, sourceCwd)) {
		return preferredBaseDir;
	}

	return join(tmpdir(), "ag1-autonomous-workspaces", sanitizePathForDir(sourceCwd));
}

function isNestedWithin(candidatePath: string, ancestorPath: string): boolean {
	const normalizedCandidate = resolve(candidatePath);
	const normalizedAncestor = resolve(ancestorPath);
	if (normalizedCandidate === normalizedAncestor) return true;
	const rel = relative(normalizedAncestor, normalizedCandidate);
	return rel !== "" && !rel.startsWith("..") && rel !== ".";
}

function resolveWorkspaceCopyExcludedRoots(sourceCwd: string, agentDir: string): string[] {
	const normalizedSource = resolve(sourceCwd);
	const normalizedAgentDir = resolve(agentDir);
	if (!isNestedWithin(normalizedAgentDir, normalizedSource)) {
		return [normalizedAgentDir];
	}

	const rel = relative(normalizedSource, normalizedAgentDir);
	const [topLevelSegment] = rel.split(/[\\/]/).filter(Boolean);
	if (!topLevelSegment) {
		return [normalizedAgentDir];
	}

	return [join(normalizedSource, topLevelSegment)];
}

export async function activateAutonomousWorkspace(
	runtimeHost: AgentSessionRuntime,
	options: { agentDir: string },
): Promise<ActivatedAutonomousWorkspace> {
	const sessionFile = runtimeHost.session.sessionFile;
	if (!sessionFile) {
		throw new Error("Autonomous workspace isolation requires a persisted session.");
	}

	const sourceCwd = runtimeHost.session.sessionManager.getCwd();
	const prepared = await prepareAutonomousWorkspace({
		sourceCwd,
		agentDir: options.agentDir,
	});

	const result = await runtimeHost.switchSession(sessionFile, prepared.activeCwd);
	if (result.cancelled) {
		throw new Error("Autonomous workspace activation was cancelled.");
	}

	return {
		...prepared,
		restore: async () => {
			const restoreResult = await runtimeHost.switchSession(sessionFile, sourceCwd);
			if (restoreResult.cancelled) {
				throw new Error("Restoring the original workspace was cancelled.");
			}
		},
	};
}

export function diffAutonomousWorkspace(workspace: PreparedAutonomousWorkspace): AutonomousWorkspaceDiff {
	const sourceEntries = collectWorkspaceEntries(workspace.sourceCwd);
	const sandboxEntries = collectWorkspaceEntries(workspace.activeCwd);

	const added: string[] = [];
	const modified: string[] = [];
	const deleted: string[] = [];

	for (const [relativePath, sandboxEntry] of sandboxEntries.entries()) {
		const sourceEntry = sourceEntries.get(relativePath);
		if (!sourceEntry) {
			added.push(relativePath);
			continue;
		}
		if (sandboxEntry.kind !== sourceEntry.kind) {
			modified.push(relativePath);
			continue;
		}
		if (sandboxEntry.kind === "file" && sourceEntry.kind === "file" && !buffersEqual(sourceEntry.content, sandboxEntry.content)) {
			modified.push(relativePath);
		}
	}

	for (const relativePath of sourceEntries.keys()) {
		if (!sandboxEntries.has(relativePath)) {
			deleted.push(relativePath);
		}
	}

	return {
		added: added.sort(),
		modified: modified.sort(),
		deleted: deleted.sort(),
	};
}

export function promoteAutonomousWorkspace(
	workspace: PreparedAutonomousWorkspace,
	options: { deleteMissing?: boolean } = {},
): PromotedAutonomousWorkspace {
	const copiedEntries = new Set<string>();
	const deletedEntries: string[] = [];
	mkdirSync(workspace.sourceCwd, { recursive: true });

	const diff = diffAutonomousWorkspace(workspace);
	for (const relativePath of [...diff.added, ...diff.modified]) {
		cpSync(join(workspace.activeCwd, relativePath), join(workspace.sourceCwd, relativePath), {
			recursive: true,
			force: true,
			verbatimSymlinks: true,
		});
		copiedEntries.add(relativePath.split(/[\\/]/)[0] ?? relativePath);
	}

	if (options.deleteMissing) {
		for (const relativePath of diff.deleted) {
			rmSync(join(workspace.sourceCwd, relativePath), { recursive: true, force: true });
			deletedEntries.push(relativePath);
		}
	}

	return {
		sourceCwd: workspace.sourceCwd,
		workspaceRoot: workspace.workspaceRoot,
		activeCwd: workspace.activeCwd,
		copiedEntries: Array.from(copiedEntries).sort(),
		deletedEntries,
	};
}

function sanitizePathForDir(targetPath: string): string {
	return targetPath
		.replace(/^[A-Za-z]:/, "")
		.replace(/[\\/]+/g, "__")
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.replace(/^_+/, "") || basename(targetPath) || "workspace";
}

async function detectGitWorkspace(
	cwd: string,
): Promise<{ repoRoot: string; isDirty: boolean } | undefined> {
	const rootResult = await execCommand("git", ["rev-parse", "--show-toplevel"], cwd, { timeout: 15000 });
	if (rootResult.code !== 0) {
		return undefined;
	}

	const repoRoot = rootResult.stdout.trim();
	if (!repoRoot) {
		return undefined;
	}

	const statusResult = await execCommand("git", ["status", "--porcelain"], cwd, { timeout: 15000 });
	return {
		repoRoot,
		isDirty: statusResult.code === 0 && statusResult.stdout.trim().length > 0,
	};
}

async function createGitWorktree(repoRoot: string, workspaceRoot: string): Promise<void> {
	const result = await execCommand("git", ["worktree", "add", "--detach", workspaceRoot], repoRoot, {
		timeout: 60000,
	});
	if (result.code !== 0) {
		throw new Error(`Failed to create autonomous git worktree: ${result.stderr || result.stdout}`);
	}
}

function copyWorkspaceTree(
	sourceCwd: string,
	workspaceRoot: string,
	options: { excludedRoots?: string[] } = {},
): void {
	const normalizedSource = resolve(sourceCwd);
	const excludedRoots = (options.excludedRoots ?? []).map((entry) => resolve(entry));
	mkdirSync(workspaceRoot, { recursive: true });

	const shouldIncludePath = (targetPath: string): boolean => {
		if (excludedRoots.some((entry) => isNestedWithin(targetPath, entry))) {
			return false;
		}
		const name = basename(targetPath);
		return name !== ".git" && name !== ".ag1-autonomous-workspace.json";
	};

	for (const entry of readdirSync(sourceCwd)) {
		const sourceEntry = join(sourceCwd, entry);
		if (!shouldIncludePath(sourceEntry)) continue;
		copyEntryRecursively(sourceEntry, join(workspaceRoot, entry), shouldIncludePath);
	}

	for (const excludedRoot of excludedRoots) {
		if (!isNestedWithin(excludedRoot, normalizedSource)) continue;
		const relativePath = relative(normalizedSource, excludedRoot);
		if (!relativePath || relativePath.startsWith("..")) continue;
		rmSync(join(workspaceRoot, relativePath), { recursive: true, force: true });
	}
}

function copyEntryRecursively(
	sourcePath: string,
	destPath: string,
	shouldIncludePath: (targetPath: string) => boolean,
): void {
	if (!shouldIncludePath(sourcePath)) return;
	const stats = lstatSync(sourcePath);

	if (stats.isSymbolicLink()) {
		const linkTarget = readlinkSync(sourcePath);
		const parentDir = resolve(destPath, "..");
		mkdirSync(parentDir, { recursive: true });
		rmSync(destPath, { recursive: true, force: true });
		symlinkSync(linkTarget, destPath);
		return;
	}

	if (stats.isDirectory()) {
		mkdirSync(destPath, { recursive: true });
		for (const entry of readdirSync(sourcePath)) {
			const childSource = join(sourcePath, entry);
			if (!shouldIncludePath(childSource)) continue;
			copyEntryRecursively(childSource, join(destPath, entry), shouldIncludePath);
		}
		return;
	}

	if (stats.isFile()) {
		const parentDir = resolve(destPath, "..");
		mkdirSync(parentDir, { recursive: true });
		copyFileSync(sourcePath, destPath);
	}
}

function writeWorkspaceMetadata(options: {
	workspaceRoot: string;
	sourceCwd: string;
	strategy: AutonomousWorkspaceStrategy;
	activeCwd: string;
	referenceRoot?: string;
}): void {
	if (!existsSync(options.workspaceRoot)) {
		mkdirSync(options.workspaceRoot, { recursive: true });
	}

	writeFileSync(
		join(options.workspaceRoot, ".ag1-autonomous-workspace.json"),
		`${JSON.stringify(
			{
				sourceCwd: options.sourceCwd,
				strategy: options.strategy,
				referenceRoot: options.referenceRoot,
				activeCwd: options.activeCwd,
				createdAt: new Date().toISOString(),
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
}

type WorkspaceEntry =
	| { kind: "file"; content: Buffer }
	| { kind: "directory" };

function collectWorkspaceEntries(root: string, current = root, entries = new Map<string, WorkspaceEntry>()): Map<string, WorkspaceEntry> {
	for (const entry of readdirSync(current)) {
		if (entry === ".git" || entry === ".ag1-autonomous-workspace.json") {
			continue;
		}
		const absolutePath = join(current, entry);
		const relativePath = relative(root, absolutePath);
		const stats = statSync(absolutePath);
		if (stats.isDirectory()) {
			entries.set(relativePath, { kind: "directory" });
			collectWorkspaceEntries(root, absolutePath, entries);
			continue;
		}
		if (stats.isFile()) {
			entries.set(relativePath, { kind: "file", content: readFileSync(absolutePath) });
		}
	}
	return entries;
}

function buffersEqual(left: Buffer, right: Buffer): boolean {
	if (left.length !== right.length) return false;
	return left.equals(right);
}
