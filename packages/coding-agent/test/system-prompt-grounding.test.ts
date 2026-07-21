import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSystemPrompt, buildWorkspaceSnapshot } from "../src/core/system-prompt.js";

let testDir: string;

beforeAll(() => {
	testDir = join(tmpdir(), `ag1-sp-test-${process.pid}`);
	mkdirSync(join(testDir, ".git"), { recursive: true });
	mkdirSync(join(testDir, "src"), { recursive: true });
	mkdirSync(join(testDir, "docs"), { recursive: true });
	writeFileSync(join(testDir, "package.json"), "{}");
	writeFileSync(join(testDir, "README.md"), "x");
});

afterAll(() => {
	rmSync(testDir, { recursive: true, force: true });
});

describe("buildWorkspaceSnapshot", () => {
	it("lists directories first with trailing slash and skips .git", () => {
		const snapshot = buildWorkspaceSnapshot(testDir);
		const lines = snapshot.split("\n");
		expect(lines).not.toContain(".git");
		expect(lines.indexOf("src/")).toBeLessThan(lines.indexOf("package.json"));
		expect(lines.indexOf("docs/")).toBeLessThan(lines.indexOf("README.md"));
		expect(lines).toContain("package.json");
	});

	it("caps long listings with a +N more marker", () => {
		for (let i = 0; i < 120; i++) writeFileSync(join(testDir, `f${String(i).padStart(3, "0")}.txt`), "x");
		const snapshot = buildWorkspaceSnapshot(testDir, 100);
		expect(snapshot).toContain("+");
		expect(snapshot).toContain("more");
	});

	it("returns empty string for unreadable directories", () => {
		expect(buildWorkspaceSnapshot(join(testDir, "does-not-exist"))).toBe("");
	});
});

describe("system prompt cache stability", () => {
	const options = {
		cwd: "/tmp/project",
		selectedTools: ["read", "bash", "edit", "write"],
		toolSnippets: { read: "Read files", bash: "Run commands", edit: "Edit files", write: "Write files" },
		workspaceSnapshot: "src/\npackage.json",
	};

	it("is byte-identical across rebuilds with the same inputs (prompt-cache friendly)", () => {
		expect(buildSystemPrompt(options)).toBe(buildSystemPrompt(options));
	});

	it("includes the workspace grounding section when a snapshot is provided", () => {
		const prompt = buildSystemPrompt(options);
		expect(prompt).toContain("Top-level workspace entries (snapshot at session start):");
		expect(prompt).toContain("src/\npackage.json");
	});

	it("omits the grounding section when no snapshot is provided", () => {
		const { workspaceSnapshot: _workspaceSnapshot, ...rest } = options;
		expect(buildSystemPrompt(rest)).not.toContain("Top-level workspace entries");
	});
});
