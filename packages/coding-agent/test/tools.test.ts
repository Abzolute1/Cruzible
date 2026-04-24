import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeBash } from "../src/core/bash-executor.js";
import { createBashTool, createLocalBashOperations } from "../src/core/tools/bash.js";
import { createEditTool } from "../src/core/tools/edit.js";
import { createFindTool } from "../src/core/tools/find.js";
import { createGrepTool } from "../src/core/tools/grep.js";
import { createLsTool } from "../src/core/tools/ls.js";
import { createReadTool } from "../src/core/tools/read.js";
import { createWriteTool } from "../src/core/tools/write.js";
import * as shellModule from "../src/utils/shell.js";

// Helper to extract text from content blocks
function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

describe("Coding Agent Tools", () => {
	let testDir: string;
	let readTool: ReturnType<typeof createReadTool>;
	let writeTool: ReturnType<typeof createWriteTool>;
	let editTool: ReturnType<typeof createEditTool>;
	let grepTool: ReturnType<typeof createGrepTool>;
	let findTool: ReturnType<typeof createFindTool>;
	let lsTool: ReturnType<typeof createLsTool>;
	let cwdBashTool: ReturnType<typeof createBashTool>;

	beforeEach(() => {
		// Create a unique temporary directory for each test
		testDir = join(tmpdir(), `coding-agent-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		readTool = createReadTool(testDir);
		writeTool = createWriteTool(testDir);
		editTool = createEditTool(testDir);
		grepTool = createGrepTool(testDir);
		findTool = createFindTool(testDir);
		lsTool = createLsTool(testDir);
		cwdBashTool = createBashTool(testDir);
	});

	afterEach(() => {
		// Clean up test directory
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("read tool", () => {
		it("should read file contents that fit within limits", async () => {
			const testFile = join(testDir, "test.txt");
			const content = "Hello, world!\nLine 2\nLine 3";
			writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-1", { path: testFile });

			expect(getTextOutput(result)).toBe(content);
			expect(getTextOutput(result)).not.toContain("Use offset=");
			expect(result.details?.progress).toMatchObject({
				startLine: 1,
				endLine: 3,
				totalLines: 3,
				hasMore: false,
				completion: "complete",
				reason: "complete",
			});
		});

		it("should handle non-existent files", async () => {
			const testFile = join(testDir, "nonexistent.txt");

			await expect(readTool.execute("test-call-2", { path: testFile })).rejects.toThrow(
				/Path not found: .*Use find to locate files or ls to inspect directories before retrying read\./i,
			);
		});

		it("should truncate files exceeding line limit", async () => {
			const testFile = join(testDir, "large.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-3", { path: testFile });
			const output = getTextOutput(result);

				expect(output).toContain("Line 1");
				expect(output).toContain("Line 2000");
				expect(output).not.toContain("Line 2001");
				expect(output).toContain("[lines 1-2000/2500; next offset=2001]");
			expect(result.details?.progress).toMatchObject({
				startLine: 1,
				endLine: 2000,
				totalLines: 2500,
				hasMore: true,
				nextOffset: 2001,
				completion: "partial",
				reason: "line_limit",
			});
		});

		it("should truncate when byte limit exceeded", async () => {
			const testFile = join(testDir, "large-bytes.txt");
			// Create file that exceeds 50KB byte limit but has fewer than 2000 lines
			const lines = Array.from({ length: 500 }, (_, i) => `Line ${i + 1}: ${"x".repeat(200)}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-4", { path: testFile });
			const output = getTextOutput(result);

				expect(output).toContain("Line 1:");
				// Should show byte limit message
				expect(output).toMatch(/\[lines 1-\d+\/500; byte limit hit; next offset=\d+\]/);
			expect(result.details?.progress?.completion).toBe("partial");
			expect(result.details?.progress?.reason).toBe("byte_limit");
			expect(result.details?.progress?.nextOffset).toBeGreaterThan(1);
		});

		it("should handle offset parameter", async () => {
			const testFile = join(testDir, "offset-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-5", { path: testFile, offset: 51 });
			const output = getTextOutput(result);

			expect(output).not.toContain("Line 50");
			expect(output).toContain("Line 51");
			expect(output).toContain("Line 100");
			// No truncation message since file fits within limits
			expect(output).not.toContain("Use offset=");
			expect(result.details?.progress).toMatchObject({
				startLine: 51,
				endLine: 100,
				totalLines: 100,
				hasMore: false,
				completion: "complete",
			});
		});

		it("should handle limit parameter", async () => {
			const testFile = join(testDir, "limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-6", { path: testFile, limit: 10 });
			const output = getTextOutput(result);

				expect(output).toContain("Line 1");
				expect(output).toContain("Line 10");
				expect(output).not.toContain("Line 11");
				expect(output).toContain("[90 more lines; next offset=11]");
			expect(result.details?.progress).toMatchObject({
				startLine: 1,
				endLine: 10,
				totalLines: 100,
				hasMore: true,
				nextOffset: 11,
				completion: "partial",
				reason: "user_limit",
			});
		});

		it("should handle offset + limit together", async () => {
			const testFile = join(testDir, "offset-limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-7", {
				path: testFile,
				offset: 41,
				limit: 20,
			});
			const output = getTextOutput(result);

			expect(output).not.toContain("Line 40");
				expect(output).toContain("Line 41");
				expect(output).toContain("Line 60");
				expect(output).not.toContain("Line 61");
				expect(output).toContain("[40 more lines; next offset=61]");
			expect(result.details?.progress).toMatchObject({
				startLine: 41,
				endLine: 60,
				totalLines: 100,
				hasMore: true,
				nextOffset: 61,
				completion: "partial",
				reason: "user_limit",
			});
		});

		it("should show error when offset is beyond file length", async () => {
			const testFile = join(testDir, "short.txt");
			writeFileSync(testFile, "Line 1\nLine 2\nLine 3");

			await expect(readTool.execute("test-call-8", { path: testFile, offset: 100 })).rejects.toThrow(
				/Offset 100 is beyond end of file \(3 lines total\)/,
			);
		});

		it("should include truncation details when truncated", async () => {
			const testFile = join(testDir, "large-file.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-9", { path: testFile });

			expect(result.details).toBeDefined();
			expect(result.details?.truncation).toBeDefined();
			expect(result.details?.truncation?.truncated).toBe(true);
			expect(result.details?.truncation?.truncatedBy).toBe("lines");
			expect(result.details?.truncation?.totalLines).toBe(2500);
			expect(result.details?.truncation?.outputLines).toBe(2000);
			expect(result.details?.progress?.nextOffset).toBe(2001);
		});

		it("should detect image MIME type from file magic (not extension)", async () => {
			const png1x1Base64 =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
			const pngBuffer = Buffer.from(png1x1Base64, "base64");

			const testFile = join(testDir, "image.txt");
			writeFileSync(testFile, pngBuffer);

			const result = await readTool.execute("test-call-img-1", { path: testFile });

			expect(result.content[0]?.type).toBe("text");
			expect(getTextOutput(result)).toContain("Read image file [image/png]");

			const imageBlock = result.content.find(
				(c): c is { type: "image"; mimeType: string; data: string } => c.type === "image",
			);
			expect(imageBlock).toBeDefined();
			expect(imageBlock?.mimeType).toBe("image/png");
			expect(typeof imageBlock?.data).toBe("string");
			expect((imageBlock?.data ?? "").length).toBeGreaterThan(0);
		});

		it("should treat files with image extension but non-image content as text", async () => {
			const testFile = join(testDir, "not-an-image.png");
			writeFileSync(testFile, "definitely not a png");

			const result = await readTool.execute("test-call-img-2", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("definitely not a png");
			expect(result.content.some((c: any) => c.type === "image")).toBe(false);
		});

		it("should guide directory reads toward ls", async () => {
			const dirPath = join(testDir, "nested");
			mkdirSync(dirPath, { recursive: true });

			await expect(readTool.execute("test-call-img-3", { path: dirPath })).rejects.toThrow(
				/Path is a directory: .*Use ls to inspect it, then read a specific file\./i,
			);
		});
	});

	describe("structured local metadata", () => {
		it("grep should expose decisive match metadata", async () => {
			const testFile = join(testDir, "sample.ts");
			writeFileSync(testFile, "export function createContextHygieneCopy() {}\n");

			const result = await grepTool.execute("grep-meta-1", {
				pattern: "createContextHygieneCopy",
				path: testDir,
				literal: true,
			});

			expect(result.details?.matchCount).toBe(1);
			expect(result.details?.uniqueFileCount).toBe(1);
			expect(result.details?.firstMatchPath).toBe("sample.ts");
			expect(result.details?.firstMatchLine).toBe(1);
		});

		it("find should expose dominant file directory metadata", async () => {
			mkdirSync(join(testDir, "scripts"), { recursive: true });
			mkdirSync(join(testDir, "benchmarks"), { recursive: true });
			writeFileSync(join(testDir, "scripts", "harness-benchmark-run.mjs"), "run");
			writeFileSync(join(testDir, "scripts", "harness-benchmark-compare.mjs"), "compare");
			writeFileSync(join(testDir, "benchmarks", "benchmark-history.jsonl"), "hist");

			const result = await findTool.execute("find-meta-1", {
				pattern: "**/*benchmark*",
				path: testDir,
			});

			expect(result.details?.resultCount).toBeGreaterThanOrEqual(3);
			expect(result.details?.dominantFileDirectory).toBe("scripts");
			expect(result.details?.firstMatchPath).toBeDefined();
		});

		it("ls should expose listing metadata", async () => {
			mkdirSync(join(testDir, "scripts"), { recursive: true });
			writeFileSync(join(testDir, "scripts", "a.ts"), "a");
			writeFileSync(join(testDir, "scripts", "b.ts"), "b");

			const result = await lsTool.execute("ls-meta-1", {
				path: join(testDir, "scripts"),
			});

			expect(result.details?.directoryPath).toBe(join(testDir, "scripts"));
			expect(result.details?.entryCount).toBe(2);
			expect(result.details?.entriesSample).toEqual(["a.ts", "b.ts"]);
		});

		it("grep should suggest answering immediately for pure path questions", async () => {
			const testFile = join(testDir, "sample.ts");
			writeFileSync(testFile, "export function createContextHygieneCopy() {}\n");

			const result = await grepTool.execute("grep-meta-2", {
				pattern: "createContextHygieneCopy",
				path: testDir,
				literal: true,
			});

			const output = getTextOutput(result);
			expect(output).toContain("if the user only asked which file/path, answer now");
			expect(output).toContain("next: read sample.ts offset=1 limit=120");
		});

		it("find should suggest answering immediately for pure path questions", async () => {
			writeFileSync(join(testDir, "only-match.ts"), "export const x = 1;\n");

			const result = await findTool.execute("find-meta-2", {
				pattern: "**/only-match.ts",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("if the user only asked which file/path, answer now");
			expect(output).toContain("next: read only-match.ts limit=120");
		});

		it("ls should suggest answering directly from a complete small listing", async () => {
			mkdirSync(join(testDir, "scripts-small"), { recursive: true });
			writeFileSync(join(testDir, "scripts-small", "a.ts"), "a");
			writeFileSync(join(testDir, "scripts-small", "b.ts"), "b");

			const result = await lsTool.execute("ls-meta-2", {
				path: join(testDir, "scripts-small"),
			});

			const output = getTextOutput(result);
			expect(output).toContain("directory listed completely");
			expect(output).toContain("answer now from this listing");
		});
	});

	describe("write tool", () => {
		it("should write file contents", async () => {
			const testFile = join(testDir, "write-test.txt");
			const content = "Test content";

			const result = await writeTool.execute("test-call-3", { path: testFile, content });

			expect(getTextOutput(result)).toContain("Wrote");
			expect(getTextOutput(result)).toContain(testFile);
			expect(result.details).toBeUndefined();
		});

		it("should create parent directories", async () => {
			const testFile = join(testDir, "nested", "dir", "test.txt");
			const content = "Nested content";

			const result = await writeTool.execute("test-call-4", { path: testFile, content });

			expect(getTextOutput(result)).toContain("Wrote");
		});
	});

	describe("edit tool", () => {
		it("should replace text in file", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			writeFileSync(testFile, originalContent);

			const result = await editTool.execute("test-call-5", {
				path: testFile,
				edits: [{ oldText: "world", newText: "testing" }],
			});

			expect(getTextOutput(result)).toContain("Patched");
			expect(result.details).toBeDefined();
			expect(result.details.diff).toBeDefined();
			expect(typeof result.details.diff).toBe("string");
			expect(result.details.diff).toContain("testing");
		});

		it("should fail if text not found", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-6", {
					path: testFile,
					edits: [{ oldText: "nonexistent", newText: "testing" }],
				}),
			).rejects.toThrow(/Could not find the exact text/);
		});

		it("should fail if text appears multiple times", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "foo foo foo";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-7", {
					path: testFile,
					edits: [{ oldText: "foo", newText: "bar" }],
				}),
			).rejects.toThrow(/Found 3 occurrences/);
		});

		it("should replace multiple disjoint regions in one call", async () => {
			const testFile = join(testDir, "edit-multi.txt");
			writeFileSync(testFile, "alpha\nbeta\ngamma\ndelta\n");

			const result = await editTool.execute("test-call-8", {
				path: testFile,
				edits: [
					{ oldText: "alpha\n", newText: "ALPHA\n" },
					{ oldText: "gamma\n", newText: "GAMMA\n" },
				],
			});

			expect(getTextOutput(result)).toContain("Patched 2 block(s)");
			expect(readFileSync(testFile, "utf-8")).toBe("ALPHA\nbeta\nGAMMA\ndelta\n");
			expect(result.details?.diff).toContain("ALPHA");
			expect(result.details?.diff).toContain("GAMMA");
		});

		it("should collapse large unchanged gaps in multi-edit diffs", async () => {
			const testFile = join(testDir, "edit-multi-large-gap.txt");
			const lines = Array.from({ length: 600 }, (_, i) => `line ${String(i + 1).padStart(3, "0")}`);
			writeFileSync(testFile, `${lines.join("\n")}\n`);

			const result = await editTool.execute("test-call-8b", {
				path: testFile,
				edits: [
					{ oldText: "line 100\n", newText: "LINE 100\n" },
					{ oldText: "line 300\n", newText: "LINE 300\n" },
					{ oldText: "line 500\n", newText: "LINE 500\n" },
				],
			});

			const diff = result.details?.diff ?? "";
			expect(diff).toContain("LINE 100");
			expect(diff).toContain("LINE 300");
			expect(diff).toContain("LINE 500");
			expect(diff).toContain("...");
			expect(diff).not.toContain("line 250");
			expect(diff.split("\n").length).toBeLessThan(50);
		});

		it("should match edits against the original file, not incrementally", async () => {
			const testFile = join(testDir, "edit-multi-original.txt");
			writeFileSync(testFile, "foo\nbar\nbaz\n");

			await editTool.execute("test-call-9", {
				path: testFile,
				edits: [
					{ oldText: "foo\n", newText: "foo bar\n" },
					{ oldText: "bar\n", newText: "BAR\n" },
				],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("foo bar\nBAR\nbaz\n");
		});

		it("should fail when edits is empty", async () => {
			const testFile = join(testDir, "edit-empty-edits.txt");
			writeFileSync(testFile, "hello\nworld\n");

			await expect(
				editTool.execute("test-call-11", {
					path: testFile,
					edits: [],
				}),
			).rejects.toThrow(/edits must contain at least one replacement/);
		});

		it("should fail when multi-edit regions overlap", async () => {
			const testFile = join(testDir, "edit-overlap.txt");
			writeFileSync(testFile, "one\ntwo\nthree\n");

			await expect(
				editTool.execute("test-call-12", {
					path: testFile,
					edits: [
						{ oldText: "one\ntwo\n", newText: "ONE\nTWO\n" },
						{ oldText: "two\nthree\n", newText: "TWO\nTHREE\n" },
					],
				}),
			).rejects.toThrow(/overlap/);
		});

		it("should not partially apply edits when one edit fails", async () => {
			const testFile = join(testDir, "edit-no-partial.txt");
			const originalContent = "alpha\nbeta\ngamma\n";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-13", {
					path: testFile,
					edits: [
						{ oldText: "alpha\n", newText: "ALPHA\n" },
						{ oldText: "missing\n", newText: "MISSING\n" },
					],
				}),
			).rejects.toThrow(/Could not find/);

			expect(readFileSync(testFile, "utf-8")).toBe(originalContent);
		});
	});

	describe("bash tool", () => {
		it("should execute simple commands", async () => {
			const result = await cwdBashTool.execute("test-call-8", { command: "echo 'test output'" });

			expect(getTextOutput(result)).toContain("test output");
			expect(result.details).toBeUndefined();
		});

		it("should add a stop-signal after inspection-style pwd commands", async () => {
			const result = await cwdBashTool.execute("test-call-pwd-hint", { command: "pwd" });
			const output = getTextOutput(result);

			expect(output).toContain(testDir);
			expect(output).toContain("[location confirmed; switch to find, grep, ls, or read next instead of repeating pwd]");
		});

		it("should handle command errors", async () => {
			await expect(cwdBashTool.execute("test-call-9", { command: "exit 1" })).rejects.toThrow(
				/(Command failed|code 1)/,
			);
		});

		it("should respect timeout", async () => {
			await expect(cwdBashTool.execute("test-call-10", { command: "sleep 5", timeout: 1 })).rejects.toThrow(
				/timed out/i,
			);
		});

		it("should throw error when cwd does not exist", async () => {
			const nonexistentCwd = "/this/directory/definitely/does/not/exist/12345";

			const bashToolWithBadCwd = createBashTool(nonexistentCwd);

			await expect(bashToolWithBadCwd.execute("test-call-11", { command: "echo test" })).rejects.toThrow(
				/Working directory does not exist/,
			);
		});

		it("should handle process spawn errors", async () => {
			vi.spyOn(shellModule, "getShellConfig").mockReturnValueOnce({
				shell: "/nonexistent-shell-path-xyz123",
				args: ["-c"],
			});

			const bashWithBadShell = createBashTool(testDir);

			await expect(bashWithBadShell.execute("test-call-12", { command: "echo test" })).rejects.toThrow(/ENOENT/);
		});

		it("should prepend command prefix when configured", async () => {
			const bashWithPrefix = createBashTool(testDir, {
				commandPrefix: "export TEST_VAR=hello",
			});

			const result = await bashWithPrefix.execute("test-prefix-1", { command: "echo $TEST_VAR" });
			expect(getTextOutput(result).trim()).toBe("hello");
		});

		it("should include output from both prefix and command", async () => {
			const bashWithPrefix = createBashTool(testDir, {
				commandPrefix: "echo prefix-output",
			});

			const result = await bashWithPrefix.execute("test-prefix-2", { command: "echo command-output" });
			expect(getTextOutput(result).trim()).toBe("prefix-output\ncommand-output");
		});

		it("should work without command prefix", async () => {
			const bashWithoutPrefix = createBashTool(testDir, {});

			const result = await bashWithoutPrefix.execute("test-prefix-3", { command: "echo no-prefix" });
			expect(getTextOutput(result).trim()).toBe("no-prefix");
		});

		it("should expose local bash operations for extension reuse", async () => {
			const ops = createLocalBashOperations();
			const chunks: Buffer[] = [];

			const result = await ops.exec("echo $TEST_LOCAL_BASH_OPS", testDir, {
				onData: (data) => chunks.push(data),
				env: { ...process.env, TEST_LOCAL_BASH_OPS: "from-local-ops" },
			});

			expect(result.exitCode).toBe(0);
			expect(Buffer.concat(chunks).toString("utf-8").trim()).toBe("from-local-ops");
		});

		it("should preserve executeBash sanitization when using local bash operations", async () => {
			const result = await executeBash("printf '\\033[31mred\\033[0m\\r\\n'");

			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("red\n");
		});

		it("should persist full output when truncation happens by line count only", async () => {
			const bash = createBashTool(testDir);
			const result = await bash.execute("test-call-line-truncation", { command: "seq 3000" });
			const output = getTextOutput(result);
			const fullOutputPath = result.details?.fullOutputPath;

			expect(result.details?.truncation?.truncated).toBe(true);
				expect(result.details?.truncation?.truncatedBy).toBe("lines");
				expect(fullOutputPath).toBeDefined();
				expect(output).toMatch(/\[tail lines \d+-\d+\/\d+\] \[full output: /);
				expect(output).not.toContain("Full output: undefined");

			for (let i = 0; i < 20 && (!fullOutputPath || !existsSync(fullOutputPath)); i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			expect(fullOutputPath).toBeDefined();
			expect(existsSync(fullOutputPath!)).toBe(true);
			const fullOutput = readFileSync(fullOutputPath!, "utf-8");
				expect(fullOutput).toContain("1\n2\n3");
				expect(fullOutput).toContain("2998\n2999\n3000");
			});

			it("should compact large listing-style bash output before transcript truncation", async () => {
				for (let i = 1; i <= 80; i++) {
					writeFileSync(join(testDir, `file-${i.toString().padStart(3, "0")}.txt`), String(i));
				}
				const bash = createBashTool(testDir);
				const result = await bash.execute("test-call-listing-compact", { command: "ls" });
				const output = getTextOutput(result);

				expect(output).toContain("file-001.txt");
				expect(output).toContain("file-025.txt");
				expect(output).not.toContain("file-080.txt");
				expect(output).toContain("[55 more lines omitted from inspection output]");
				expect(output).toContain(
					"[discovery output only; if the target path is visible here, inspect it directly instead of repeating shell discovery]",
				);
			});

		it("executeBash should persist full output when truncation happens by line count only", async () => {
			const result = await executeBash("seq 3000");
			const fullOutputPath = result.fullOutputPath;

			expect(result.truncated).toBe(true);
			expect(fullOutputPath).toBeDefined();

			for (let i = 0; i < 20 && (!fullOutputPath || !existsSync(fullOutputPath)); i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			expect(fullOutputPath).toBeDefined();
			expect(existsSync(fullOutputPath!)).toBe(true);
			const fullOutput = readFileSync(fullOutputPath!, "utf-8");
			expect(fullOutput).toContain("1\n2\n3");
			expect(fullOutput).toContain("2998\n2999\n3000");
		});
	});

	describe("grep tool", () => {
		it("should include filename when searching a single file", async () => {
			const testFile = join(testDir, "example.txt");
			writeFileSync(testFile, "first line\nmatch line\nlast line");

			const result = await grepTool.execute("test-call-11", {
				pattern: "match",
				path: testFile,
			});

			const output = getTextOutput(result);
			expect(output).toContain("example.txt:2: match line");
		});

		it("should emit a direct read follow-up for a single definitive match", async () => {
			const testFile = join(testDir, "single-match.ts");
			writeFileSync(testFile, "line one\nexport function target() {}\nline three\n");

			const result = await grepTool.execute("test-call-11b", {
				pattern: "export function target",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("single-match.ts:2: export function target() {}");
			expect(output).toContain("[1 match in single-match.ts:2; if the user only asked which file/path, answer now; otherwise next: read single-match.ts offset=1 limit=120]");
		});

		it("should explain no-match retries when literal search looks like regex syntax", async () => {
			const testFile = join(testDir, "single-match.ts");
			writeFileSync(testFile, "export function target() {}\n");

			const result = await grepTool.execute("test-call-11c", {
				pattern: "target|other.*thing",
				path: testDir,
				literal: true,
			});

			const output = getTextOutput(result);
			expect(output).toContain("(no matches)");
			expect(output).toContain("literal=true with regex-like pattern");
			expect(output).toContain("retry one identifier at a time");
			expect(output).toContain("prefer find on filenames");
			expect(output).toContain("narrower source path");
		});

		it("should explain how to recover when grep path escapes the workspace", async () => {
			await expect(
				grepTool.execute("test-call-11d", {
					pattern: "target",
					path: "/",
				}),
			).rejects.toThrow(/workspace-relative path like \., scripts, src, or packages/i);
		});

		it("should respect global limit and include context lines", async () => {
			const testFile = join(testDir, "context.txt");
			const content = ["before", "match one", "after", "middle", "match two", "after two"].join("\n");
			writeFileSync(testFile, content);

			const result = await grepTool.execute("test-call-12", {
				pattern: "match",
				path: testFile,
				limit: 1,
				context: 1,
			});

			const output = getTextOutput(result);
			expect(output).toContain("context.txt-1- before");
			expect(output).toContain("context.txt:2: match one");
			expect(output).toContain("context.txt-3- after");
			expect(output).toContain("[1 matches limit; next limit=2]");
			// Ensure second match is not present
			expect(output).not.toContain("match two");
		});

		it("should rank source files ahead of mission markdown for local code lookups", async () => {
			const missionFile = join(testDir, "HARNESS_36_POINT_MISSION_2026-04-15.md");
			const sourceDir = join(testDir, "packages", "coding-agent", "src", "core");
			mkdirSync(sourceDir, { recursive: true });
			writeFileSync(
				missionFile,
				"prompt-intent steering follow-up notes\nprompt-intent steering is tracked here\n",
			);
			writeFileSync(
				join(sourceDir, "prompt-intent-steering.ts"),
				"export function buildPromptIntentSteering() {\n\treturn 'prompt-intent steering';\n}\n",
			);

			const result = await grepTool.execute("test-call-12b", {
				pattern: "prompt-intent steering",
				path: testDir,
			});

			const outputLines = getTextOutput(result)
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
			const firstMatchLine = outputLines.find((line) => line.includes(":"));
			expect(firstMatchLine).toContain("packages/coding-agent/src/core/prompt-intent-steering.ts");
			expect(outputLines.some((line) => line.includes("HARNESS_36_POINT_MISSION_2026-04-15.md"))).toBe(true);
		});

		it("should rank exported implementation definitions ahead of legacy internal functions", async () => {
			const codingAgentDir = join(testDir, "packages", "coding-agent", "src", "core");
			const momDir = join(testDir, "packages", "mom", "src");
			mkdirSync(codingAgentDir, { recursive: true });
			mkdirSync(momDir, { recursive: true });
			writeFileSync(
				join(codingAgentDir, "system-prompt.ts"),
				"export function buildSystemPrompt(options = {}) {\n\treturn String(options);\n}\n",
			);
			writeFileSync(
				join(momDir, "agent.ts"),
				"function buildSystemPrompt(workspacePath, channelId) {\n\treturn workspacePath + channelId;\n}\n",
			);

			const result = await grepTool.execute("test-call-12c", {
				pattern: "buildSystemPrompt",
				path: testDir,
			});

			const outputLines = getTextOutput(result)
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
			const firstMatchLine = outputLines.find((line) => line.includes(":"));
			expect(firstMatchLine).toContain("packages/coding-agent/src/core/system-prompt.ts");
			expect(outputLines.some((line) => line.includes("packages/mom/src/agent.ts"))).toBe(true);
		});

		it("should rank implementation modules ahead of transcript-formatting and prompt-guidance matches", async () => {
			const toolsDir = join(testDir, "packages", "coding-agent", "src", "core", "tools");
			const promptDir = join(testDir, "packages", "coding-agent", "src", "core");
			mkdirSync(toolsDir, { recursive: true });
			mkdirSync(promptDir, { recursive: true });

			writeFileSync(
				join(toolsDir, "websearch.ts"),
				"export function normalizeCurrentEventsQuery(query: string) {\n\t// current-events normalization happens here\n\treturn query.trim();\n}\n",
			);
			writeFileSync(
				join(toolsDir, "research-output.ts"),
				"lines.push(\"For a brief current-events summary, answer from it directly.\");\n",
			);
			writeFileSync(
				join(promptDir, "prompt-intent-steering.ts"),
				"const note = \"For local current-events normalization lookups, prefer the real web-search implementation module\";\n",
			);

			const result = await grepTool.execute("test-call-12d", {
				pattern: "current-events",
				path: testDir,
				ignoreCase: true,
			});

			const outputLines = getTextOutput(result)
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
			const firstMatchLine = outputLines.find((line) => line.includes(":"));
			expect(firstMatchLine).toContain("packages/coding-agent/src/core/tools/websearch.ts");
			expect(outputLines.some((line) => line.includes("packages/coding-agent/src/core/tools/research-output.ts"))).toBe(true);
			expect(outputLines.some((line) => line.includes("packages/coding-agent/src/core/prompt-intent-steering.ts"))).toBe(true);
		});

		it("should keep implementation files visible for descriptive current-events normalization queries", async () => {
			const toolsDir = join(testDir, "packages", "coding-agent", "src", "core", "tools");
			const testsDir = join(testDir, "packages", "coding-agent", "test");
			const promptDir = join(testDir, "packages", "coding-agent", "src", "core");
			mkdirSync(toolsDir, { recursive: true });
			mkdirSync(testsDir, { recursive: true });
			mkdirSync(promptDir, { recursive: true });

			writeFileSync(
				join(toolsDir, "websearch.ts"),
				"export function normalizeCurrentEventsQuery(query: string) {\n\t// current-events normalization happens here\n\treturn query.trim();\n}\n",
			);
			writeFileSync(
				join(promptDir, "prompt-intent-steering.ts"),
				"const note = \"For prompts about current-events query normalization in this repo, try the likely implementation symbol normalizeCurrentEventsQuery before a broad grep for the prose phrase current-events.\";\n",
			);
			writeFileSync(
				join(testsDir, "web-tools-context.test.ts"),
				"it(\"mentions current-events normalization\", () => {\n\texpect(\"current-events normalization\").toBeTruthy();\n});\n",
			);

			const result = await grepTool.execute("test-call-12e", {
				pattern: "current-events",
				path: testDir,
				ignoreCase: true,
			});

			const outputLines = getTextOutput(result)
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
			expect(outputLines.some((line) => line.includes("packages/coding-agent/src/core/tools/websearch.ts"))).toBe(true);
			expect(outputLines.some((line) => line.includes("packages/coding-agent/src/core/prompt-intent-steering.ts"))).toBe(true);
			expect(outputLines.some((line) => line.includes("packages/coding-agent/test/web-tools-context.test.ts"))).toBe(true);
		});

		it("should emit a semantic recovery notice for current-events normalization trap hits", async () => {
			const toolsDir = join(testDir, "packages", "coding-agent", "src", "core", "tools");
			const testsDir = join(testDir, "packages", "coding-agent", "test");
			mkdirSync(toolsDir, { recursive: true });
			mkdirSync(testsDir, { recursive: true });

			writeFileSync(
				join(testsDir, "tools.test.ts"),
				"export function normalizeCurrentEventsQuery(query: string) {\n\t// current-events normalization happens here\n\treturn query.trim();\n}\n",
			);
			writeFileSync(
				join(toolsDir, "research-output.ts"),
				"lines.push(\"For a brief current-events summary, answer from it directly.\");\n",
			);

			const result = await grepTool.execute("test-call-12f", {
				pattern: "current-events",
				path: testDir,
				ignoreCase: true,
			});

			const output = getTextOutput(result);
			expect(output).toContain("descriptive current-events normalization lookup");
			expect(output).toContain("normalizeCurrentEventsQuery");
			expect(output).toContain("next: grep normalizeCurrentEventsQuery path=packages/coding-agent/src/core/tools or src/core/tools");
			expect(output).toContain("src/core/tools");
			expect(result.details?.recoveryPattern).toBe("normalizeCurrentEventsQuery");
			expect(result.details?.recoveryPath).toBe("packages/coding-agent/src/core/tools");
			expect(result.details?.recoveryRequired).toBe(true);
		});

		it("should prefer a concrete implementation-symbol current-events match when one exists", async () => {
			const toolsDir = join(testDir, "packages", "coding-agent", "src", "core", "tools");
			const promptDir = join(testDir, "packages", "coding-agent", "src", "core");
			mkdirSync(toolsDir, { recursive: true });
			mkdirSync(promptDir, { recursive: true });

			writeFileSync(
				join(promptDir, "prompt-intent-steering.ts"),
				"const note = \"For prompts about current-events query normalization in this repo, do not start by grepping the prose phrase current-events.\";\n",
			);
			writeFileSync(
				join(toolsDir, "websearch.ts"),
				"export function normalizeCurrentEventsQuery(query: string) {\n\t// normalizeCurrentEventsQuery handles current-events search normalization\n\treturn query.trim();\n}\n",
			);

			const result = await grepTool.execute("test-call-12f-2", {
				pattern: "current-events",
				path: testDir,
				ignoreCase: true,
			});

			const output = getTextOutput(result);
			const outputLines = output
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
			expect(output).toContain("next: read packages/coding-agent/src/core/tools/websearch.ts");
			expect(result.details?.firstMatchPath).toBe("packages/coding-agent/src/core/tools/websearch.ts");
			expect(outputLines.some((line) => line.includes("packages/coding-agent/src/core/tools/websearch.ts:2:"))).toBe(true);
		});

		it("should emit a semantic recovery notice for benchmark archive lookups", async () => {
			const scriptsDir = join(testDir, "scripts");
			mkdirSync(scriptsDir, { recursive: true });

			writeFileSync(
				join(scriptsDir, "harness-benchmark-archive.mjs"),
				"if (suiteIds[0] === \"benchmark-v2\") return \"/home/alex/Desktop/Benchmark-v2\";\nreturn \"/home/alex/Desktop/Benchmark\";\n",
			);
			writeFileSync(
				join(scriptsDir, "profile-coding-agent-node.mjs"),
				"async function runBenchmarkRun(params) {\n\treturn params;\n}\n",
			);

			const result = await grepTool.execute("test-call-12g", {
				pattern: "Benchmark|benchmark.*archive",
				path: testDir,
				glob: "**/*.mjs",
			});

			const output = getTextOutput(result);
			expect(output).toContain("benchmark archive lookup");
			expect(output).toContain("scripts/harness-benchmark-archive.mjs");
			expect(result.details?.firstMatchPath).toBe("scripts/harness-benchmark-archive.mjs");
		});

		it("should prefer benchmark compare implementation over history artifacts for scorePer1kTokens lookups", async () => {
			mkdirSync(join(testDir, "scripts"), { recursive: true });
			mkdirSync(join(testDir, "benchmarks", "history"), { recursive: true });
			writeFileSync(
				join(testDir, "scripts", "harness-benchmark-compare.mjs"),
				"const scorePer1kTokens = totalTokens > 0 ? weightedScore / (totalTokens / 1000) : null;\n",
			);
			writeFileSync(
				join(testDir, "benchmarks", "history", "history-summary.json"),
				"{\"score_per_1k_tokens\": 0.5}\n",
			);

			const result = await grepTool.execute("test-call-12h", {
				pattern: "scorePer1kTokens|score_per_1k_tokens",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("scripts/harness-benchmark-compare.mjs");
			expect(output).toContain("benchmark metric lookup");
			expect(result.details?.firstMatchPath).toBe("scripts/harness-benchmark-compare.mjs");
		});
	});

	describe("find tool", () => {
		it("should include hidden files that are not gitignored", async () => {
			const hiddenDir = join(testDir, ".secret");
			mkdirSync(hiddenDir);
			writeFileSync(join(hiddenDir, "hidden.txt"), "hidden");
			writeFileSync(join(testDir, "visible.txt"), "visible");

			const result = await findTool.execute("test-call-13", {
				pattern: "**/*.txt",
				path: testDir,
			});

			const outputLines = getTextOutput(result)
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);

			expect(outputLines).toContain("visible.txt");
			expect(outputLines).toContain(".secret/hidden.txt");
		});

		it("should respect .gitignore", async () => {
			writeFileSync(join(testDir, ".gitignore"), "ignored.txt\n");
			writeFileSync(join(testDir, "ignored.txt"), "ignored");
			writeFileSync(join(testDir, "kept.txt"), "kept");

			const result = await findTool.execute("test-call-14", {
				pattern: "**/*.txt",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("kept.txt");
			expect(output).not.toContain("ignored.txt");
		});

		it("should emit compact result-limit notices", async () => {
			writeFileSync(join(testDir, "alpha.txt"), "a");
			writeFileSync(join(testDir, "beta.txt"), "b");
			writeFileSync(join(testDir, "gamma.txt"), "c");

			const result = await findTool.execute("test-call-14b", {
				pattern: "*.txt",
				path: testDir,
				limit: 2,
			});

			expect(getTextOutput(result)).toContain("[2 results limit; next limit=4]");
		});

		it("should emit a read follow-up for a single file match", async () => {
			writeFileSync(join(testDir, "only.ts"), "export const only = true;\n");

			const result = await findTool.execute("test-call-14c", {
				pattern: "only.ts",
				path: testDir,
			});

			expect(getTextOutput(result)).toContain("[1 match in only.ts; if the user only asked which file/path, answer now; otherwise next: read only.ts limit=120]");
		});

		it("should keep single-match follow-up paths workspace-relative when searching inside a subdirectory", async () => {
			mkdirSync(join(testDir, "scripts"), { recursive: true });
			writeFileSync(join(testDir, "scripts", "harness-benchmark-archive.mjs"), "export {};\n");

			const result = await findTool.execute("test-call-14c-subdir", {
				pattern: "*archive*.mjs",
				path: join(testDir, "scripts"),
			});

			expect(getTextOutput(result)).toContain("scripts/harness-benchmark-archive.mjs");
			expect(getTextOutput(result)).toContain("next: read scripts/harness-benchmark-archive.mjs limit=120");
			expect(result.details?.firstMatchPath).toBe("scripts/harness-benchmark-archive.mjs");
		});

		it("should emit an ls follow-up for a single directory match", async () => {
			mkdirSync(join(testDir, "src"), { recursive: true });

			const result = await findTool.execute("test-call-14d", {
				pattern: "src",
				path: testDir,
			});

			expect(getTextOutput(result)).toContain("[1 directory match in src/; if the directory itself answers the question, answer now; otherwise next: ls src/]");
		});

		it("should explain shared-anchor retries when an over-specific find pattern has no matches", async () => {
			writeFileSync(join(testDir, "harness-benchmark-run.mjs"), "");
			writeFileSync(join(testDir, "harness-benchmark-compare.mjs"), "");
			writeFileSync(join(testDir, "harness-benchmark-archive.mjs"), "");

			const result = await findTool.execute("test-call-14e", {
				pattern: "**/*benchmark*compare*archive*",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("(no matches)");
			expect(output).toContain("pattern may be too specific");
			expect(output).toContain("shared anchor or common prefix");
		});

		it("should redirect benchmark harness script misses from package-local scripts to repo-root scripts", async () => {
			const packageScriptsDir = join(testDir, "packages", "coding-agent", "scripts");
			const rootScriptsDir = join(testDir, "scripts");
			mkdirSync(packageScriptsDir, { recursive: true });
			mkdirSync(rootScriptsDir, { recursive: true });
			writeFileSync(join(rootScriptsDir, "harness-benchmark-archive.mjs"), "");

			const result = await findTool.execute("test-call-14f", {
				pattern: "*benchmark*archive*.mjs",
				path: packageScriptsDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("for benchmark harness command scripts in this repo");
			expect(output).toContain("repo-root `scripts/`");
			expect(output).toContain("harness-benchmark-*");
		});

		it("should rank likely script files ahead of benchmark history artifacts", async () => {
			mkdirSync(join(testDir, "scripts"), { recursive: true });
			mkdirSync(join(testDir, "benchmarks", "history"), { recursive: true });
			writeFileSync(join(testDir, "scripts", "harness-benchmark-compare.mjs"), "console.log('compare');\n");
			writeFileSync(join(testDir, "benchmarks", "history", "benchmark-history.jsonl"), "{}\n");

			const result = await findTool.execute("test-call-14e", {
				pattern: "*benchmark*",
				path: testDir,
			});

			const outputLines = getTextOutput(result)
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
			expect(outputLines[0]).toBe("scripts/harness-benchmark-compare.mjs");
			expect(outputLines).toContain("benchmarks/history/benchmark-history.jsonl");
		});
	});

	describe("ls tool", () => {
		it("should list dotfiles and directories", async () => {
			writeFileSync(join(testDir, ".hidden-file"), "secret");
			mkdirSync(join(testDir, ".hidden-dir"));

			const result = await lsTool.execute("test-call-15", { path: testDir });
			const output = getTextOutput(result);

			expect(output).toContain(".hidden-file");
			expect(output).toContain(".hidden-dir/");
		});

		it("should emit compact entry-limit notices", async () => {
			writeFileSync(join(testDir, "a.txt"), "a");
			writeFileSync(join(testDir, "b.txt"), "b");
			writeFileSync(join(testDir, "c.txt"), "c");

			const result = await lsTool.execute("test-call-16", { path: testDir, limit: 2 });
			expect(getTextOutput(result)).toContain("[2 entries limit; next limit=4]");
		});
	});
});

describe("edit tool fuzzy matching", () => {
	let testDir: string;
	let editTool: ReturnType<typeof createEditTool>;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-fuzzy-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		editTool = createEditTool(testDir);
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("should match text with trailing whitespace stripped", async () => {
		const testFile = join(testDir, "trailing-ws.txt");
		// File has trailing spaces on lines
		writeFileSync(testFile, "line one   \nline two  \nline three\n");

		// oldText without trailing whitespace should still match
		const result = await editTool.execute("test-fuzzy-1", {
			path: testFile,
			edits: [{ oldText: "line one\nline two\n", newText: "replaced\n" }],
		});

		expect(getTextOutput(result)).toContain("Patched");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("replaced\nline three\n");
	});

	it("should match fullwidth punctuation in Chinese text", async () => {
		const testFile = join(testDir, "chinese-punctuation.txt");
		writeFileSync(testFile, "你好，世界\n你好（世界）\n");

		const result = await editTool.execute("test-fuzzy-chinese", {
			path: testFile,
			edits: [{ oldText: "你好,世界\n你好(世界)\n", newText: "你好，ag1\n你好(ag1)\n" }],
		});

		expect(getTextOutput(result)).toContain("Patched");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("你好，ag1\n你好(ag1)\n");
	});

	it("should match compatibility-equivalent Unicode forms", async () => {
		const testFile = join(testDir, "unicode-compatibility.txt");
		writeFileSync(testFile, "ＡＢＣ１２３\ncafe\u0301\n");

		const result = await editTool.execute("test-fuzzy-unicode", {
			path: testFile,
			edits: [{ oldText: "ABC123\ncafé\n", newText: "XYZ789\ncoffee\n" }],
		});

		expect(getTextOutput(result)).toContain("Patched");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("XYZ789\ncoffee\n");
	});

	it("should match smart single quotes to ASCII quotes", async () => {
		const testFile = join(testDir, "smart-quotes.txt");
		// File has smart/curly single quotes (U+2018, U+2019)
		writeFileSync(testFile, "console.log(\u2018hello\u2019);\n");

		// oldText with ASCII quotes should match
		const result = await editTool.execute("test-fuzzy-2", {
			path: testFile,
			edits: [{ oldText: "console.log('hello');", newText: "console.log('world');" }],
		});

		expect(getTextOutput(result)).toContain("Patched");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toContain("world");
	});

	it("should match smart double quotes to ASCII quotes", async () => {
		const testFile = join(testDir, "smart-double-quotes.txt");
		// File has smart/curly double quotes (U+201C, U+201D)
		writeFileSync(testFile, "const msg = \u201CHello World\u201D;\n");

		// oldText with ASCII quotes should match
		const result = await editTool.execute("test-fuzzy-3", {
			path: testFile,
			edits: [{ oldText: 'const msg = "Hello World";', newText: 'const msg = "Goodbye";' }],
		});

		expect(getTextOutput(result)).toContain("Patched");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toContain("Goodbye");
	});

	it("should match Unicode dashes to ASCII hyphen", async () => {
		const testFile = join(testDir, "unicode-dashes.txt");
		// File has en-dash (U+2013) and em-dash (U+2014)
		writeFileSync(testFile, "range: 1\u20135\nbreak\u2014here\n");

		// oldText with ASCII hyphens should match
		const result = await editTool.execute("test-fuzzy-4", {
			path: testFile,
			edits: [{ oldText: "range: 1-5\nbreak-here", newText: "range: 10-50\nbreak--here" }],
		});

		expect(getTextOutput(result)).toContain("Patched");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toContain("10-50");
	});

	it("should match non-breaking space to regular space", async () => {
		const testFile = join(testDir, "nbsp.txt");
		// File has non-breaking space (U+00A0)
		writeFileSync(testFile, "hello\u00A0world\n");

		// oldText with regular space should match
		const result = await editTool.execute("test-fuzzy-5", {
			path: testFile,
			edits: [{ oldText: "hello world", newText: "hello universe" }],
		});

		expect(getTextOutput(result)).toContain("Patched");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toContain("universe");
	});

	it("should prefer exact match over fuzzy match", async () => {
		const testFile = join(testDir, "exact-preferred.txt");
		// File has both exact and fuzzy-matchable content
		writeFileSync(testFile, "const x = 'exact';\nconst y = 'other';\n");

		const result = await editTool.execute("test-fuzzy-6", {
			path: testFile,
			edits: [{ oldText: "const x = 'exact';", newText: "const x = 'changed';" }],
		});

		expect(getTextOutput(result)).toContain("Patched");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("const x = 'changed';\nconst y = 'other';\n");
	});

	it("should still fail when text is not found even with fuzzy matching", async () => {
		const testFile = join(testDir, "no-match.txt");
		writeFileSync(testFile, "completely different content\n");

		await expect(
			editTool.execute("test-fuzzy-7", {
				path: testFile,
				edits: [{ oldText: "this does not exist", newText: "replacement" }],
			}),
		).rejects.toThrow(/Could not find the exact text/);
	});

	it("should detect duplicates after fuzzy normalization", async () => {
		const testFile = join(testDir, "fuzzy-dups.txt");
		// Two lines that are identical after trailing whitespace is stripped
		writeFileSync(testFile, "hello world   \nhello world\n");

		await expect(
			editTool.execute("test-fuzzy-8", {
				path: testFile,
				edits: [{ oldText: "hello world", newText: "replaced" }],
			}),
		).rejects.toThrow(/Found 2 occurrences/);
	});

	it("should support fuzzy matching in multi-edit mode", async () => {
		const testFile = join(testDir, "fuzzy-multi.txt");
		writeFileSync(testFile, "console.log(\u2018hello\u2019);\nhello\u00A0world\n");

		await editTool.execute("test-fuzzy-9", {
			path: testFile,
			edits: [
				{ oldText: "console.log('hello');\n", newText: "console.log('world');\n" },
				{ oldText: "hello world\n", newText: "hello universe\n" },
			],
		});

		expect(readFileSync(testFile, "utf-8")).toBe("console.log('world');\nhello universe\n");
	});
});

describe("edit tool CRLF handling", () => {
	let testDir: string;
	let editTool: ReturnType<typeof createEditTool>;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-crlf-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		editTool = createEditTool(testDir);
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("should match LF oldText against CRLF file content", async () => {
		const testFile = join(testDir, "crlf-test.txt");

		writeFileSync(testFile, "line one\r\nline two\r\nline three\r\n");

		const result = await editTool.execute("test-crlf-1", {
			path: testFile,
			edits: [{ oldText: "line two\n", newText: "replaced line\n" }],
		});

		expect(getTextOutput(result)).toContain("Patched");
	});

	it("should preserve CRLF line endings after edit", async () => {
		const testFile = join(testDir, "crlf-preserve.txt");
		writeFileSync(testFile, "first\r\nsecond\r\nthird\r\n");

		await editTool.execute("test-crlf-2", {
			path: testFile,
			edits: [{ oldText: "second\n", newText: "REPLACED\n" }],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("first\r\nREPLACED\r\nthird\r\n");
	});

	it("should preserve LF line endings for LF files", async () => {
		const testFile = join(testDir, "lf-preserve.txt");
		writeFileSync(testFile, "first\nsecond\nthird\n");

		await editTool.execute("test-lf-1", {
			path: testFile,
			edits: [{ oldText: "second\n", newText: "REPLACED\n" }],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("first\nREPLACED\nthird\n");
	});

	it("should detect duplicates across CRLF/LF variants", async () => {
		const testFile = join(testDir, "mixed-endings.txt");

		writeFileSync(testFile, "hello\r\nworld\r\n---\r\nhello\nworld\n");

		await expect(
			editTool.execute("test-crlf-dup", {
				path: testFile,
				edits: [{ oldText: "hello\nworld\n", newText: "replaced\n" }],
			}),
		).rejects.toThrow(/Found 2 occurrences/);
	});

	it("should preserve UTF-8 BOM after edit", async () => {
		const testFile = join(testDir, "bom-test.txt");
		writeFileSync(testFile, "\uFEFFfirst\r\nsecond\r\nthird\r\n");

		await editTool.execute("test-bom", {
			path: testFile,
			edits: [{ oldText: "second\n", newText: "REPLACED\n" }],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("\uFEFFfirst\r\nREPLACED\r\nthird\r\n");
	});

	it("should preserve CRLF line endings and BOM in multi-edit mode", async () => {
		const testFile = join(testDir, "bom-crlf-multi.txt");
		writeFileSync(testFile, "\uFEFFfirst\r\nsecond\r\nthird\r\nfourth\r\n");

		await editTool.execute("test-crlf-multi", {
			path: testFile,
			edits: [
				{ oldText: "second\n", newText: "SECOND\n" },
				{ oldText: "fourth\n", newText: "FOURTH\n" },
			],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("\uFEFFfirst\r\nSECOND\r\nthird\r\nFOURTH\r\n");
	});
});
