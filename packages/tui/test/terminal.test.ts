import assert from "node:assert";
import { describe, it } from "node:test";
import { ProcessTerminal } from "../src/terminal.js";

/**
 * Capture escape sequences written to stdout while letting normal output
 * (e.g. the test runner's TAP stream) pass through untouched.
 */
function installEscapeCapture(): { getWrites(): string; restore(): void } {
	const chunks: string[] = [];
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: any, ...rest: any[]): boolean => {
		const text = String(chunk);
		if (text.includes("\x1b")) {
			chunks.push(text);
			return true;
		}
		return (original as any)(chunk, ...rest);
	}) as any;
	return {
		getWrites: () => chunks.join(""),
		restore: () => {
			process.stdout.write = original;
		},
	};
}

describe("ProcessTerminal.setTitle", () => {
	it("writes plain titles unchanged", () => {
		const terminal = new ProcessTerminal();
		const capture = installEscapeCapture();
		try {
			terminal.setTitle("my session");
			assert.strictEqual(capture.getWrites(), "\x1b]0;my session\x07");
		} finally {
			capture.restore();
		}
	});

	it("strips control characters so the title cannot break out of the OSC sequence", () => {
		const terminal = new ProcessTerminal();
		const capture = installEscapeCapture();
		try {
			terminal.setTitle("evil\x07\x1b[2J\x1b]0;pwned\x07title\x00\x1f\x7f");
			// All \x00-\x1f and \x7f bytes are gone; only the framing ESC and BEL remain
			assert.strictEqual(capture.getWrites(), "\x1b]0;evil[2J]0;pwnedtitle\x07");
		} finally {
			capture.restore();
		}
	});
});

describe("ProcessTerminal modifyOtherKeys fallback", () => {
	it("enables modifyOtherKeys when no Kitty response arrives and disables it in stop()", async () => {
		const terminal = new ProcessTerminal();
		const capture = installEscapeCapture();
		try {
			terminal.start(
				() => {},
				() => {},
			);
			await new Promise((resolve) => setTimeout(resolve, 250));
			assert.ok(capture.getWrites().includes("\x1b[>4;2m"), "Fallback should enable modifyOtherKeys");
			terminal.stop();
			assert.ok(capture.getWrites().includes("\x1b[>4;0m"), "stop() should disable modifyOtherKeys");
		} finally {
			capture.restore();
		}
	});

	it("cancels a pending fallback in stop() so it cannot fire after terminal restore", async () => {
		const terminal = new ProcessTerminal();
		const capture = installEscapeCapture();
		try {
			terminal.start(
				() => {},
				() => {},
			);
			terminal.stop(); // within the 150ms fallback window
			await new Promise((resolve) => setTimeout(resolve, 250));
			assert.ok(
				!capture.getWrites().includes("\x1b[>4;2m"),
				"Fallback must not enable modifyOtherKeys after stop()",
			);
		} finally {
			capture.restore();
		}
	});
});
