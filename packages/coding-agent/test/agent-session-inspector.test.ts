import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	exportAgentSessionJsonl,
	getLastAgentAssistantText,
} from "../src/core/agent-session-inspector.js";
import { SessionManager } from "../src/core/session-manager.js";

describe("agent-session-inspector", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("skips aborted empty assistant messages when extracting the last assistant text", () => {
		const text = getLastAgentAssistantText([
			{
				role: "assistant",
				content: [],
				api: "api",
				provider: "provider",
				model: "model",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "aborted",
				timestamp: 1,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: "api",
				provider: "provider",
				model: "model",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
		]);

		expect(text).toBe("done");
	});

	it("exports the current branch to jsonl with a session header", () => {
		tempDir = mkdtempSync(join(tmpdir(), "agent-session-inspector-"));
		const outputPath = join(tempDir, "session.jsonl");
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		const filePath = exportAgentSessionJsonl({
			sessionManager,
			outputPath,
		});

		const lines = readFileSync(filePath, "utf8").trim().split("\n");
		expect(lines[0]).toContain('"type":"session"');
		expect(lines[1]).toContain('"type":"message"');
	});
});
