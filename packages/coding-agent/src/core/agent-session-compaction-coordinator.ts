import type { Agent } from "@ag1/agent-core";
import type { AssistantMessage, Model } from "@ag1/ai";
import type { AgentSessionEvent } from "./agent-session.js";
import type { AgentSessionRecoveryArbiter } from "./agent-session-recovery-arbiter.js";
import { AgentSessionRecoveryReplayScheduler } from "./agent-session-recovery-replay-scheduler.js";
import { getAutoCompactTrigger, selectCompactionPolicy } from "./auton/compaction-policy.js";
import {
	type CompactionPreparation,
	type CompactionResult,
	compact,
	estimateContextTokens,
	microCompact,
	prepareCompaction,
	selectCompactionStrategy,
	snipHistory,
} from "./compaction/index.js";
import type { ExtensionRunner, SessionBeforeCompactResult } from "./extensions/index.js";
import type { ModelRegistry } from "./model-registry.js";
import { selectCheapModelForTask } from "./model-routing.js";
import type { CompactionEntry, SessionManager } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";

type AutoCompactionReason = "overflow" | "threshold";

/**
 * Bound on the summarization LLM call during compaction. The call sits on the
 * session event loop's critical path — a provider that accepts the request and
 * then hangs would otherwise stall the whole session forever. Local models can
 * be slow to prefill large contexts, so the default is generous; the guard
 * exists to catch *unresponsive* providers, not to tune latency.
 * Override with AG1_COMPACTION_TIMEOUT_MS (read at call time so tests and
 * embedders can adjust without re-importing).
 */
const DEFAULT_COMPACTION_LLM_TIMEOUT_MS = 180_000;

function compactionLlmTimeoutMs(): number {
	const raw = Number(process.env.AG1_COMPACTION_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_COMPACTION_LLM_TIMEOUT_MS;
}

export class CompactionTimeoutError extends Error {
	constructor(timeoutMs: number) {
		const budget = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
		super(
			`Compaction summarization timed out after ${budget} (provider unresponsive). Continuing without compaction.`,
		);
		this.name = "CompactionTimeoutError";
	}
}

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
	recordToolOutcome?: (outcome: any) => void;
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
		// Concurrency guard: a second manual compact (or an auto-compaction
		// triggered from the event queue while a manual one is active) would
		// overwrite manualAbortController and interleave commits.
		if (this.isCompacting) {
			throw new Error("Compaction already in progress");
		}
		this.options.disconnectFromAgent();
		await this.options.abortAgent();
		this.manualAbortController = new AbortController();
		this.options.emit({ type: "compaction_start", reason: "manual" });

		try {
			const model = this.options.getModel();
			if (!model) {
				throw new Error("No model selected");
			}

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
			const summaryModel = this.selectSummarizationModel(model, preparation.tokensBefore);
			const { apiKey, headers } = await this.options.getRequiredRequestAuth(summaryModel);

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
				: await this.compactWithTimeout(
						preparation,
						summaryModel,
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

	async runAuto(reason: AutoCompactionReason, willRetry: boolean): Promise<void> {
		// Skip auto-compaction while another compaction (manual or auto) is
		// active instead of interleaving abort controllers and commits.
		if (this.isCompacting) {
			this.emitNoopAutoCompaction(reason);
			return;
		}

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

			const currentEstimate = estimateContextTokens(this.options.agent.state.messages);
			const strategy = selectCompactionStrategy(currentEstimate.tokens, policy);

			if (strategy === "micro") {
				// TODO(S1b): microCompact/snipHistory mutate only the live message
				// array (truncating tool results, replacing/splicing message
				// objects), while the session file keeps the full history — the
				// savings vanish on any rebuild/reload. Persisting these edits
				// needs entry-level context editing (entries are append-only and
				// snip removes whole messages mid-branch), i.e. a rearchitecture;
				// until then the session file cannot be the source of truth here.
				const truncated = microCompact(
					this.options.agent.state.messages,
					policy.autoCompactKeepTurns,
					this.options.recordToolOutcome,
				);
				if (truncated > 0) {
					const newEstimate = estimateContextTokens(this.options.agent.state.messages);
					const freedTokens = currentEstimate.tokens - newEstimate.tokens;
					process.stderr.write?.(
						`[Compaction] Micro-compact freed ${freedTokens} tokens (${truncated} stale items compacted)\n`,
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
			const summaryModel = this.selectSummarizationModel(model, preparation.tokensBefore);
			const authResult = await this.options.modelRegistry.getApiKeyAndHeaders(summaryModel);
			if (!authResult.ok) {
				this.emitNoopAutoCompaction(reason);
				return;
			}
			const { headers } = authResult;
			const apiKey = authResult.apiKey ?? "not-needed";

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
				: await this.compactWithTimeout(
						preparation,
						summaryModel,
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

	private selectSummarizationModel(currentModel: Model<any>, tokensBefore: number): Model<any> {
		const minContextWindow = Math.min(Math.max(tokensBefore, 32_768), 128_000);
		return selectCheapModelForTask({
			task: "summarization",
			currentModel,
			candidates: this.getAvailableRoutingModels(),
			minContextWindow,
			minMaxTokens: 2_048,
		}).model;
	}

	/**
	 * Run the summarization pass bounded by compactionLlmTimeoutMs(). The
	 * timeout aborts a linked controller (cancelling the HTTP request where the
	 * provider honors the signal) and rejects with CompactionTimeoutError either
	 * way — even a provider that ignores aborts cannot stall the event loop.
	 * The parent signal still wins for genuine user cancellation.
	 */
	private compactWithTimeout(
		preparation: CompactionPreparation,
		summaryModel: Model<any>,
		apiKey: string,
		headers: Record<string, string> | undefined,
		customInstructions: string | undefined,
		parentSignal: AbortSignal,
	): Promise<CompactionResult> {
		const timeoutMs = compactionLlmTimeoutMs();
		const controller = new AbortController();
		const onParentAbort = () => controller.abort();
		if (parentSignal.aborted) {
			controller.abort();
		} else {
			parentSignal.addEventListener("abort", onParentAbort, { once: true });
		}

		const compactPromise = compact(preparation, summaryModel, apiKey, headers, customInstructions, controller.signal);
		// When the timeout wins the race this promise is abandoned; swallow any
		// late rejection so it never surfaces as an unhandledRejection.
		compactPromise.catch(() => {});

		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new CompactionTimeoutError(timeoutMs));
			}, timeoutMs);
		});

		return Promise.race([compactPromise, timeoutPromise]).finally(() => {
			if (timer) {
				clearTimeout(timer);
			}
			parentSignal.removeEventListener("abort", onParentAbort);
		});
	}

	private getAvailableRoutingModels(): Model<any>[] {
		try {
			return this.options.modelRegistry.getAvailable();
		} catch {
			return [];
		}
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
			onRunError: (error) => {
				// Log + surface: a rejected continue() must not vanish into the scheduler's catch.
				const message = error instanceof Error ? error.message : String(error);
				console.error(`[AgentSession] Auto-continue after compaction failed: ${message}`);
				this.options.emit({ type: "recovery_replay_error", owner: "compaction", message });
			},
		});
	}
}
