import type { AssistantMessageEvent, Context, Model } from "@ag1/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProxyAssistantMessageEvent, streamProxy } from "../src/proxy.js";

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

function sseStream(events: Array<ProxyAssistantMessageEvent | string>): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const event of events) {
				const data = typeof event === "string" ? event : JSON.stringify(event);
				controller.enqueue(encoder.encode(`data: ${data}\n\n`));
			}
			controller.close();
		},
	});
}

function mockFetchWith(events: Array<ProxyAssistantMessageEvent | string>) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(sseStream(events), { status: 200 })),
	);
}

/** Raw SSE chunks for tests that need exact control over framing. */
function mockFetchRaw(chunks: string[]) {
	const encoder = new TextEncoder();
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							for (const chunk of chunks) {
								controller.enqueue(encoder.encode(chunk));
							}
							controller.close();
						},
					}),
					{ status: 200 },
				),
		),
	);
}

describe("streamProxy", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("should resolve result() with an error when the server closes without a completion event", async () => {
		mockFetchWith([
			{ type: "start" },
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "partial" },
		]);

		const stream = streamProxy(createModel(), createContext(), {
			authToken: "token",
			proxyUrl: "https://proxy.example",
		});

		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const errorEvent = events.find((e) => e.type === "error");
		expect(errorEvent).toBeDefined();
		if (errorEvent?.type === "error") {
			expect(errorEvent.reason).toBe("error");
			expect(errorEvent.error.errorMessage).toBe(
				"Stream ended unexpectedly: connection closed without completion event",
			);
		}

		// Must resolve (not hang) with the partial message
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Stream ended unexpectedly: connection closed without completion event");
	});

	it("should skip malformed SSE lines and still complete on a later done event", async () => {
		mockFetchWith([{ type: "start" }, "{not valid json", { type: "done", reason: "stop", usage: createUsage() }]);

		const stream = streamProxy(createModel(), createContext(), {
			authToken: "token",
			proxyUrl: "https://proxy.example",
		});

		for await (const _event of stream) {
			// consume
		}

		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
	});

	it("should accept data: lines without a space after the colon", async () => {
		mockFetchRaw([
			`data:${JSON.stringify({ type: "start" })}\n\ndata:${JSON.stringify({ type: "done", reason: "stop", usage: createUsage() })}\n\n`,
		]);

		const stream = streamProxy(createModel(), createContext(), {
			authToken: "token",
			proxyUrl: "https://proxy.example",
		});

		for await (const _event of stream) {
			// consume
		}

		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
	});

	it("should resolve result() with a stall error when the stream goes silent", async () => {
		process.env.AG1_STREAM_STALL_TIMEOUT_MS = "40";
		try {
			const encoder = new TextEncoder();
			vi.stubGlobal(
				"fetch",
				vi.fn(
					async () =>
						new Response(
							new ReadableStream({
								start(controller) {
									controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "start" })}\n\n`));
									// never closes: simulates a hung proxy connection
								},
							}),
							{ status: 200 },
						),
				),
			);

			const stream = streamProxy(createModel(), createContext(), {
				authToken: "token",
				proxyUrl: "https://proxy.example",
			});

			const result = await stream.result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("stalled");
		} finally {
			delete process.env.AG1_STREAM_STALL_TIMEOUT_MS;
		}
	});

	it("should process a trailing SSE line without a final newline", async () => {
		// No trailing newline after the done event: the tail only surfaces after
		// the decoder's final flush and the leftover buffer is processed.
		mockFetchRaw([
			`data: ${JSON.stringify({ type: "start" })}\n\ndata: ${JSON.stringify({ type: "done", reason: "stop", usage: createUsage() })}`,
		]);

		const stream = streamProxy(createModel(), createContext(), {
			authToken: "token",
			proxyUrl: "https://proxy.example",
		});

		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(events.some((event) => event.type === "done")).toBe(true);
	});
});
