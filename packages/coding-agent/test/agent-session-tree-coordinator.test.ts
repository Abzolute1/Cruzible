import { describe, expect, it } from "vitest";
import { AgentSessionTreeCoordinator } from "../src/core/agent-session-tree-coordinator.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

function createUserMessage(text: string) {
	return {
		role: "user" as const,
		content: [{ type: "text" as const, text }],
		timestamp: Date.now(),
	};
}

function createAssistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function createCoordinator(sessionManager: SessionManager, callOrder: string[]) {
	const agent = { state: { messages: [] as any[] } };
	const coordinator = new AgentSessionTreeCoordinator({
		agent: agent as any,
		sessionManager,
		settingsManager: SettingsManager.inMemory({}),
		getModel: () => undefined,
		getExtensionRunner: () => undefined,
		getRequiredRequestAuth: async () => ({ apiKey: "test-key" }),
		disconnectFromAgent: () => callOrder.push("disconnect"),
		reconnectToAgent: () => callOrder.push("reconnect"),
		abortAgent: async () => {
			callOrder.push("abort");
		},
		waitForEventLoop: async () => {
			callOrder.push("drain");
		},
	});
	return { coordinator, agent };
}

describe("AgentSessionTreeCoordinator streaming guard", () => {
	it("does not abort or disconnect when navigating to the current leaf", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(createUserMessage("hello"));
		const leafId = sessionManager.getLeafId()!;
		const callOrder: string[] = [];
		const { coordinator } = createCoordinator(sessionManager, callOrder);

		const result = await coordinator.navigateTree(leafId);

		expect(result.cancelled).toBe(false);
		expect(callOrder).toEqual([]);
	});

	it("aborts and drains before moving the leaf, then reconnects", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(createUserMessage("first"));
		sessionManager.appendMessage(createAssistantMessage("answer one"));
		sessionManager.appendMessage(createUserMessage("second"));
		sessionManager.appendMessage(createAssistantMessage("answer two"));
		const entries = sessionManager.getEntries();
		const u2 = entries[2];
		const a1 = entries[1];

		const callOrder: string[] = [];
		const { coordinator, agent } = createCoordinator(sessionManager, callOrder);

		const result = await coordinator.navigateTree(u2.id);

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe("second");
		expect(callOrder).toEqual(["disconnect", "abort", "drain", "reconnect"]);
		expect(sessionManager.getLeafId()).toBe(a1.id);
		expect(agent.state.messages).toHaveLength(2);
	});

	it("appends drained in-flight events to the old branch, not the new leaf", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(createUserMessage("first"));
		sessionManager.appendMessage(createAssistantMessage("answer one"));
		sessionManager.appendMessage(createUserMessage("second"));
		sessionManager.appendMessage(createAssistantMessage("answer two"));
		const entries = sessionManager.getEntries();
		const u2 = entries[2];
		const a2 = entries[3];

		const drainedMessage = createAssistantMessage("late event");
		const callOrder: string[] = [];
		const agent = { state: { messages: [] as any[] } };
		const coordinator = new AgentSessionTreeCoordinator({
			agent: agent as any,
			sessionManager,
			settingsManager: SettingsManager.inMemory({}),
			getModel: () => undefined,
			getExtensionRunner: () => undefined,
			getRequiredRequestAuth: async () => ({ apiKey: "test-key" }),
			disconnectFromAgent: () => callOrder.push("disconnect"),
			reconnectToAgent: () => callOrder.push("reconnect"),
			abortAgent: async () => {
				callOrder.push("abort");
			},
			// Simulate a queued message_end flushed during the drain: it must land
			// on the old branch (current leaf), not under the new leaf.
			waitForEventLoop: async () => {
				callOrder.push("drain");
				sessionManager.appendMessage(drainedMessage);
			},
		});

		const result = await coordinator.navigateTree(u2.id);

		expect(result.cancelled).toBe(false);
		// The drained event was appended under the old leaf (a2), so the new
		// branch context is clean and the old branch keeps the late event.
		expect(sessionManager.buildSessionContext().messages).toHaveLength(2);
		const drainedEntry = sessionManager.getEntries().at(-1)!;
		expect(drainedEntry.parentId).toBe(a2.id);
		expect(sessionManager.getChildren(a2.id).map((entry) => entry.id)).toContain(drainedEntry.id);
	});

	it("reconnects even when navigation fails", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(createUserMessage("hello"));
		const callOrder: string[] = [];
		const { coordinator } = createCoordinator(sessionManager, callOrder);

		await expect(coordinator.navigateTree("missing-entry")).rejects.toThrow("Entry missing-entry not found");

		expect(callOrder).toEqual(["disconnect", "abort", "drain", "reconnect"]);
	});
});
