import { describe, expect, test, vi } from "vitest";
import {
	applyInteractiveTreeNavigationSuccess,
	performInteractiveTreeNavigation,
} from "../src/modes/interactive/interactive-tree-actions.js";

describe("interactive-tree-actions", () => {
	test("applies a successful tree navigation result", () => {
		const clearChat = vi.fn();
		const renderInitialMessages = vi.fn();
		const setEditorText = vi.fn();
		const showStatus = vi.fn();

		applyInteractiveTreeNavigationSuccess({
			result: { editorText: "restored prompt" },
			clearChat,
			renderInitialMessages,
			getEditorText: () => "",
			setEditorText,
			showStatus,
		});

		expect(clearChat).toHaveBeenCalledOnce();
		expect(renderInitialMessages).toHaveBeenCalledOnce();
		expect(setEditorText).toHaveBeenCalledWith("restored prompt");
		expect(showStatus).toHaveBeenCalledWith("Navigated to selected point");
	});

	test("does not overwrite a non-empty editor during successful navigation", () => {
		const setEditorText = vi.fn();

		applyInteractiveTreeNavigationSuccess({
			result: { editorText: "restored prompt" },
			clearChat: vi.fn(),
			renderInitialMessages: vi.fn(),
			getEditorText: () => "keep this",
			setEditorText,
			showStatus: vi.fn(),
		});

		expect(setEditorText).not.toHaveBeenCalled();
	});

	test("handles aborted navigation and runs cleanup", async () => {
		const cleanup = vi.fn();
		const showStatus = vi.fn();
		const onAborted = vi.fn();

		await performInteractiveTreeNavigation({
			navigateTree: async () => ({ cancelled: true, aborted: true }),
			enableSummaryUi: () => cleanup,
			applySuccess: vi.fn(),
			showStatus,
			showError: vi.fn(),
			onAborted,
		});

		expect(showStatus).toHaveBeenCalledWith("Branch summarization cancelled");
		expect(onAborted).toHaveBeenCalledOnce();
		expect(cleanup).toHaveBeenCalledOnce();
	});

	test("handles cancelled navigation without applying success", async () => {
		const applySuccess = vi.fn();
		const showStatus = vi.fn();

		await performInteractiveTreeNavigation({
			navigateTree: async () => ({ cancelled: true }),
			applySuccess,
			showStatus,
			showError: vi.fn(),
		});

		expect(applySuccess).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Navigation cancelled");
	});

	test("applies successful navigation and cleans up summary ui", async () => {
		const cleanup = vi.fn();
		const applySuccess = vi.fn();

		await performInteractiveTreeNavigation({
			navigateTree: async () => ({ cancelled: false, editorText: "x" }),
			enableSummaryUi: () => cleanup,
			applySuccess,
			showStatus: vi.fn(),
			showError: vi.fn(),
		});

		expect(applySuccess).toHaveBeenCalledWith({ cancelled: false, editorText: "x" });
		expect(cleanup).toHaveBeenCalledOnce();
	});
});
