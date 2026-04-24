import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
	performInteractiveCopyLastAssistantMessage,
	performInteractiveReload,
	performInteractiveSessionExport,
	performInteractiveSessionShare,
} from "../src/modes/interactive/interactive-maintenance-actions.js";

const { showEditorHostComponent, restoreEditorHost } = vi.hoisted(() => ({
	showEditorHostComponent: vi.fn(),
	restoreEditorHost: vi.fn(),
}));

vi.mock("../src/modes/interactive/components/bordered-loader.js", () => ({
	BorderedLoader: class {
		public signal = new AbortController().signal;
		public onAbort?: () => void;
		dispose(): void {}
	},
}));

vi.mock("../src/modes/interactive/interactive-editor-host.js", () => ({
	showEditorHostComponent,
	restoreEditorHost,
}));

describe("interactive-maintenance-actions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test("reload warns and exits while streaming", async () => {
		const showWarning = vi.fn();
		const reload = vi.fn(async () => undefined);

		const result = await performInteractiveReload({
			isStreaming: true,
			isCompacting: false,
			resetExtensionUI: vi.fn(),
			ui: { requestRender: vi.fn(), setFocus: vi.fn() },
			editorContainer: { clear: vi.fn(), addChild: vi.fn() },
			editor: {} as never,
			showWarning,
			showError: vi.fn(),
			showStatus: vi.fn(),
			reload,
		});

		expect(result).toBe(false);
		expect(showWarning).toHaveBeenCalledWith("Wait for the current response to finish before reloading.");
		expect(reload).not.toHaveBeenCalled();
	});

	test("reload restores editor and reports success", async () => {
		const result = await performInteractiveReload({
			isStreaming: false,
			isCompacting: false,
			resetExtensionUI: vi.fn(),
			ui: { requestRender: vi.fn(), setFocus: vi.fn() },
			editorContainer: { clear: vi.fn(), addChild: vi.fn() },
			editor: { kind: "editor" } as never,
			showWarning: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			reload: vi.fn(async () => undefined),
		});

		expect(result).toBe(true);
		expect(showEditorHostComponent).toHaveBeenCalledOnce();
		expect(restoreEditorHost).toHaveBeenCalledOnce();
	});

	test("export routes jsonl and html outputs correctly", async () => {
		const showStatus = vi.fn();
		const exportToJsonl = vi.fn(() => "/tmp/session.jsonl");
		const exportToHtml = vi.fn(async () => "/tmp/session.html");

		await performInteractiveSessionExport("/export /tmp/session.jsonl", {
			exportToJsonl,
			exportToHtml,
			showStatus,
			showError: vi.fn(),
		});
		await performInteractiveSessionExport("/export", {
			exportToJsonl,
			exportToHtml,
			showStatus,
			showError: vi.fn(),
		});

		expect(exportToJsonl).toHaveBeenCalledWith("/tmp/session.jsonl");
		expect(exportToHtml).toHaveBeenCalledWith(undefined);
		expect(showStatus).toHaveBeenCalledWith("Session exported to: /tmp/session.jsonl");
		expect(showStatus).toHaveBeenCalledWith("Session exported to: /tmp/session.html");
	});

	test("share fails cleanly when gh auth is unavailable", async () => {
		const showError = vi.fn();
		const exportToHtml = vi.fn(async () => "/tmp/session.html");

		await performInteractiveSessionShare({
			ui: { requestRender: vi.fn(), setFocus: vi.fn() },
			editorContainer: { clear: vi.fn(), addChild: vi.fn() },
			editor: {} as never,
			exportToHtml,
			showStatus: vi.fn(),
			showError,
			spawnSyncImpl: vi.fn(() => ({ status: 1 })) as never,
		});

		expect(showError).toHaveBeenCalledWith("GitHub CLI is not logged in. Run 'gh auth login' first.");
		expect(exportToHtml).not.toHaveBeenCalled();
	});

	test("share reports gist URLs on success", async () => {
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const on = vi.fn((event: string, handler: (code: number) => void) => {
			if (event === "close") {
				queueMicrotask(() => {
					stdout.emit("data", Buffer.from("https://gist.github.com/user/abc123\n"));
					handler(0);
				});
			}
			return child as never;
		});
		const child = {
			stdout,
			stderr,
			on,
			kill: vi.fn(),
		};
		const showStatus = vi.fn();

		await performInteractiveSessionShare({
			ui: { requestRender: vi.fn(), setFocus: vi.fn() },
			editorContainer: { clear: vi.fn(), addChild: vi.fn() },
			editor: {} as never,
			exportToHtml: vi.fn(async () => "/tmp/session.html"),
			showStatus,
			showError: vi.fn(),
			spawnSyncImpl: vi.fn(() => ({ status: 0 })) as never,
			spawnImpl: vi.fn(() => child as never) as never,
			unlinkSyncImpl: vi.fn() as never,
			tmpDir: "/tmp",
		});

		expect(showStatus).toHaveBeenCalledWith(
			"Share URL: https://ag1.dev/session/#abc123\nGist: https://gist.github.com/user/abc123",
		);
	});

	test("copy reports missing assistant text and success", async () => {
		const showError = vi.fn();
		const showStatus = vi.fn();
		const copyToClipboardImpl = vi.fn(async () => undefined);

		await performInteractiveCopyLastAssistantMessage({
			getLastAssistantText: () => undefined,
			showStatus,
			showError,
			copyToClipboardImpl,
		});

		await performInteractiveCopyLastAssistantMessage({
			getLastAssistantText: () => "hello",
			showStatus,
			showError,
			copyToClipboardImpl,
		});

		expect(showError).toHaveBeenCalledWith("No agent messages to copy yet.");
		expect(copyToClipboardImpl).toHaveBeenCalledWith("hello");
		expect(showStatus).toHaveBeenCalledWith("Copied last agent message to clipboard");
	});
});
