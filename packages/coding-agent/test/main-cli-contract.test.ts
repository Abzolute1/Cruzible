import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Args } from "../src/cli/args.js";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import {
	buildRuntimeCliOptions,
	main,
	prepareStartupModelsFile,
	prepareStartupInput,
	resolveSessionReference,
	resolveSelectedTools,
	resolveSessionStorageDir,
	validateModeFlags,
	validateToolFlags,
	validateSessionFlags,
} from "../src/main.js";

function createArgs(messages: string[] = []): Args {
	return {
		messages: [...messages],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
	};
}

function createTempDir(name: string): string {
	const dir = join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeSessionFile(path: string, cwd: string, id: string): void {
	writeFileSync(
		path,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: new Date().toISOString(),
			cwd,
		})}\n`,
	);
}

describe("main CLI contract", () => {
	const cleanupPaths: string[] = [];

	afterEach(() => {
		for (const path of cleanupPaths.splice(0)) {
			rmSync(path, { recursive: true, force: true });
		}
		process.exitCode = undefined;
	});

	it("resolves session storage dir from CLI override before settings/defaults", () => {
		const cwd = createTempDir("main-cli-cwd");
		const agentDir = createTempDir("main-cli-agent");
		cleanupPaths.push(cwd, agentDir);

		const settings = SettingsManager.inMemory({ sessionDir: "./from-settings" });

		expect(resolveSessionStorageDir(cwd, agentDir, settings, createArgs())).toBe(join(cwd, "from-settings"));
		expect(resolveSessionStorageDir(cwd, agentDir, settings, { ...createArgs(), sessionDir: "./from-cli" })).toBe(
			join(cwd, "from-cli"),
		);
		expect(resolveSessionStorageDir(cwd, agentDir, SettingsManager.inMemory({}), createArgs())).toBe(
			getDefaultSessionDir(cwd, agentDir),
		);
	});

	it("prepares startup input from stdin, @file text, and the first message", async () => {
		const cwd = createTempDir("main-cli-input");
		const textFile = join(cwd, "README.txt");
		cleanupPaths.push(cwd);
		writeFileSync(textFile, "file body");

		const parsed = createArgs(["Explain this", "Second message"]);
		parsed.fileArgs = [textFile];

		const result = await prepareStartupInput(parsed, "stdin\n");

		expect(result.initialMessage).toContain("stdin\n");
		expect(result.initialMessage).toContain(`<file name="${textFile}">`);
		expect(result.initialMessage).toContain("Explain this");
		expect(result.remainingMessages).toEqual(["Second message"]);
	});

	it("resolves a session by partial id within the configured session dir", async () => {
		const cwd = createTempDir("main-cli-session-cwd");
		const sessionDir = createTempDir("main-cli-session-dir");
		cleanupPaths.push(cwd, sessionDir);

		const sessionA = join(sessionDir, "a.jsonl");
		const sessionB = join(sessionDir, "b.jsonl");
		writeSessionFile(sessionA, cwd, "1234abcd-session");
		writeSessionFile(sessionB, cwd, "9876wxyz-session");

		const resolved = await resolveSessionReference("1234", cwd, sessionDir);
		expect(resolved).toBe(sessionA);
	});

	it("resolves relative session paths against the target cwd", async () => {
		const cwd = createTempDir("main-cli-relative-session-cwd");
		const sessionDir = createTempDir("main-cli-relative-session-dir");
		const nestedDir = join(cwd, "nested");
		const relativeSessionPath = join(nestedDir, "session.jsonl");
		cleanupPaths.push(cwd, sessionDir);
		mkdirSync(nestedDir, { recursive: true });
		writeSessionFile(relativeSessionPath, cwd, "relative-session");

		const originalCwd = process.cwd();
		const otherCwd = createTempDir("main-cli-other-cwd");
		cleanupPaths.push(otherCwd);
		process.chdir(otherCwd);
		try {
			const resolved = await resolveSessionReference("./nested/session.jsonl", cwd, sessionDir);
			expect(resolved).toBe(relativeSessionPath);
		} finally {
			process.chdir(originalCwd);
		}
	});

	it("can resolve a session by partial id across all sessions when requested", async () => {
		const cwd = createTempDir("main-cli-session-all-cwd");
		const sessionDir = createTempDir("main-cli-session-all-dir");
		cleanupPaths.push(cwd, sessionDir);

		const listSpy = vi.spyOn(SessionManager, "list").mockResolvedValue([]);
		const listAllSpy = vi.spyOn(SessionManager, "listAll").mockResolvedValue([
			{
				path: "/tmp/shared-session.jsonl",
				id: "feedbeef-session",
				cwd: "/tmp/project",
				created: new Date(0),
				modified: new Date(0),
				messageCount: 1,
				firstMessage: "hello",
				allMessagesText: "hello",
			},
		]);

		try {
			const resolved = await resolveSessionReference("feed", cwd, sessionDir, true);
			expect(resolved).toBe("/tmp/shared-session.jsonl");
			expect(listSpy).toHaveBeenCalled();
			expect(listAllSpy).toHaveBeenCalled();
		} finally {
			listSpy.mockRestore();
			listAllSpy.mockRestore();
		}
	});

	it("rejects conflicting session selector flags", () => {
		expect(validateSessionFlags({ ...createArgs(), continue: true, session: "abc" }, "interactive")).toContain(
			"Only one of",
		);
		expect(validateSessionFlags({ ...createArgs(), noSession: true, fork: "abc" }, "interactive")).toContain(
			"--no-session",
		);
		expect(validateSessionFlags({ ...createArgs(), resume: true }, "print")).toContain("--resume requires");
		expect(validateSessionFlags(createArgs(), "interactive")).toBeNull();
	});

	it("rejects conflicting non-interactive mode flags", () => {
		expect(validateModeFlags({ ...createArgs(), print: true, mode: "json" })).toContain("Only one");
		expect(validateModeFlags({ ...createArgs(), mode: "json" })).toBeNull();
	});

	it("rejects conflicting tool selection flags", () => {
		expect(validateToolFlags({ ...createArgs(), noTools: true, tools: ["read"] })).toContain("--no-tools");
		expect(validateToolFlags(createArgs())).toBeNull();
	});

	it("maps explicit tool selection and no-tools consistently", () => {
		const cwd = createTempDir("main-cli-tools");
		cleanupPaths.push(cwd);
		expect(resolveSelectedTools({ ...createArgs(), tools: ["read", "bash"] }, cwd)?.map((tool) => tool.name)).toEqual([
			"read",
			"bash",
		]);
		expect(resolveSelectedTools({ ...createArgs(), noTools: true }, cwd)).toEqual([]);
		expect(resolveSelectedTools(createArgs(), cwd)).toBeUndefined();
	});

	it("binds selected built-in tools to the target cwd instead of process cwd", async () => {
		const cwd = createTempDir("main-cli-tool-cwd");
		const nestedFile = join(cwd, "note.txt");
		cleanupPaths.push(cwd);
		writeFileSync(nestedFile, "cwd-bound");

		const [readTool] = resolveSelectedTools({ ...createArgs(), tools: ["read"] }, cwd) ?? [];
		expect(readTool).toBeDefined();

		const result = await readTool!.execute("test-call", { path: "note.txt" });
		expect(result.content[0]).toMatchObject({ type: "text", text: "cwd-bound" });
	});

	it("builds runtime cli options from relative paths and extension flags", () => {
		const cwd = createTempDir("main-cli-runtime-options");
		const systemPromptPath = join(cwd, "system.txt");
		const appendPromptPath = join(cwd, "append.txt");
		cleanupPaths.push(cwd);
		writeFileSync(systemPromptPath, "system");
		writeFileSync(appendPromptPath, "append");

		const args: Args = {
			...createArgs(),
			tools: ["read", "webSearch"],
			extensions: ["./extensions/test.ts"],
			skills: ["./skills/test"],
			promptTemplates: ["./prompts"],
			themes: ["./themes/crucible.json"],
			noExtensions: true,
			noThemes: true,
			systemPrompt: "./system.txt",
			appendSystemPrompt: "./append.txt",
			unknownFlags: new Map([
				["experimental-flag", true],
				["provider-mode", "strict"],
			]),
		};

		const result = buildRuntimeCliOptions(args, cwd);

		expect(result.selectedToolNames).toEqual(["read", "webSearch"]);
		expect(result.extensionFlagValues).toEqual(
			new Map([
				["experimental-flag", true],
				["provider-mode", "strict"],
			]),
		);
		expect(result.resourceLoaderOptions).toMatchObject({
			additionalExtensionPaths: [join(cwd, "extensions/test.ts")],
			additionalSkillPaths: [join(cwd, "skills/test")],
			additionalPromptTemplatePaths: [join(cwd, "prompts")],
			additionalThemePaths: [join(cwd, "themes/crucible.json")],
			noExtensions: true,
			noThemes: true,
			systemPrompt: systemPromptPath,
			appendSystemPrompt: appendPromptPath,
		});
	});

	it("prepares startup models by preserving custom providers and replacing managed ones", async () => {
		const agentDir = createTempDir("main-cli-models-agent");
		const modelsPath = join(agentDir, "models.json");
		cleanupPaths.push(agentDir);
		writeFileSync(
			modelsPath,
			JSON.stringify(
				{
					providers: {
						custom: { api: "custom" },
						nvidia: { stale: true },
						local: { stale: true },
					},
				},
				null,
				2,
			),
		);

		await prepareStartupModelsFile({
			agentDir,
			env: {},
			fetchImpl: vi.fn().mockResolvedValue({ ok: false }),
		});

		const saved = JSON.parse(readFileSync(modelsPath, "utf-8")) as {
			providers: Record<string, unknown>;
		};
		expect(saved.providers.custom).toEqual({ api: "custom" });
		expect(saved.providers.nvidia).toBeUndefined();
		expect(saved.providers.local).toBeUndefined();
	});

	it("adds detected local provider and survives malformed LM Studio payloads", async () => {
		const agentDir = createTempDir("main-cli-local-provider");
		cleanupPaths.push(agentDir);

		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ data: [{ id: "qwen-local" }, { id: 42 }, {}] }),
			})
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ broken: true }),
			});

		const first = await prepareStartupModelsFile({
			agentDir,
			env: { LM_STUDIO_URL: "http://127.0.0.1:1234" },
			fetchImpl: fetchImpl as typeof fetch,
		});
		expect(first.modelsData.providers.local).toBeDefined();

		const second = await prepareStartupModelsFile({
			agentDir,
			env: { LM_STUDIO_URL: "http://127.0.0.1:1234" },
			fetchImpl: fetchImpl as typeof fetch,
		});
		expect(second.modelsData.providers.local).toBeUndefined();
	});

	it("does not probe providers or write models.json for invalid mode flags", async () => {
		const agentDir = createTempDir("main-cli-invalid-flags-agent");
		cleanupPaths.push(agentDir);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await main(["--agent-dir", agentDir, "--mode", "json", "-p"]);
			expect(process.exitCode).toBe(1);
			expect(existsSync(join(agentDir, "models.json"))).toBe(false);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("does not probe providers or write models.json for deferred non-interactive help", async () => {
		const agentDir = createTempDir("main-cli-help-agent");
		cleanupPaths.push(agentDir);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await main(["--agent-dir", agentDir, "--mode", "json", "--help"]);
			expect(process.exitCode).toBeUndefined();
			expect(existsSync(join(agentDir, "models.json"))).toBe(false);
		} finally {
			errorSpy.mockRestore();
		}
	});
});
