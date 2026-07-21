/**
 * Subagent concurrency scheduler — a semaphore pair, not a free-for-all.
 *
 * LM Studio is single-slot: parallel local subagent streams kill each other
 * ("terminated" mid-stream). Local-routed subagents therefore serialize on a
 * depth-1 slot. API providers tolerate concurrency, so they share a depth-3
 * pool. Foreground task calls that arrive while the slot is taken simply wait
 * their turn inside the parent's tool execution.
 */

import type { Model } from "@ag1/ai";

export interface SubagentSchedulerLimits {
	/** Max concurrent subagents on local models. Default 1 (single GPU slot). */
	localDepth?: number;
	/** Max concurrent subagents on API providers. Default 3. */
	apiDepth?: number;
}

class Semaphore {
	private available: number;
	private readonly waiters: Array<() => void> = [];

	constructor(private readonly capacity: number) {
		this.available = capacity;
	}

	async acquire(): Promise<void> {
		if (this.available > 0) {
			this.available--;
			return;
		}
		await new Promise<void>((resolve) => this.waiters.push(resolve));
	}

	release(): void {
		const next = this.waiters.shift();
		if (next) {
			next();
			return;
		}
		this.available = Math.min(this.available + 1, this.capacity);
	}

	get queueLength(): number {
		return this.waiters.length;
	}
}

let localSlot = new Semaphore(1);
let apiPool = new Semaphore(3);

/** Test hook: reconfigure pool depths (also resets any queued state). */
export function configureSubagentScheduler(limits: SubagentSchedulerLimits): void {
	localSlot = new Semaphore(Math.max(1, limits.localDepth ?? 1));
	apiPool = new Semaphore(Math.max(1, limits.apiDepth ?? 3));
}

function poolForModel(model: Model<any>): Semaphore {
	return model.provider === "local" ? localSlot : apiPool;
}

/**
 * Acquire a subagent execution slot for the given model. Resolves to a release
 * function that MUST be called exactly once (typically in a finally block).
 */
export async function acquireSubagentSlot(model: Model<any>): Promise<() => void> {
	const pool = poolForModel(model);
	await pool.acquire();
	let released = false;
	return () => {
		if (released) return;
		released = true;
		pool.release();
	};
}

/** Introspection for tests/diagnostics. */
export function subagentSchedulerState(): { localQueue: number; apiQueue: number } {
	return { localQueue: localSlot.queueLength, apiQueue: apiPool.queueLength };
}
