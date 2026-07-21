import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	findMostRecentSession,
	loadEntriesFromFile,
	SessionManager,
	SessionPersistenceError,
} from "../../src/core/session-manager.js";

describe("loadEntriesFromFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns empty array for non-existent file", () => {
		const entries = loadEntriesFromFile(join(tempDir, "nonexistent.jsonl"));
		expect(entries).toEqual([]);
	});

	it("returns empty array for empty file", () => {
		const file = join(tempDir, "empty.jsonl");
		writeFileSync(file, "");
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("returns empty array for file without valid session header", () => {
		const file = join(tempDir, "no-header.jsonl");
		writeFileSync(file, '{"type":"message","id":"1"}\n');
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("returns empty array for malformed JSON", () => {
		const file = join(tempDir, "malformed.jsonl");
		writeFileSync(file, "not json\n");
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("loads valid session file", () => {
		const file = join(tempDir, "valid.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("session");
		expect(entries[1].type).toBe("message");
	});

	it("treats malformed-line sessions as invalid instead of partially loading them", () => {
		const file = join(tempDir, "mixed.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				"not valid json\n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		expect(loadEntriesFromFile(file)).toEqual([]);
	});
});

describe("findMostRecentSession", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns null for empty directory", () => {
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns null for non-existent directory", () => {
		expect(findMostRecentSession(join(tempDir, "nonexistent"))).toBeNull();
	});

	it("ignores non-jsonl files", () => {
		writeFileSync(join(tempDir, "file.txt"), "hello");
		writeFileSync(join(tempDir, "file.json"), "{}");
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("ignores jsonl files without valid session header", () => {
		writeFileSync(join(tempDir, "invalid.jsonl"), '{"type":"message"}\n');
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns single valid session file", () => {
		const file = join(tempDir, "session.jsonl");
		writeFileSync(file, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		expect(findMostRecentSession(tempDir)).toBe(file);
	});

	it("returns most recently modified session", async () => {
		const file1 = join(tempDir, "older.jsonl");
		const file2 = join(tempDir, "newer.jsonl");

		writeFileSync(file1, '{"type":"session","id":"old","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		// Small delay to ensure different mtime
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(file2, '{"type":"session","id":"new","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(file2);
	});

	it("skips invalid files and returns valid one", async () => {
		const invalid = join(tempDir, "invalid.jsonl");
		const valid = join(tempDir, "valid.jsonl");

		writeFileSync(invalid, '{"type":"not-session"}\n');
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(valid, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(valid);
	});

	it("ignores malformed-line sessions when choosing the most recent session", async () => {
		const malformed = join(tempDir, "malformed.jsonl");
		const valid = join(tempDir, "valid.jsonl");

		writeFileSync(
			malformed,
			'{"type":"session","id":"bad","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' + "not valid json\n",
		);
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(valid, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(valid);
	});
});

describe("SessionManager.setSessionFile with corrupted files", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("quarantines an empty file and rewrites a fresh session header", () => {
		const emptyFile = join(tempDir, "empty.jsonl");
		writeFileSync(emptyFile, "");

		const sm = SessionManager.open(emptyFile, tempDir);

		// Should have created a new session with valid header
		expect(sm.getSessionId()).toBeTruthy();
		expect(sm.getHeader()).toBeTruthy();
		expect(sm.getHeader()?.type).toBe("session");

		// File should now contain a valid header
		const content = readFileSync(emptyFile, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		expect(lines.length).toBe(1);
		const header = JSON.parse(lines[0]);
		expect(header.type).toBe("session");
		expect(header.id).toBe(sm.getSessionId());

		const quarantined = readdirSync(tempDir).filter((name) => name.startsWith("empty.jsonl.corrupt-"));
		expect(quarantined).toHaveLength(1);
	});

	it("quarantines a file without a valid header", () => {
		const noHeaderFile = join(tempDir, "no-header.jsonl");
		// File with messages but no session header (corrupted state)
		writeFileSync(
			noHeaderFile,
			'{"type":"message","id":"abc","parentId":"orphaned","timestamp":"2025-01-01T00:00:00Z","message":{"role":"assistant","content":"test"}}\n',
		);

		const sm = SessionManager.open(noHeaderFile, tempDir);

		// Should have created a new session with valid header
		expect(sm.getSessionId()).toBeTruthy();
		expect(sm.getHeader()).toBeTruthy();
		expect(sm.getHeader()?.type).toBe("session");

		// File should now contain only a valid header
		const content = readFileSync(noHeaderFile, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		expect(lines.length).toBe(1);
		const header = JSON.parse(lines[0]);
		expect(header.type).toBe("session");
		expect(header.id).toBe(sm.getSessionId());

		const quarantined = readdirSync(tempDir).filter((name) => name.startsWith("no-header.jsonl.corrupt-"));
		expect(quarantined).toHaveLength(1);
	});

	it("quarantines a file with malformed lines even when the header is valid", () => {
		const malformedFile = join(tempDir, "mixed.jsonl");
		writeFileSync(
			malformedFile,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				"not valid json\n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);

		const sm = SessionManager.open(malformedFile, tempDir);

		expect(sm.getHeader()?.type).toBe("session");
		const content = readFileSync(malformedFile, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]).type).toBe("session");

		const quarantined = readdirSync(tempDir).filter((name) => name.startsWith("mixed.jsonl.corrupt-"));
		expect(quarantined).toHaveLength(1);
	});

	it("preserves explicit session file path when recovering from corrupted file", () => {
		const explicitPath = join(tempDir, "my-session.jsonl");
		writeFileSync(explicitPath, "");

		const sm = SessionManager.open(explicitPath, tempDir);

		// The session file path should be preserved
		expect(sm.getSessionFile()).toBe(explicitPath);
	});

	it("subsequent loads of recovered file work correctly", () => {
		const corruptedFile = join(tempDir, "corrupted.jsonl");
		writeFileSync(corruptedFile, "garbage content\n");

		// First open recovers the file
		const sm1 = SessionManager.open(corruptedFile, tempDir);
		const sessionId = sm1.getSessionId();

		// Second open should load the recovered file successfully
		const sm2 = SessionManager.open(corruptedFile, tempDir);
		expect(sm2.getSessionId()).toBe(sessionId);
		expect(sm2.getHeader()?.type).toBe("session");
	});
});

describe("SessionManager immediate persistence", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("writes the session header immediately for persisted sessions", () => {
		const sm = SessionManager.create(tempDir, tempDir);
		const sessionFile = sm.getSessionFile();

		expect(sessionFile).toBeTruthy();
		expect(existsSync(sessionFile!)).toBe(true);

		const lines = readFileSync(sessionFile!, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]).type).toBe("session");
	});

	it("persists the first user turn immediately", () => {
		const sm = SessionManager.create(tempDir, tempDir);
		const sessionFile = sm.getSessionFile()!;

		sm.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		const lines = readFileSync(sessionFile, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1]).type).toBe("message");
		expect(JSON.parse(lines[1]).message.role).toBe("user");
	});

	it("removes the session write lock after persistence", () => {
		const sm = SessionManager.create(tempDir, tempDir);
		const sessionFile = sm.getSessionFile()!;

		sm.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		expect(existsSync(`${sessionFile}.lock`)).toBe(false);
	});

	it("recovers a stale session write lock", () => {
		const sm = SessionManager.create(tempDir, tempDir);
		const sessionFile = sm.getSessionFile()!;
		const lockPath = `${sessionFile}.lock`;
		mkdirSync(lockPath);
		const staleTime = new Date(Date.now() - 10 * 60_000);
		utimesSync(lockPath, staleTime, staleTime);

		sm.appendMessage({ role: "user", content: "after stale lock", timestamp: 1 });

		expect(existsSync(lockPath)).toBe(false);
		const lines = readFileSync(sessionFile, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1]).message.content).toBe("after stale lock");
	});

	it("preserves entries written by another manager before rewriting", () => {
		const first = SessionManager.create(tempDir, tempDir);
		const sessionFile = first.getSessionFile()!;
		const second = SessionManager.open(sessionFile, tempDir);

		first.appendMessage({ role: "user", content: "from first manager", timestamp: 1 });
		second.appendMessage({ role: "user", content: "from second manager", timestamp: 2 });

		const lines = readFileSync(sessionFile, "utf-8").trim().split("\n");
		const messages = lines
			.map((line) => JSON.parse(line))
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message.content);
		expect(messages).toContain("from first manager");
		expect(messages).toContain("from second manager");
	});

	it("rejects unserializable entries before mutating state or disk", () => {
		const sm = SessionManager.create(tempDir, tempDir);
		const sessionFile = sm.getSessionFile()!;

		expect(() => sm.appendCustomEntry("bad", { big: 1n })).toThrow(SessionPersistenceError);
		expect(sm.getEntries()).toHaveLength(0);
		expect(sm.getLeafId()).toBeNull();

		// The failed append must not poison later appends.
		const id = sm.appendMessage({ role: "user", content: "after failure", timestamp: 1 });
		expect(sm.getEntries()).toHaveLength(1);
		expect(sm.getLeafId()).toBe(id);

		const lines = readFileSync(sessionFile, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2); // header + the successful append only
		expect(JSON.parse(lines[1]).message.content).toBe("after failure");
	});

	it("rejects circular extension details without poisoning the session", () => {
		const sm = SessionManager.create(tempDir, tempDir);

		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() => sm.appendCustomEntry("bad", circular)).toThrow(SessionPersistenceError);
		expect(sm.getEntries()).toHaveLength(0);

		sm.appendMessage({ role: "user", content: "still works", timestamp: 1 });
		expect(sm.getEntries()).toHaveLength(1);
	});

	it("writes the header before the first append for explicit paths that do not exist yet", () => {
		const explicitFile = join(tempDir, "explicit.jsonl");
		const sm = SessionManager.open(explicitFile, tempDir);

		sm.appendMessage({ role: "user", content: "hi", timestamp: 1 });

		const lines = readFileSync(explicitFile, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]).type).toBe("session");
		expect(JSON.parse(lines[1]).type).toBe("message");
	});
});
