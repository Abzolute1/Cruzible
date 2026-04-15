import type { Agent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Model } from "@mariozechner/pi-ai";
import { isContextOverflow } from "@mariozechner/pi-ai";
import { getAutoCompactTrigger, selectCompactionPolicy } from "./auton/compaction-policy.js";
import type { AgentSessionRecoveryArbiter } from "./agent-session-recovery-arbiter.js";
import { AgentSessionRecoveryReplayScheduler } from "./agent-session-recovery-replay-scheduler.js";
import {
	type CompactionResult,
	calculateContextTokens,
	compact,
	estimateContextTokens,
	microCompact,
	prepareCompaction,
	selectCompactionStrategy,
	shouldCompact,
	snipHistory,
} from "./compaction/index.js";
import type { ExtensionRunner, SessionBeforeCompactResult } from "./extensions/index.js";
import type { ModelRegistry } from "./model-registry.js";
import type { CompactionEntry, SessionManager } from "./session-manager.js";
import { getLatestCompactionEntry } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";
import type { AgentSessionEvent } from "./agent-session.js";

type AutoCompactionReason = "overflow" | "threshold";

interface RequestAuth {
	apiKey: string;
	headers?: Record<string, string>;
}

export interface AgentSessionCompactionCoordinatorOptions {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	modelRegistry: ModelRegistry;
	getModel: () => Model<any> | undefined;
	getContextWindow: () => number | undefined;
	getExtensionRunner: () => ExtensionRunner | undefined;
	getRequiredRequestAuth: (model: Model<any>) => Promise<RequestAuth>;
	emit: (event: AgentSessionEvent) => void;
	disconnectFromAgent: () => void;
	reconnectToAgent: () => void;
	abortAgent: () => Promise<void>;
	recoveryArbiter: AgentSessionRecoveryArbiter;
}

export class AgentSessionCompactionCoordinator {
	private manualAbortController: AbortController | undefined = undefined;
	private autoAbortController: AbortController | undefined = undefined;
	private overflowRecoveryAttempted = false;
	private readonly replayScheduler: AgentSessionRecoveryReplayScheduler;

	constructor(private readonly options: AgentSessionCompactionCoordinatorOptions) {
		this.replayScheduler = new AgentSessionRecoveryReplayScheduler({
			owner: "compaction",
			recoveryArbiter: this.options.recoveryArbiter,
			getState: () => ({
				messages: this.options.agent.state.messages,
				isStreaming: this.options.agent.state.isStreaming === true,
				model: this.options.agent.state.model,
				thinkingLevel: this.options.agent.state.thinkingLevel,
			}),
			emit: this.options.emit,
		});
	}

	get isCompacting(): boolean {
		return this.manualAbortController !== undefined || this.autoAbortController !== undefined;
	}

	get hasOverflowRecoveryAttempted(): boolean {
		return this.overflowRecoveryAttempted;
	}

	markOverflowRecoveryAttempted(): void {
		this.overflowRecoveryAttempted = true;
	}

	resetOverflowRecovery(): void {
		this.overflowRecoveryAttempted = false;
	}

	abort(): void {
		this.manualAbortController?.abort();
		this.autoAbortController?.abort();
		this.replayScheduler.cancel();
	}

	async compact(customInstructions?: string): Promise<CompactionResult> {
		this.options.disconnectFromAgent();
		await this.options.abortAgent();
		this.manualAbortController = new AbortController();
		this.options.emit({ type: "compaction_start", reason: "manual" });

		try {
			const model = this.options.getModel();
			if (!model) {
				throw new Error("No model selected");
			}

			const { apiKey, headers } = await this.options.getRequiredRequestAuth(model);
			const pathEntries = this.options.sessionManager.getBranch();
			const settings = this.options.settingsManager.getCompactionSettings();
			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;
			const extensionRunner = this.options.getExtensionRunner();
			if (extensionRunner?.hasHandlers("session_before_compact")) {
				const result = (await extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					signal: this.manualAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			const result = extensionCompaction
				? extensionCompaction
				: await compact(
						preparation,
						model,
						apiKey,
						headers,
						customInstructions,
						this.manualAbortController.signal,
					);

			if (this.manualAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			await this.commitCompaction(result, fromExtension);
			this.options.emit({
				type: "compaction_end",
				reason: "manual",
				result,
				aborted: false,
				willRetry: false,
			});
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			this.options.emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
			});
			throw error;
		} finally {
			this.manualAbortController = undefined;
			this.options.reconnectToAgent();
		}
	}

	async check(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<void> {
		const settings = this.options.settingsManager.getCompactionSettings();
		if (!settings.enabled) return;
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return;

		const contextWindow = this.options.getContextWindow() ?? 0;
		const model = this.options.getModel();
		const sameModel =
			model !== undefined && assistantMessage.provider === model.provider && assistantMessage.model === model.id;

		const compactionEntry = getLatestCompactionEntry(this.options.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return;
		}

		if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
			if (this.overflowRecoveryAttempted) {
				this.options.emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
				});
				return;
			}

			this.overflowRecoveryAttempted = true;
			const messages = this.options.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.options.agent.state.messages = messages.slice(0, -1);
			}
			await this.runAuto("overflow", true);
			return;
		}

		let contextTokens: number;
		if (assistantMessage.stopReason === "error") {
			const messages = this.options.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			if (estimate.lastUsageIndex === null) return;
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				compactionEntry &&
				usageMsg.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
			) {
				return;
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = calculateContextTokens(assistantMessage.usage);
		}

		if (shouldCompact(contextTokens, contextWindow, settings)) {
			await this.runAuto("threshold", false);
		}
	}

	async runAuto(reason: AutoCompactionReason, willRetry: boolean): Promise<void> {
		const settings = this.options.settingsManager.getCompactionSettings();
		const contextWindow = this.options.getContextWindow() ?? 32768;
		const policy = selectCompactionPolicy(contextWindow);

		this.options.emit({ type: "compaction_start", reason });
		this.autoAbortController = new AbortController();

		try {
			const model = this.options.getModel();
			if (!model) {
				this.emitNoopAutoCompaction(reason);
				return;
			}

			const authResult = await this.options.modelRegistry.getApiKeyAndHeaders(model);
			if (!authResult.ok || !authResult.apiKey) {
				this.emitNoopAutoCompaction(reason);
				return;
			}
			const { apiKey, headers } = authResult;

			const currentEstimate = estimateContextTokens(this.options.agent.state.messages);
			const strategy = selectCompactionStrategy(currentEstimate.tokens, policy);

			if (strategy === "micro") {
				const truncated = microCompact(this.options.agent.state.messages, policy.autoCompactKeepTurns);
				if (truncated > 0) {
					const newEstimate = estimateContextTokens(this.options.agent.state.messages);
					const freedTokens = currentEstimate.tokens - newEstimate.tokens;
					process.stderr.write?.(
						`[Compaction] Micro-compact freed ${freedTokens} tokens (${truncated} tool results truncated)\n`,
					);

					const newStrategy = selectCompactionStrategy(newEstimate.tokens, policy);
					if (newStrategy === null || newStrategy === "micro") {
						this.emitNoopAutoCompaction(reason);
						return;
					}
				}
			}

			if (
				strategy === "snip" ||
				selectCompactionStrategy(estimateContextTokens(this.options.agent.state.messages).tokens, policy) === "snip"
			) {
				const targetTokens =
					estimateContextTokens(this.options.agent.state.messages).tokens - getAutoCompactTrigger(policy);
				if (targetTokens > 0) {
					const { freedTokens } = snipHistory(
						this.options.agent.state.messages,
						targetTokens,
						policy.autoCompactKeepTurns,
					);
					process.stderr.write?.(`[Compaction] Snip freed ${freedTokens} tokens\n`);

					const newEstimate = estimateContextTokens(this.options.agent.state.messages);
					const newStrategy = selectCompactionStrategy(newEstimate.tokens, policy);
					if (newStrategy === null) {
						this.emitNoopAutoCompaction(reason);
						return;
					}
				}
			}

			const pathEntries = this.options.sessionManager.getBranch();
			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				this.emitNoopAutoCompaction(reason);
				return;
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;
			const extensionRunner = this.options.getExtensionRunner();
			if (extensionRunner?.hasHandlers("session_before_compact")) {
				const extensionResult = (await extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					signal: this.autoAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					this.options.emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					return;
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}

			const result = extensionCompaction
				? extensionCompaction
				: await compact(
						preparation,
						model,
						apiKey,
						headers,
						undefined,
						this.autoAbortController.signal,
					);

			if (this.autoAbortController.signal.aborted) {
				this.options.emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return;
			}

			await this.commitCompaction(result, fromExtension);
			this.options.emit({
				type: "compaction_end",
				reason,
				result,
				aborted: false,
				willRetry,
			});

			if (willRetry) {
				const messages = this.options.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).stopReason === "error") {
					this.options.agent.state.messages = messages.slice(0, -1);
				}
				this.scheduleAutoContinue(100);
			} else if (this.options.agent.hasQueuedMessages()) {
				this.scheduleAutoContinue(100);
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			this.options.emit({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage:
					reason === "overflow"
						? `Context overflow recovery failed: ${errorMessage}`
						: `Auto-compaction failed: ${errorMessage}`,
			});
		} finally {
			this.autoAbortController = undefined;
		}
	}

	private emitNoopAutoCompaction(reason: AutoCompactionReason): void {
		this.options.emit({
			type: "compaction_end",
			reason,
			result: undefined,
			aborted: false,
			willRetry: false,
		});
	}

	private async commitCompaction(result: CompactionResult, fromExtension: boolean): Promise<void> {
		this.options.sessionManager.appendCompaction(
			result.summary,
			result.firstKeptEntryId,
			result.tokensBefore,
			result.details,
			fromExtension,
		);
		const newEntries = this.options.sessionManager.getEntries();
		const sessionContext = this.options.sessionManager.buildSessionContext();
		this.options.agent.state.messages = sessionContext.messages;

		const savedCompactionEntry = newEntries.find(
			(entry) => entry.type === "compaction" && entry.summary === result.summary,
		) as CompactionEntry | undefined;
		const extensionRunner = this.options.getExtensionRunner();
		if (extensionRunner && savedCompactionEntry) {
			await extensionRunner.emit({
				type: "session_compact",
				compactionEntry: savedCompactionEntry,
				fromExtension,
			});
		}
	}

	private clearScheduledAutoContinue(): void {
		this.replayScheduler.cancel();
	}

	private scheduleAutoContinue(delayMs: number): void {
		this.clearScheduledAutoContinue();
		this.replayScheduler.schedule({
			delayMs,
			alreadyScheduledMessage: "Auto-continue skipped because another recovery path is already scheduled.",
			stateChangedMessage: "Auto-continue skipped because the session changed before replay.",
			run: () => this.options.agent.continue(),
		});
	}
}
