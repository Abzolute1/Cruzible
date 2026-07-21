/**
 * Extension loader - loads TypeScript extension modules using jiti.
 *
 * Uses @mariozechner/jiti fork with virtualModules support for compiled Bun binaries.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as _bundledPiAgentCore from "@ag1/agent-core";
import * as _bundledPiAi from "@ag1/ai";
import * as _bundledPiAiOauth from "@ag1/ai/oauth";
import type { KeyId } from "@ag1/tui";
import * as _bundledPiTui from "@ag1/tui";
import { createJiti } from "@mariozechner/jiti";
// Static imports of packages that extensions may use.
// These MUST be static so Bun bundles them into the compiled binary.
// The virtualModules option then makes them available to extensions.
import * as _bundledTypebox from "@sinclair/typebox";
import { getAgentDir, getProjectConfigDir, isBunBinary } from "../../config.js";
// NOTE: This import works because loader.ts exports are NOT re-exported from index.ts,
// avoiding a circular dependency. Extensions can import from @ag1/coding-agent.
import * as _bundledPiCodingAgent from "../../index.js";
import { createEventBus, type EventBus } from "../event-bus.js";
import type { ExecOptions } from "../exec.js";
import { execCommand } from "../exec.js";
import { isStdoutTakenOver } from "../output-guard.js";
import { SettingsManager } from "../settings-manager.js";
import { createSyntheticSourceInfo } from "../source-info.js";
import type {
	Extension,
	ExtensionAPI,
	ExtensionFactory,
	ExtensionRuntime,
	LoadExtensionsResult,
	MessageRenderer,
	ProjectTrustPrompt,
	ProviderConfig,
	RegisteredCommand,
	ToolDefinition,
} from "./types.js";

// Re-exported to preserve this module's public surface (the types live in types.js).
export type { LoadExtensionsResult, ProjectTrustPrompt } from "./types.js";

/** Modules available to extensions via virtualModules (for compiled Bun binary) */
const VIRTUAL_MODULES: Record<string, unknown> = {
	"@sinclair/typebox": _bundledTypebox,
	"@ag1/agent-core": _bundledPiAgentCore,
	"@ag1/tui": _bundledPiTui,
	"@ag1/ai": _bundledPiAi,
	"@ag1/ai/oauth": _bundledPiAiOauth,
	"@ag1/coding-agent": _bundledPiCodingAgent,
};

const require = createRequire(import.meta.url);

/**
 * Get aliases for jiti (used in Node.js/development mode).
 * In Bun binary mode, virtualModules is used instead.
 */
let _aliases: Record<string, string> | null = null;
function getAliases(): Record<string, string> {
	if (_aliases) return _aliases;

	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	const packageIndex = path.resolve(__dirname, "../..", "index.js");

	const typeboxEntry = require.resolve("@sinclair/typebox");
	const typeboxRoot = typeboxEntry.replace(/[\\/]build[\\/]cjs[\\/]index\.js$/, "");

	const packagesRoot = path.resolve(__dirname, "../../../../");
	const resolveWorkspaceOrImport = (workspaceRelativePath: string, specifier: string): string => {
		const workspacePath = path.join(packagesRoot, workspaceRelativePath);
		if (fs.existsSync(workspacePath)) {
			return workspacePath;
		}
		return fileURLToPath(import.meta.resolve(specifier));
	};

	_aliases = {
		"@ag1/coding-agent": packageIndex,
		"@ag1/agent-core": resolveWorkspaceOrImport("agent/dist/index.js", "@ag1/agent-core"),
		"@ag1/tui": resolveWorkspaceOrImport("tui/dist/index.js", "@ag1/tui"),
		"@ag1/ai": resolveWorkspaceOrImport("ai/dist/index.js", "@ag1/ai"),
		"@ag1/ai/oauth": resolveWorkspaceOrImport("ai/dist/oauth.js", "@ag1/ai/oauth"),
		"@sinclair/typebox": typeboxRoot,
	};

	return _aliases;
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

function expandPath(p: string): string {
	const normalized = normalizeUnicodeSpaces(p);
	if (normalized.startsWith("~/")) {
		return path.join(os.homedir(), normalized.slice(2));
	}
	if (normalized.startsWith("~")) {
		return path.join(os.homedir(), normalized.slice(1));
	}
	return normalized;
}

function resolvePath(extPath: string, cwd: string): string {
	const expanded = expandPath(extPath);
	if (path.isAbsolute(expanded)) {
		return expanded;
	}
	return path.resolve(cwd, expanded);
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

/**
 * Create a runtime with throwing stubs for action methods.
 * Runner.bindCore() replaces these with real implementations.
 */
export function createExtensionRuntime(): ExtensionRuntime {
	const notInitialized = () => {
		throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	};

	const runtime: ExtensionRuntime = {
		sendMessage: notInitialized,
		sendUserMessage: notInitialized,
		appendEntry: notInitialized,
		setSessionName: notInitialized,
		getSessionName: notInitialized,
		setLabel: notInitialized,
		getActiveTools: notInitialized,
		getAllTools: notInitialized,
		setActiveTools: notInitialized,
		// registerTool() is valid during extension load; refresh is only needed post-bind.
		refreshTools: () => {},
		getCommands: notInitialized,
		setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
		getThinkingLevel: notInitialized,
		setThinkingLevel: notInitialized,
		flagValues: new Map(),
		pendingProviderRegistrations: [],
		// Pre-bind: queue registrations so bindCore() can flush them once the
		// model registry is available. bindCore() replaces both with direct calls.
		registerProvider: (name, config, extensionPath = "<unknown>") => {
			runtime.pendingProviderRegistrations.push({ name, config, extensionPath });
		},
		unregisterProvider: (name) => {
			runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((r) => r.name !== name);
		},
	};

	return runtime;
}

/**
 * Create the ExtensionAPI for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
function createExtensionAPI(
	extension: Extension,
	runtime: ExtensionRuntime,
	cwd: string,
	eventBus: EventBus,
): ExtensionAPI {
	const api = {
		// Registration methods - write to extension
		on(event: string, handler: HandlerFn): void {
			const list = extension.handlers.get(event) ?? [];
			list.push(handler);
			extension.handlers.set(event, list);
		},

		registerTool(tool: ToolDefinition): void {
			extension.tools.set(tool.name, {
				definition: tool,
				sourceInfo: extension.sourceInfo,
			});
			runtime.refreshTools();
		},

		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
			extension.commands.set(name, {
				name,
				sourceInfo: extension.sourceInfo,
				...options,
			});
		},

		registerShortcut(
			shortcut: KeyId,
			options: {
				description?: string;
				handler: (ctx: import("./types.js").ExtensionContext) => Promise<void> | void;
			},
		): void {
			extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
		},

		registerFlag(
			name: string,
			options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
		): void {
			extension.flags.set(name, { name, extensionPath: extension.path, ...options });
			if (options.default !== undefined && !runtime.flagValues.has(name)) {
				runtime.flagValues.set(name, options.default);
			}
		},

		registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
			extension.messageRenderers.set(customType, renderer as MessageRenderer);
		},

		// Flag access - checks extension registered it, reads from runtime
		getFlag(name: string): boolean | string | undefined {
			if (!extension.flags.has(name)) return undefined;
			return runtime.flagValues.get(name);
		},

		// Action methods - delegate to shared runtime
		sendMessage(message, options): void {
			runtime.sendMessage(message, options);
		},

		sendUserMessage(content, options): void {
			runtime.sendUserMessage(content, options);
		},

		appendEntry(customType: string, data?: unknown): void {
			runtime.appendEntry(customType, data);
		},

		setSessionName(name: string): void {
			runtime.setSessionName(name);
		},

		getSessionName(): string | undefined {
			return runtime.getSessionName();
		},

		setLabel(entryId: string, label: string | undefined): void {
			runtime.setLabel(entryId, label);
		},

		exec(command: string, args: string[], options?: ExecOptions) {
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},

		getActiveTools(): string[] {
			return runtime.getActiveTools();
		},

		getAllTools() {
			return runtime.getAllTools();
		},

		setActiveTools(toolNames: string[]): void {
			runtime.setActiveTools(toolNames);
		},

		getCommands() {
			return runtime.getCommands();
		},

		setModel(model) {
			return runtime.setModel(model);
		},

		getThinkingLevel() {
			return runtime.getThinkingLevel();
		},

		setThinkingLevel(level) {
			runtime.setThinkingLevel(level);
		},

		registerProvider(name: string, config: ProviderConfig) {
			runtime.registerProvider(name, config, extension.path);
		},

		unregisterProvider(name: string) {
			runtime.unregisterProvider(name, extension.path);
		},

		events: eventBus,
	} as ExtensionAPI;

	return api;
}

async function loadExtensionModule(extensionPath: string) {
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		// In Bun binary: use virtualModules for bundled packages (no filesystem resolution)
		// Also disable tryNative so jiti handles ALL imports (not just the entry point)
		// In Node.js/dev: use aliases to resolve to node_modules paths
		...(isBunBinary ? { virtualModules: VIRTUAL_MODULES, tryNative: false } : { alias: getAliases() }),
	});

	const module = await jiti.import(extensionPath, { default: true });
	const factory = module as ExtensionFactory;
	return typeof factory !== "function" ? undefined : factory;
}

/**
 * Create an Extension object with empty collections.
 */
function createExtension(extensionPath: string, resolvedPath: string): Extension {
	const source =
		extensionPath.startsWith("<") && extensionPath.endsWith(">")
			? extensionPath.slice(1, -1).split(":")[0] || "temporary"
			: "local";
	const baseDir = extensionPath.startsWith("<") ? undefined : path.dirname(resolvedPath);

	return {
		path: extensionPath,
		resolvedPath,
		sourceInfo: createSyntheticSourceInfo(extensionPath, { source, baseDir }),
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

async function loadExtension(
	extensionPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
): Promise<{ extension: Extension | null; error: string | null }> {
	const resolvedPath = resolvePath(extensionPath, cwd);

	try {
		const factory = await loadExtensionModule(resolvedPath);
		if (!factory) {
			return { extension: null, error: `Extension does not export a valid factory function: ${extensionPath}` };
		}

		const extension = createExtension(extensionPath, resolvedPath);
		const api = createExtensionAPI(extension, runtime, cwd, eventBus);
		await factory(api);

		return { extension, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * Create an Extension from an inline factory function.
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	extensionPath = "<inline>",
): Promise<Extension> {
	const extension = createExtension(extensionPath, extensionPath);
	const api = createExtensionAPI(extension, runtime, cwd, eventBus);
	await factory(api);
	return extension;
}

/**
 * Workspace trust gate for PROJECT-local extensions.
 *
 * Everything under the project config dir (e.g. <cwd>/.ag1) is attacker-controlled
 * when a repo is cloned, so extensions living there only execute when the project
 * is trusted. Trust is resolved in order:
 * 1. explicit option (SDK callers/tests),
 * 2. AG1_TRUST_PROJECT env override (1/true/yes = force-trust, 0/false/no = force-disable),
 * 3. trustedProjects in the USER settings (never project settings — those ship with the repo).
 *
 * Global extensions (user agentDir) and explicitly configured CLI paths are unaffected.
 * Untrusted project extensions are skipped with a warning (never auto-executed, never
 * prompted from here); interactive mode consumes LoadExtensionsResult.pendingTrustPrompt
 * to ask the user once — on accept it calls trustProject() and reloads, on decline the
 * extensions stay skipped.
 */
export interface LoadExtensionsOptions {
	/** Explicit workspace-trust override for project-local extensions */
	trustProject?: boolean;
	/** Agent dir used to look up trusted projects in user settings (defaults to getAgentDir()) */
	agentDir?: string;
}

function getEnvProjectTrust(): boolean | undefined {
	const value = process.env.AG1_TRUST_PROJECT;
	if (!value) return undefined;
	const normalized = value.toLowerCase();
	if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
	if (normalized === "0" || normalized === "false" || normalized === "no") return false;
	return undefined;
}

function isPathWithin(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isProjectTrusted(cwd: string, agentDir: string, projectConfigDir: string, explicitTrust?: boolean): boolean {
	if (explicitTrust !== undefined) return explicitTrust;
	const envTrust = getEnvProjectTrust();
	if (envTrust !== undefined) return envTrust;
	try {
		return SettingsManager.create(cwd, agentDir).isProjectTrusted(projectConfigDir);
	} catch {
		return false;
	}
}

/** Record a project config dir as trusted in the USER settings (workspace trust). */
export async function trustProject(
	projectConfigDir: string,
	cwd: string = process.cwd(),
	agentDir: string = getAgentDir(),
): Promise<void> {
	const settingsManager = SettingsManager.create(cwd, agentDir);
	settingsManager.addTrustedProject(projectConfigDir);
	// Settings writes are queued asynchronously; flush so a reload right after
	// trusting actually sees the project as trusted.
	await settingsManager.flush();
}

/**
 * Load extensions from paths.
 */
export async function loadExtensions(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	options?: LoadExtensionsOptions,
): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedEventBus = eventBus ?? createEventBus();
	const runtime = createExtensionRuntime();

	let pathsToLoad = paths;
	let pendingTrustPrompt: ProjectTrustPrompt | undefined;
	const projectConfigDir = getProjectConfigDir(cwd);
	const projectLocalPaths = paths.filter((p) => isPathWithin(resolvePath(p, cwd), projectConfigDir));
	if (
		projectLocalPaths.length > 0 &&
		!isProjectTrusted(cwd, options?.agentDir ?? getAgentDir(), projectConfigDir, options?.trustProject)
	) {
		const skipped = new Set(projectLocalPaths);
		pathsToLoad = paths.filter((p) => !skipped.has(p));
		pendingTrustPrompt = { projectConfigDir, extensionPaths: projectLocalPaths };
		const warning =
			`Skipped ${projectLocalPaths.length} project-local extension(s) under ${projectConfigDir}: ` +
			"project is not trusted. Trust the project in interactive mode, add it to trustedProjects " +
			"in user settings, or set AG1_TRUST_PROJECT=1 to load project extensions.";
		errors.push({ path: projectConfigDir, error: warning });
		if (!isStdoutTakenOver()) {
			console.error(`Warning: ${warning}`);
		}
	}

	for (const extPath of pathsToLoad) {
		const { extension, error } = await loadExtension(extPath, cwd, resolvedEventBus, runtime);

		if (error) {
			errors.push({ path: extPath, error });
			continue;
		}

		if (extension) {
			extensions.push(extension);
		}
	}

	return {
		extensions,
		errors,
		runtime,
		...(pendingTrustPrompt ? { pendingTrustPrompt } : {}),
	};
}

interface Ag1Manifest {
	extensions?: string[];
	themes?: string[];
	skills?: string[];
	prompts?: string[];
}

type LoaderDiagnostic = { path: string; error: string };

function readAg1Manifest(packageJsonPath: string): { manifest: Ag1Manifest | null; error: string | null } {
	try {
		const content = fs.readFileSync(packageJsonPath, "utf-8");
		const pkg = JSON.parse(content);
		if (pkg.ag1 && typeof pkg.ag1 === "object") {
			return { manifest: pkg.ag1 as Ag1Manifest, error: null };
		}
		return { manifest: null, error: null };
	} catch (error) {
		// A malformed package.json silently disabling a package's extensions is
		// confusing; surface it as a loader diagnostic instead of returning null.
		return { manifest: null, error: error instanceof Error ? error.message : String(error) };
	}
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Resolve extension entry points from a directory.
 *
 * Checks for:
 * 1. package.json with "ag1.extensions" field -> returns declared paths
 * 2. index.ts or index.js -> returns the index file
 *
 * Returns resolved paths or null if no entry points found.
 */
function resolveExtensionEntries(dir: string, diagnostics?: LoaderDiagnostic[]): string[] | null {
	// Check for package.json with "ag1" field first
	const packageJsonPath = path.join(dir, "package.json");
	if (fs.existsSync(packageJsonPath)) {
		const { manifest, error } = readAg1Manifest(packageJsonPath);
		if (error) {
			diagnostics?.push({ path: packageJsonPath, error: `Failed to parse extension manifest: ${error}` });
		}
		if (manifest?.extensions?.length) {
			const entries: string[] = [];
			for (const extPath of manifest.extensions) {
				const resolvedExtPath = path.resolve(dir, extPath);
				if (fs.existsSync(resolvedExtPath)) {
					entries.push(resolvedExtPath);
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	// Check for index.ts or index.js
	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	if (fs.existsSync(indexTs)) {
		return [indexTs];
	}
	if (fs.existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/* /index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/* /package.json` with "ag1" field -> load what it declares
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
function discoverExtensionsInDir(dir: string, diagnostics?: LoaderDiagnostic[]): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}

	const discovered: string[] = [];

	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);

			// 1. Direct files: *.ts or *.js
			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				discovered.push(entryPath);
				continue;
			}

			// 2 & 3. Subdirectories
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				const entries = resolveExtensionEntries(entryPath, diagnostics);
				if (entries) {
					discovered.push(...entries);
				}
			}
		}
	} catch (error) {
		diagnostics?.push({
			path: dir,
			error: `Failed to read extensions directory: ${error instanceof Error ? error.message : String(error)}`,
		});
		return [];
	}

	return discovered;
}

/**
 * Discover and load extensions from standard locations.
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	agentDir: string = getAgentDir(),
	eventBus?: EventBus,
	options?: LoadExtensionsOptions,
): Promise<LoadExtensionsResult> {
	const allPaths: string[] = [];
	const seen = new Set<string>();
	const discoveryDiagnostics: LoaderDiagnostic[] = [];

	const addPaths = (paths: string[]) => {
		for (const p of paths) {
			const resolved = path.resolve(p);
			if (!seen.has(resolved)) {
				seen.add(resolved);
				allPaths.push(p);
			}
		}
	};

	// 1. Project-local extensions: cwd/<configDir>/extensions/ (with legacy fallback)
	const localExtDir = path.join(getProjectConfigDir(cwd), "extensions");
	addPaths(discoverExtensionsInDir(localExtDir, discoveryDiagnostics));

	// 2. Global extensions: agentDir/extensions/
	const globalExtDir = path.join(agentDir, "extensions");
	addPaths(discoverExtensionsInDir(globalExtDir, discoveryDiagnostics));

	// 3. Explicitly configured paths
	for (const p of configuredPaths) {
		const resolved = resolvePath(p, cwd);
		if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
			// Check for package.json with AG1 manifest or index.ts
			const entries = resolveExtensionEntries(resolved, discoveryDiagnostics);
			if (entries) {
				addPaths(entries);
				continue;
			}
			// No explicit entries - discover individual files in directory
			addPaths(discoverExtensionsInDir(resolved, discoveryDiagnostics));
			continue;
		}

		addPaths([resolved]);
	}

	const result = await loadExtensions(allPaths, cwd, eventBus, { ...options, agentDir });
	result.errors.push(...discoveryDiagnostics);
	return result;
}
