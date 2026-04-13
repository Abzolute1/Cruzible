export interface InteractiveBranchSummaryChoice {
	wantsSummary: boolean;
	customInstructions?: string;
	cancelledToTree: boolean;
}

export async function resolveInteractiveBranchSummaryChoice(options: {
	skipPrompt: boolean;
	showSummarySelector: () => Promise<string | undefined>;
	showCustomInstructionsEditor: () => Promise<string | undefined>;
}): Promise<InteractiveBranchSummaryChoice> {
	if (options.skipPrompt) {
		return {
			wantsSummary: false,
			customInstructions: undefined,
			cancelledToTree: false,
		};
	}

	while (true) {
		const summaryChoice = await options.showSummarySelector();
		if (summaryChoice === undefined) {
			return {
				wantsSummary: false,
				customInstructions: undefined,
				cancelledToTree: true,
			};
		}

		const wantsSummary = summaryChoice !== "No summary";
		if (summaryChoice !== "Summarize with custom prompt") {
			return {
				wantsSummary,
				customInstructions: undefined,
				cancelledToTree: false,
			};
		}

		const customInstructions = await options.showCustomInstructionsEditor();
		if (customInstructions === undefined) {
			continue;
		}

		return {
			wantsSummary: true,
			customInstructions,
			cancelledToTree: false,
		};
	}
}
