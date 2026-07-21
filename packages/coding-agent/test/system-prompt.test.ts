import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.js";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("includes discovery-oriented guidance for local inspection tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "grep", "find", "ls"],
				promptGuidelines: [
					"Use find to locate files when the path is uncertain before retrying read.",
					"Use grep to locate symbols or strings before opening candidate files with read.",
					"Use ls to inspect directories before reading files inside them.",
				],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("- Use find to locate files when the path is uncertain before retrying read.");
			expect(prompt).toContain("- Use grep to locate symbols or strings before opening candidate files with read.");
			expect(prompt).toContain("- Use ls to inspect directories before reading files inside them.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});

		test("uses compact ag1-doc guidance in the default prompt", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "bash"],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("AG1 docs: only for AG1-specific work.");
			expect(prompt).toContain("README ");
			expect(prompt).toContain("Docs ");
			expect(prompt).toContain("Examples ");
			expect(prompt).toContain("Follow markdown cross-references before implementing.");
			expect(prompt).not.toContain("Always read ag1 .md files completely");
			expect(prompt).not.toContain("When asked about:");
		});

		test("uses a read-only role line when only inspection tools are available", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "grep", "find", "ls", "webSearch", "webFetch"],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain(
				"Use the available read-only and research tools to inspect evidence and answer precisely.",
			);
			expect(prompt).not.toContain("run commands, edit files");
		});

		test("uses a more compact prompt profile for local/low-context models", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "bash"],
				contextFiles: [],
				skills: [],
				modelProvider: "local",
				contextWindow: 32000,
			});

			expect(prompt).toContain("Use tools sparingly");
			expect(prompt).toContain("AG1 docs only for AG1-specific work:");
			expect(prompt).not.toContain("You are an expert coding assistant inside AG1.");
		});
	});
});
