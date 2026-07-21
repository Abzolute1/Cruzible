import type { AssistantMessage, AssistantMessageEvent } from "../types.js";

export interface EventStreamStallOptions<T> {
	/** Max silence between pushed events before a synthetic stall event terminates the stream. 0/undefined disables. */
	stallTimeoutMs?: number;
	/** Builds the terminal event emitted when a stall is detected. */
	createStallEvent?: (stallTimeoutMs: number) => T;
}

// Generic event stream class for async iteration
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue: T[] = [];
	private waiting: ((value: IteratorResult<T>) => void)[] = [];
	private done = false;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private stallTimer?: ReturnType<typeof setTimeout>;

	constructor(
		private isComplete: (event: T) => boolean,
		private extractResult: (event: T) => R,
		private createFallbackResult?: () => R,
		private stallOptions?: EventStreamStallOptions<T>,
	) {
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
		this.armStallWatchdog();
	}

	private armStallWatchdog(): void {
		if (this.stallTimer) clearTimeout(this.stallTimer);
		const timeoutMs = this.stallOptions?.stallTimeoutMs;
		const createStallEvent = this.stallOptions?.createStallEvent;
		if (!timeoutMs || timeoutMs <= 0 || !createStallEvent || this.done) return;
		this.stallTimer = setTimeout(() => {
			if (this.done) return;
			// No events arrived within the stall window: the producer is almost certainly
			// dead (server hung, connection silently dropped). Terminate instead of
			// letting consumers wait forever.
			this.push(createStallEvent(timeoutMs));
			this.end();
		}, timeoutMs);
		(this.stallTimer as { unref?: () => void }).unref?.();
	}

	push(event: T): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		// Deliver to waiting consumer or queue it
		const waiter = this.waiting.shift();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
		this.armStallWatchdog();
	}

	end(result?: R): void {
		if (this.stallTimer) clearTimeout(this.stallTimer);
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		} else if (this.createFallbackResult) {
			// Stream ended without a terminal event — resolve with a synthetic
			// result so result() consumers can't hang. No-op if a terminal
			// event already resolved the promise.
			this.resolveFinalResult(this.createFallbackResult());
		}
		// Notify all waiting consumers that we're done
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter({ value: undefined as any, done: true });
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift()!;
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
				if (result.done) return;
				yield result.value;
			}
		}
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

export function stalledAssistantMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "",
		provider: "",
		model: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

/**
 * Inactivity watchdog for provider streams, in milliseconds. Local servers (LM Studio
 * et al.) can go silent mid-generation without closing the connection; without a stall
 * timeout the run hangs forever. Default 600s: large local reasoning models are
 * frequently busy-but-wire-silent for several minutes (verified: server GENERATING
 * while emitting nothing), so anything shorter risks aborting legitimate generations.
 * AG1_STREAM_STALL_TIMEOUT_MS overrides; 0 disables.
 */
export function readStallTimeoutMs(): number {
	const raw = typeof process !== "undefined" ? process.env?.AG1_STREAM_STALL_TIMEOUT_MS : undefined;
	if (raw === undefined || raw === "") return 600_000;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 600_000;
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
			() => stalledAssistantMessage("stream ended without completion"),
			{
				stallTimeoutMs: readStallTimeoutMs(),
				createStallEvent: (timeoutMs) => ({
					type: "error",
					reason: "error",
					error: stalledAssistantMessage(
						`Provider stream stalled: no events for ${Math.round(timeoutMs / 1000)}s. The connection was terminated (server hung or silently dropped it). Retry the request.`,
					),
				}),
			},
		);
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
