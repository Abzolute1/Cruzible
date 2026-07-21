import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DELEGATION_DIFF_MAX_PATHS,
	DELEGATION_SNAPSHOT_MAX_FILES,
	DELEGATION_TOOL_NAMES,
	DelegationEvidenceTracker,
	diffWorkspaceSnapshots,
	hasStructuredEvidence,
	snapshotWorkspaceMtimes,
} from "../src/core/delegation-evidence.js";
import { extractInteractiveToolMetadata } from "../src/modes/interactive/interactive-tool-outcomes.js";

describe("delegation-evidence", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "ag1-delegation-evidence-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeTempFile(relativePath: string, contents = "x"): void {
		writeFileSync(join(tempDir, relativePath), contents);
	}

	describe("snapshotWorkspaceMtimes", () => {
		it("maps workspace files to their mtime, relative to the root", () => {
			writeTempFile("a.ts", "a");
			mkdirSync(join(tempDir, "src"));
			writeTempFile(join("src", "b.ts"), "b");

			const snapshot = snapshotWorkspaceMtimes(tempDir);

			expect(snapshot.size).toBe(2);
			expect(snapshot.get("a.ts")).toEqual(expect.any(Number));
			expect(snapshot.get(join("src", "b.ts"))).toEqual(expect.any(Number));
		});

		it("skips node_modules, .git, Debug and dist directories", () => {
			for (const skipped of ["node_modules", ".git", "Debug", "dist"]) {
				mkdirSync(join(tempDir, skipped));
				writeTempFile(join(skipped, "ignored.ts"));
			}
			writeTempFile("kept.ts");

			const snapshot = snapshotWorkspaceMtimes(tempDir);

			expect([...snapshot.keys()]).toEqual(["kept.ts"]);
		});

		it("tolerates a missing directory without throwing", () => {
			const snapshot = snapshotWorkspaceMtimes(join(tempDir, "does-not-exist"));
			expect(snapshot.size).toBe(0);
		});

		it("caps the walk at DELEGATION_SNAPSHOT_MAX_FILES", () => {
			for (let i = 0; i < DELEGATION_SNAPSHOT_MAX_FILES + 25; i++) {
				writeTempFile(`file-${String(i).padStart(5, "0")}.ts`);
			}

			const snapshot = snapshotWorkspaceMtimes(tempDir);

			expect(snapshot.size).toBe(DELEGATION_SNAPSHOT_MAX_FILES);
		});
	});

	describe("diffWorkspaceSnapshots", () => {
		it("reports added files and files with a newer mtime, sorted", () => {
			const before = new Map([
				["changed.ts", 1000],
				["same.ts", 1000],
				["removed.ts", 1000],
			]);
			const after = new Map([
				["changed.ts", 2000],
				["same.ts", 1000],
				["added.ts", 1000],
			]);

			expect(diffWorkspaceSnapshots(before, after)).toEqual(["added.ts", "changed.ts"]);
		});

		it("caps the result at DELEGATION_DIFF_MAX_PATHS", () => {
			const before = new Map<string, number>();
			const after = new Map<string, number>();
			for (let i = 0; i < DELEGATION_DIFF_MAX_PATHS + 50; i++) {
				after.set(`file-${String(i).padStart(5, "0")}.ts`, 1000);
			}

			const diff = diffWorkspaceSnapshots(before, after);

			expect(diff.length).toBe(DELEGATION_DIFF_MAX_PATHS);
			expect(diff).toEqual([...diff].sort());
		});
	});

	describe("hasStructuredEvidence", () => {
		it("is false without an evidence array entry", () => {
			expect(hasStructuredEvidence(undefined)).toBe(false);
			expect(hasStructuredEvidence(null)).toBe(false);
			expect(hasStructuredEvidence("evidence")).toBe(false);
			expect(hasStructuredEvidence({})).toBe(false);
			expect(hasStructuredEvidence({ evidence: [] })).toBe(false);
			expect(hasStructuredEvidence({ evidence: "not-an-array" })).toBe(false);
		});

		it("is true with at least one evidence entry", () => {
			expect(hasStructuredEvidence({ evidence: [{ kind: "file", path: "a.ts" }] })).toBe(true);
		});
	});

	describe("DelegationEvidenceTracker", () => {
		it("covers the delegation tool names", () => {
			expect(DELEGATION_TOOL_NAMES.has("task")).toBe(true);
			expect(DELEGATION_TOOL_NAMES.has("subagent")).toBe(true);
		});

		it("attaches observed file changes when a delegation result lacks evidence", () => {
			writeTempFile("modified.ts", "before");
			writeTempFile("untouched.ts", "same");
			// Pin the pre-delegation mtime into the past so the rewrite is reliably newer.
			const past = new Date("2020-01-01T00:00:00Z");
			utimesSync(join(tempDir, "modified.ts"), past, past);
			utimesSync(join(tempDir, "untouched.ts"), past, past);

			const tracker = new DelegationEvidenceTracker();
			tracker.handleToolStart("subagent", "call-1", tempDir);
			writeTempFile("modified.ts", "after");
			writeTempFile("added.ts", "new");

			// Fake extension-tool result: content plus details, but no evidence.
			const fakeResult = {
				content: [{ type: "text", text: "done" }],
				details: { summary: "delegated run finished" },
			};
			const metadata = tracker.handleToolEnd(
				"subagent",
				"call-1",
				tempDir,
				extractInteractiveToolMetadata(fakeResult),
			);

			expect(metadata?.summary).toBe("delegated run finished");
			expect(metadata?.evidence).toEqual([
				{ kind: "file", path: "added.ts" },
				{ kind: "file", path: "modified.ts" },
			]);
		});

		it("leaves a result with its own structured evidence untouched", () => {
			const tracker = new DelegationEvidenceTracker();
			tracker.handleToolStart("task", "call-2", tempDir);
			writeTempFile("changed-during-call.ts");

			const metadata = {
				summary: "delegated run finished",
				evidence: [{ kind: "file", action: "write", path: "reported-by-tool.ts" }],
			};
			const merged = tracker.handleToolEnd("task", "call-2", tempDir, metadata);

			expect(merged).toBe(metadata);
		});

		it("ignores non-delegation tools entirely", () => {
			const tracker = new DelegationEvidenceTracker();
			tracker.handleToolStart("bash", "call-3", tempDir);
			writeTempFile("changed-during-call.ts");

			expect(tracker.handleToolEnd("bash", "call-3", tempDir, undefined)).toBeUndefined();
		});

		it("adds no evidence when nothing changed", () => {
			writeTempFile("same.ts");
			const tracker = new DelegationEvidenceTracker();
			tracker.handleToolStart("subagent", "call-4", tempDir);

			expect(tracker.handleToolEnd("subagent", "call-4", tempDir, undefined)).toBeUndefined();
		});

		it("never throws when the workspace cannot be snapshotted", () => {
			const missing = join(tempDir, "does-not-exist");
			const tracker = new DelegationEvidenceTracker();
			expect(() => {
				tracker.handleToolStart("subagent", "call-5", missing);
				tracker.handleToolEnd("subagent", "call-5", missing, undefined);
			}).not.toThrow();
			expect(tracker.handleToolEnd("subagent", "call-5", missing, undefined)).toBeUndefined();
		});
	});
});
