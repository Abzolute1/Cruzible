import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionLockTimeout, SessionManager } from "../../src/core/session-manager.js";

describe("SessionManager write lock", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `ag1-session-lock-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("times out with a distinguishable SessionLockTimeout when the lock is held", () => {
		const sm = SessionManager.create(tempDir, tempDir);
		const sessionFile = sm.getSessionFile()!;
		const lockPath = `${sessionFile}.lock`;
		mkdirSync(lockPath);
		writeFileSync(join(lockPath, "owner"), `${process.pid}:held-by-test`);

		const start = Date.now();
		expect(() => sm.appendMessage({ role: "user", content: "blocked", timestamp: 1 })).toThrow(SessionLockTimeout);
		const elapsed = Date.now() - start;

		// Bounded wait (~2s), not the old 30s spin.
		expect(elapsed).toBeLessThan(10_000);
		// The held lock was never removed by the failed acquisition.
		expect(existsSync(lockPath)).toBe(true);
		// Persist-before-mutate: in-memory state was not changed either.
		expect(sm.getEntries()).toHaveLength(0);
	}, 15_000);

	it("does not break a stale lock whose owner process is still alive", () => {
		const sm = SessionManager.create(tempDir, tempDir);
		const sessionFile = sm.getSessionFile()!;
		const lockPath = `${sessionFile}.lock`;
		mkdirSync(lockPath);
		// A live pid (this process) with a stale mtime: the stale-breaker must
		// not delete a lock whose owner is clearly running.
		writeFileSync(join(lockPath, "owner"), `${process.pid}:stale-but-alive`);
		const staleTime = new Date(Date.now() - 10 * 60_000);
		utimesSync(lockPath, staleTime, staleTime);

		expect(() => sm.appendMessage({ role: "user", content: "blocked", timestamp: 1 })).toThrow(SessionLockTimeout);
		expect(existsSync(lockPath)).toBe(true);
	}, 15_000);

	it("breaks a stale lock whose owner process is dead", () => {
		const sm = SessionManager.create(tempDir, tempDir);
		const sessionFile = sm.getSessionFile()!;
		const lockPath = `${sessionFile}.lock`;
		mkdirSync(lockPath);
		// 99999999 exceeds the Linux pid_max, so kill(pid, 0) always reports ESRCH.
		writeFileSync(join(lockPath, "owner"), "99999999:dead-owner");
		const staleTime = new Date(Date.now() - 10 * 60_000);
		utimesSync(lockPath, staleTime, staleTime);

		sm.appendMessage({ role: "user", content: "after stale lock", timestamp: 1 });

		expect(existsSync(lockPath)).toBe(false);
		const lines = readFileSync(sessionFile, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1]).message.content).toBe("after stale lock");
	});

	it("persists via the async append path without leaving a lock behind", async () => {
		const sm = SessionManager.create(tempDir, tempDir);
		const sessionFile = sm.getSessionFile()!;

		await sm.appendMessageAsync({ role: "user", content: "async hello", timestamp: 1 });

		expect(existsSync(`${sessionFile}.lock`)).toBe(false);
		const lines = readFileSync(sessionFile, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1]).message.content).toBe("async hello");
		expect(sm.getEntries()).toHaveLength(1);
	});

	it("async append path also times out with SessionLockTimeout when the lock is held", async () => {
		const sm = SessionManager.create(tempDir, tempDir);
		const sessionFile = sm.getSessionFile()!;
		const lockPath = `${sessionFile}.lock`;
		mkdirSync(lockPath);
		writeFileSync(join(lockPath, "owner"), `${process.pid}:held-by-test`);

		await expect(sm.appendMessageAsync({ role: "user", content: "blocked", timestamp: 1 })).rejects.toThrow(
			SessionLockTimeout,
		);
		expect(existsSync(lockPath)).toBe(true);
		expect(sm.getEntries()).toHaveLength(0);
	}, 15_000);
});
