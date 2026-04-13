import { describe, expect, test, vi } from "vitest";
import { resolveInteractiveBranchSummaryChoice } from "../src/modes/interactive/interactive-tree-navigation.js";

describe("interactive-tree-navigation", () => {
	test("skips the prompt entirely when configured", async () => {
		const showSummarySelector = vi.fn();
		const showCustomInstructionsEditor = vi.fn();

		await expect(
			resolveInteractiveBranchSummaryChoice({
				skipPrompt: true,
				showSummarySelector,
				showCustomInstructionsEditor,
			}),
		).resolves.toEqual({
			wantsSummary: false,
			customInstructions: undefined,
			cancelledToTree: false,
		});

		expect(showSummarySelector).not.toHaveBeenCalled();
		expect(showCustomInstructionsEditor).not.toHaveBeenCalled();
	});

	test("returns cancellation when the selector is escaped", async () => {
		await expect(
			resolveInteractiveBranchSummaryChoice({
				skipPrompt: false,
				showSummarySelector: async () => undefined,
				showCustomInstructionsEditor: async () => "unused",
			}),
		).resolves.toEqual({
			wantsSummary: false,
			customInstructions: undefined,
			cancelledToTree: true,
		});
	});

	test("loops back when custom-prompt editing is cancelled", async () => {
		const showSummarySelector = vi
			.fn<() => Promise<string | undefined>>()
			.mockResolvedValueOnce("Summarize with custom prompt")
			.mockResolvedValueOnce("Summarize");
		const showCustomInstructionsEditor = vi.fn(async () => undefined);

		await expect(
			resolveInteractiveBranchSummaryChoice({
				skipPrompt: false,
				showSummarySelector,
				showCustomInstructionsEditor,
			}),
		).resolves.toEqual({
			wantsSummary: true,
			customInstructions: undefined,
			cancelledToTree: false,
		});

		expect(showSummarySelector).toHaveBeenCalledTimes(2);
		expect(showCustomInstructionsEditor).toHaveBeenCalledTimes(1);
	});

	test("returns custom instructions when provided", async () => {
		await expect(
			resolveInteractiveBranchSummaryChoice({
				skipPrompt: false,
				showSummarySelector: async () => "Summarize with custom prompt",
				showCustomInstructionsEditor: async () => "summarize only the important branch changes",
			}),
		).resolves.toEqual({
			wantsSummary: true,
			customInstructions: "summarize only the important branch changes",
			cancelledToTree: false,
		});
	});
});
