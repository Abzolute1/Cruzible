export type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp";
};

export function getInteractiveQueuedMessages(
	sessionQueues: { steering: readonly string[]; followUp: readonly string[] },
	compactionQueuedMessages: CompactionQueuedMessage[],
): { steering: string[]; followUp: string[] } {
	return {
		steering: [
			...sessionQueues.steering,
			...compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text),
		],
		followUp: [
			...sessionQueues.followUp,
			...compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text),
		],
	};
}

export function clearInteractiveQueuedMessages(
	sessionQueues: { steering: readonly string[]; followUp: readonly string[] },
	compactionQueuedMessages: CompactionQueuedMessage[],
): { steering: string[]; followUp: string[] } {
	return {
		steering: [
			...sessionQueues.steering,
			...compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text),
		],
		followUp: [
			...sessionQueues.followUp,
			...compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text),
		],
	};
}

export function combineQueuedMessagesForEditor(
	queues: { steering: string[]; followUp: string[] },
	currentText: string,
): { text: string; restoredCount: number } {
	const allQueued = [...queues.steering, ...queues.followUp];
	if (allQueued.length === 0) {
		return { text: currentText, restoredCount: 0 };
	}
	const queuedText = allQueued.join("\n\n");
	return {
		text: [queuedText, currentText].filter((value) => value.trim()).join("\n\n"),
		restoredCount: allQueued.length,
	};
}

export interface InteractiveFollowUpState {
	isCompacting: boolean;
	isStreaming: boolean;
	isExtensionCommand: (text: string) => boolean;
}

export interface InteractiveFollowUpActions {
	addToHistory: (text: string) => void;
	clearEditor: () => void;
	prompt: (text: string, options?: { streamingBehavior?: "followUp" }) => Promise<void>;
	queueCompactionMessage: (text: string, mode: "followUp") => void;
	updatePendingMessagesDisplay: () => void;
	requestRender: () => void;
	submitNormally: (text: string) => void | Promise<void>;
}

export async function handleInteractiveFollowUpSubmit(
	text: string,
	state: InteractiveFollowUpState,
	actions: InteractiveFollowUpActions,
): Promise<boolean> {
	if (state.isCompacting) {
		if (state.isExtensionCommand(text)) {
			actions.addToHistory(text);
			actions.clearEditor();
			await actions.prompt(text);
		} else {
			actions.queueCompactionMessage(text, "followUp");
		}
		return true;
	}

	if (state.isStreaming) {
		actions.addToHistory(text);
		actions.clearEditor();
		await actions.prompt(text, { streamingBehavior: "followUp" });
		actions.updatePendingMessagesDisplay();
		actions.requestRender();
		return true;
	}

	await actions.submitNormally(text);
	return true;
}

export interface InteractiveCompactionQueueActions {
	updatePendingMessagesDisplay: () => void;
	isExtensionCommand: (text: string) => boolean;
	prompt: (text: string) => Promise<void>;
	followUp: (text: string) => Promise<void>;
	steer: (text: string) => Promise<void>;
	clearSessionQueue: () => void;
	restoreCompactionQueuedMessages: (messages: CompactionQueuedMessage[]) => void;
	showError: (message: string) => void;
}

export async function flushInteractiveCompactionQueue(
	queuedMessages: CompactionQueuedMessage[],
	actions: InteractiveCompactionQueueActions,
	options?: { willRetry?: boolean },
): Promise<void> {
	if (queuedMessages.length === 0) {
		return;
	}

	actions.updatePendingMessagesDisplay();

	const restoreQueue = (error: unknown) => {
		actions.clearSessionQueue();
		actions.restoreCompactionQueuedMessages(queuedMessages);
		actions.updatePendingMessagesDisplay();
		actions.showError(
			`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	};

	try {
		if (options?.willRetry) {
			for (const message of queuedMessages) {
				if (actions.isExtensionCommand(message.text)) {
					await actions.prompt(message.text);
				} else if (message.mode === "followUp") {
					await actions.followUp(message.text);
				} else {
					await actions.steer(message.text);
				}
			}
			actions.updatePendingMessagesDisplay();
			return;
		}

		const firstPromptIndex = queuedMessages.findIndex((message) => !actions.isExtensionCommand(message.text));
		if (firstPromptIndex === -1) {
			for (const message of queuedMessages) {
				await actions.prompt(message.text);
			}
			return;
		}

		const preCommands = queuedMessages.slice(0, firstPromptIndex);
		const firstPrompt = queuedMessages[firstPromptIndex];
		const rest = queuedMessages.slice(firstPromptIndex + 1);

		for (const message of preCommands) {
			await actions.prompt(message.text);
		}

		const promptPromise = actions.prompt(firstPrompt.text).catch((error) => {
			restoreQueue(error);
		});

		for (const message of rest) {
			if (actions.isExtensionCommand(message.text)) {
				await actions.prompt(message.text);
			} else if (message.mode === "followUp") {
				await actions.followUp(message.text);
			} else {
				await actions.steer(message.text);
			}
		}
		actions.updatePendingMessagesDisplay();
		void promptPromise;
	} catch (error) {
		restoreQueue(error);
	}
}
