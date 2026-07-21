import assert from "node:assert";
import { describe, it } from "node:test";
import { Chalk } from "chalk";
import { Markdown } from "../src/components/markdown.js";
import { Text } from "../src/components/text.js";
import { TruncatedText } from "../src/components/truncated-text.js";
import { sanitizeTerminalText } from "../src/utils.js";
import { defaultMarkdownTheme } from "./test-themes.js";

// Force full color in CI so ANSI assertions are deterministic
const chalk = new Chalk({ level: 3 });

describe("sanitizeTerminalText", () => {
	it("returns clean text unchanged", () => {
		const text = "hello world\nsecond line\twith tab";
		assert.strictEqual(sanitizeTerminalText(text), text);
	});

	it("strips OSC 52 clipboard-write sequences", () => {
		const malicious = "hello\x1b]52;c;aGVsbG8=\x07world";
		assert.strictEqual(sanitizeTerminalText(malicious), "helloworld");
	});

	it("strips OSC 8 hyperlink sequences", () => {
		const spoofed = "\x1b]8;;https://evil.example\x1b\\click me\x1b]8;;\x07";
		assert.strictEqual(sanitizeTerminalText(spoofed), "click me");
	});

	it("strips DCS and APC sequences", () => {
		// DCS (ESC P) is not parsed by extractAnsiCode: the ESC is dropped, the
		// payload remains as harmless literal text.
		assert.strictEqual(sanitizeTerminalText("\x1bPq1;2;3\x1b\\text"), "Pq1;2;3\\text");
		// APC (ESC _) is parsed and dropped entirely.
		assert.strictEqual(sanitizeTerminalText("\x1b_Ga=T,f=100;AAAA\x1b\\img"), "img");
	});

	it("strips raw/lone ESC and other C0 controls except \\n and \\t", () => {
		assert.strictEqual(sanitizeTerminalText("a\x1bb"), "ab");
		assert.strictEqual(sanitizeTerminalText("a\x00\x07\x0cb"), "ab");
		assert.strictEqual(sanitizeTerminalText("a\nb\tc"), "a\nb\tc");
	});

	it("strips non-SGR CSI sequences like clear-screen", () => {
		assert.strictEqual(sanitizeTerminalText("a\x1b[2Jb"), "ab");
		assert.strictEqual(sanitizeTerminalText("a\x1b[Hb"), "ab");
	});

	it("strips DEL and C1 control characters", () => {
		assert.strictEqual(sanitizeTerminalText("a\x7f\x85\x9bb"), "ab");
	});

	it("preserves SGR styling sequences", () => {
		const styled = `${chalk.red("hello")} ${chalk.bold("world")}`;
		assert.strictEqual(sanitizeTerminalText(styled), styled);
	});
});

describe("Component sanitization", () => {
	it("Text strips escape injection from rendered output", () => {
		const text = new Text("hello\x1b]52;c;aGVsbG8=\x07 world", 0, 0);
		const lines = text.render(40);
		const joined = lines.join("\n");
		assert.ok(!joined.includes("\x1b]"), "OSC must not reach the terminal");
		assert.ok(joined.includes("hello world"));
	});

	it("Text preserves pre-styled SGR content", () => {
		const styled = chalk.red("hello");
		const text = new Text(styled, 0, 0);
		const lines = text.render(40);
		assert.ok(lines[0]!.includes("\x1b["), "SGR styling should survive");
	});

	it("Text sanitizes text set via setText", () => {
		const text = new Text("clean", 0, 0);
		text.setText("a\x1b[2Jb");
		const lines = text.render(40);
		const joined = lines.join("\n");
		assert.ok(!joined.includes("\x1b[2J"));
		assert.ok(joined.includes("ab"));
	});

	it("Markdown strips escape injection from rendered output", () => {
		const markdown = new Markdown("hello\x1b]8;;https://evil.example\x07 world", 0, 0, defaultMarkdownTheme);
		const lines = markdown.render(80);
		const joined = lines.join("\n");
		assert.ok(!joined.includes("\x1b]"), "OSC must not reach the terminal");
		assert.ok(joined.includes("hello world"));
	});

	it("Markdown keeps theme SGR styling working", () => {
		const markdown = new Markdown("# Title", 0, 0, defaultMarkdownTheme);
		const lines = markdown.render(80);
		assert.ok(lines[0]!.includes("\x1b["), "theme styling should survive");
		assert.ok(lines[0]!.includes("Title"));
	});

	it("TruncatedText strips escape injection from rendered output", () => {
		const text = new TruncatedText("hello\x1b[2J\x1b]52;c;aGVsbG8=\x07 world", 0, 0);
		const lines = text.render(50);
		const joined = lines.join("\n");
		assert.ok(!joined.includes("\x1b"), "no escape sequences should remain");
		assert.ok(joined.includes("hello world"));
	});
});
