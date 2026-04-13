import { basename, dirname } from "node:path";
import type {
	ExtensionCommandContextActions,
	ExtensionErrorListener,
	ExtensionRunner,
	ExtensionUIContext,
	SessionStartEvent,
	ShutdownHandler,
} from "./extensions/index.js";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.js";

export interface ExtensionLifecycleBindings {
	uiContext?: ExtensionUIContext;
	commandContextActions?: ExtensionCommandContextActions;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

export interface AgentSessionExtensionLifecycleCoordinatorOptions {
	getExtensionRunner: () => ExtensionRunner | undefined;
	getSessionStartEvent: () => SessionStartEvent;
	getCwd: () => string;
	getResourceLoader: () => ResourceLoader;
	getActiveToolNames: () => string[];
	rebuildSystemPrompt: (toolNames: string[]) => string;
	applySystemPrompt: (prompt: string) => void;
}

export class AgentSessionExtensionLifecycleCoordinator {
	private extensionUIContext?: ExtensionUIContext;
	private extensionCommandContextActions?: ExtensionCommandContextActions;
	private extensionShutdownHandler?: ShutdownHandler;
	private extensionErrorListener?: ExtensionErrorListener;
	private extensionErrorUnsubscriber?: () => void;

	constructor(private readonly options: AgentSessionExtensionLifecycleCoordinatorOptions) {}

	get uiContext(): ExtensionUIContext | undefined {
		return this.extensionUIContext;
	}

	get commandContextActions(): ExtensionCommandContextActions | undefined {
		return this.extensionCommandContextActions;
	}

	get shutdownHandler(): ShutdownHandler | undefined {
		return this.extensionShutdownHandler;
	}

	get errorListener(): ExtensionErrorListener | undefined {
		return this.extensionErrorListener;
	}

	applyBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this.extensionUIContext);
		runner.bindCommandContext(this.extensionCommandContextActions);

		this.extensionErrorUnsubscriber?.();
		this.extensionErrorUnsubscriber = this.extensionErrorListener
			? runner.onError(this.extensionErrorListener)
			: undefined;
	}

	async bindExtensions(bindings: ExtensionLifecycleBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this.extensionUIContext = bindings.uiContext;
		}
		if (bindings.commandContextActions !== undefined) {
			this.extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.shutdownHandler !== undefined) {
			this.extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this.extensionErrorListener = bindings.onError;
		}

		const runner = this.options.getExtensionRunner();
		if (!runner) {
			return;
		}

		this.applyBindings(runner);
		const sessionStartEvent = this.options.getSessionStartEvent();
		await runner.emit(sessionStartEvent);
		await this.extendResourcesFromExtensions(sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		const runner = this.options.getExtensionRunner();
		if (!runner?.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await runner.emitResourcesDiscover(this.options.getCwd(), reason);
		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this.options.getResourceLoader().extendResources(extensionPaths);
		this.options.applySystemPrompt(this.options.rebuildSystemPrompt(this.options.getActiveToolNames()));
	}

	dispose(): void {
		this.extensionErrorUnsubscriber?.();
		this.extensionErrorUnsubscriber = undefined;
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}
}
