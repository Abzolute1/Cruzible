import type { Model } from "@ag1/ai";
import { describe, expect, test, vi } from "vitest";
import {
	performInteractiveModelSwitch,
	renameInteractiveSession,
} from "../src/modes/interactive/interactive-selector-actions.js";

const { openSessionManager } = vi.hoisted(() => ({
	openSessionManager: vi.fn(),
}));

vi.mock("../src/core/session-manager.js", () => ({
	SessionManager: {
		open: openSessionManager,
	},
}));

describe("interactive-selector-actions", () => {
	test("switches models and reports success", async () => {
		const model = { id: "gpt-5.4", provider: "openai" } as Model<any>;
		const onModelSelected = vi.fn();
		const closeSelector = vi.fn();
		const showStatus = vi.fn();

		await performInteractiveModelSwitch({
			model,
			setModel: vi.fn(async () => undefined),
			invalidateFooter: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			closeSelector,
			showStatus,
			showError: vi.fn(),
			onModelSelected,
		});

		expect(closeSelector).toHaveBeenCalledOnce();
		expect(showStatus).toHaveBeenCalledWith("Model: gpt-5.4");
		expect(onModelSelected).toHaveBeenCalledWith(model);
	});

	test("closes selector and reports model switch failures", async () => {
		const closeSelector = vi.fn();
		const showError = vi.fn();

		await performInteractiveModelSwitch({
			model: { id: "bad", provider: "broken" } as Model<any>,
			setModel: vi.fn(async () => {
				throw new Error("boom");
			}),
			invalidateFooter: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			closeSelector,
			showStatus: vi.fn(),
			showError,
		});

		expect(closeSelector).toHaveBeenCalledOnce();
		expect(showError).toHaveBeenCalledWith("boom");
	});

	test("renames sessions only when a non-empty name is provided", async () => {
		const appendSessionInfo = vi.fn();
		openSessionManager.mockReturnValue({ appendSessionInfo });

		await renameInteractiveSession("/tmp/session.jsonl", "  New Name  ");
		await renameInteractiveSession("/tmp/session.jsonl", "   ");

		expect(openSessionManager).toHaveBeenCalledTimes(1);
		expect(openSessionManager).toHaveBeenCalledWith("/tmp/session.jsonl");
		expect(appendSessionInfo).toHaveBeenCalledWith("New Name");
	});
});
