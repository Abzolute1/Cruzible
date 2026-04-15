import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ImageContent } from "@mariozechner/pi-ai";
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
	reload: ReturnType<typeof vi.fn>;
	getActiveToolNames: () => string[];
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

function createRuntimeHost(assistantMessage: AssistantMessage, cwd: string): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [assistantMessage] };

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
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
		getActiveToolNames: () => ["read", "webSearch"],
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
		const cwd = mkdtempSync(join(tmpdir(), "crucible-print-mode-"));
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
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown" });
		expect(existsSync(join(cwd, "Debug"))).toBe(true);
		rmSync(cwd, { recursive: true, force: true });
	});

	it("emits session_shutdown in json mode", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "crucible-print-mode-"));
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }), cwd);
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown" });
		rmSync(cwd, { recursive: true, force: true });
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "crucible-print-mode-"));
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
		const cwd = mkdtempSync(join(tmpdir(), "crucible-print-mode-"));
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
});
