// Auton — Main dispatch: parse args, create runtime, launch mode
//
// Cleaned up: removed all broken imports (kairos-tool-registry, aikit-provider,
// lmstudio, spinner, coordinator). We use AG1's built-in tools only. Autonomous
// mode is implemented as a flag on the interactive prompt handler, not a
// separate entry point.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Api, ImageContent, Model } from "@ag1/ai";
import type { Args } from "./cli/args.js";
import { parseArgs } from "./cli/args.js";
import { processFileArguments } from "./cli/file-processor.js";
import { buildInitialMessage } from "./cli/initial-message.js";
import { selectSession } from "./cli/session-picker.js";
import { APP_NAME, CLI_NAME, VERSION } from "./config.js";
import { filterHeadlessActiveToolNames } from "./core/headless-tool-filter.js";
import { matchSavedDefaultModel, pickPreferredAvailableModel } from "./core/model-resolver.js";
import { restoreStdout, takeOverStdout } from "./core/output-guard.js";
import { readProviderSecretFileApiKey } from "./core/provider-secret-file.js";
import type { DefaultResourceLoaderOptions } from "./core/resource-loader.js";
import { getDefaultSessionDir } from "./core/session-manager.js";
import { createAllTools, type Tool, type ToolName } from "./core/tools/index.js";
import {
	AuthStorage,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	InteractiveMode,
	initTheme,
	ModelRegistry,
	runPrintMode,
	runRpcMode,
	SessionManager,
	SettingsManager,
} from "./index.js";
import { runAutonomousMode } from "./modes/autonomous-mode.js";
import { handleConfigCommand, handlePackageCommand } from "./package-manager-cli.js";
import { createNvidiaModelEntry, getNvidiaModels, NVIDIA_BASE_URL } from "./providers/nvidia-provider.js";

type StartupModelsFile = {
	providers: Record<string, unknown>;
};

function modelsMatch(
	a: Pick<Model<Api>, "provider" | "id"> | undefined,
	b: Pick<Model<Api>, "provider" | "id"> | undefined,
): boolean {
	return a?.provider === b?.provider && a?.id === b?.id;
}

export function enforceRequestedStartupModel(
	session: {
		agent: { state: { model?: Model<Api> } };
		sessionManager: { appendModelChange: (provider: string, modelId: string) => string };
	},
	requestedModel: Model<Api> | undefined,
): boolean {
	if (!requestedModel || modelsMatch(session.agent.state.model, requestedModel)) {
		return false;
	}
	session.agent.state.model = requestedModel;
	session.sessionManager.appendModelChange(requestedModel.provider, requestedModel.id);
	return true;
}

export async function enforceExplicitRuntimeModel(
	session: {
		model?: Model<Api>;
		setModel: (model: Model<Api>) => Promise<void>;
	},
	requestedModel: Model<Api> | undefined,
	hasExplicitRequest: boolean,
): Promise<boolean> {
	if (!hasExplicitRequest || !requestedModel || modelsMatch(session.model, requestedModel)) {
		return false;
	}
	await session.setModel(requestedModel);
	return true;
}

export function shouldUseRequestedStartupModel(existingSession: {
	messages: unknown[];
	model: { provider: string; modelId: string } | null | undefined;
}): boolean {
	return existingSession.messages.length === 0 && existingSession.model == null;
}

function printHelp(stream: "stdout" | "stderr" = "stdout"): void {
	const cliName = basename(process.argv[1] || CLI_NAME);
	const writer = stream === "stderr" ? console.error : console.log;
	writer(`
${APP_NAME} — interactive and autonomous coding harness

Usage: ${cliName} [prompt] [options]

Options:
  --model <model>        Model to use (default: nvidia/llama-3.1-nemotron-ultra-253b-v1, or qwen3.6-plus, or a local LM Studio model)
  --thinking [level]     Enable thinking mode (optional level: low, medium, high, xhigh)
  --session <id|path>    Resume or load a specific session
  --cwd <dir>            Working directory (default: current directory)
  --provider <provider>  Force a specific provider (e.g., nvidia, dashscope, local)
  --max-cost <usd>       Maximum USD cost before auto-stop (default: 0 = unlimited)
  --max-tokens <n>       Maximum total tokens before auto-stop (default: 0 = unlimited)
  --max-turns <n>        Maximum turns per session (default: 100)
  --max-output <n>       Max output tokens per turn (default: 0 = unlimited)
  --tools <tool>         Enable specific tool (can be repeated)
  --agent-dir <dir>      Agent config directory (default: ${getAgentDir()})

  --resume               Resume the most recent session
  --fork <id>            Fork an existing session
  --no-session           Run without saving a session
  --print                Print output without TUI
  --json                 Output in JSON format
  --list-models          List available models

  --help                 Show this help
  --version              Show version
  --auto                 Start the TUI with autonomous mode armed for the first prompt
  --autonomous           Run a headless autonomous session and exit

Local models: Start LM Studio (port 1234) and models appear automatically.
  Override URL with LM_STUDIO_URL or LM_STUDIO_PORT env vars.

Primary autonomy UX: use Alt+M inside the TUI to arm autonomous mode for the next prompt.
`);
}

function printVersion(): void {
	console.log(`${APP_NAME} v${VERSION}`);
}

function findModelMatch(available: Model<Api>[], query: string): Model<Api> | undefined {
	const lower = query.toLowerCase();
	return (
		available.find((m: Model<Api>) => m.id.toLowerCase() === lower) ??
		available.find((m: Model<Api>) => m.name?.toLowerCase().includes(lower) || m.id.toLowerCase().includes(lower))
	);
}

export async function resolveModel(
	modelArg: string | undefined,
	providerArg: string | undefined,
	modelRegistry: ModelRegistry,
	settingsManager: SettingsManager,
): Promise<{ model: Model<Api> }> {
	const available = modelRegistry.getAvailable();
	if (available.length === 0) {
		throw new Error(
			"No models available. Set NVIDIA_API_KEY or DASHSCOPE_API_KEY for cloud models, or start LM Studio on port 1234 for local models.",
		);
	}

	if (providerArg) {
		const providerLower = providerArg.toLowerCase();
		const providerModels = available.filter((m: Model<Api>) => m.provider.toLowerCase() === providerLower);
		if (providerModels.length === 0) {
			throw new Error(`No models available for provider "${providerArg}".`);
		}

		if (modelArg) {
			const providerMatch = findModelMatch(providerModels, modelArg);
			if (providerMatch) return { model: providerMatch };
			throw new Error(`No model matching "${modelArg}" found for provider "${providerArg}".`);
		}

		const savedModelId = settingsManager.getDefaultModel();
		if (savedModelId) {
			const matched = matchSavedDefaultModel(savedModelId, providerModels);
			if (matched) return { model: matched };
		}

		return { model: pickPreferredAvailableModel(providerModels) ?? providerModels[0] };
	}

	if (modelArg) {
		const matched = findModelMatch(available, modelArg);
		if (matched) return { model: matched };
		throw new Error(`No model matching "${modelArg}" is available.`);
	}

	const savedModelId = settingsManager.getDefaultModel();
	if (savedModelId) {
		const matched = matchSavedDefaultModel(savedModelId, available);
		if (matched) return { model: matched };
	}

	return { model: pickPreferredAvailableModel(available) ?? available[0] };
}

async function listModelsCmd(modelRegistry: ModelRegistry, search?: string | true): Promise<void> {
	const available = modelRegistry.getAvailable();
	if (available.length === 0) {
		console.log("No models configured. Set an API key.");
		return;
	}
	const filtered =
		typeof search === "string"
			? available.filter((model) => {
					const haystack = `${model.provider} ${model.id} ${model.name ?? ""}`.toLowerCase();
					return haystack.includes(search.toLowerCase());
				})
			: available;
	for (const m of filtered) console.log(`  ${m.id}`);
}

function resolveRequestedMode(
	config: Args,
	stdinIsTTY: boolean,
): "interactive" | "print" | "json" | "rpc" | "autonomous" {
	if (config.autonomous) return "autonomous";
	if (config.mode === "rpc") return "rpc";
	if (config.mode === "json") return "json";
	if (config.print || !stdinIsTTY) return "print";
	return "interactive";
}

function emitArgDiagnostics(config: Args): boolean {
	for (const diagnostic of config.diagnostics) {
		const writer = diagnostic.type === "error" ? console.error : console.error;
		writer(diagnostic.message);
	}
	return config.diagnostics.some((diagnostic) => diagnostic.type === "error");
}

export function resolveSessionStorageDir(
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManager,
	config: Args,
): string {
	const configuredDir = config.sessionDir ?? settingsManager.getSessionDir();
	return configuredDir ? resolve(cwd, configuredDir) : getDefaultSessionDir(cwd, agentDir);
}

export function validateSessionFlags(
	config: Args,
	mode: "interactive" | "print" | "json" | "rpc" | "autonomous",
): string | null {
	const selectors = [config.continue, config.resume, Boolean(config.session), Boolean(config.fork)].filter(
		Boolean,
	).length;
	if (selectors > 1) {
		return "Only one of --continue, --resume, --session, or --fork may be used at a time.";
	}
	if (config.noSession && selectors > 0) {
		return "--no-session cannot be combined with --continue, --resume, --session, or --fork.";
	}
	if (config.resume && mode !== "interactive") {
		return "--resume requires interactive mode.";
	}
	return null;
}

export function validateModeFlags(config: Args): string | null {
	const requestedModes = [config.print, config.mode === "json", config.mode === "rpc", config.autonomous].filter(
		Boolean,
	).length;
	if (requestedModes > 1) {
		return "Only one non-interactive output mode may be selected at a time.";
	}
	return null;
}

export function validateToolFlags(config: Args): string | null {
	if (config.noTools && config.tools && config.tools.length > 0) {
		return "--no-tools cannot be combined with --tools.";
	}
	return null;
}

function resolveCliPaths(paths: string[] | undefined, cwd: string): string[] | undefined {
	return paths?.map((path) => resolve(cwd, path));
}

function resolvePromptInputPath(value: string | undefined, cwd: string): string | undefined {
	if (!value) return undefined;
	const resolved = resolve(cwd, value);
	return existsSync(resolved) ? resolved : value;
}

export function resolveSelectedTools(config: Args, cwd: string): Tool[] | undefined {
	if (config.noTools) {
		return [];
	}
	if (!config.tools) {
		return undefined;
	}
	const tools = createAllTools(cwd);
	return config.tools.map((name) => tools[name]);
}

export function buildRuntimeCliOptions(
	config: Args,
	cwd: string,
): {
	selectedToolNames?: ToolName[];
	extensionFlagValues?: Map<string, boolean | string>;
	resourceLoaderOptions: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
} {
	return {
		selectedToolNames: config.noTools ? [] : config.tools,
		extensionFlagValues: config.unknownFlags.size > 0 ? new Map(config.unknownFlags) : undefined,
		resourceLoaderOptions: {
			additionalExtensionPaths: resolveCliPaths(config.extensions, cwd),
			additionalSkillPaths: resolveCliPaths(config.skills, cwd),
			additionalPromptTemplatePaths: resolveCliPaths(config.promptTemplates, cwd),
			additionalThemePaths: resolveCliPaths(config.themes, cwd),
			noExtensions: config.noExtensions,
			noSkills: config.noSkills,
			noPromptTemplates: config.noPromptTemplates,
			noThemes: config.noThemes,
			systemPrompt: resolvePromptInputPath(config.systemPrompt, cwd),
			appendSystemPrompt: resolvePromptInputPath(config.appendSystemPrompt, cwd),
		},
	};
}

function loadStartupModelsFile(modelsPath: string): StartupModelsFile {
	try {
		const content = readFileSync(modelsPath, "utf-8");
		if (!content.trim()) return { providers: {} };
		const parsed = JSON.parse(content) as Partial<StartupModelsFile>;
		if (!parsed || typeof parsed !== "object" || !parsed.providers || typeof parsed.providers !== "object") {
			return { providers: {} };
		}
		return { providers: { ...parsed.providers } };
	} catch {
		return { providers: {} };
	}
}

function buildNvidiaProviderConfig(modelIds: string[] = []): Record<string, unknown> {
	const entriesById = new Map(getNvidiaModels().map((model) => [model.id, model]));
	for (const id of modelIds) {
		if (isNvidiaNemotronModelId(id) && !entriesById.has(id)) {
			entriesById.set(id, createNvidiaModelEntry(id));
		}
	}
	const nvidiaModels = [...entriesById.values()].map((m) => ({
		id: m.id,
		name: m.name,
		reasoning: m.supportsThinking ?? false,
		compat: { thinkingFormat: "openai" as const, supportsDeveloperRole: true },
		cost: m.cost,
		contextWindow: m.contextWindow ?? 128_000,
		maxTokens: 8192,
	}));

	return {
		baseUrl: NVIDIA_BASE_URL,
		api: "openai-completions",
		apiKey: "NVIDIA_API_KEY",
		models: nvidiaModels,
	};
}

function isNvidiaNemotronModelId(id: string): boolean {
	const normalized = id.toLowerCase();
	return normalized.includes("nemotron") || normalized.startsWith("nvidia/llama-3.1-nemotron");
}

function getStoredApiKeyReference(agentDir: string, provider: string): string | undefined {
	try {
		const authPath = resolve(agentDir, "auth.json");
		const parsed = JSON.parse(readFileSync(authPath, "utf-8")) as Record<
			string,
			{ type?: string; key?: string } | undefined
		>;
		const credential = parsed[provider];
		if (credential?.type === "api_key" && typeof credential.key === "string" && credential.key.trim()) {
			return credential.key;
		}
	} catch {
		// Missing or malformed auth storage should not block other provider discovery.
	}
	return undefined;
}

function resolveStartupApiKeyReference(value: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
	if (!value) return undefined;
	if (value.startsWith("!")) return undefined;
	return env[value] ?? value;
}

async function detectNvidiaModels(apiKey: string, fetchImpl: typeof fetch): Promise<string[]> {
	try {
		const response = await fetchImpl(`${NVIDIA_BASE_URL}/models`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) return [];
		const payload = (await response.json()) as { data?: Array<{ id?: string }> };
		const ids = (payload.data ?? []).flatMap((entry) => (typeof entry?.id === "string" ? [entry.id] : []));
		return [...new Set(ids.filter(isNvidiaNemotronModelId))].sort();
	} catch {
		return [];
	}
}

async function detectLmStudioModels(lmStudioUrl: string, fetchImpl: typeof fetch): Promise<string[]> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const response = await fetchImpl(`${lmStudioUrl}/v1/models`, { signal: AbortSignal.timeout(5000) });
			if (!response.ok) continue;
			const payload = (await response.json()) as { data?: Array<{ id?: string }> };
			const ids = (payload.data ?? []).flatMap((entry) => (typeof entry?.id === "string" ? [entry.id] : []));
			if (ids.length > 0) {
				return ids;
			}
		} catch {
			// Retry once before treating LM Studio discovery as unavailable.
		}
	}
	return [];
}

function buildLocalProviderConfig(lmStudioUrl: string, modelIds: string[]): Record<string, unknown> {
	return {
		baseUrl: `${lmStudioUrl}/v1`,
		api: "openai-completions",
		apiKey: "local",
		models: modelIds.map((id) => ({
			id,
			name: id,
			reasoning: false,
			compat: { thinkingFormat: "openai" as const, supportsDeveloperRole: true },
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
	};
}

export async function prepareStartupModelsFile(options: {
	agentDir: string;
	fallbackAgentDir?: string;
	startupLog?: (message: string) => void;
	startupWarn?: (message: string) => void;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
}): Promise<{ modelsPath: string; modelsData: StartupModelsFile }> {
	const startupLog = options.startupLog ?? (() => {});
	const startupWarn = options.startupWarn ?? (() => {});
	const env = options.env ?? process.env;
	const fetchImpl = options.fetchImpl ?? fetch;
	const userModelsPath = resolve(options.agentDir, "models.json");
	const runtimeModelsPath = resolve(options.agentDir, "models.runtime.json");
	const fallbackAgentDir = resolve(options.fallbackAgentDir ?? getAgentDir());
	const fallbackRuntimeModelsData =
		fallbackAgentDir !== resolve(options.agentDir)
			? loadStartupModelsFile(resolve(fallbackAgentDir, "models.runtime.json"))
			: undefined;

	if (!existsSync(options.agentDir)) mkdirSync(options.agentDir, { recursive: true });

	const userModelsData = loadStartupModelsFile(userModelsPath);
	const previousRuntimeModelsData = loadStartupModelsFile(runtimeModelsPath);
	const modelsData: StartupModelsFile = {
		providers: { ...userModelsData.providers },
	};
	delete modelsData.providers.nvidia;
	delete modelsData.providers.local;

	const nvidiaStoredKeyReference = getStoredApiKeyReference(options.agentDir, "nvidia");
	const nvidiaDiscoveryKey =
		readProviderSecretFileApiKey("nvidia", env) ?? env.NVIDIA_API_KEY ?? resolveStartupApiKeyReference(nvidiaStoredKeyReference, env);
	if (!nvidiaDiscoveryKey) {
		startupWarn(
			"[AG1] NVIDIA_API_KEY, AG1_NVIDIA_API_KEY_FILE, local NVIDIA secret file, or saved NVIDIA auth not set. NVIDIA models will not be available.",
		);
	} else {
		const discoveredNvidiaModels = await detectNvidiaModels(nvidiaDiscoveryKey, fetchImpl);
		modelsData.providers.nvidia = buildNvidiaProviderConfig(discoveredNvidiaModels);
		if (discoveredNvidiaModels.length > 0) {
			startupLog(`[AG1] NVIDIA Nemotron models detected: ${discoveredNvidiaModels.join(", ")}`);
		}
	}

	const lmStudioUrl = env.LM_STUDIO_URL ?? `http://127.0.0.1:${env.LM_STUDIO_PORT ?? "1234"}`;
	const lmModels = await detectLmStudioModels(lmStudioUrl, fetchImpl);
	if (lmModels.length > 0) {
		modelsData.providers.local = buildLocalProviderConfig(lmStudioUrl, lmModels);
		startupLog(`[Auton] LM Studio detected: ${lmModels.join(", ")}`);
	} else if (previousRuntimeModelsData.providers.local) {
		modelsData.providers.local = previousRuntimeModelsData.providers.local;
		startupWarn(
			"[Auton] LM Studio model discovery returned no models. Preserving the previous local runtime model list.",
		);
	} else if (fallbackRuntimeModelsData?.providers.local) {
		modelsData.providers.local = fallbackRuntimeModelsData.providers.local;
		startupWarn(
			"[Auton] LM Studio model discovery returned no models. Reusing the default agent runtime local model list.",
		);
	}

	try {
		const nextContent = JSON.stringify(modelsData, null, 2);
		const previousContent = existsSync(runtimeModelsPath) ? readFileSync(runtimeModelsPath, "utf-8") : undefined;
		if (previousContent !== nextContent) {
			writeFileSync(runtimeModelsPath, nextContent);
		}
	} catch (error) {
		startupWarn(
			`[Auton] Failed to write runtime models config: ${(error as Error).message}. Startup provider discovery not persisted.`,
		);
	}

	return { modelsPath: runtimeModelsPath, modelsData };
}

async function readPipedStdin(stdinIsTTY: boolean): Promise<string | undefined> {
	if (stdinIsTTY) return undefined;
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	}
	if (chunks.length === 0) return undefined;
	return Buffer.concat(chunks).toString("utf-8");
}

export async function prepareStartupInput(
	config: Args,
	stdinContent?: string,
	cwd = process.cwd(),
): Promise<{ initialMessage?: string; initialImages?: ImageContent[]; remainingMessages: string[] }> {
	const files =
		config.fileArgs.length > 0
			? await processFileArguments(config.fileArgs, {
					autoResizeImages: true,
					cwd,
				})
			: { text: "", images: [] as ImageContent[] };
	const { initialMessage, initialImages } = buildInitialMessage({
		parsed: config,
		fileText: files.text || undefined,
		fileImages: files.images.length > 0 ? files.images : undefined,
		stdinContent,
	});
	return {
		initialMessage,
		initialImages,
		remainingMessages: [...config.messages],
	};
}

export async function resolveSessionReference(
	reference: string,
	cwd: string,
	sessionDir: string,
	searchAllSessions = false,
): Promise<string> {
	const resolvedPath = resolve(cwd, reference);
	if (existsSync(resolvedPath)) {
		return resolvedPath;
	}

	const matchSession = (session: { id: string; path: string }) =>
		session.id === reference || session.id.startsWith(reference) || basename(session.path) === reference;
	const sessions = await SessionManager.list(cwd, sessionDir);
	const matches = sessions.filter(matchSession);
	if (matches.length === 0 && searchAllSessions) {
		const allSessions = await SessionManager.listAll();
		const allMatches = allSessions.filter(matchSession);
		if (allMatches.length === 1) {
			return allMatches[0]!.path;
		}
		if (allMatches.length > 1) {
			throw new Error(`Session reference "${reference}" is ambiguous. Use a full path or a longer session id.`);
		}
	}

	if (matches.length === 1) {
		return matches[0]!.path;
	}
	if (matches.length > 1) {
		throw new Error(`Session reference "${reference}" is ambiguous. Use a full path or a longer session id.`);
	}
	throw new Error(`Session "${reference}" not found.`);
}

async function createSessionManagerFromConfig(
	config: Args,
	cwd: string,
	sessionDir: string,
	mode: "interactive" | "print" | "json" | "rpc" | "autonomous",
	useCrossProjectResumePicker: boolean,
): Promise<SessionManager | null> {
	if (config.noSession) {
		return SessionManager.inMemory(cwd);
	}
	if (config.session) {
		const sessionPath = await resolveSessionReference(config.session, cwd, sessionDir, useCrossProjectResumePicker);
		return SessionManager.open(sessionPath, sessionDir);
	}
	if (config.fork) {
		const sourcePath = await resolveSessionReference(config.fork, cwd, sessionDir, useCrossProjectResumePicker);
		return SessionManager.forkFrom(sourcePath, cwd, sessionDir);
	}
	if (config.resume) {
		if (mode !== "interactive") {
			throw new Error("--resume requires interactive mode.");
		}
		const currentSessionsLoader = (onProgress?: Parameters<typeof SessionManager.list>[2]) =>
			SessionManager.list(cwd, sessionDir, onProgress);
		const allSessionsLoader = useCrossProjectResumePicker
			? (onProgress?: Parameters<typeof SessionManager.listAll>[0]) => SessionManager.listAll(onProgress)
			: currentSessionsLoader;
		const selectedSession = await selectSession(currentSessionsLoader, allSessionsLoader);
		if (!selectedSession) {
			return null;
		}
		return SessionManager.open(selectedSession, sessionDir);
	}
	if (config.continue) {
		return SessionManager.continueRecent(cwd, sessionDir);
	}
	return SessionManager.create(cwd, sessionDir);
}

function finishMain(
	deferNonInteractiveHelp: boolean,
	options?: { exitCode?: number; printDeferredHelp?: boolean },
): void {
	if (options?.exitCode !== undefined) {
		process.exitCode = options.exitCode;
	}
	if (options?.printDeferredHelp) {
		printHelp("stderr");
	}
	if (deferNonInteractiveHelp) {
		restoreStdout();
	}
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
	const args = argv;
	if (await handleConfigCommand(args)) {
		return;
	}
	if (await handlePackageCommand(args)) {
		return;
	}
	const stdinIsTTY = process.stdin.isTTY ?? true;
	const config = parseArgs(args);
	const requestedMode = resolveRequestedMode(config, stdinIsTTY);
	const wantsHelp = config.help === true;
	const deferNonInteractiveHelp = wantsHelp && requestedMode !== "interactive";
	const startupLog = requestedMode === "interactive" ? () => {} : console.error;
	const startupWarn = requestedMode === "interactive" ? () => {} : console.error;

	if (deferNonInteractiveHelp) {
		takeOverStdout();
	}

	if (emitArgDiagnostics(config)) {
		finishMain(deferNonInteractiveHelp, { exitCode: 1 });
		return;
	}

	if (wantsHelp && !deferNonInteractiveHelp) {
		printHelp("stdout");
		return;
	}
	if (config.version) {
		printVersion();
		return;
	}
	const modeFlagError = validateModeFlags(config);
	if (modeFlagError) {
		console.error(modeFlagError);
		finishMain(deferNonInteractiveHelp, { exitCode: 1 });
		return;
	}
	const toolFlagError = validateToolFlags(config);
	if (toolFlagError) {
		console.error(toolFlagError);
		finishMain(deferNonInteractiveHelp, { exitCode: 1 });
		return;
	}
	const sessionFlagError = validateSessionFlags(config, requestedMode);
	if (sessionFlagError) {
		console.error(sessionFlagError);
		finishMain(deferNonInteractiveHelp, { exitCode: 1 });
		return;
	}
	if (deferNonInteractiveHelp) {
		finishMain(true, { printDeferredHelp: true });
		return;
	}

	const cwd = config.cwd ? resolve(config.cwd) : process.cwd();
	const agentDir = config.agentDir ? resolve(config.agentDir) : getAgentDir();
	const { modelsPath } = await prepareStartupModelsFile({
		agentDir,
		startupLog,
		startupWarn,
	});

	const settingsManager = SettingsManager.create(cwd, agentDir);
	const sessionDir = resolveSessionStorageDir(cwd, agentDir, settingsManager, config);
	const authStorage = AuthStorage.create(resolve(agentDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, modelsPath);
	if (config.listModels) {
		await listModelsCmd(modelRegistry, config.listModels);
		return;
	}

	let resolvedModel: Model<Api>;
	try {
		({ model: resolvedModel } = await resolveModel(config.model, config.provider, modelRegistry, settingsManager));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		finishMain(deferNonInteractiveHelp, { exitCode: 1 });
		return;
	}

	const sessionManager = await createSessionManagerFromConfig(
		config,
		cwd,
		sessionDir,
		requestedMode,
		config.sessionDir === undefined && settingsManager.getSessionDir() === undefined,
	);
	if (!sessionManager) {
		finishMain(deferNonInteractiveHelp);
		return;
	}

	const { selectedToolNames, extensionFlagValues, resourceLoaderOptions } = buildRuntimeCliOptions(config, cwd);

	// Runtime creation: use AG1's built-in tools only. No custom tools for MVP.
	const createRuntimeFn: CreateAgentSessionRuntimeFactory = async ({
		cwd: rCwd,
		agentDir: rAgentDir,
		sessionManager: rSessionManager,
		sessionStartEvent,
	}) => {
		const services = await createAgentSessionServices({
			cwd: rCwd,
			agentDir: rAgentDir,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.create(rCwd, rAgentDir),
			extensionFlagValues,
			resourceLoaderOptions,
		});
		const existingSession = rSessionManager.buildSessionContext();
		const shouldUsePreferredModel = shouldUseRequestedStartupModel(existingSession);
		const requestedRuntimeModel = shouldUsePreferredModel
			? (await resolveModel(config.model, config.provider, services.modelRegistry, services.settingsManager)).model
			: undefined;
		const selectedTools =
			selectedToolNames === undefined
				? undefined
				: (() => {
						const availableTools = createAllTools(rCwd);
						return selectedToolNames.map((name) => availableTools[name]);
					})();
		const sessionResult = await createAgentSessionFromServices({
			services,
			sessionManager: rSessionManager,
			model: requestedRuntimeModel,
			tools: selectedTools,
			sessionStartEvent,
		});
		enforceRequestedStartupModel(sessionResult.session, requestedRuntimeModel);
		return {
			session: sessionResult.session,
			services,
			diagnostics: [...services.diagnostics],
			modelFallbackMessage: sessionResult.modelFallbackMessage,
			extensionsResult: sessionResult.extensionsResult,
		};
	};

	const runtime = await createAgentSessionRuntime(createRuntimeFn, { cwd, agentDir, sessionManager });
	await enforceExplicitRuntimeModel(runtime.session, resolvedModel, Boolean(config.model || config.provider));

	// Determine mode: interactive (default), print, json, or rpc
	// Autonomous execution is primarily a keyboard-toggled TUI mode. The
	// optional --auto flag only changes the startup state for the first prompt.
	const mode = requestedMode;

	if (mode === "print" || mode === "json" || mode === "rpc") {
		runtime.session.setActiveToolsByName(
			filterHeadlessActiveToolNames(
				runtime.session.getActiveToolNames(),
				runtime.session.getAllTools().map((tool) => tool.name),
			),
		);
	}

	// Headless modes cannot surface interactive approvals, so mutating tool calls
	// are blocked there by default. Interactive mode rebinds the policy after the
	// TUI starts so it can ask the user before write/edit/bash execution.
	if (mode !== "interactive") {
		runtime.session.setToolSafetyPolicy({
			mode: mode === "autonomous" ? "autonomous" : "headless",
			cwd: runtime.session.sessionManager.getCwd(),
		});
	}

	const startupInput = await prepareStartupInput(config, await readPipedStdin(stdinIsTTY), cwd);

	if (mode === "interactive") {
		initTheme(settingsManager.getTheme(), false);
		const interactiveMode = new InteractiveMode(runtime, {
			initialMessage: startupInput.initialMessage,
			migratedProviders: [],
			modelFallbackMessage: runtime.modelFallbackMessage,
			autonomousConfig: {
				startInAutonomousMode: config.auto ?? false,
				maxCostUsd: config.maxCost ?? 0,
				maxTokens: config.maxTokens ?? 0,
				maxTurns: config.maxTurns ?? 100,
				maxOutputPerTurn: config.maxOutput ?? 0,
				enableNudges: config.enableNudges,
				enableBehavioralPrompt: config.enableBehavioralPrompt,
				verbose: config.verbose,
			},
		});

		// Override terminal title: π → Auton
		const origUpdateTitle = (interactiveMode as any).updateTerminalTitle?.bind(interactiveMode);
		if (origUpdateTitle) {
			(interactiveMode as any).updateTerminalTitle = function () {
				const session = this.sessionManager;
				const cwdBasename = basename(session.getCwd());
				const sessionName = session.getSessionName();
				this.ui.terminal.setTitle(
					sessionName ? `Auton - ${sessionName} - ${cwdBasename}` : `Auton - ${cwdBasename}`,
				);
			};
			(interactiveMode as any).updateTerminalTitle();
		}

		await interactiveMode.run();
	} else if (mode === "autonomous") {
		const autonomousGoal = [startupInput.initialMessage, ...startupInput.remainingMessages]
			.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
			.join("\n\n");
		if (!autonomousGoal.trim()) {
			console.error("--autonomous requires a prompt or piped input.");
			process.exitCode = 1;
			return;
		}
		if ((startupInput.initialImages?.length ?? 0) > 0) {
			console.error("--autonomous does not yet support image attachments.");
			process.exitCode = 1;
			return;
		}
		process.exitCode = await runAutonomousMode(runtime, {
			goal: autonomousGoal,
			autonConfig: {
				maxCost: config.maxCost ?? 0,
				maxTokens: config.maxTokens ?? 0,
				maxTurns: config.maxTurns ?? 100,
				enableNudges: config.enableNudges,
				enableBehavioralPrompt: config.enableBehavioralPrompt,
				verbose: config.verbose,
			},
			cwd,
		});
	} else if (mode === "print") {
		process.exitCode = await runPrintMode(runtime, {
			mode: "text",
			initialMessage: startupInput.initialMessage,
			initialImages: startupInput.initialImages,
			messages: startupInput.remainingMessages,
		});
	} else if (mode === "json") {
		process.exitCode = await runPrintMode(runtime, {
			mode: "json",
			initialMessage: startupInput.initialMessage,
			initialImages: startupInput.initialImages,
			messages: startupInput.remainingMessages,
		});
	} else if (mode === "rpc") {
		await runRpcMode(runtime);
	}
}
