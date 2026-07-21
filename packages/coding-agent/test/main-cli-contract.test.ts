import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Args } from "../src/cli/args.js";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { ModelRegistry } from "../src/index.js";
import {
	buildRuntimeCliOptions,
	enforceExplicitRuntimeModel,
	enforceRequestedStartupModel,
	main,
	prepareStartupInput,
	prepareStartupModelsFile,
	resolveModel,
	resolveSelectedTools,
	resolveSessionReference,
	resolveSessionStorageDir,
	shouldUseRequestedStartupModel,
	validateModeFlags,
	validateSessionFlags,
	validateToolFlags,
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

		const result = await prepareStartupInput(parsed, "stdin\n", cwd);

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
		expect(validateModeFlags({ ...createArgs(), print: true, autonomous: true })).toContain("Only one");
		expect(validateModeFlags({ ...createArgs(), mode: "json" })).toBeNull();
		expect(validateModeFlags({ ...createArgs(), autonomous: true })).toBeNull();
	});

	it("rejects conflicting tool selection flags", () => {
		expect(validateToolFlags({ ...createArgs(), noTools: true, tools: ["read"] })).toContain("--no-tools");
		expect(validateToolFlags(createArgs())).toBeNull();
	});

	it("maps explicit tool selection and no-tools consistently", () => {
		const cwd = createTempDir("main-cli-tools");
		cleanupPaths.push(cwd);
		expect(resolveSelectedTools({ ...createArgs(), tools: ["read", "bash"] }, cwd)?.map((tool) => tool.name)).toEqual(
			["read", "bash"],
		);
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
			themes: ["./themes/ag1.json"],
			noExtensions: true,
			noThemes: true,
			systemPrompt: "./system.txt",
			appendSystemPrompt: "./append.txt",
			unknownFlags: new Map<string, boolean | string>([
				["experimental-flag", true],
				["provider-mode", "strict"],
			]),
		};

		const result = buildRuntimeCliOptions(args, cwd);

		expect(result.selectedToolNames).toEqual(["read", "webSearch"]);
		expect(result.extensionFlagValues).toEqual(
			new Map<string, boolean | string>([
				["experimental-flag", true],
				["provider-mode", "strict"],
			]),
		);
		expect(result.resourceLoaderOptions).toMatchObject({
			additionalExtensionPaths: [join(cwd, "extensions/test.ts")],
			additionalSkillPaths: [join(cwd, "skills/test")],
			additionalPromptTemplatePaths: [join(cwd, "prompts")],
			additionalThemePaths: [join(cwd, "themes/ag1.json")],
			noExtensions: true,
			noThemes: true,
			systemPrompt: systemPromptPath,
			appendSystemPrompt: appendPromptPath,
		});
	});

	it("prepares startup models by preserving custom providers and replacing managed ones", async () => {
		const agentDir = createTempDir("main-cli-models-agent");
		const isolatedFallbackAgentDir = createTempDir("main-cli-models-fallback");
		const userModelsPath = join(agentDir, "models.json");
		const runtimeModelsPath = join(agentDir, "models.runtime.json");
		cleanupPaths.push(agentDir, isolatedFallbackAgentDir);
		writeFileSync(
			userModelsPath,
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
			fallbackAgentDir: isolatedFallbackAgentDir,
			env: { AG1_HOME: isolatedFallbackAgentDir },
			fetchImpl: vi.fn().mockResolvedValue({ ok: false }),
		});

		const userSaved = JSON.parse(readFileSync(userModelsPath, "utf-8")) as {
			providers: Record<string, unknown>;
		};
		const runtimeSaved = JSON.parse(readFileSync(runtimeModelsPath, "utf-8")) as {
			providers: Record<string, unknown>;
		};
		expect(userSaved.providers.nvidia).toEqual({ stale: true });
		expect(userSaved.providers.local).toEqual({ stale: true });
		expect(runtimeSaved.providers.custom).toEqual({ api: "custom" });
		expect(runtimeSaved.providers.nvidia).toBeUndefined();
		expect(runtimeSaved.providers.local).toBeUndefined();
	});

	it("adds detected local provider using real LM Studio model ids and preserves the prior runtime list when detection later fails", async () => {
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
			env: { AG1_HOME: agentDir, LM_STUDIO_URL: "http://127.0.0.1:1234" },
			fetchImpl: fetchImpl as typeof fetch,
		});
		expect(first.modelsData.providers.local).toBeDefined();
		expect((first.modelsData.providers.local as any).models).toEqual([
			expect.objectContaining({ id: "qwen-local", name: "qwen-local", contextWindow: 128000 }),
		]);

		const second = await prepareStartupModelsFile({
			agentDir,
			env: { AG1_HOME: agentDir, LM_STUDIO_URL: "http://127.0.0.1:1234" },
			fetchImpl: fetchImpl as typeof fetch,
		});
		expect(second.modelsData.providers.local).toBeDefined();
		expect((second.modelsData.providers.local as any).models).toEqual([
			expect.objectContaining({ id: "qwen-local", name: "qwen-local", contextWindow: 128000 }),
		]);
	});

	it("assigns conservative context windows to small detected local models", async () => {
		const agentDir = createTempDir("main-cli-local-context-window");
		cleanupPaths.push(agentDir);
		const fetchImpl = vi.fn().mockResolvedValueOnce({
			ok: true,
			json: async () => ({ data: [{ id: "qwen/qwen3.5-9b" }, { id: "qwen3.5-35b-a3b" }] }),
		});

		const prepared = await prepareStartupModelsFile({
			agentDir,
			env: { AG1_HOME: agentDir, LM_STUDIO_URL: "http://127.0.0.1:1234" },
			fetchImpl: fetchImpl as typeof fetch,
		});
		const models = (prepared.modelsData.providers.local as any).models;

		expect(models).toEqual([
			expect.objectContaining({ id: "qwen/qwen3.5-9b", contextWindow: 32768 }),
			expect.objectContaining({ id: "qwen3.5-35b-a3b", contextWindow: 65536 }),
		]);
	});

	it("stores NVIDIA api key as an env reference instead of persisting the secret value", async () => {
		const agentDir = createTempDir("main-cli-nvidia-models");
		cleanupPaths.push(agentDir);

		const result = await prepareStartupModelsFile({
			agentDir,
			env: { NVIDIA_API_KEY: "super-secret-token" },
			fetchImpl: vi.fn().mockResolvedValue({ ok: false }),
		});

		expect((result.modelsData.providers.nvidia as any).apiKey).toBe("NVIDIA_API_KEY");
		expect(readFileSync(join(agentDir, "models.runtime.json"), "utf-8")).not.toContain("super-secret-token");
	});

	it("includes NVIDIA models when auth.json has saved NVIDIA auth without env", async () => {
		const agentDir = createTempDir("main-cli-nvidia-saved-auth");
		cleanupPaths.push(agentDir);
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ nvidia: { type: "api_key", key: "saved-test-token" } }),
		);

		const result = await prepareStartupModelsFile({
			agentDir,
			env: {},
			fetchImpl: vi.fn().mockResolvedValue({ ok: false }),
		});

		expect(result.modelsData.providers.nvidia).toBeDefined();
		expect((result.modelsData.providers.nvidia as any).apiKey).toBe("NVIDIA_API_KEY");
		expect(readFileSync(join(agentDir, "models.runtime.json"), "utf-8")).not.toContain("saved-test-token");
	});

	it("includes NVIDIA models when the local NVIDIA secret file exists without env", async () => {
		const agentDir = createTempDir("main-cli-nvidia-secret-file");
		const ag1Home = createTempDir("main-cli-nvidia-secret-home");
		cleanupPaths.push(agentDir, ag1Home);
		const secretDir = join(ag1Home, ".ag1-secrets");
		mkdirSync(secretDir, { recursive: true });
		writeFileSync(join(secretDir, "nvidia-api-key"), "local-secret-token\n");

		const result = await prepareStartupModelsFile({
			agentDir,
			env: { AG1_HOME: ag1Home },
			fetchImpl: vi.fn().mockResolvedValue({ ok: false }),
		});

		expect(result.modelsData.providers.nvidia).toBeDefined();
		expect((result.modelsData.providers.nvidia as any).apiKey).toBe("NVIDIA_API_KEY");
		expect(readFileSync(join(agentDir, "models.runtime.json"), "utf-8")).not.toContain("local-secret-token");
	});

	it("adds Nemotron models discovered from the NVIDIA API model list", async () => {
		const agentDir = createTempDir("main-cli-nvidia-discovery");
		cleanupPaths.push(agentDir);
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					data: [
						{ id: "nvidia/nemotron-future-42b" },
						{ id: "nvidia/other-model" },
						{ id: "nvidia/nemotron-3-super-120b-a12b" },
					],
				}),
			})
			.mockResolvedValue({ ok: false });

		const result = await prepareStartupModelsFile({
			agentDir,
			env: { NVIDIA_API_KEY: "super-secret-token" },
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		const models = ((result.modelsData.providers.nvidia as any).models ?? []) as Array<{ id: string }>;
		expect(models).toEqual(expect.arrayContaining([expect.objectContaining({ id: "nvidia/nemotron-future-42b" })]));
		expect(models.some((model) => model.id === "nvidia/other-model")).toBe(false);
		expect(readFileSync(join(agentDir, "models.runtime.json"), "utf-8")).not.toContain("super-secret-token");
	});

	it("reuses the default agent runtime local model list for fresh custom agent dirs", async () => {
		const globalAgentDir = createTempDir("main-cli-global-agent");
		const freshAgentDir = createTempDir("main-cli-fresh-agent");
		cleanupPaths.push(globalAgentDir, freshAgentDir);

		writeFileSync(
			join(globalAgentDir, "models.runtime.json"),
			JSON.stringify(
				{
					providers: {
						local: {
							baseUrl: "http://127.0.0.1:1234/v1",
							api: "openai-completions",
							apiKey: "local",
							models: [{ id: "qwen/qwen3.5-9b", name: "qwen/qwen3.5-9b" }],
						},
					},
				},
				null,
				2,
			),
		);

		const result = await prepareStartupModelsFile({
			agentDir: freshAgentDir,
			fallbackAgentDir: globalAgentDir,
			env: { LM_STUDIO_URL: "http://127.0.0.1:1234" },
			fetchImpl: vi.fn().mockResolvedValue({ ok: false }),
		});

		expect(result.modelsData.providers.local).toBeDefined();
		expect((result.modelsData.providers.local as any).models).toEqual([
			expect.objectContaining({ id: "qwen/qwen3.5-9b", name: "qwen/qwen3.5-9b" }),
		]);
	});

	it("hydrates NVIDIA model pricing into the runtime registry", async () => {
		const agentDir = createTempDir("main-cli-nvidia-pricing");
		cleanupPaths.push(agentDir);

		const result = await prepareStartupModelsFile({
			agentDir,
			env: { NVIDIA_API_KEY: "super-secret-token" },
			fetchImpl: vi.fn().mockResolvedValue({ ok: false }),
		});

		const models = ((result.modelsData.providers.nvidia as any).models ?? []) as Array<{
			id: string;
			cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
		}>;
		expect(models).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "nvidia/nemotron-3-super-120b-a12b",
					cost: { input: 0.2, output: 0.8, cacheRead: 0, cacheWrite: 0 },
				}),
				expect.objectContaining({
					id: "nvidia/llama-3.1-nemotron-ultra-253b-v1",
					cost: { input: 0.6, output: 1.8, cacheRead: 0, cacheWrite: 0 },
				}),
			]),
		);
	});

	it("prefers the requested provider when only --provider is supplied", async () => {
		const settings = SettingsManager.inMemory({ defaultModel: "nvidia/default" });
		const modelRegistry = {
			getAvailable: () => [
				{ id: "nvidia/default", provider: "nvidia", name: "NVIDIA Default" },
				{ id: "local/qwen", provider: "local", name: "Qwen Local" },
			],
		} as unknown as ModelRegistry;

		const resolved = await resolveModel(undefined, "local", modelRegistry, settings);
		expect(resolved.model.id).toBe("local/qwen");
	});

	it("fails clearly when an explicit model is unavailable", async () => {
		const settings = SettingsManager.inMemory({});
		const modelRegistry = {
			getAvailable: () => [{ id: "local/qwen", provider: "local", name: "Qwen Local" }],
		} as unknown as ModelRegistry;

		await expect(resolveModel("missing-model", undefined, modelRegistry, settings)).rejects.toThrow(
			'No model matching "missing-model" is available.',
		);
	});

	it("fails clearly when a requested provider/model pair is impossible", async () => {
		const settings = SettingsManager.inMemory({});
		const modelRegistry = {
			getAvailable: () => [
				{ id: "local/qwen", provider: "local", name: "Qwen Local" },
				{ id: "openai/gpt-5.4", provider: "openai", name: "GPT-5.4" },
			],
		} as unknown as ModelRegistry;

		await expect(resolveModel("gpt-5.4", "local", modelRegistry, settings)).rejects.toThrow(
			'No model matching "gpt-5.4" found for provider "local".',
		);
	});

	it("fails clearly when a requested provider has no available models", async () => {
		const settings = SettingsManager.inMemory({});
		const modelRegistry = {
			getAvailable: () => [{ id: "local/qwen", provider: "local", name: "Qwen Local" }],
		} as unknown as ModelRegistry;

		await expect(resolveModel(undefined, "openai", modelRegistry, settings)).rejects.toThrow(
			'No models available for provider "openai".',
		);
	});

	it("reapplies an explicit startup model when runtime bootstrap drifts to another model", () => {
		const requestedModel = {
			provider: "openai",
			id: "gpt-5.4-mini",
			name: "GPT-5.4 mini",
		} as any;
		const appendModelChange = vi.fn(() => "entry-1");
		const session = {
			agent: {
				state: {
					model: {
						provider: "local",
						id: "lm-studio",
						name: "LM Studio",
					},
				},
			},
			sessionManager: {
				appendModelChange,
			},
		};

		const corrected = enforceRequestedStartupModel(session as any, requestedModel);

		expect(corrected).toBe(true);
		expect(session.agent.state.model).toBe(requestedModel);
		expect(appendModelChange).toHaveBeenCalledWith("openai", "gpt-5.4-mini");
	});

	it("reapplies an explicit runtime model before execution when the live session drifted", async () => {
		const requestedModel = {
			provider: "openai",
			id: "gpt-5.4-mini",
			name: "GPT-5.4 mini",
		} as any;
		const setModel = vi.fn().mockResolvedValue(undefined);
		const session = {
			model: {
				provider: "local",
				id: "lm-studio",
				name: "LM Studio",
			},
			setModel,
		};

		const corrected = await enforceExplicitRuntimeModel(session as any, requestedModel, true);

		expect(corrected).toBe(true);
		expect(setModel).toHaveBeenCalledWith(requestedModel);
	});

	it("does not reapply the runtime model when there was no explicit CLI request", async () => {
		const requestedModel = {
			provider: "openai",
			id: "gpt-5.4-mini",
			name: "GPT-5.4 mini",
		} as any;
		const setModel = vi.fn().mockResolvedValue(undefined);
		const session = {
			model: {
				provider: "local",
				id: "lm-studio",
				name: "LM Studio",
			},
			setModel,
		};

		const corrected = await enforceExplicitRuntimeModel(session as any, requestedModel, false);

		expect(corrected).toBe(false);
		expect(setModel).not.toHaveBeenCalled();
	});

	it("treats a null session model as an empty startup session", () => {
		expect(shouldUseRequestedStartupModel({ messages: [], model: null })).toBe(true);
		expect(shouldUseRequestedStartupModel({ messages: [], model: undefined })).toBe(true);
		expect(
			shouldUseRequestedStartupModel({
				messages: [],
				model: { provider: "local", modelId: "lm-studio" },
			}),
		).toBe(false);
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

	it("lists models without creating session state", async () => {
		const agentDir = createTempDir("main-cli-list-models-agent");
		const cwd = createTempDir("main-cli-list-models-cwd");
		cleanupPaths.push(agentDir, cwd);
		const listSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const createSessionSpy = vi.spyOn(SessionManager, "create");

		try {
			await main(["--agent-dir", agentDir, "--cwd", cwd, "--list-models"]);
			expect(createSessionSpy).not.toHaveBeenCalled();
			expect(listSpy).toHaveBeenCalled();
		} finally {
			listSpy.mockRestore();
			createSessionSpy.mockRestore();
		}
	});

	it("fails cleanly for an explicit unavailable model request", async () => {
		const agentDir = createTempDir("main-cli-invalid-model-agent");
		const cwd = createTempDir("main-cli-invalid-model-cwd");
		cleanupPaths.push(agentDir, cwd);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await main(["--agent-dir", agentDir, "--cwd", cwd, "--model", "missing-model", "--print", "hello"]);
			expect(process.exitCode).toBe(1);
			expect(errorSpy).toHaveBeenCalledWith('No model matching "missing-model" is available.');
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
