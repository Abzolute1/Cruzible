import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel, type Message } from "@ag1/ai";
import { describe, expect, it, vi } from "vitest";
import { Agent, type AgentEvent, type AgentMessage } from "../src/index.js";

// Mock stream that mimics AssistantMessageEventStream
class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createDeferred(): {
	promise: Promise<void>;
	resolve: () => void;
} {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("Agent", () => {
	it("should create an agent instance with default state", () => {
		const agent = new Agent();

		expect(agent.state).toBeDefined();
		expect(agent.state.systemPrompt).toBe("");
		expect(agent.state.model).toBeDefined();
		expect(agent.state.thinkingLevel).toBe("off");
		expect(agent.state.tools).toEqual([]);
		expect(agent.state.messages).toEqual([]);
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.streamingMessage).toBe(undefined);
		expect(agent.state.pendingToolCalls).toEqual(new Set());
		expect(agent.state.errorMessage).toBeUndefined();
	});

	it("should create an agent instance with custom initial state", () => {
		const customModel = getModel("openai", "gpt-4o-mini");
		const agent = new Agent({
			initialState: {
				systemPrompt: "You are a helpful assistant.",
				model: customModel,
				thinkingLevel: "low",
			},
		});

		expect(agent.state.systemPrompt).toBe("You are a helpful assistant.");
		expect(agent.state.model).toBe(customModel);
		expect(agent.state.thinkingLevel).toBe("low");
	});

	it("should subscribe to events", () => {
		const agent = new Agent();

		let eventCount = 0;
		const unsubscribe = agent.subscribe((_event) => {
			eventCount++;
		});

		// No initial event on subscribe
		expect(eventCount).toBe(0);

		// State mutators don't emit events
		agent.state.systemPrompt = "Test prompt";
		expect(eventCount).toBe(0);
		expect(agent.state.systemPrompt).toBe("Test prompt");

		// Unsubscribe should work
		unsubscribe();
		agent.state.systemPrompt = "Another prompt";
		expect(eventCount).toBe(0); // Should not increase
	});

	it("should await async subscribers before prompt resolves", async () => {
		const barrier = createDeferred();
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		let listenerFinished = false;
		agent.subscribe(async (event) => {
			if (event.type === "agent_end") {
				await barrier.promise;
				listenerFinished = true;
			}
		});

		let promptResolved = false;
		const promptPromise = agent.prompt("hello").then(() => {
			promptResolved = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(promptResolved).toBe(false);
		expect(listenerFinished).toBe(false);
		expect(agent.state.isStreaming).toBe(true);

		barrier.resolve();
		await promptPromise;

		expect(listenerFinished).toBe(true);
		expect(promptResolved).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("waitForIdle should wait for async subscribers", async () => {
		const barrier = createDeferred();
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		agent.subscribe(async (event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				await barrier.promise;
			}
		});

		const promptPromise = agent.prompt("hello");
		let idleResolved = false;
		const idlePromise = agent.waitForIdle().then(() => {
			idleResolved = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(idleResolved).toBe(false);
		expect(agent.state.isStreaming).toBe(true);

		barrier.resolve();
		await Promise.all([promptPromise, idlePromise]);

		expect(idleResolved).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("should pass the active abort signal to subscribers", async () => {
		let receivedSignal: AbortSignal | undefined;
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (options?.signal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		agent.subscribe((event, signal) => {
			if (event.type === "agent_start") {
				receivedSignal = signal;
			}
		});

		const promptPromise = agent.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(receivedSignal).toBeDefined();
		expect(receivedSignal?.aborted).toBe(false);

		agent.abort();
		await promptPromise;

		expect(receivedSignal?.aborted).toBe(true);
	});

	it("should update state with mutators", () => {
		const agent = new Agent();

		// Test setSystemPrompt
		agent.state.systemPrompt = "Custom prompt";
		expect(agent.state.systemPrompt).toBe("Custom prompt");

		// Test setModel
		const newModel = getModel("google", "gemini-2.5-flash");
		agent.state.model = newModel;
		expect(agent.state.model).toBe(newModel);

		// Test setThinkingLevel
		agent.state.thinkingLevel = "high";
		expect(agent.state.thinkingLevel).toBe("high");

		// Test setTools
		const tools = [{ name: "test", description: "test tool" } as any];
		agent.state.tools = tools;
		expect(agent.state.tools).toEqual(tools);
		expect(agent.state.tools).not.toBe(tools); // Should be a copy

		// Test replaceMessages
		const messages = [{ role: "user" as const, content: "Hello", timestamp: Date.now() }];
		agent.state.messages = messages;
		expect(agent.state.messages).toEqual(messages);
		expect(agent.state.messages).not.toBe(messages); // Should be a copy

		// Reads return copies: mutating a returned array must not affect internal state
		const toolsCopy = agent.state.tools;
		toolsCopy.push({ name: "other" } as any);
		expect(agent.state.tools).toHaveLength(1);

		const messagesCopy = agent.state.messages;
		messagesCopy.push({ role: "assistant", content: [{ type: "text", text: "Hi" }] } as any);
		expect(agent.state.messages).toHaveLength(1);

		// Test clearMessages
		agent.state.messages = [];
		expect(agent.state.messages).toEqual([]);
	});

	it("should support steering message queue", async () => {
		const agent = new Agent();

		const message = { role: "user" as const, content: "Steering message", timestamp: Date.now() };
		agent.steer(message);

		// The message is queued but not yet in state.messages
		expect(agent.state.messages).not.toContainEqual(message);
	});

	it("should support follow-up message queue", async () => {
		const agent = new Agent();

		const message = { role: "user" as const, content: "Follow-up message", timestamp: Date.now() };
		agent.followUp(message);

		// The message is queued but not yet in state.messages
		expect(agent.state.messages).not.toContainEqual(message);
	});

	it("should handle abort controller", () => {
		const agent = new Agent();

		// Should not throw even if nothing is running
		expect(() => agent.abort()).not.toThrow();
	});

	it("should throw when prompt() called while streaming", async () => {
		let abortSignal: AbortSignal | undefined;
		const agent = new Agent({
			// Use a stream function that responds to abort
			streamFn: (_model, _context, options) => {
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					// Check abort signal periodically
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		// Start first prompt (don't await, it will block until abort)
		const firstPrompt = agent.prompt("First message");

		// Wait a tick for isStreaming to be set
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(agent.state.isStreaming).toBe(true);

		// Second prompt should reject
		await expect(agent.prompt("Second message")).rejects.toThrow(
			"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
		);

		// Cleanup - abort to stop the stream
		agent.abort();
		await firstPrompt.catch(() => {}); // Ignore abort error
	});

	it("should throw when continue() called while streaming", async () => {
		let abortSignal: AbortSignal | undefined;
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		// Start first prompt
		const firstPrompt = agent.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(agent.state.isStreaming).toBe(true);

		// continue() should reject
		await expect(agent.continue()).rejects.toThrow(
			"Agent is already processing. Wait for completion before continuing.",
		);

		// Cleanup
		agent.abort();
		await firstPrompt.catch(() => {});
	});

	it("continue() should process queued follow-up messages after an assistant turn", async () => {
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Processed") });
				});
				return stream;
			},
		});

		agent.state.messages = [
			{
				role: "user",
				content: [{ type: "text", text: "Initial" }],
				timestamp: Date.now() - 10,
			},
			createAssistantMessage("Initial response"),
		];

		agent.followUp({
			role: "user",
			content: [{ type: "text", text: "Queued follow-up" }],
			timestamp: Date.now(),
		});

		await expect(agent.continue()).resolves.toBeUndefined();

		const hasQueuedFollowUp = agent.state.messages.some((message) => {
			if (message.role !== "user") return false;
			if (typeof message.content === "string") return message.content === "Queued follow-up";
			return message.content.some((part) => part.type === "text" && part.text === "Queued follow-up");
		});

		expect(hasQueuedFollowUp).toBe(true);
		expect(agent.state.messages[agent.state.messages.length - 1].role).toBe("assistant");
	});

	it("continue() should keep one-at-a-time steering semantics from assistant tail", async () => {
		let responseCount = 0;
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				responseCount++;
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage(`Processed ${responseCount}`),
					});
				});
				return stream;
			},
		});

		agent.state.messages = [
			{
				role: "user",
				content: [{ type: "text", text: "Initial" }],
				timestamp: Date.now() - 10,
			},
			createAssistantMessage("Initial response"),
		];

		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Steering 1" }],
			timestamp: Date.now(),
		});
		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Steering 2" }],
			timestamp: Date.now() + 1,
		});

		await expect(agent.continue()).resolves.toBeUndefined();

		const recentMessages = agent.state.messages.slice(-4);
		expect(recentMessages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(responseCount).toBe(2);
	});

	it("forwards sessionId to streamFn options", async () => {
		let receivedSessionId: string | undefined;
		const agent = new Agent({
			sessionId: "session-abc",
			streamFn: (_model, _context, options) => {
				receivedSessionId = options?.sessionId;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message = createAssistantMessage("ok");
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});

		await agent.prompt("hello");
		expect(receivedSessionId).toBe("session-abc");

		// Test setter
		agent.sessionId = "session-def";
		expect(agent.sessionId).toBe("session-def");

		await agent.prompt("hello again");
		expect(receivedSessionId).toBe("session-def");
	});

	it("should emit the full message lifecycle when the run fails", async () => {
		const agent = new Agent({
			streamFn: () => {
				throw new Error("stream factory exploded");
			},
		});

		const events: AgentEvent[] = [];
		agent.subscribe((event) => {
			events.push(event);
		});

		await agent.prompt("hello");

		const types = events.map((event) => event.type);
		expect(types.filter((type) => type === "agent_end")).toHaveLength(1);

		const messageStartIndex = types.lastIndexOf("message_start");
		const messageEndIndex = types.lastIndexOf("message_end");
		const turnEndIndex = types.indexOf("turn_end");
		const agentEndIndex = types.indexOf("agent_end");
		expect(messageStartIndex).toBeGreaterThan(-1);
		expect(messageStartIndex).toBeLessThan(messageEndIndex);
		expect(messageEndIndex).toBeLessThan(turnEndIndex);
		expect(turnEndIndex).toBeLessThan(agentEndIndex);

		const failureMessage =
			events[messageEndIndex].type === "message_end" ? events[messageEndIndex].message : undefined;
		expect(failureMessage?.role).toBe("assistant");
		if (failureMessage?.role === "assistant") {
			expect(failureMessage.stopReason).toBe("error");
			expect(failureMessage.errorMessage).toBe("stream factory exploded");
		}

		// The failure message lands in the transcript like a normal turn
		const lastMessage = agent.state.messages[agent.state.messages.length - 1];
		expect(lastMessage.role).toBe("assistant");
		expect(agent.state.errorMessage).toBe("stream factory exploded");
	});

	it("should omit failed empty assistant messages from the provider context on the next run", async () => {
		let shouldThrow = true;
		const seenByProvider: AgentMessage[][] = [];
		const agent = new Agent({
			convertToLlm: (messages) => {
				seenByProvider.push(messages.slice());
				return messages.filter(
					(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
				) as Message[];
			},
			streamFn: () => {
				if (shouldThrow) {
					throw new Error("stream factory exploded");
				}
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		await agent.prompt("first");
		// Transcript keeps the failure message for display/persistence
		expect(agent.state.messages[agent.state.messages.length - 1].role).toBe("assistant");

		shouldThrow = false;
		await agent.prompt("second");

		const lastCallMessages = seenByProvider[seenByProvider.length - 1];
		const failedEmptyAssistant = lastCallMessages.filter(
			(message) =>
				message.role === "assistant" &&
				message.errorMessage !== undefined &&
				message.content.every((block) => block.type === "text" && block.text.trim() === ""),
		);
		expect(failedEmptyAssistant).toHaveLength(0);
	});

	it("should isolate throwing listeners from the run and other listeners", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const agent = new Agent({
				streamFn: () => {
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
					});
					return stream;
				},
			});

			const seen: string[] = [];
			agent.subscribe(() => {
				throw new Error("listener exploded");
			});
			agent.subscribe((event) => {
				seen.push(event.type);
			});

			await expect(agent.prompt("hello")).resolves.toBeUndefined();

			// The run completed normally and the second listener saw every event
			expect(seen).toContain("agent_end");
			expect(agent.state.messages[agent.state.messages.length - 1].role).toBe("assistant");
			expect(agent.state.errorMessage).toBeUndefined();
			expect(errorSpy).toHaveBeenCalled();
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("should throw when reset() called while streaming", async () => {
		let abortSignal: AbortSignal | undefined;
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		const firstPrompt = agent.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(agent.state.isStreaming).toBe(true);

		expect(() => agent.reset()).toThrow(
			"Agent is processing a run. Abort the run and wait for completion before resetting.",
		);

		agent.abort();
		await firstPrompt.catch(() => {});
		expect(agent.state.isStreaming).toBe(false);
		expect(() => agent.reset()).not.toThrow();
		expect(agent.state.messages).toEqual([]);
	});

	it("should throw when prompt() is called with an empty message array", async () => {
		const agent = new Agent();

		await expect(agent.prompt([])).rejects.toThrow(
			"Cannot prompt with an empty message array. Provide at least one message.",
		);
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.messages).toEqual([]);
	});

	it("should give each failure message its own usage object", async () => {
		const agent = new Agent({
			streamFn: () => {
				throw new Error("boom");
			},
		});

		await agent.prompt("one");
		await agent.prompt("two");

		const failureMessages = agent.state.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant" && message.errorMessage !== undefined,
		);
		expect(failureMessages).toHaveLength(2);
		expect(failureMessages[0].usage).not.toBe(failureMessages[1].usage);

		// Mutating one failure message's usage must not leak into the other
		failureMessages[0].usage.input = 999;
		failureMessages[0].usage.cost.total = 999;
		expect(failureMessages[1].usage.input).toBe(0);
		expect(failureMessages[1].usage.cost.total).toBe(0);
	});

	it("should not share the default model object between agents", () => {
		const first = new Agent();
		first.state.model.input.push("text");
		first.state.model.cost.input = 1;

		const second = new Agent();
		expect(second.state.model.input).toEqual([]);
		expect(second.state.model.cost.input).toBe(0);
	});

	it("continue() should resume from the last real message after a failed run", async () => {
		let shouldThrow = true;
		const agent = new Agent({
			streamFn: () => {
				if (shouldThrow) {
					throw new Error("stream factory exploded");
				}
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("recovered") });
				});
				return stream;
			},
		});

		await agent.prompt("first");
		// Transcript tail is the failed empty assistant message
		expect(agent.state.messages[agent.state.messages.length - 1].role).toBe("assistant");

		shouldThrow = false;
		await expect(agent.continue()).resolves.toBeUndefined();

		const lastMessage = agent.state.messages[agent.state.messages.length - 1];
		expect(lastMessage.role).toBe("assistant");
		if (lastMessage.role === "assistant") {
			expect(lastMessage.stopReason).toBe("stop");
			expect(lastMessage.errorMessage).toBeUndefined();
		}
	});
});
