/**
 * Delegation evidence bridge.
 *
 * Delegation tools other than the built-in `task` tool (e.g. an extension
 * `subagent` tool) return results without `metadata.evidence`, so the auton
 * ledger cannot see what the delegated run actually changed below the tool
 * boundary — honest work becomes unverifiable on paper.
 *
 * This module bridges that gap with reality instead of receipts: it snapshots
 * workspace file mtimes when a delegation tool starts, diffs them when the
 * tool ends, and — only when the result carries no structured evidence of its
 * own — records the files that genuinely appeared or changed as
 * `{ kind: "file", path }` evidence entries on the recorded tool outcome.
 *
 * Every entry point is failure-soft: a snapshotting problem yields no
 * evidence, never an error.
 */

import { type Dirent, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { normalizeToolName } from "./auton/nudges/types.js";

/** Tools whose execution delegates work below the parent tool boundary. */
export const DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set(["task", "subagent"]);

/** Directories never worth diffing for delegation evidence. */
const SKIPPED_DIR_NAMES: ReadonlySet<string> = new Set(["node_modules", ".git", "Debug", "dist"]);

/** Upper bound on files tracked per snapshot — keeps walks cheap in large repos. */
export const DELEGATION_SNAPSHOT_MAX_FILES = 2000;

/** Upper bound on evidence paths emitted per delegation call. */
export const DELEGATION_DIFF_MAX_PATHS = 100;

/**
 * Walk `cwd` and map each file's root-relative path to its mtimeMs.
 * Skips node_modules/.git/Debug/dist directories and caps the walk at
 * DELEGATION_SNAPSHOT_MAX_FILES entries. Never throws: any filesystem error
 * yields whatever partial snapshot was collected (possibly empty).
 */
export function snapshotWorkspaceMtimes(cwd: string): Map<string, number> {
	const snapshot = new Map<string, number>();
	try {
		const pendingDirs: string[] = [cwd];
		while (pendingDirs.length > 0 && snapshot.size < DELEGATION_SNAPSHOT_MAX_FILES) {
			const dir = pendingDirs.pop();
			if (dir === undefined) break;
			let entries: Dirent[];
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (snapshot.size >= DELEGATION_SNAPSHOT_MAX_FILES) break;
				const fullPath = join(dir, entry.name);
				try {
					if (entry.isDirectory()) {
						if (!SKIPPED_DIR_NAMES.has(entry.name)) pendingDirs.push(fullPath);
						continue;
					}
					const stats = statSync(fullPath);
					if (!stats.isFile()) continue;
					snapshot.set(relative(cwd, fullPath), stats.mtimeMs);
				} catch {
					// Unreadable entry (dangling symlink, race, permissions): skip it.
				}
			}
		}
	} catch {
		// Never let snapshotting break tool outcome recording.
	}
	return snapshot;
}

/**
 * Paths present in `after` that were added since `before` or carry a newer
 * mtime, sorted ascending and capped at DELEGATION_DIFF_MAX_PATHS entries.
 */
export function diffWorkspaceSnapshots(before: Map<string, number>, after: Map<string, number>): string[] {
	const changed: string[] = [];
	for (const [path, mtimeMs] of after) {
		const beforeMtimeMs = before.get(path);
		if (beforeMtimeMs === undefined || mtimeMs > beforeMtimeMs) changed.push(path);
	}
	changed.sort();
	return changed.slice(0, DELEGATION_DIFF_MAX_PATHS);
}

/**
 * True when the tool result metadata already carries structured delegation
 * evidence (an `evidence` array with at least one entry), as the built-in
 * `task` tool emits. Such metadata is authoritative and must be left alone.
 */
export function hasStructuredEvidence(metadata: unknown): boolean {
	if (!metadata || typeof metadata !== "object") return false;
	const evidence = (metadata as { evidence?: unknown }).evidence;
	return Array.isArray(evidence) && evidence.length > 0;
}

/**
 * Tracks workspace snapshots across delegation tool calls (keyed by
 * toolCallId) so tool_execution_end can attach observed file changes when the
 * tool itself reported no structured evidence. All methods are failure-soft.
 */
export class DelegationEvidenceTracker {
	private readonly pendingSnapshots = new Map<string, Map<string, number>>();

	/** Stash a workspace snapshot for a delegation tool call. */
	handleToolStart(toolName: string, toolCallId: string, cwd: string): void {
		try {
			if (!DELEGATION_TOOL_NAMES.has(normalizeToolName(toolName))) return;
			this.pendingSnapshots.set(toolCallId, snapshotWorkspaceMtimes(cwd));
		} catch {
			// No snapshot, no evidence — never an error.
		}
	}

	/** Drop a stashed snapshot without producing evidence. */
	discard(toolCallId: string): void {
		this.pendingSnapshots.delete(toolCallId);
	}

	/**
	 * Diff the stashed snapshot against the workspace now and, when `metadata`
	 * lacks structured evidence and files actually changed, return a copy of
	 * the metadata with `evidence: [{ kind: "file", path }, ...]` added.
	 * Existing metadata fields are never overwritten; when the tool reported
	 * its own evidence or nothing changed, `metadata` is returned as-is.
	 */
	handleToolEnd(
		toolName: string,
		toolCallId: string,
		cwd: string,
		metadata: Record<string, unknown> | undefined,
	): Record<string, unknown> | undefined {
		const before = this.pendingSnapshots.get(toolCallId);
		this.pendingSnapshots.delete(toolCallId);
		try {
			if (before === undefined) return metadata;
			if (!DELEGATION_TOOL_NAMES.has(normalizeToolName(toolName))) return metadata;
			if (hasStructuredEvidence(metadata)) return metadata;
			const changed = diffWorkspaceSnapshots(before, snapshotWorkspaceMtimes(cwd));
			if (changed.length === 0) return metadata;
			return {
				...metadata,
				evidence: changed.map((path) => ({ kind: "file", path })),
			};
		} catch {
			return metadata;
		}
	}
}
