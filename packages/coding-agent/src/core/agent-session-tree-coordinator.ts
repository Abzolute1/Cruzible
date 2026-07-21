import type { Agent } from "@ag1/agent-core";
import type { Model } from "@ag1/ai";
import { collectEntriesForBranchSummary, generateBranchSummary } from "./compaction/index.js";
import type { ExtensionRunner, SessionBeforeTreeResult, TreePreparation } from "./extensions/index.js";
import type { BranchSummaryEntry, SessionManager } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";

interface RequestAuth {
	apiKey: string;
	headers?: Record<string, string>;
}

interface NavigateTreeOptions {
	summarize?: boolean;
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
}

export interface AgentSessionTreeCoordinatorOptions {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	getModel: () => Model<any> | undefined;
	getExtensionRunner: () => ExtensionRunner | undefined;
	getRequiredRequestAuth: (model: Model<any>) => Promise<RequestAuth>;
	disconnectFromAgent: () => void;
	reconnectToAgent: () => void;
	abortAgent: () => Promise<void>;
	waitForEventLoop: () => Promise<void>;
}

export class AgentSessionTreeCoordinator {
	private branchSummaryAbortController: AbortController | undefined = undefined;

	constructor(private readonly options: AgentSessionTreeCoordinatorOptions) {}

	get isRunning(): boolean {
		return this.branchSummaryAbortController !== undefined;
	}

	abort(): void {
		this.branchSummaryAbortController?.abort();
	}

	async navigateTree(
		targetId: string,
		options: NavigateTreeOptions = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		// Cheap pre-check before touching the agent: navigating to the current
		// leaf is a no-op and must not interrupt an active run.
		if (targetId === this.options.sessionManager.getLeafId()) {
			return { cancelled: false };
		}

		// Streaming guard: abort any active run and drain the event queue before
		// moving the leaf, so in-flight message_end events cannot append
		// old-branch entries under the new leaf and live state is not clobbered
		// mid-run. Same pattern as compact().
		this.options.disconnectFromAgent();
		try {
			await this.options.abortAgent();
			await this.options.waitForEventLoop();
			return await this.navigateTreeInner(targetId, options);
		} finally {
			this.options.reconnectToAgent();
		}
	}

	private async navigateTreeInner(
		targetId: string,
		options: NavigateTreeOptions,
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		const oldLeafId = this.options.sessionManager.getLeafId();
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		const model = this.options.getModel();
		if (options.summarize && !model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.options.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.options.sessionManager,
			oldLeafId,
			targetId,
		);

		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		this.branchSummaryAbortController = new AbortController();
		// try/finally: any error below (extension emit, auth, summary generation,
		// branch rewrite) must not leak the controller and leave isRunning stuck true.
		try {
			let extensionSummary: { summary: string; details?: unknown } | undefined;
			let fromExtension = false;

			const extensionRunner = this.options.getExtensionRunner();
			if (extensionRunner?.hasHandlers("session_before_tree")) {
				const result = (await extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this.branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			let summaryText: string | undefined;
			let summaryDetails: unknown;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const currentModel = model!;
				const { apiKey, headers } = await this.options.getRequiredRequestAuth(currentModel);
				const branchSummarySettings = this.options.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model: currentModel,
					apiKey,
					headers,
					signal: this.branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
			}

			let newLeafId: string | null;
			let editorText: string | undefined;
			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				newLeafId = targetEntry.parentId;
				editorText = this.extractUserMessageText(targetEntry.message.content);
			} else if (targetEntry.type === "custom_message") {
				newLeafId = targetEntry.parentId;
				editorText =
					typeof targetEntry.content === "string"
						? targetEntry.content
						: targetEntry.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
			} else {
				newLeafId = targetId;
			}

			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				const summaryId = this.options.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
				);
				summaryEntry = this.options.sessionManager.getEntry(summaryId) as BranchSummaryEntry;
				if (label) {
					this.options.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				this.options.sessionManager.resetLeaf();
			} else {
				this.options.sessionManager.branch(newLeafId);
			}

			if (label && !summaryText) {
				this.options.sessionManager.appendLabelChange(targetId, label);
			}

			const sessionContext = this.options.sessionManager.buildSessionContext();
			this.options.agent.state.messages = sessionContext.messages;

			if (extensionRunner) {
				await extensionRunner.emit({
					type: "session_tree",
					newLeafId: this.options.sessionManager.getLeafId(),
					oldLeafId,
					summaryEntry,
					fromExtension: summaryText ? fromExtension : undefined,
				});
			}

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this.branchSummaryAbortController = undefined;
		}
	}

	private extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
		}
		return "";
	}
}
