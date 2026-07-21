import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

describe("AssistantMessageEventStream", () => {
	it("resolves result() with a synthetic error when ended without a terminal event", async () => {
		const stream = new AssistantMessageEventStream();
		stream.end();

		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("stream ended without completion");
	});

	it("keeps explicit end(result) behavior unchanged", async () => {
		const stream = new AssistantMessageEventStream();
		const message = { role: "assistant", stopReason: "stop" } as AssistantMessage;
		stream.end(message);

		expect(await stream.result()).toBe(message);
	});

	it("prefers a terminal event over the synthetic fallback", async () => {
		const stream = new AssistantMessageEventStream();
		const message = { role: "assistant", stopReason: "stop" } as AssistantMessage;
		stream.push({ type: "done", reason: "stop", message });
		stream.end();

		expect(await stream.result()).toBe(message);
	});

	it("terminates with a stall error when no events arrive within the stall window", async () => {
		process.env.AG1_STREAM_STALL_TIMEOUT_MS = "40";
		try {
			const stream = new AssistantMessageEventStream();
			const result = await stream.result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("stalled");
			expect(result.errorMessage).toContain("terminated");
		} finally {
			delete process.env.AG1_STREAM_STALL_TIMEOUT_MS;
		}
	});

	it("does not fire the stall watchdog while events keep arriving", async () => {
		process.env.AG1_STREAM_STALL_TIMEOUT_MS = "60";
		try {
			const stream = new AssistantMessageEventStream();
			const message = { role: "assistant", stopReason: "stop" } as AssistantMessage;
			for (let i = 0; i < 5; i++) {
				stream.push({
					type: "text_delta",
					contentIndex: 0,
					delta: "x",
					partial: message,
				} as Parameters<AssistantMessageEventStream["push"]>[0]);
				await new Promise((resolve) => setTimeout(resolve, 30));
			}
			stream.push({ type: "done", reason: "stop", message });
			expect(await stream.result()).toBe(message);
		} finally {
			delete process.env.AG1_STREAM_STALL_TIMEOUT_MS;
		}
	});
});
