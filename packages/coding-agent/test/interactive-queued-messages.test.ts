import { describe, expect, test, vi } from "vitest";
import {
	type CompactionQueuedMessage,
	clearInteractiveQueuedMessages,
	combineQueuedMessagesForEditor,
	flushInteractiveCompactionQueue,
	getInteractiveQueuedMessages,
	handleInteractiveFollowUpSubmit,
	type InteractiveCompactionQueueActions,
	type InteractiveFollowUpActions,
	type InteractiveFollowUpState,
} from "../src/modes/interactive/interactive-queued-messages.js";

function createQueuedMessages(): CompactionQueuedMessage[] {
	return [
		{ text: "steer later", mode: "steer" },
		{ text: "follow later", mode: "followUp" },
	];
}

function createFollowUpState(overrides: Partial<InteractiveFollowUpState> = {}): InteractiveFollowUpState {
	return {
		isCompacting: false,
		isStreaming: false,
		isExtensionCommand: () => false,
		...overrides,
	};
}

function createFollowUpActions(): InteractiveFollowUpActions {
	return {
		addToHistory: vi.fn(),
		clearEditor: vi.fn(),
		prompt: vi.fn(async () => {}),
		queueCompactionMessage: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		requestRender: vi.fn(),
		submitNormally: vi.fn(async () => {}),
	};
}

function createCompactionQueueActions(): InteractiveCompactionQueueActions {
	return {
		updatePendingMessagesDisplay: vi.fn(),
		isExtensionCommand: vi.fn((text: string) => text.startsWith("/")),
		prompt: vi.fn(async () => {}),
		followUp: vi.fn(async () => {}),
		steer: vi.fn(async () => {}),
		clearSessionQueue: vi.fn(),
		restoreCompactionQueuedMessages: vi.fn(),
		showError: vi.fn(),
	};
}

describe("interactive-queued-messages", () => {
	test("combines session and compaction queues", () => {
		const result = getInteractiveQueuedMessages(
			{ steering: ["session steer"], followUp: ["session follow"] },
			createQueuedMessages(),
		);

		expect(result).toEqual({
			steering: ["session steer", "steer later"],
			followUp: ["session follow", "follow later"],
		});
	});

	test("combines restored queued text for the editor", () => {
		const result = combineQueuedMessagesForEditor(
			{
				steering: ["one"],
				followUp: ["two"],
			},
			"current",
		);

		expect(result).toEqual({
			text: "one\n\ntwo\n\ncurrent",
			restoredCount: 2,
		});
	});

	test("clears compaction and session queues into a single structure", () => {
		const result = clearInteractiveQueuedMessages(
			{ steering: ["session steer"], followUp: [] },
			createQueuedMessages(),
		);

		expect(result).toEqual({
			steering: ["session steer", "steer later"],
			followUp: ["follow later"],
		});
	});

	test("queues or executes follow-up input based on current state", async () => {
		const actions = createFollowUpActions();

		await handleInteractiveFollowUpSubmit("hello", createFollowUpState({ isCompacting: true }), actions);
		expect(actions.queueCompactionMessage).toHaveBeenCalledWith("hello", "followUp");

		await handleInteractiveFollowUpSubmit("hello", createFollowUpState({ isStreaming: true }), actions);
		expect(actions.prompt).toHaveBeenCalledWith("hello", { streamingBehavior: "followUp" });

		await handleInteractiveFollowUpSubmit("hello", createFollowUpState(), actions);
		expect(actions.submitNormally).toHaveBeenCalledWith("hello");
	});

	test("runs extension commands immediately during compaction", async () => {
		const actions = createFollowUpActions();

		await handleInteractiveFollowUpSubmit(
			"/ext",
			createFollowUpState({ isCompacting: true, isExtensionCommand: () => true }),
			actions,
		);

		expect(actions.addToHistory).toHaveBeenCalledWith("/ext");
		expect(actions.clearEditor).toHaveBeenCalledOnce();
		expect(actions.prompt).toHaveBeenCalledWith("/ext");
	});

	test("flushes compaction queue in retry mode via prompt/followUp/steer routing", async () => {
		const actions = createCompactionQueueActions();
		const queued: CompactionQueuedMessage[] = [
			{ text: "/ext", mode: "steer" },
			{ text: "follow later", mode: "followUp" },
			{ text: "steer later", mode: "steer" },
		];

		await flushInteractiveCompactionQueue(queued, actions, { willRetry: true });

		expect(actions.prompt).toHaveBeenCalledWith("/ext");
		expect(actions.followUp).toHaveBeenCalledWith("follow later");
		expect(actions.steer).toHaveBeenCalledWith("steer later");
		expect(actions.showError).not.toHaveBeenCalled();
	});

	test("restores compaction queue on execution failure", async () => {
		const actions = createCompactionQueueActions();
		const queued: CompactionQueuedMessage[] = [{ text: "steer later", mode: "steer" }];
		actions.steer = vi.fn(async () => {
			throw new Error("boom");
		});

		await flushInteractiveCompactionQueue(queued, actions, { willRetry: true });

		expect(actions.clearSessionQueue).toHaveBeenCalledOnce();
		expect(actions.restoreCompactionQueuedMessages).toHaveBeenCalledWith(queued);
		expect(actions.showError).toHaveBeenCalledWith(expect.stringContaining("Failed to send queued message"));
	});
});
