import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { SessionManager } from "../../src/core/session-manager.js";
import type {
	AssistantMessage,
	ExtensionAPI,
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionStartEvent,
} from "../../src/index.js";

type RecordedSessionEvent = SessionBeforeSwitchEvent | SessionBeforeForkEvent | SessionStartEvent;

describe("AgentSessionRuntime characterization", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
		process.chdir(tmpdir());
	});

	async function createRuntimeForTest(
		extensionFactory: ExtensionFactory,
		options?: { cwd?: string; bootstrapModel?: boolean; bootstrapThinkingLevel?: boolean },
	) {
		const tempDir =
			options?.cwd ?? join(tmpdir(), `pi-runtime-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: options?.bootstrapModel === false ? undefined : faux.getModel(),
			thinkingLevel: options?.bootstrapThinkingLevel === false ? undefined : undefined,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
						extensionFactory(pi);
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: runtimeOptions.model,
					thinkingLevel: runtimeOptions.thinkingLevel,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await runtime.session.bindExtensions({});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtime, faux, tempDir };
	}

	function createRetryableErrorMessage(session: { model: { api: string; provider: string; id: string } }): AssistantMessage {
		return {
			role: "assistant",
			content: [],
			api: session.model.api,
			provider: session.model.provider,
			model: session.model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "overloaded_error",
			timestamp: Date.now(),
		};
	}

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile;
		const originalSession = runtime.session;

		const newSessionResult = await runtime.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(runtime.session).not.toBe(originalSession);
		expect(runtime.session.messages).toEqual([]);
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;
		const secondSessionFile = runtime.session.sessionFile;

		const switchResult = await runtime.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("honors session_before_switch cancellation for new and resume", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelReason: "new" | "resume" | undefined;
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
				if (event.reason === cancelReason) {
					return { cancel: true };
				}
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile;

		cancelReason = "new";
		const newResult = await runtime.newSession();
		expect(newResult.cancelled).toBe(true);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);

		events.length = 0;
		const otherDir = join(tmpdir(), `pi-runtime-other-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(otherDir, { recursive: true });
		const otherSession = SessionManager.create(otherDir);
		otherSession.appendMessage({ role: "user", content: [{ type: "text", text: "other" }], timestamp: Date.now() });
		const otherSessionFile = otherSession.getSessionFile();
		cancelReason = "resume";
		const resumeResult = await runtime.switchSession(otherSessionFile!);
		expect(resumeResult.cancelled).toBe(true);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		events.length = 0;
		await runtime.session.prompt("hello");
		const userMessage = runtime.session.getUserMessagesForForking()[0]!;
		const previousSessionFile = runtime.session.sessionFile;

		const successResult = await runtime.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtime.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId }]);
	});

	it("throws when forking with an invalid entry id", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await expect(runtime.fork("missing-entry")).rejects.toThrow("Invalid entry ID for forking");
	});

	it("updates process.cwd() on cross-cwd session replacement", async () => {
		const firstDir = join(tmpdir(), `pi-runtime-cwd-a-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const secondDir = join(tmpdir(), `pi-runtime-cwd-b-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(firstDir, { recursive: true });
		mkdirSync(secondDir, { recursive: true });
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, { cwd: firstDir });
		const otherAuthStorage = AuthStorage.inMemory();
		otherAuthStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const otherRuntimeOptions = {
			agentDir: tempDir,
			authStorage: otherAuthStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createOtherRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				...otherRuntimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const otherRuntime = await createAgentSessionRuntime(createOtherRuntime, {
			cwd: secondDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(secondDir),
		});
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.prompt("other");
		const otherSessionFile = otherRuntime.session.sessionFile!;

		await runtime.switchSession(otherSessionFile);

		expect(realpathSync(process.cwd())).toBe(realpathSync(secondDir));
		expect(realpathSync(runtime.session.sessionManager.getCwd())).toBe(realpathSync(secondDir));
	});

	it("restores model and thinking state from the destination session", async () => {
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, {
			bootstrapModel: false,
			bootstrapThinkingLevel: false,
		});
		const otherDir = join(tempDir, "other");
		mkdirSync(otherDir, { recursive: true });
		const otherAuthStorage = AuthStorage.inMemory();
		otherAuthStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const otherRuntimeOptions = {
			agentDir: tempDir,
			authStorage: otherAuthStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createOtherRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				...otherRuntimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const otherRuntime = await createAgentSessionRuntime(createOtherRuntime, {
			cwd: otherDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(otherDir),
		});
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.setModel(faux.getModel("faux-2")!);
		otherRuntime.session.setThinkingLevel("off");
		await otherRuntime.session.prompt("hello");
		const targetSessionFile = otherRuntime.session.sessionFile!;

		await runtime.switchSession(targetSessionFile);

		expect(runtime.session.model?.id).toBe("faux-2");
		expect(runtime.session.thinkingLevel).toBe("off");
	});

	it("can keep the currently selected model across a new session when the runtime factory tracks it", async () => {
		const { faux, tempDir } = await createRuntimeForTest(() => {});
		let preferredRuntimeModel: any = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const createTrackedRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				agentDir: tempDir,
				authStorage,
				cwd,
				resourceLoaderOptions: {
					extensionFactories: [
						(pi: ExtensionAPI) => {
							pi.registerProvider(faux.getModel().provider, {
								baseUrl: faux.getModel().baseUrl,
								apiKey: "faux-key",
								api: faux.api,
								models: faux.models.map((registeredModel) => ({
									id: registeredModel.id,
									name: registeredModel.name,
									api: registeredModel.api,
									reasoning: registeredModel.reasoning,
									input: registeredModel.input,
									cost: registeredModel.cost,
									contextWindow: registeredModel.contextWindow,
									maxTokens: registeredModel.maxTokens,
								})),
							});
						},
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			const existingSession = sessionManager.buildSessionContext();
			const result = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: existingSession.messages.length === 0 && existingSession.model === undefined ? preferredRuntimeModel : undefined,
			});
			preferredRuntimeModel = result.session.model;
			return {
				...result,
				services,
				diagnostics: services.diagnostics,
			};
		};

		const trackedRuntime = await createAgentSessionRuntime(createTrackedRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		cleanups.push(async () => {
			await trackedRuntime.dispose();
		});

		await trackedRuntime.session.setModel(faux.getModel("faux-2")!);
		expect(trackedRuntime.session.model?.id).toBe("faux-2");

		await trackedRuntime.newSession();

		expect(trackedRuntime.session.model?.id).toBe("faux-2");
	});

	it("preserves the current thinking level across a new session", async () => {
		const { runtime } = await createRuntimeForTest(() => {});

		runtime.session.setThinkingLevel("high");
		expect(runtime.session.thinkingLevel).toBe("high");

		await runtime.newSession();

		expect(runtime.session.model?.id).toBe("faux-1");
		expect(runtime.session.thinkingLevel).toBe("high");
	});

	it("preserves the current runtime if preparing a replacement runtime fails", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const originalSession = runtime.session;
		const originalSessionFile = runtime.session.sessionFile;
		const disposeSpy = vi.spyOn(originalSession, "dispose");

		let failNext = false;
		const createRuntime = runtime["createRuntime"] as CreateAgentSessionRuntimeFactory;
		runtime["createRuntime"] = (async (options) => {
			if (failNext && options.sessionStartEvent?.reason === "new") {
				throw new Error("prepare replacement failed");
			}
			return createRuntime(options);
		}) as CreateAgentSessionRuntimeFactory;

		failNext = true;
		await expect(runtime.newSession()).rejects.toThrow("prepare replacement failed");

		expect(runtime.session).toBe(originalSession);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);
		expect(disposeSpy).not.toHaveBeenCalled();
	});

	it("disposes a prepared replacement runtime if teardown of the current runtime fails", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const originalSession = runtime.session;
		const originalDispose = runtime.session.dispose.bind(runtime.session);
		const originalSessionFile = runtime.session.sessionFile;

		let preparedSessionDisposeSpy: ReturnType<typeof vi.spyOn> | undefined;
		const createRuntime = runtime["createRuntime"] as CreateAgentSessionRuntimeFactory;
		runtime["createRuntime"] = (async (options) => {
			const result = await createRuntime(options);
			if (options.sessionStartEvent?.reason === "new") {
				preparedSessionDisposeSpy = vi.spyOn(result.session, "dispose");
			}
			return result;
		}) as CreateAgentSessionRuntimeFactory;

		runtime.session.dispose = (() => {
			throw new Error("current teardown failed");
		}) as typeof runtime.session.dispose;

		await expect(runtime.newSession()).rejects.toThrow("current teardown failed");

		expect(runtime.session).toBe(originalSession);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);
		expect(preparedSessionDisposeSpy).toBeDefined();
		expect(preparedSessionDisposeSpy).toHaveBeenCalledTimes(1);

		runtime.session.dispose = originalDispose as typeof runtime.session.dispose;
	});

	it("cancels a pending retry replay when newSession replaces the runtime", async () => {
		vi.useFakeTimers();
		try {
			const { runtime } = await createRuntimeForTest(() => {});
			const oldSession = runtime.session;
			const errorMessage = createRetryableErrorMessage({ model: oldSession.model! });
			oldSession.agent.state.messages = [errorMessage];
			const continueSpy = vi.spyOn(oldSession.agent, "continue").mockResolvedValue();
			const handleRetryableError = (
				oldSession as unknown as {
					_handleRetryableError: (message: AssistantMessage) => Promise<boolean>;
				}
			)._handleRetryableError.bind(oldSession);

			const retryPromise = handleRetryableError(errorMessage);
			await runtime.newSession();
			await retryPromise;
			await vi.advanceTimersByTimeAsync(5_000);

			expect(runtime.session).not.toBe(oldSession);
			expect(continueSpy).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels a pending compaction replay when switchSession replaces the runtime", async () => {
		vi.useFakeTimers();
		try {
			const { runtime } = await createRuntimeForTest(() => {});
			await runtime.session.prompt("hello");
			const originalSessionFile = runtime.session.sessionFile!;

			await runtime.newSession();
			const oldSession = runtime.session;
			oldSession.agent.followUp({
				role: "custom",
				customType: "test",
				content: [{ type: "text", text: "Queued custom" }],
				display: false,
				timestamp: Date.now(),
			});
			const continueSpy = vi.spyOn(oldSession.agent, "continue").mockResolvedValue();
			const coordinator = (oldSession as any)._compactionCoordinator;
			coordinator.scheduleAutoContinue(100);

			await runtime.switchSession(originalSessionFile);
			await vi.advanceTimersByTimeAsync(500);

			expect(runtime.session).not.toBe(oldSession);
			expect(continueSpy).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
