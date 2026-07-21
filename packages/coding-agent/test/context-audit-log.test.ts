import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import { createContextAuditLogger } from "../src/core/context-audit-log.js";

describe("context audit log", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	test("is disabled unless AG1_CONTEXT_AUDIT_DIR is set", () => {
		const tempDir = join(tmpdir(), `ag1-context-audit-disabled-${Date.now()}`);
		tempDirs.push(tempDir);
		const logger = createContextAuditLogger({
			sessionId: "session/1",
			cwd: "/workspace",
			env: {},
		});

		logger.write([{ role: "user", content: "hello", timestamp: 1 }]);

		expect(existsSync(tempDir)).toBe(false);
	});

	test("writes exact provider context payload with private file permissions", () => {
		const tempDir = join(tmpdir(), `ag1-context-audit-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		const logger = createContextAuditLogger({
			sessionId: "session/1",
			cwd: "/workspace",
			env: { AG1_CONTEXT_AUDIT_DIR: tempDir },
			now: () => new Date("2026-04-25T00:00:00.000Z"),
		});

		logger.write(
			[
				{ role: "user", content: "hello", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "text", text: "world" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude",
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
			],
			{ sourceMessageCount: 2 },
		);

		const files = readdirSync(tempDir);
		expect(files).toHaveLength(1);
		expect(files[0]).toContain("session-1");
		const filePath = join(tempDir, files[0]);
		const payload = JSON.parse(readFileSync(filePath, "utf8"));
		expect(payload).toMatchObject({
			timestamp: "2026-04-25T00:00:00.000Z",
			sessionId: "session/1",
			cwd: "/workspace",
			messageCount: 2,
			sourceMessageCount: 2,
		});
		expect(payload.messages[0]).toEqual({ role: "user", content: "hello", timestamp: 1 });
		expect(statSync(filePath).mode & 0o777).toBe(0o600);
	});

	test("redacts obvious secrets before writing audit payloads", () => {
		const tempDir = join(tmpdir(), `ag1-context-audit-redact-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		const logger = createContextAuditLogger({
			sessionId: "session/1",
			cwd: "/workspace",
			env: { AG1_CONTEXT_AUDIT_DIR: tempDir },
			now: () => new Date("2026-04-25T00:00:00.000Z"),
		});

		logger.write(
			[
				{
					role: "user",
					content: "OPENAI_API_KEY=sk-proj-secretvalue123456\nAuthorization: Bearer provider-token-123456",
					timestamp: 1,
				},
			],
			{
				apiKey: "literal-secret",
				headers: { Authorization: "Bearer header-token-123456" },
			},
		);

		const filePath = join(tempDir, readdirSync(tempDir)[0]);
		const raw = readFileSync(filePath, "utf8");
		expect(raw).not.toContain("sk-proj-secretvalue123456");
		expect(raw).not.toContain("provider-token-123456");
		expect(raw).not.toContain("literal-secret");
		expect(raw).not.toContain("header-token-123456");

		const payload = JSON.parse(raw);
		expect(payload.apiKey).toBe("[redacted]");
		expect(payload.headers.Authorization).toBe("[redacted]");
		expect(payload.messages[0].content).toContain("OPENAI_API_KEY=[redacted]");
		expect(payload.messages[0].content).toContain("Authorization: Bearer [redacted]");
	});
});
