import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SessionDebugLogger } from "../src/core/session-debug-logger.js";
import type { AgentSession } from "../src/core/agent-session.js";

function createStubSession(): AgentSession {
	return {
		model: {
			provider: "local",
			id: "lm-studio",
			name: "LM Studio",
		},
		contextWindow: 50000,
		thinkingLevel: "medium",
		sessionManager: {
			getCwd: () => "/tmp/project",
			getSessionId: () => "session-123",
			getSessionName: () => "test session",
		},
		getActiveToolNames: () => ["read", "bash"],
		subscribe: () => () => {},
	} as unknown as AgentSession;
}

describe("session-debug-logger", () => {
	const tempRoots: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const root of tempRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("writes debug artifacts under the provided project root with UTC time in the folder name", () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "crucible-debug-root-"));
		tempRoots.push(projectRoot);
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-13T22:49:15.000Z"));

		const logger = new SessionDebugLogger({
			session: createStubSession(),
			projectRoot,
		});

		logger.start();

		const artifacts = logger.getArtifacts();
		expect(artifacts.sessionDir).toBe(join(projectRoot, "Debug", "2026-04-13_22-49-15_local_lm-studio"));
		expect(existsSync(artifacts.sessionDir!)).toBe(true);
		expect(existsSync(artifacts.sessionMd!)).toBe(true);
		expect(readFileSync(artifacts.sessionMd!, "utf8")).toContain("2026-04-13 22:49:15 UTC");
	});

	test("adds a numeric suffix when the same timestamp/model directory already exists", () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "crucible-debug-root-"));
		tempRoots.push(projectRoot);
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-13T22:49:15.000Z"));

		const first = new SessionDebugLogger({
			session: createStubSession(),
			projectRoot,
		});
		first.start();

		const second = new SessionDebugLogger({
			session: createStubSession(),
			projectRoot,
		});
		second.start();

		expect(first.getArtifacts().sessionDir).toBe(join(projectRoot, "Debug", "2026-04-13_22-49-15_local_lm-studio"));
		expect(second.getArtifacts().sessionDir).toBe(join(projectRoot, "Debug", "2026-04-13_22-49-15_local_lm-studio-2"));
	});
});
