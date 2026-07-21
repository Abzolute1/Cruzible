import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ImageContent } from "@ag1/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPrintMode } from "../src/modes/print-mode.js";

type EmitEvent = { type: string };

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionManager: {
		getHeader: () => object | undefined;
		getCwd: () => string;
		getSessionName: () => string | undefined;
		getSessionId: () => string;
		getEntries: () => Array<{ id: string; role: string }>;
	};
	agent: { waitForIdle: () => Promise<void> };
	state: { messages: AssistantMessage[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	sendCustomMessage: ReturnType<typeof vi.fn>;
	recoverXmlToolCallsNow?: ReturnType<typeof vi.fn>;
	abort?: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
	getActiveToolNames: () => string[];
	setActiveToolsByName: ReturnType<typeof vi.fn<(toolNames: string[]) => void>>;
	model: { provider: string; id: string };
	contextWindow: number;
	thinkingLevel: string;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
};

function createSubscriptionHarness() {
	const subscribers: Array<(event: { type: string; [key: string]: unknown }) => void> = [];
	return {
		subscribeImpl: vi.fn((callback: (event: { type: string; [key: string]: unknown }) => void) => {
			subscribers.push(callback);
			return () => {
				const index = subscribers.indexOf(callback);
				if (index >= 0) subscribers.splice(index, 1);
			};
		}),
		emit(event: { type: string; [key: string]: unknown }) {
			for (const subscriber of [...subscribers]) {
				subscriber(event);
			}
		},
	};
}

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createRuntimeHost(
	assistantMessage: AssistantMessage,
	cwd: string,
	options?: {
		promptImpl?: FakeSession["prompt"];
		subscribeImpl?: FakeSession["subscribe"];
	},
): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [assistantMessage] };
	let activeToolNames = ["read", "webSearch", "grep", "find", "ls"];

	const session: FakeSession = {
		sessionManager: {
			getHeader: () => undefined,
			getCwd: () => cwd,
			getSessionName: () => undefined,
			getSessionId: () => "session-print-mode",
			getEntries: () => [],
		},
		agent: { waitForIdle: async () => {} },
		state,
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: options?.subscribeImpl ?? vi.fn(() => () => {}),
		prompt: options?.promptImpl ?? vi.fn(async () => {}),
		sendCustomMessage: vi.fn(async () => {}),
		recoverXmlToolCallsNow: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
		getActiveToolNames: () => [...activeToolNames],
		setActiveToolsByName: vi.fn((toolNames: string[]) => {
			activeToolNames = [...toolNames];
		}),
		model: { provider: assistantMessage.provider, id: assistantMessage.model },
		contextWindow: 50_000,
		thinkingLevel: "off",
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown" });
		}),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runPrintMode", () => {
	it("emits session_shutdown in text mode", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "ag1-print-mode-"));
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }), cwd);
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.sendCustomMessage).not.toHaveBeenCalled();
		expect(session.abort).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown" });
		expect(existsSync(join(cwd, "Debug"))).toBe(true);
		rmSync(cwd, { recursive: true, force: true });
	});

	it("emits session_shutdown in json mode", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "ag1-print-mode-"));
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }), cwd);
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith(
			"hello",
			expect.objectContaining({
				systemPromptAddendum: expect.stringContaining("conversational or simple assistance request"),
			}),
		);
		expect(session.sendCustomMessage).not.toHaveBeenCalled();
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown" });
		rmSync(cwd, { recursive: true, force: true });
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "ag1-print-mode-"));
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
			cwd,
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown" });
		rmSync(cwd, { recursive: true, force: true });
	});

	it("prints classified local backend failures with recovery guidance", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "ag1-print-mode-"));
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({
				stopReason: "error",
				errorMessage: "Connection error.",
			}),
			cwd,
		);
		runtimeHost.session.state.messages[0] = {
			...runtimeHost.session.state.messages[0],
			provider: "local",
			model: "lm-studio",
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith(
			"Local model backend unavailable for local/lm-studio: Connection error.\nStart LM Studio (or the configured local backend), verify LM_STUDIO_URL, or switch models with Ctrl+L.",
		);
		rmSync(cwd, { recursive: true, force: true });
	});

	it("waits through a quick continuation after agent_end before printing the final answer", async () => {
		vi.useFakeTimers();
		const cwd = mkdtempSync(join(tmpdir(), "ag1-print-mode-"));
		const subscriptions = createSubscriptionHarness();
		const promptImpl = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					subscriptions.emit({ type: "agent_end" });
					setTimeout(() => {
						runtimeHost.session.state.messages = [createAssistantMessage({ text: "final after xml" })];
						subscriptions.emit({ type: "agent_start" });
						subscriptions.emit({ type: "agent_end" });
						resolve();
					}, 50);
				}),
		);
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "" }), cwd, {
			promptImpl,
			subscribeImpl: subscriptions.subscribeImpl,
		});
		const stdoutChunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: string | Uint8Array,
			...rest: unknown[]
		) => {
			stdoutChunks.push(String(chunk));
			const callback = rest.find((value) => typeof value === "function") as
				| ((error?: Error | null) => void)
				| undefined;
			callback?.(null);
			return true;
		}) as typeof process.stdout.write);

		let settled = false;
		const exitPromise = runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "hello",
		}).then((value) => {
			settled = true;
			return value;
		});

		await vi.advanceTimersByTimeAsync(25);
		expect(settled).toBe(false);

		await vi.advanceTimersByTimeAsync(250);
		const exitCode = await exitPromise;

		expect(exitCode).toBe(0);
		expect(stdoutChunks.join("")).toContain("final after xml");
		stdoutSpy.mockRestore();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("recovers repeated truncated thinking-only assistant steps before printing the final answer", async () => {
		vi.useFakeTimers();
		const cwd = mkdtempSync(join(tmpdir(), "ag1-print-mode-"));
		const subscriptions = createSubscriptionHarness();
		const promptImpl = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					subscriptions.emit({ type: "agent_start" });
					subscriptions.emit({
						type: "message_end",
						message: {
							...createAssistantMessage({ stopReason: "length" }),
							content: [
								{
									type: "thinking",
									thinking: "I should first inspect the likely scripts directory before answering.",
								},
							],
						},
					});
					setTimeout(() => {
						subscriptions.emit({
							type: "message_end",
							message: {
								...createAssistantMessage({ stopReason: "length" }),
								content: [
									{
										type: "thinking",
										thinking: "I should search in the scripts directory for the archive command.",
									},
								],
							},
						});
						setTimeout(() => {
							const finalMessage = createAssistantMessage({
								text: "The archive command is defined in `scripts/harness-benchmark-archive.mjs`.",
							});
							runtimeHost.session.state.messages = [finalMessage];
							subscriptions.emit({ type: "message_end", message: finalMessage });
							subscriptions.emit({ type: "agent_end" });
							resolve();
						}, 50);
					}, 50);
				}),
		);
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "" }), cwd, {
			promptImpl,
			subscribeImpl: subscriptions.subscribeImpl,
		});
		const stdoutChunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: string | Uint8Array,
			...rest: unknown[]
		) => {
			stdoutChunks.push(String(chunk));
			const callback = rest.find((value) => typeof value === "function") as
				| ((error?: Error | null) => void)
				| undefined;
			callback?.(null);
			return true;
		}) as typeof process.stdout.write);

		const exitPromise = runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage:
				"which file defines the script that archives benchmark runs into /home/alex/Desktop/Benchmark?",
		});

		await vi.advanceTimersByTimeAsync(250);
		const exitCode = await exitPromise;

		expect(exitCode).toBe(0);
		expect(stdoutChunks.join("")).toContain("scripts/harness-benchmark-archive.mjs");
		expect(runtimeHost.session.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "runtime_continuation_state",
				content: expect.stringContaining(
					"Continue immediately with either one concrete next tool call or a direct answer",
				),
			}),
			expect.objectContaining({ deliverAs: "followUp" }),
		);
		expect(runtimeHost.session.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "runtime_continuation_state",
				content: expect.stringContaining(
					"Output exactly one concrete next tool call now, or the direct answer if no tool is needed",
				),
			}),
			expect.objectContaining({ deliverAs: "followUp" }),
		);
		expect(runtimeHost.session.sendCustomMessage).toHaveBeenCalledTimes(2);
		stdoutSpy.mockRestore();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("recovers a malformed first tool call by requesting one corrected tool invocation", async () => {
		vi.useFakeTimers();
		const cwd = mkdtempSync(join(tmpdir(), "ag1-print-mode-"));
		const subscriptions = createSubscriptionHarness();
		const promptImpl = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					subscriptions.emit({ type: "agent_start" });
					subscriptions.emit({
						type: "message_end",
						message: {
							...createAssistantMessage({ stopReason: "length" }),
							content: [
								{ type: "thinking", thinking: "I should search repo-root scripts for the archive command." },
								{ type: "text", text: "\n\n" },
								{ type: "toolCall", id: "call-find", name: "find", arguments: {} },
							],
						},
					});
					subscriptions.emit({
						type: "tool_execution_start",
						toolCallId: "call-find",
						toolName: "find",
						args: {},
					});
					subscriptions.emit({
						type: "tool_execution_end",
						toolCallId: "call-find",
						toolName: "find",
						isError: true,
						result: {
							content: [
								{
									type: "text",
									text: "Validation failed for tool \"find\":\n  - pattern: must have required property 'pattern'\n\nReceived arguments:\n{}",
								},
							],
							details: {},
						},
					});
					setTimeout(() => {
						const finalMessage = createAssistantMessage({
							text: "The benchmark archive command is implemented in `scripts/harness-benchmark-archive.mjs`.",
						});
						runtimeHost.session.state.messages = [finalMessage];
						subscriptions.emit({ type: "message_end", message: finalMessage });
						subscriptions.emit({ type: "agent_end" });
						resolve();
					}, 50);
				}),
		);
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "" }), cwd, {
			promptImpl,
			subscribeImpl: subscriptions.subscribeImpl,
		});
		const stdoutChunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: string | Uint8Array,
			...rest: unknown[]
		) => {
			stdoutChunks.push(String(chunk));
			const callback = rest.find((value) => typeof value === "function") as
				| ((error?: Error | null) => void)
				| undefined;
			callback?.(null);
			return true;
		}) as typeof process.stdout.write);

		const exitPromise = runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage:
				"which source file implements the benchmark archive command? give the exact path and one-sentence purpose",
		});

		await vi.advanceTimersByTimeAsync(250);
		const exitCode = await exitPromise;

		expect(exitCode).toBe(0);
		expect(stdoutChunks.join("")).toContain("scripts/harness-benchmark-archive.mjs");
		expect(runtimeHost.session.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "runtime_continuation_state",
				content: expect.stringContaining("The previous tool call was malformed or incomplete"),
			}),
			expect.objectContaining({ deliverAs: "followUp" }),
		);
		expect(runtimeHost.session.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "runtime_continuation_state",
				content: expect.stringContaining("concrete `pattern` argument"),
			}),
			expect.objectContaining({ deliverAs: "followUp" }),
		);
		stdoutSpy.mockRestore();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("recovers a malformed first edit call by requesting one corrected edit invocation", async () => {
		vi.useFakeTimers();
		const cwd = mkdtempSync(join(tmpdir(), "ag1-print-mode-"));
		const subscriptions = createSubscriptionHarness();
		const promptImpl = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					subscriptions.emit({ type: "agent_start" });
					subscriptions.emit({
						type: "message_end",
						message: {
							...createAssistantMessage({ stopReason: "length" }),
							content: [
								{ type: "thinking", thinking: "I should patch src/request.mjs directly." },
								{ type: "text", text: "\n\n" },
								{ type: "toolCall", id: "call-edit", name: "edit", arguments: {} },
							],
						},
					});
					subscriptions.emit({
						type: "tool_execution_start",
						toolCallId: "call-edit",
						toolName: "edit",
						args: {},
					});
					subscriptions.emit({
						type: "tool_execution_end",
						toolCallId: "call-edit",
						toolName: "edit",
						isError: true,
						result: {
							content: [
								{
									type: "text",
									text: "Error executing 'edit': Edit tool input is invalid. edits must contain at least one replacement.",
								},
							],
							details: {},
						},
					});
					setTimeout(() => {
						const finalMessage = createAssistantMessage({
							text: "Updated `src/request.mjs` to use `AbortSignal.timeout(...)` and pass a `signal` option instead of `timeoutMs`.",
						});
						runtimeHost.session.state.messages = [finalMessage];
						subscriptions.emit({ type: "message_end", message: finalMessage });
						subscriptions.emit({ type: "agent_end" });
						resolve();
					}, 50);
				}),
		);
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "" }), cwd, {
			promptImpl,
			subscribeImpl: subscriptions.subscribeImpl,
		});
		const stdoutChunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: string | Uint8Array,
			...rest: unknown[]
		) => {
			stdoutChunks.push(String(chunk));
			const callback = rest.find((value) => typeof value === "function") as
				| ((error?: Error | null) => void)
				| undefined;
			callback?.(null);
			return true;
		}) as typeof process.stdout.write);

		const exitPromise = runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "read the local migration note and patch the request helper, then verify",
		});

		await vi.advanceTimersByTimeAsync(250);
		const exitCode = await exitPromise;

		expect(exitCode).toBe(0);
		expect(stdoutChunks.join("")).toContain("src/request.mjs");
		expect(runtimeHost.session.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "runtime_continuation_state",
				content: expect.stringContaining("The previous tool call was malformed or incomplete"),
			}),
			expect.objectContaining({ deliverAs: "followUp" }),
		);
		expect(runtimeHost.session.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "runtime_continuation_state",
				content: expect.stringContaining("concrete `path` and a non-empty `edits` array"),
			}),
			expect.objectContaining({ deliverAs: "followUp" }),
		);
		expect(runtimeHost.session.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "runtime_continuation_state",
				content: expect.stringContaining("Each edit entry must contain at least one actual replacement"),
			}),
			expect.objectContaining({ deliverAs: "followUp" }),
		);
		stdoutSpy.mockRestore();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("recovers a malformed edit after earlier successful local reads in the same prompt", async () => {
		vi.useFakeTimers();
		const cwd = mkdtempSync(join(tmpdir(), "ag1-print-mode-"));
		const subscriptions = createSubscriptionHarness();
		const promptImpl = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					subscriptions.emit({ type: "agent_start" });
					subscriptions.emit({
						type: "tool_execution_start",
						toolCallId: "call-read",
						toolName: "read",
						args: { path: "src/request.mjs" },
					});
					subscriptions.emit({
						type: "tool_execution_end",
						toolCallId: "call-read",
						toolName: "read",
						isError: false,
						result: {
							content: [
								{
									type: "text",
									text: "export async function getJson(url, { timeoutMs = 1000 } = {}) {\n\treturn fakeFetchJson(url, { timeoutMs });\n}",
								},
							],
							details: {
								progress: { startLine: 1, endLine: 4, totalLines: 4, completion: "complete" },
							},
						},
					});
					subscriptions.emit({
						type: "message_end",
						message: {
							...createAssistantMessage({ stopReason: "length" }),
							content: [
								{ type: "thinking", thinking: "I should patch src/request.mjs directly." },
								{ type: "text", text: "\n\n" },
								{ type: "toolCall", id: "call-edit", name: "edit", arguments: {} },
							],
						},
					});
					subscriptions.emit({
						type: "tool_execution_start",
						toolCallId: "call-edit",
						toolName: "edit",
						args: {},
					});
					subscriptions.emit({
						type: "tool_execution_end",
						toolCallId: "call-edit",
						toolName: "edit",
						isError: true,
						result: {
							content: [
								{
									type: "text",
									text: "Error executing 'edit': Edit tool input is invalid. edits must contain at least one replacement.",
								},
							],
							details: {},
						},
					});
					setTimeout(() => {
						const finalMessage = createAssistantMessage({
							text: "Updated `src/request.mjs` to use `AbortSignal.timeout(...)` and pass a `signal` option instead of `timeoutMs`.",
						});
						runtimeHost.session.state.messages = [finalMessage];
						subscriptions.emit({ type: "message_end", message: finalMessage });
						subscriptions.emit({ type: "agent_end" });
						resolve();
					}, 50);
				}),
		);
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "" }), cwd, {
			promptImpl,
			subscribeImpl: subscriptions.subscribeImpl,
		});
		const stdoutChunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: string | Uint8Array,
			...rest: unknown[]
		) => {
			stdoutChunks.push(String(chunk));
			const callback = rest.find((value) => typeof value === "function") as
				| ((error?: Error | null) => void)
				| undefined;
			callback?.(null);
			return true;
		}) as typeof process.stdout.write);

		const exitPromise = runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "read the local migration note and patch the request helper, then verify",
		});

		await vi.advanceTimersByTimeAsync(250);
		const exitCode = await exitPromise;

		expect(exitCode).toBe(0);
		expect(stdoutChunks.join("")).toContain("src/request.mjs");
		expect(runtimeHost.session.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "runtime_continuation_state",
				content: expect.stringContaining("The previous tool call was malformed or incomplete"),
			}),
			expect.objectContaining({ deliverAs: "followUp" }),
		);
		expect(runtimeHost.session.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "runtime_continuation_state",
				content: expect.stringContaining("concrete `path` and a non-empty `edits` array"),
			}),
			expect.objectContaining({ deliverAs: "followUp" }),
		);
		stdoutSpy.mockRestore();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("treats read path-not-found errors as recoverable runtime steering", async () => {
		vi.useFakeTimers();
		const cwd = mkdtempSync(join(tmpdir(), "ag1-print-mode-"));
		const subscriptions = createSubscriptionHarness();
		const promptImpl = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					subscriptions.emit({ type: "agent_start" });
					subscriptions.emit({
						type: "message_end",
						message: {
							...createAssistantMessage({ stopReason: "length" }),
							content: [
								{ type: "thinking", thinking: "I should inspect the guessed file path next." },
								{ type: "text", text: "\n\n" },
								{
									type: "toolCall",
									id: "call-read",
									name: "read",
									arguments: { path: "reference/request.mjs" },
								},
							],
						},
					});
					subscriptions.emit({
						type: "tool_execution_start",
						toolCallId: "call-read",
						toolName: "read",
						args: { path: "reference/request.mjs" },
					});
					subscriptions.emit({
						type: "tool_execution_end",
						toolCallId: "call-read",
						toolName: "read",
						isError: true,
						result: {
							content: [
								{
									type: "text",
									text: "Path not found: reference/request.mjs. Use find to locate files or ls to inspect directories before retrying read.",
								},
							],
							details: {},
						},
					});
					setTimeout(() => {
						const finalMessage = createAssistantMessage({
							text: "The request helper lives in `src/request.mjs`.",
						});
						runtimeHost.session.state.messages = [finalMessage];
						subscriptions.emit({ type: "message_end", message: finalMessage });
						subscriptions.emit({ type: "agent_end" });
						resolve();
					}, 50);
				}),
		);
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "" }), cwd, {
			promptImpl,
			subscribeImpl: subscriptions.subscribeImpl,
		});
		const stdoutChunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: string | Uint8Array,
			...rest: unknown[]
		) => {
			stdoutChunks.push(String(chunk));
			const callback = rest.find((value) => typeof value === "function") as
				| ((error?: Error | null) => void)
				| undefined;
			callback?.(null);
			return true;
		}) as typeof process.stdout.write);

		const exitPromise = runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "read the request helper implementation in this workspace",
		});

		await vi.advanceTimersByTimeAsync(250);
		const exitCode = await exitPromise;

		expect(exitCode).toBe(0);
		expect(stdoutChunks.join("")).toContain("src/request.mjs");
		expect(runtimeHost.session.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "runtime_continuation_state",
				content: expect.stringContaining("If the exact path is not known, do one direct discovery call"),
			}),
			expect.objectContaining({ deliverAs: "followUp" }),
		);
		stdoutSpy.mockRestore();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("finishes when a final assistant message arrives even if agent_end is missing", async () => {
		vi.useFakeTimers();
		const cwd = mkdtempSync(join(tmpdir(), "ag1-print-mode-"));
		const subscriptions = createSubscriptionHarness();
		const promptImpl = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					setTimeout(() => {
						const finalMessage = createAssistantMessage({ text: "final without agent_end" });
						runtimeHost.session.state.messages = [finalMessage];
						subscriptions.emit({ type: "message_end", message: finalMessage });
					}, 25);
					setTimeout(() => resolve(), 500);
				}),
		);
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "" }), cwd, {
			promptImpl,
			subscribeImpl: subscriptions.subscribeImpl,
		});
		const stdoutChunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: string | Uint8Array,
			...rest: unknown[]
		) => {
			stdoutChunks.push(String(chunk));
			const callback = rest.find((value) => typeof value === "function") as
				| ((error?: Error | null) => void)
				| undefined;
			callback?.(null);
			return true;
		}) as typeof process.stdout.write);

		const exitPromise = runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "hello",
		});

		await vi.advanceTimersByTimeAsync(250);
		const exitCode = await exitPromise;

		expect(exitCode).toBe(0);
		expect(stdoutChunks.join("")).toContain("final without agent_end");
		stdoutSpy.mockRestore();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("does not let turn_end cancel completion after a final assistant message", async () => {
		vi.useFakeTimers();
		const cwd = mkdtempSync(join(tmpdir(), "ag1-print-mode-"));
		const subscriptions = createSubscriptionHarness();
		const promptImpl = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					setTimeout(() => {
						const finalMessage = createAssistantMessage({ text: "final with turn_end" });
						runtimeHost.session.state.messages = [finalMessage];
						subscriptions.emit({ type: "message_end", message: finalMessage });
						subscriptions.emit({ type: "turn_end", message: finalMessage, toolResults: [] });
					}, 25);
					setTimeout(() => resolve(), 500);
				}),
		);
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "" }), cwd, {
			promptImpl,
			subscribeImpl: subscriptions.subscribeImpl,
		});
		const stdoutChunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: string | Uint8Array,
			...rest: unknown[]
		) => {
			stdoutChunks.push(String(chunk));
			const callback = rest.find((value) => typeof value === "function") as
				| ((error?: Error | null) => void)
				| undefined;
			callback?.(null);
			return true;
		}) as typeof process.stdout.write);

		const exitPromise = runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "hello",
		});

		await vi.advanceTimersByTimeAsync(250);
		const exitCode = await exitPromise;

		expect(exitCode).toBe(0);
		expect(stdoutChunks.join("")).toContain("final with turn_end");
		stdoutSpy.mockRestore();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("does not let hidden custom message activity cancel completion after a final assistant message", async () => {
		vi.useFakeTimers();
		const cwd = mkdtempSync(join(tmpdir(), "ag1-print-mode-"));
		const subscriptions = createSubscriptionHarness();
		const promptImpl = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					setTimeout(() => {
						const finalMessage = createAssistantMessage({ text: "final with hidden custom" });
						runtimeHost.session.state.messages = [finalMessage];
						subscriptions.emit({ type: "message_end", message: finalMessage });
						subscriptions.emit({
							type: "message_start",
							message: {
								role: "custom",
								display: false,
								customType: "runtime_continuation_state",
								content: "hint",
							},
						});
					}, 25);
					setTimeout(() => resolve(), 500);
				}),
		);
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "" }), cwd, {
			promptImpl,
			subscribeImpl: subscriptions.subscribeImpl,
		});
		const stdoutChunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: string | Uint8Array,
			...rest: unknown[]
		) => {
			stdoutChunks.push(String(chunk));
			const callback = rest.find((value) => typeof value === "function") as
				| ((error?: Error | null) => void)
				| undefined;
			callback?.(null);
			return true;
		}) as typeof process.stdout.write);

		const exitPromise = runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "hello",
		});

		await vi.advanceTimersByTimeAsync(250);
		const exitCode = await exitPromise;

		expect(exitCode).toBe(0);
		expect(stdoutChunks.join("")).toContain("final with hidden custom");
		stdoutSpy.mockRestore();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("returns after the first final assistant answer instead of waiting for late hidden steering follow-ups", async () => {
		vi.useFakeTimers();
		const cwd = mkdtempSync(join(tmpdir(), "ag1-print-mode-"));
		const subscriptions = createSubscriptionHarness();
		const promptImpl = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					setTimeout(() => {
						const finalMessage = createAssistantMessage({ text: "first final answer" });
						runtimeHost.session.state.messages = [finalMessage];
						subscriptions.emit({ type: "message_end", message: finalMessage });
					}, 25);
					setTimeout(() => {
						subscriptions.emit({
							type: "message_start",
							message: {
								role: "custom",
								display: false,
								customType: "runtime_continuation_state",
								content: "late hint",
							},
						});
					}, 50);
					setTimeout(() => {
						const secondMessage = createAssistantMessage({ text: "late follow-up answer" });
						runtimeHost.session.state.messages = [secondMessage];
						subscriptions.emit({ type: "message_end", message: secondMessage });
					}, 100);
					setTimeout(() => resolve(), 500);
				}),
		);
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "" }), cwd, {
			promptImpl,
			subscribeImpl: subscriptions.subscribeImpl,
		});
		const stdoutChunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: string | Uint8Array,
			...rest: unknown[]
		) => {
			stdoutChunks.push(String(chunk));
			const callback = rest.find((value) => typeof value === "function") as
				| ((error?: Error | null) => void)
				| undefined;
			callback?.(null);
			return true;
		}) as typeof process.stdout.write);

		let settled = false;
		const exitPromise = runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "hello",
		}).then((value) => {
			settled = true;
			return value;
		});

		await vi.advanceTimersByTimeAsync(250);
		expect(settled).toBe(true);
		const exitCode = await exitPromise;

		expect(exitCode).toBe(0);
		expect(stdoutChunks.join("")).toContain("first final answer");
		expect(stdoutChunks.join("")).not.toContain("late follow-up answer");
		expect(runtimeHost.session.abort).not.toHaveBeenCalled();
		stdoutSpy.mockRestore();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("triggers XML recovery when assistant message_end leaks XML in thinking", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "ag1-print-mode-"));
		const subscriptions = createSubscriptionHarness();
		const promptImpl = vi.fn(async () => {
			subscriptions.emit({
				type: "message_end",
				message: {
					...createAssistantMessage(),
					content: [
						{
							type: "thinking",
							thinking: [
								"<tool_call>",
								"<function=webSearch>",
								"<parameter=query>react docs</parameter>",
								"</function>",
								"</tool_call>",
							].join("\n"),
						},
					],
				},
			});
		});
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }), cwd, {
			promptImpl,
			subscribeImpl: subscriptions.subscribeImpl,
		});

		await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "look up docs",
		});

		expect(runtimeHost.session.recoverXmlToolCallsNow).toHaveBeenCalledTimes(1);
		expect(runtimeHost.session.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "runtime_continuation_state",
				display: false,
			}),
			expect.objectContaining({ deliverAs: "steer" }),
		);
		rmSync(cwd, { recursive: true, force: true });
	});

	it("still recovers XML leaks after a temporary runtime tool lock", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "ag1-print-mode-"));
		const subscriptions = createSubscriptionHarness();
		const promptImpl = vi.fn(async () => {
			subscriptions.emit({ type: "agent_start" });
			subscriptions.emit({
				type: "tool_execution_start",
				toolCallId: "call-grep",
				toolName: "grep",
				args: { pattern: "createLiveProviderContext", path: ".", literal: true },
			});
			subscriptions.emit({
				type: "tool_execution_end",
				toolCallId: "call-grep",
				toolName: "grep",
				isError: false,
				result: {
					content: [
						{
							type: "text",
							text: "packages/coding-agent/src/core/compaction/micro-compact.ts:456: createLiveProviderContext",
						},
					],
					details: {
						matchCount: 1,
						uniqueFileCount: 1,
						firstMatchPath: "packages/coding-agent/src/core/compaction/micro-compact.ts",
						firstMatchLine: 456,
					},
				},
			});
			subscriptions.emit({
				type: "tool_execution_start",
				toolCallId: "call-read",
				toolName: "read",
				args: { filePath: "packages/coding-agent/src/core/compaction/micro-compact.ts", offset: 440, limit: 100 },
			});
			subscriptions.emit({
				type: "tool_execution_end",
				toolCallId: "call-read",
				toolName: "read",
				isError: false,
				result: {
					content: [{ type: "text", text: "export function createLiveProviderContext(...) { /* ... */ }" }],
					details: { progress: { startLine: 440, endLine: 474, totalLines: 474, completion: "complete" } },
				},
			});
			subscriptions.emit({
				type: "message_end",
				message: {
					...createAssistantMessage(),
					content: [
						{
							type: "thinking",
							thinking: [
								"<tool_call>",
								"<function=read>",
								"<parameter=path>packages/coding-agent/src/core/compaction/micro-compact.ts</parameter>",
								"</function>",
								"</tool_call>",
							].join("\n"),
						},
					],
				},
			});
		});
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }), cwd, {
			promptImpl,
			subscribeImpl: subscriptions.subscribeImpl,
		});

		await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage:
				"find where createLiveProviderContext is defined and explain how it differs from createContextHygieneCopy; do not browse the web",
		});

		expect(runtimeHost.session.recoverXmlToolCallsNow).toHaveBeenCalledTimes(1);
		expect(runtimeHost.session.setActiveToolsByName).toHaveBeenCalledWith(["read"]);
		expect(runtimeHost.session.setActiveToolsByName).toHaveBeenCalledWith([]);
		expect(runtimeHost.session.setActiveToolsByName).toHaveBeenCalledWith([
			"read",
			"webSearch",
			"grep",
			"find",
			"ls",
		]);
		rmSync(cwd, { recursive: true, force: true });
	});

	it("locks tools to read and then to none after decisive local evidence", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "ag1-print-mode-"));
		const subscriptions = createSubscriptionHarness();
		const promptImpl = vi.fn(async () => {
			subscriptions.emit({ type: "agent_start" });
			subscriptions.emit({
				type: "tool_execution_start",
				toolCallId: "call-grep",
				toolName: "grep",
				args: { pattern: "normalizeCurrentEventsQuery" },
			});
			subscriptions.emit({
				type: "tool_execution_end",
				toolCallId: "call-grep",
				toolName: "grep",
				isError: false,
				result: {
					content: [
						{
							type: "text",
							text: "packages/coding-agent/src/core/tools/websearch.ts:211: normalizeCurrentEventsQuery",
						},
					],
					details: {
						matchCount: 1,
						uniqueFileCount: 1,
						firstMatchPath: "packages/coding-agent/src/core/tools/websearch.ts",
						firstMatchLine: 211,
					},
				},
			});
			subscriptions.emit({
				type: "tool_execution_start",
				toolCallId: "call-read",
				toolName: "read",
				args: { filePath: "packages/coding-agent/src/core/tools/websearch.ts", offset: 211, limit: 40 },
			});
			subscriptions.emit({
				type: "tool_execution_end",
				toolCallId: "call-read",
				toolName: "read",
				isError: false,
				result: {
					content: [{ type: "text", text: "function normalizeCurrentEventsQuery(...) { /* ... */ }" }],
					details: {
						progress: {
							startLine: 211,
							endLine: 250,
							totalLines: 500,
							completion: "partial",
							nextOffset: 251,
						},
					},
				},
			});
			const finalMessage = createAssistantMessage({ text: "It normalizes queries for current-events lookups." });
			subscriptions.emit({ type: "message_end", message: finalMessage });
			subscriptions.emit({ type: "agent_end" });
		});
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "" }), cwd, {
			promptImpl,
			subscribeImpl: subscriptions.subscribeImpl,
		});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage:
				"find where normalizeCurrentEventsQuery is actually defined in this repo and summarize why it exists",
		});

		expect(exitCode).toBe(0);
		expect(runtimeHost.session.setActiveToolsByName).toHaveBeenCalledWith(["read"]);
		expect(runtimeHost.session.setActiveToolsByName).toHaveBeenCalledWith([]);
		expect(runtimeHost.session.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "runtime_continuation_state",
				content: expect.stringContaining("Do exactly one targeted read"),
			}),
			expect.objectContaining({ deliverAs: "steer" }),
		);
		expect(runtimeHost.session.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "runtime_continuation_state",
				content: expect.stringContaining("The targeted read already completed"),
			}),
			expect.objectContaining({ deliverAs: "steer" }),
		);
		rmSync(cwd, { recursive: true, force: true });
	});

	it("continues a truncated answer-now reply instead of printing the partial answer", async () => {
		vi.useFakeTimers();
		const cwd = mkdtempSync(join(tmpdir(), "ag1-print-mode-"));
		const subscriptions = createSubscriptionHarness();
		const promptImpl = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					subscriptions.emit({ type: "agent_start" });
					subscriptions.emit({
						type: "tool_execution_start",
						toolCallId: "call-grep",
						toolName: "grep",
						args: { pattern: "normalizeCurrentEventsQuery" },
					});
					subscriptions.emit({
						type: "tool_execution_end",
						toolCallId: "call-grep",
						toolName: "grep",
						isError: false,
						result: {
							content: [
								{
									type: "text",
									text: "packages/coding-agent/src/core/tools/websearch.ts:211: normalizeCurrentEventsQuery",
								},
							],
							details: {
								matchCount: 1,
								uniqueFileCount: 1,
								firstMatchPath: "packages/coding-agent/src/core/tools/websearch.ts",
								firstMatchLine: 211,
							},
						},
					});
					subscriptions.emit({
						type: "tool_execution_start",
						toolCallId: "call-read",
						toolName: "read",
						args: { filePath: "packages/coding-agent/src/core/tools/websearch.ts", offset: 211, limit: 40 },
					});
					subscriptions.emit({
						type: "tool_execution_end",
						toolCallId: "call-read",
						toolName: "read",
						isError: false,
						result: {
							content: [{ type: "text", text: "function normalizeCurrentEventsQuery(...) { /* ... */ }" }],
							details: {
								progress: {
									startLine: 211,
									endLine: 250,
									totalLines: 500,
									completion: "partial",
									nextOffset: 251,
								},
							},
						},
					});
					subscriptions.emit({
						type: "message_end",
						message: createAssistantMessage({
							text: "It is defined in `packages/coding-agent/src/core/tools/websearch.ts`, and",
							stopReason: "length",
						}),
					});
					setTimeout(() => {
						const finalMessage = createAssistantMessage({
							text: "It is defined in `packages/coding-agent/src/core/tools/websearch.ts`, and it exists to normalize current-events queries before web search heuristics run.",
						});
						runtimeHost.session.state.messages = [finalMessage];
						subscriptions.emit({ type: "agent_start" });
						subscriptions.emit({ type: "message_end", message: finalMessage });
						subscriptions.emit({ type: "agent_end" });
						resolve();
					}, 50);
				}),
		);
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "" }), cwd, {
			promptImpl,
			subscribeImpl: subscriptions.subscribeImpl,
		});
		const stdoutChunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: string | Uint8Array,
			...rest: unknown[]
		) => {
			stdoutChunks.push(String(chunk));
			const callback = rest.find((value) => typeof value === "function") as
				| ((error?: Error | null) => void)
				| undefined;
			callback?.(null);
			return true;
		}) as typeof process.stdout.write);

		const exitPromise = runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage:
				"find where normalizeCurrentEventsQuery is actually defined in this repo and summarize why it exists",
		});

		await vi.advanceTimersByTimeAsync(250);
		const exitCode = await exitPromise;

		expect(exitCode).toBe(0);
		expect(stdoutChunks.join("")).toContain("normalize current-events queries before web search heuristics run");
		expect(runtimeHost.session.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "runtime_continuation_state",
				content: expect.stringContaining("The previous answer was cut off mid-response"),
			}),
			expect.objectContaining({ deliverAs: "followUp" }),
		);
		stdoutSpy.mockRestore();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("reasserts answer-now control when another tool starts after decisive docs evidence", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "ag1-print-mode-"));
		const subscriptions = createSubscriptionHarness();
		const promptImpl = vi.fn(async () => {
			subscriptions.emit({ type: "agent_start" });
			subscriptions.emit({
				type: "tool_execution_start",
				toolCallId: "call-webfetch",
				toolName: "webFetch",
				args: { url: "https://react.dev/reference/react/useActionState" },
			});
			subscriptions.emit({
				type: "tool_execution_end",
				toolCallId: "call-webfetch",
				toolName: "webFetch",
				isError: false,
				result: {
					content: [{ type: "text", text: "Fetched source: https://react.dev/reference/react/useActionState" }],
					details: {
						url: "https://react.dev/reference/react/useActionState",
						status: "rich",
						intent: "docs_reference",
						authoritative: true,
					},
				},
			});
			subscriptions.emit({
				type: "tool_execution_start",
				toolCallId: "call-websearch",
				toolName: "webSearch",
				args: { query: "React useActionState permalink parameter docs" },
			});
			const finalMessage = createAssistantMessage({
				text: "The permalink parameter preserves state across navigation.",
			});
			subscriptions.emit({ type: "message_end", message: finalMessage });
			subscriptions.emit({ type: "agent_end" });
		});
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "" }), cwd, {
			promptImpl,
			subscribeImpl: subscriptions.subscribeImpl,
		});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage:
				"look up the official React docs for useActionState and explain the permalink parameter in one sentence",
		});

		expect(exitCode).toBe(0);
		expect(runtimeHost.session.setActiveToolsByName).toHaveBeenCalledWith([]);
		expect(runtimeHost.session.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "runtime_continuation_state",
				content: expect.stringContaining("A rich authoritative web source is already in hand"),
			}),
			expect.objectContaining({ deliverAs: "steer" }),
		);
		expect(runtimeHost.session.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "runtime_continuation_state",
				content: expect.stringContaining("Answer now from the evidence already gathered"),
			}),
			expect.objectContaining({ deliverAs: "steer" }),
		);
		rmSync(cwd, { recursive: true, force: true });
	});

	it("sends non-locking local evidence steering immediately as a follow-up", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "ag1-print-mode-"));
		const subscriptions = createSubscriptionHarness();
		const promptImpl = vi.fn(async () => {
			subscriptions.emit({ type: "agent_start" });
			subscriptions.emit({
				type: "tool_execution_start",
				toolCallId: "call-ls",
				toolName: "ls",
				args: { path: "scripts" },
			});
			subscriptions.emit({
				type: "tool_execution_end",
				toolCallId: "call-ls",
				toolName: "ls",
				isError: false,
				result: {
					content: [{ type: "text", text: "archive.mjs\ncompare.mjs\nrun.mjs" }],
					details: {
						directoryPath: "scripts",
						entryCount: 3,
						entriesSample: ["archive.mjs", "compare.mjs", "run.mjs"],
					},
				},
			});
			const finalMessage = createAssistantMessage({
				text: "The scripts directory contains archive.mjs, compare.mjs, and run.mjs.",
			});
			subscriptions.emit({ type: "message_end", message: finalMessage });
			subscriptions.emit({ type: "agent_end" });
		});
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "" }), cwd, {
			promptImpl,
			subscribeImpl: subscriptions.subscribeImpl,
		});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "take a quick look at scripts before deciding what to answer",
		});

		expect(exitCode).toBe(0);
		expect(runtimeHost.session.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "runtime_continuation_state",
				content: expect.stringContaining("listed `scripts` completely"),
			}),
			expect.objectContaining({ deliverAs: "followUp" }),
		);
		rmSync(cwd, { recursive: true, force: true });
	});

	it("completes on the agent_end terminal signal without waiting for the idle watchdog", async () => {
		vi.useFakeTimers();
		const cwd = mkdtempSync(join(tmpdir(), "ag1-print-mode-"));
		const subscriptions = createSubscriptionHarness();
		const promptImpl = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					setTimeout(() => {
						const finalMessage = createAssistantMessage({ text: "terminal signal answer" });
						runtimeHost.session.state.messages = [finalMessage];
						subscriptions.emit({ type: "message_end", message: finalMessage });
						subscriptions.emit({ type: "agent_end" });
					}, 25);
					// The prompt promise itself settles much later; completion must be
					// driven by agent_end, not by the prompt promise or the 150ms watchdog.
					setTimeout(() => resolve(), 1000);
				}),
		);
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "" }), cwd, {
			promptImpl,
			subscribeImpl: subscriptions.subscribeImpl,
		});
		const stdoutChunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: string | Uint8Array,
			...rest: unknown[]
		) => {
			stdoutChunks.push(String(chunk));
			const callback = rest.find((value) => typeof value === "function") as
				| ((error?: Error | null) => void)
				| undefined;
			callback?.(null);
			return true;
		}) as typeof process.stdout.write);

		let settled = false;
		const exitPromise = runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "hello",
		}).then((value) => {
			settled = true;
			return value;
		});

		// agent_end fired at t=25; well before the 150ms watchdog would fire.
		await vi.advanceTimersByTimeAsync(50);
		expect(settled).toBe(true);
		const exitCode = await exitPromise;

		expect(exitCode).toBe(0);
		expect(stdoutChunks.join("")).toContain("terminal signal answer");
		stdoutSpy.mockRestore();
		rmSync(cwd, { recursive: true, force: true });
	});
});
