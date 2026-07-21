// Auton — Cost Tracking and Budget Status Hook
//
// Wires cost tracking and budget status into AG1's AgentSession lifecycle.
// Provides: cost tracking, budget status reporting, and behavioral prompt injection.

import type { AssistantMessage, Model } from "@ag1/ai";
import type { AgentSessionEvent, AgentSessionEventListener } from "../agent-session.js";
import { AUTON_BEHAVIORAL_PROMPT } from "./behavioral-prompt.js";
import { type CompactionPolicy, selectCompactionPolicy } from "./compaction-policy.js";
import { CostTracker, MODEL_PRICING_MAP, type PricingModel, QWEN_PRICING } from "./cost-tracker.js";

export interface AutonConfig {
	/** Maximum cost in USD (0 = unlimited) */
	maxCost?: number;
	/** Maximum tokens (0 = unlimited) */
	maxTokens?: number;
	/** Maximum turns (0 = unlimited) */
	maxTurns?: number;
	/** Enable nudge engine (default: true) */
	enableNudges?: boolean;
	/** Append behavioral prompt to system prompt (default: false) */
	enableBehavioralPrompt?: boolean;
	/** Pricing model for cost calculation */
	pricing?: PricingModel;
	/** Model ID for per-model pricing resolution */
	modelId?: string;
	/** Context window size for compaction policy */
	contextWindow?: number;
	/** Verbosity for debug logging */
	verbose?: boolean;
}

export interface BudgetStatus {
	costUsed: number;
	costAuthoritative: boolean;
	tokensUsed: number;
	turnsUsed: number;
	exceeded: {
		cost: boolean;
		tokens: boolean;
		turns: boolean;
	};
}

export class AutonHook {
	private costTracker: CostTracker;
	private compactionPolicy: CompactionPolicy | null;
	private turnCount = 0;
	private session: { unsubscribe?: () => void } | null = null;
	private _budgetCheckInterval: ReturnType<typeof setInterval> | null = null;

	// Config
	readonly maxCost: number;
	readonly maxTokens: number;
	readonly maxTurns: number;
	readonly enableNudges: boolean;
	readonly enableBehavioralPrompt: boolean;
	readonly verbose: boolean;

	constructor(config: AutonConfig = {}) {
		this.maxCost = config.maxCost ?? 0;
		this.maxTokens = config.maxTokens ?? 0;
		this.maxTurns = config.maxTurns ?? 0;
		this.enableNudges = config.enableNudges ?? true;
		this.enableBehavioralPrompt = config.enableBehavioralPrompt ?? false;
		this.verbose = config.verbose ?? false;

		const pricing = config.pricing ?? QWEN_PRICING;
		const modelId = config.modelId ?? "";
		this.costTracker = new CostTracker(pricing, modelId, MODEL_PRICING_MAP, pricing.authoritative === true);

		// Select compaction policy based on context window
		if (config.contextWindow) {
			this.compactionPolicy = selectCompactionPolicy(config.contextWindow);
		} else {
			this.compactionPolicy = null;
		}
	}

	/** Bind to a session — wires the message_end handler into the session lifecycle */
	bindSession(session: { subscribe: (listener: AgentSessionEventListener) => () => void; model?: Model<any> }): void {
		// The model's declared rates make the budget hard-stop real: without them
		// every pricing path is an estimate and --max-cost never enforces.
		this.costTracker.setDeclaredModelCost(session.model?.cost);
		const handler: AgentSessionEventListener = (event: AgentSessionEvent) => {
			if (
				event.type === "message_end" &&
				"message" in event &&
				(event as { message: AssistantMessage }).message.role === "assistant"
			) {
				const msg = (event as { message: AssistantMessage }).message;
				if (msg.usage) {
					this.costTracker.recordUsage(
						msg.usage.input,
						msg.usage.output,
						msg.usage.cacheRead ?? 0,
						msg.usage.cacheWrite ?? 0,
					);
					if (this.verbose) {
						process.stderr.write(`[Auton] Cost: ${this.costTracker.getSummary()}\n`);
					}
				}
				this.turnCount++;
			}
		};
		const unsubscribe = session.subscribe(handler);
		this.session = { unsubscribe };
	}

	/**
	 * Get handler for message_end events.
	 * Records cost after each model response.
	 */
	getMessageEndHandler(): (event: { type: string; message: AssistantMessage }) => void {
		return (event: { type: string; message: AssistantMessage }) => {
			if (event.message.role === "assistant") {
				const msg = event.message;
				if (msg.usage) {
					this.costTracker.recordUsage(
						msg.usage.input,
						msg.usage.output,
						msg.usage.cacheRead ?? 0,
						msg.usage.cacheWrite ?? 0,
					);
					if (this.verbose) {
						process.stderr.write(`[Auton] Cost: ${this.costTracker.getSummary()}\n`);
					}
				}
				this.turnCount++;
			}
		};
	}

	/**
	 * Public method to record token usage. Used by attachAutonHook's inline handler.
	 */
	recordUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): void {
		this.costTracker.recordUsage(input, output, cacheRead, cacheWrite);
		if (this.verbose) {
			process.stderr.write(`[Auton] Cost: ${this.costTracker.getSummary()}\n`);
		}
		this.turnCount++;
	}

	/**
	 * Get behavioral prompt to append to system prompt.
	 */
	getBehavioralPrompt(): string {
		return this.enableBehavioralPrompt ? AUTON_BEHAVIORAL_PROMPT : "";
	}

	/**
	 * Get current budget status.
	 */
	getBudgetStatus(): BudgetStatus {
		const costSummary = this.costTracker.getCostSummary();
		const costExceeded = costSummary.authoritative && this.maxCost > 0 && costSummary.totalCost >= this.maxCost;
		const tokensExceeded =
			this.maxTokens > 0 &&
			this.costTracker.totalInputTokens +
				this.costTracker.totalOutputTokens +
				this.costTracker.totalCacheReadTokens +
				this.costTracker.totalCacheWriteTokens >=
				this.maxTokens;
		const turnsExceeded = this.maxTurns > 0 && this.turnCount >= this.maxTurns;

		return {
			costUsed: costSummary.totalCost,
			costAuthoritative: costSummary.authoritative,
			tokensUsed:
				this.costTracker.totalInputTokens +
				this.costTracker.totalOutputTokens +
				this.costTracker.totalCacheReadTokens +
				this.costTracker.totalCacheWriteTokens,
			turnsUsed: this.turnCount,
			exceeded: {
				cost: costExceeded,
				tokens: tokensExceeded,
				turns: turnsExceeded,
			},
		};
	}

	/**
	 * Throw if any budget is exceeded.
	 */
	abortIfBudgetExceeded(): void {
		const status = this.getBudgetStatus();

		if (status.exceeded.cost) {
			throw new Error(
				`Cost budget exceeded: $${status.costUsed.toFixed(2)} used (limit: $${this.maxCost.toFixed(2)})`,
			);
		}

		if (status.exceeded.tokens) {
			throw new Error(
				`Token budget exceeded: ${status.tokensUsed.toLocaleString()} tokens used (limit: ${this.maxTokens.toLocaleString()})`,
			);
		}

		if (status.exceeded.turns) {
			throw new Error(`Turn budget exceeded: ${status.turnsUsed} turns used (limit: ${this.maxTurns})`);
		}
	}

	/**
	 * Get cost tracker summary for display.
	 */
	getCostSummary(): string {
		return this.costTracker.getSummary();
	}

	/**
	 * Get the compaction policy trigger threshold (in tokens), or null if
	 * no context window was configured. Used by the autonomous loop to decide
	 * when to proactively compact.
	 */
	getCompactionTriggerTokens(): number | null {
		if (!this.compactionPolicy) return null;
		return Math.floor(this.compactionPolicy.contextWindow * this.compactionPolicy.triggerThreshold);
	}

	/** Cleanup — removes event listeners, clears intervals, releases resources */
	dispose(): void {
		// Clear any budget check intervals
		if (this._budgetCheckInterval !== null) {
			clearInterval(this._budgetCheckInterval);
			this._budgetCheckInterval = null;
		}

		// Unsubscribe from session events
		if (this.session?.unsubscribe) {
			this.session.unsubscribe();
		}

		// Clear references
		this.session = null;

		// Reset turn counter
		this.turnCount = 0;
	}
}

/**
 * Factory function to create an AutonHook from config.
 */
export function createAutonHook(config: AutonConfig): AutonHook {
	return new AutonHook(config);
}

/**
 * Attaches auton hooks (cost tracking, budget enforcement, nudges, behavioral prompt)
 * to a running agent session runtime. This is the primary integration point called
 * from main.ts after session creation.
 *
 * Wires the AutonHook's message_end handler into the session's event pipeline so
 * that every assistant response is recorded for cost/token/turn budget tracking.
 */
export function attachAutonHook(
	runtime: {
		session: {
			subscribe: (listener: AgentSessionEventListener) => () => void;
			agent: {
				state: { systemPrompt: string };
			};
		};
	},
	modelId: string,
	config: {
		maxCostUsd?: number;
		maxTokens?: number;
		maxTurns?: number;
		maxOutputPerTurn?: number;
		pricing?: PricingModel;
		contextWindow?: number;
		enableNudges?: boolean;
		enableBehavioralPrompt?: boolean;
		verbose?: boolean;
	},
): AutonHook {
	const hook = new AutonHook({
		maxCost: config.maxCostUsd ?? 0,
		maxTokens: config.maxTokens ?? 0,
		maxTurns: config.maxTurns ?? 0,
		enableNudges: config.enableNudges ?? true,
		enableBehavioralPrompt: config.enableBehavioralPrompt ?? false,
		pricing: config.pricing,
		modelId,
		contextWindow: config.contextWindow,
		verbose: config.verbose,
	});

	// Wire message_end handler for cost/token/turn tracking via session.subscribe
	const handler: AgentSessionEventListener = (event: AgentSessionEvent) => {
		if (
			event.type === "message_end" &&
			"message" in event &&
			(event as { message: AssistantMessage }).message.role === "assistant"
		) {
			const msg = (event as { message: AssistantMessage }).message;
			if (msg.usage) {
				hook.recordUsage(msg.usage.input, msg.usage.output, msg.usage.cacheRead ?? 0, msg.usage.cacheWrite ?? 0);
			}
		}
	};
	const unsubscribe = runtime.session.subscribe(handler);

	// Store unsubscribe for cleanup
	(hook as unknown as Record<string, { unsubscribe?: () => void } | null>).session = { unsubscribe };

	// Append behavioral prompt if enabled
	if (hook.enableBehavioralPrompt) {
		runtime.session.agent.state.systemPrompt += AUTON_BEHAVIORAL_PROMPT;
	}

	// Log budget configuration on attach
	if (hook.verbose) {
		const limits: string[] = [];
		if (hook.maxCost > 0) {
			limits.push(
				hook.getBudgetStatus().costAuthoritative
					? `cost=$${hook.maxCost.toFixed(2)}`
					: `cost~$${hook.maxCost.toFixed(2)} (estimate-only)`,
			);
		}
		if (hook.maxTokens > 0) limits.push(`tokens=${hook.maxTokens.toLocaleString()}`);
		if (hook.maxTurns > 0) limits.push(`turns=${hook.maxTurns}`);
		if (limits.length > 0) {
			process.stderr.write(`[Auton] Budget limits: ${limits.join(", ")}\n`);
		} else {
			process.stderr.write("[Auton] No budget limits set (unlimited mode)\n");
		}
	}

	return hook;
}
