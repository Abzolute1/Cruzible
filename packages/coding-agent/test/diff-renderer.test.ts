import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { generateDiffString } from "../src/core/tools/edit-diff.js";
import { renderDiff } from "../src/modes/interactive/components/diff.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

beforeAll(() => {
	initTheme("dark", false);
});

/** Matches an ANSI truecolor background sequence, e.g. \x1b[48;2;42;69;49m */
const BG_RE = /\x1b\[48;2;\d+;\d+;\d+m/;

describe("renderDiff", () => {
	it("renders a two-column gutter with old and new line numbers", () => {
		const oldLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
		const newLines = [...oldLines];
		newLines.splice(4, 1, "newA", "newB"); // replace line5 with two lines
		const { diff } = generateDiffString(`${oldLines.join("\n")}\n`, `${newLines.join("\n")}\n`);

		const lines = stripAnsi(renderDiff(diff)).split("\n");

		// Context before the change: old and new numbers equal
		expect(lines[0]).toBe(" 1  1 │ line1");
		// Removed line: old number on the left, right column blank
		expect(lines[4]).toBe(" 5    │ - line5");
		// Added lines: left column blank, new number on the right
		expect(lines[5]).toBe("    5 │ + newA");
		expect(lines[6]).toBe("    6 │ + newB");
		// Context after the change: new number reflects the +1 delta
		expect(lines[7]).toBe(" 6  7 │ line6");
	});

	it("renders separator lines for skipped regions", () => {
		const oldLines = Array.from({ length: 40 }, (_, i) => `line${i + 1}`);
		const newLines = [...oldLines];
		newLines[4] = "changed5";
		newLines[34] = "changed35";
		const { diff } = generateDiffString(`${oldLines.join("\n")}\n`, `${newLines.join("\n")}\n`);

		const lines = stripAnsi(renderDiff(diff)).split("\n");
		const sepLine = lines.find((l) => l.includes("..."));
		expect(sepLine).toBeDefined();
		expect(sepLine).toMatch(/^ + │ \.\.\.$/);
	});

	it("highlights changed tokens with a background tint on single-line changes", () => {
		const { diff } = generateDiffString("const x = foo(bar);\n", "const x = qux(bar);\n");
		const raw = renderDiff(diff);

		expect(BG_RE.test(raw)).toBe(true);
		// The changed words carry the tint...
		expect(raw).toMatch(/\x1b\[48;2;\d+;\d+;\d+m\x1b\[38;2;\d+;\d+;\d+mfoo/);
		expect(raw).toMatch(/\x1b\[48;2;\d+;\d+;\d+m\x1b\[38;2;\d+;\d+;\d+mqux/);
		// ...using background colors, not inverse video
		expect(raw).not.toContain("\x1b[7m");
	});

	it("pairs similar lines within multi-line blocks and highlights them", () => {
		const oldContent = [
			"\t\tgameOver();",
			"\t\treturn;",
			"\t}",
			"",
			"\t// Self collision",
			"\tif (snake.some(segment => segment.x === head.x && segment.y === head.y)) {",
			"\t\tgameOver();",
			"\t\treturn;",
			"\t}",
			"",
			"\tsnake.unshift(head);",
			"",
			"\t// Food collision",
		].join("\n");
		const newContent = [
			"\t\tgameOver();",
			"\t\treturn;",
			"\t}",
			"",
			"\tsnake.unshift(head);",
			"",
			"\t// Self collision - check from index 1 to length-2 (exclude tail which moves anyway)",
			"\tif (snake.some((segment, i) => i > 0 && i < snake.length - 1 && segment.x === head.x && segment.y === head.y)) {",
			"\t\tgameOver();",
			"\t\treturn;",
			"\t}",
			"",
			"\t// Food collision",
		].join("\n");
		const { diff } = generateDiffString(oldContent, newContent);
		const raw = renderDiff(diff);

		// The modified `if` line is a block change (2 removed vs 6 added) but is
		// similarity-paired, so its changed tokens still get background tints.
		expect(BG_RE.test(raw)).toBe(true);
		expect(raw).not.toContain("\x1b[7m");
	});

	it("does not highlight unrelated lines in a change block", () => {
		const { diff } = generateDiffString("aaaa bbbb cccc\nzzzz\n", "xxxx yyyy wwww\nqqqq\nrrrr\n");
		const raw = renderDiff(diff);

		expect(BG_RE.test(raw)).toBe(false);
	});

	it("replaces tabs with spaces", () => {
		const { diff } = generateDiffString("\tfoo\n", "\tbar\n");
		const out = stripAnsi(renderDiff(diff));

		expect(out).not.toContain("\t");
		expect(out).toContain("   foo");
		expect(out).toContain("   bar");
	});

	it("handles empty input", () => {
		expect(renderDiff("")).toBe("");
	});
});
