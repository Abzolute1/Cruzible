import type { AgentMessage, ThinkingLevel } from "@ag1/agent-core";
import type { Model } from "@ag1/ai";

export interface ContinueReplayState {
	messages: AgentMessage[];
	isStreaming: boolean;
	model?: Pick<Model<any>, "provider" | "id">;
	thinkingLevel?: ThinkingLevel;
}

export interface ContinueReplaySnapshot {
	messageCount: number;
	lastMessage: AgentMessage | undefined;
	modelProvider: string | undefined;
	modelId: string | undefined;
	thinkingLevel: ThinkingLevel | undefined;
}

export function captureContinueReplaySnapshot(state: ContinueReplayState): ContinueReplaySnapshot {
	const messages = state.messages;
	return {
		messageCount: messages.length,
		lastMessage: messages[messages.length - 1],
		modelProvider: state.model?.provider,
		modelId: state.model?.id,
		thinkingLevel: state.thinkingLevel,
	};
}

export function canReplayContinue(state: ContinueReplayState, snapshot: ContinueReplaySnapshot): boolean {
	const messages = state.messages;
	return (
		state.isStreaming !== true &&
		messages.length === snapshot.messageCount &&
		messages[messages.length - 1] === snapshot.lastMessage &&
		state.model?.provider === snapshot.modelProvider &&
		state.model?.id === snapshot.modelId &&
		state.thinkingLevel === snapshot.thinkingLevel
	);
}
