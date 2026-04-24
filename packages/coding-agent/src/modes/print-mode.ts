/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `ag1 -p "prompt"` - text output
 * - `ag1 --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, ImageContent } from "@ag1/ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.js";
import { normalizeToolName, type ToolOutcome } from "../core/auton/nudges/types.js";
import {
	buildLocalEvidenceControl,
	buildLocalEvidencePromptAddendum,
	buildRuntimeContinuationMessage,
} from "../core/local-evidence-steering.js";
import { flushRawStdout, writeRawStdout } from "../core/output-guard.js";
import { buildPromptIntentAddendum } from "../core/prompt-intent-steering.js";
import { classifyRequestFailure } from "../core/request-failure.js";
import { SessionDebugLogger } from "../core/session-debug-logger.js";
import { extractTrackedFileFromToolResult } from "../core/tool-outcome-file.js";
import { parseXmlToolCalls } from "../core/xml-tool-parser.js";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

type XmlRecoverableSession = AgentSessionRuntime["session"] & {
	recoverXmlToolCallsNow?: () => Promise<void>;
	abort?: () => Promise<void>;
	setActiveToolsByName?: (toolNames: string[]) => void;
};

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	const turnCompletionIdleMs = 150;
	const maxContinuationRecoveriesPerPrompt = 2;
	let exitCode = 0;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let debugLogger: SessionDebugLogger | undefined;
	let pendingRuntimePromptAddendum: string | undefined;
	let pendingTurnCompletionResolve: (() => void) | undefined;
	let pendingTurnCompletionTimer: ReturnType<typeof setTimeout> | undefined;
	const pendingToolArgs = new Map<string, Record<string, unknown>>();
	let currentTurnToolCallHistory: ToolOutcome[] = [];
	let currentTurnFileAccessHistory: ToolOutcome[] = [];
	let xmlRecoverySteerQueuedThisTurn = false;
	let lastRuntimeSteerSent: string | undefined;
	let finalAssistantSeenThisPrompt = false;
	let exitedAfterFinalAssistant = false;
	let lastDecisiveRuntimeControlMode: "answer_now" | "read_then_answer" | undefined;
	let runtimeToolLockViolatedThisTurn = false;
	let activePromptText = "";
	let configuredActiveToolNames = session.getActiveToolNames();
	let activeRuntimeToolLock: "answer_now" | "read_then_answer" | undefined;
	let continuationRecoveryCountThisPrompt = 0;
	let finalAssistantMessageForPrompt: AssistantMessage | undefined;
	let lastCompletedAssistantMessage: AssistantMessage | undefined;

	const clearPendingTurnCompletionTimer = (): void => {
		if (!pendingTurnCompletionTimer) return;
		clearTimeout(pendingTurnCompletionTimer);
		pendingTurnCompletionTimer = undefined;
	};

	const beginTurnCompletionWait = (): Promise<void> =>
		new Promise((resolve) => {
			clearPendingTurnCompletionTimer();
			pendingTurnCompletionResolve = () => {
				clearPendingTurnCompletionTimer();
				pendingTurnCompletionResolve = undefined;
				resolve();
			};
		});

	const shouldCancelPendingTurnCompletion = (event: {
		type: string;
		message?: unknown;
	}): boolean => {
		if (finalAssistantSeenThisPrompt) {
			return false;
		}
		if (event.type === "agent_start") return true;
		if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
			return true;
		}
		if (event.type === "message_update") return true;
		if (event.type === "message_start") {
			const message =
				event.message && typeof event.message === "object" ? (event.message as { role?: string; display?: boolean }) : undefined;
			if (message?.role === "custom" && message.display === false) {
				return false;
			}
			return true;
		}
		return false;
	};

	const consumeRuntimePromptAddendum = (existing?: string): string | undefined => {
		const pending = pendingRuntimePromptAddendum;
		pendingRuntimePromptAddendum = undefined;
		if (!pending) return existing;
		return existing ? `${existing}\n\n${pending}` : pending;
	};

	const extractToolDetail = (toolName: string, args: Record<string, unknown> | undefined): string | undefined => {
		if (!args) return undefined;
		if ((toolName === "bash" || toolName === "verify") && typeof args.command === "string") {
			return args.command;
		}
		if (toolName === "websearch" && typeof args.query === "string") return args.query;
		if (toolName === "webfetch" && typeof args.url === "string") return args.url;
		if (toolName === "read") {
			const path = typeof args.filePath === "string" ? args.filePath : typeof args.path === "string" ? args.path : undefined;
			if (!path) return undefined;
			const suffix: string[] = [];
			if (typeof args.offset === "number") suffix.push(`offset=${args.offset}`);
			if (typeof args.limit === "number") suffix.push(`limit=${args.limit}`);
			return suffix.length > 0 ? `${path} (${suffix.join(", ")})` : path;
		}
		if (typeof args.filePath === "string") return args.filePath;
		if (typeof args.path === "string") return args.path;
		return undefined;
	};

	const extractToolMetadata = (result: unknown): Record<string, unknown> | undefined => {
		if (!result || typeof result !== "object" || !("details" in result)) return undefined;
		const details = (result as { details?: unknown }).details;
		return details && typeof details === "object" ? (details as Record<string, unknown>) : undefined;
	};

	const estimateToolResultTokens = (result: unknown): number | undefined => {
		if (!result || typeof result !== "object" || !("content" in result)) return undefined;
		const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
		if (!Array.isArray(content)) return undefined;
		const text = content
			.filter((item) => item && item.type === "text" && typeof item.text === "string")
			.map((item) => item.text ?? "")
			.join("\n");
		if (text.length === 0) return undefined;
		return Math.ceil(text.length / 4);
	};

	const extractToolResultText = (result: unknown): string | undefined => {
		if (!result || typeof result !== "object" || !("content" in result)) return undefined;
		const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
		if (!Array.isArray(content)) return undefined;
		const text = content
			.filter((item) => item && item.type === "text" && typeof item.text === "string")
			.map((item) => item.text ?? "")
			.join("\n")
			.trim();
		return text.length > 0 ? text : undefined;
	};

	const isRecoverableToolValidationError = (toolName: string, result: unknown): boolean => {
		const text = extractToolResultText(result);
		if (!text) return false;
		const normalizedText = text.toLowerCase();
		const normalizedToolName = normalizeToolName(toolName);
		if (
			normalizedToolName === "read"
			&& (normalizedText.includes("path not found") || normalizedText.includes("use find to locate files") || normalizedText.includes("use ls to inspect directories"))
		) {
			return true;
		}
		const looksLikeValidationFailure =
			/^Validation failed for tool\b/i.test(text)
			|| normalizedText.includes("input is invalid")
			|| normalizedText.includes("must have required property");
		if (!looksLikeValidationFailure) return false;
		return normalizedToolName === "find"
			|| normalizedToolName === "grep"
			|| normalizedToolName === "read"
			|| normalizedToolName === "edit";
	};

	const buildToolValidationRecoveryMessage = (toolName: string): string => {
		const normalizedToolName = normalizeToolName(toolName);
		const requirementHint =
			normalizedToolName === "find"
				? "- Reissue exactly one valid `find` call with a concrete `pattern` argument."
				: normalizedToolName === "grep"
					? "- Reissue exactly one valid `grep` call with a concrete `pattern` argument."
					: normalizedToolName === "edit"
					? "- Reissue exactly one valid `edit` call with a concrete `path` and a non-empty `edits` array."
						: "- Reissue exactly one valid `read` call with a concrete `path` or `filePath` argument.";
		const replacementHint = normalizedToolName === "edit"
			? "\n- Each edit entry must contain at least one actual replacement such as `oldText` and `newText`."
			: normalizedToolName === "read"
				? "\n- If the exact path is not known, do one direct discovery call (`find` or `ls`) instead of retrying the same missing path."
				: "";
		return [
			"<runtime-continuation-state>",
			"- The previous tool call was malformed or incomplete.",
			`${requirementHint}${replacementHint}`,
			"- Do not emit planning text. Output only the corrected tool call or a direct answer if no tool is needed.",
			"</runtime-continuation-state>",
		].join("\n");
	};

	const scheduleTurnCompletion = (): void => {
		clearPendingTurnCompletionTimer();
		if (!pendingTurnCompletionResolve) return;
		pendingTurnCompletionTimer = setTimeout(() => {
			pendingTurnCompletionTimer = undefined;
			pendingTurnCompletionResolve?.();
		}, turnCompletionIdleMs);
	};

	const sameToolSet = (left: string[], right: string[]): boolean =>
		left.length === right.length && left.every((tool, index) => tool === right[index]);

	const restoreConfiguredActiveTools = (): void => {
		const maybeSession = session as XmlRecoverableSession;
		if (typeof maybeSession.setActiveToolsByName !== "function") {
			activeRuntimeToolLock = undefined;
			return;
		}
		if (!sameToolSet(session.getActiveToolNames(), configuredActiveToolNames)) {
			maybeSession.setActiveToolsByName(configuredActiveToolNames);
		}
		activeRuntimeToolLock = undefined;
	};

	const applyRuntimeToolLock = (mode: "answer_now" | "read_then_answer"): void => {
		const maybeSession = session as XmlRecoverableSession;
		if (typeof maybeSession.setActiveToolsByName !== "function") {
			activeRuntimeToolLock = mode;
			return;
		}
		const nextActiveToolNames =
			mode === "read_then_answer" && configuredActiveToolNames.includes("read")
				? ["read"]
				: [];
		if (!sameToolSet(session.getActiveToolNames(), nextActiveToolNames)) {
			maybeSession.setActiveToolsByName(nextActiveToolNames);
		}
		activeRuntimeToolLock = mode;
	};

	const runtimeControlPriority = (mode: "answer_now" | "read_then_answer" | undefined): number => {
		if (mode === "answer_now") return 2;
		if (mode === "read_then_answer") return 1;
		return 0;
	};

	const shouldSendDecisiveRuntimeControl = (mode: "answer_now" | "read_then_answer"): boolean =>
		runtimeControlPriority(mode) > runtimeControlPriority(lastDecisiveRuntimeControlMode)
		|| runtimeToolLockViolatedThisTurn;

	const sendRuntimeControlMessage = (mode: "answer_now" | "read_then_answer", message: string): void => {
		applyRuntimeToolLock(mode);
		lastDecisiveRuntimeControlMode = mode;
		runtimeToolLockViolatedThisTurn = false;
		lastRuntimeSteerSent = message;
		void session
			.sendCustomMessage(
				{
					customType: "runtime_continuation_state",
					content: message,
					display: false,
					details: { kind: "runtime_continuation_state", mode },
				},
				{ deliverAs: "steer" },
			)
			.catch(() => {});
	};

	const assistantMessageLooksFinal = (message: AssistantMessage): boolean => {
		if (message.stopReason === "error" || message.stopReason === "aborted") return true;
		const content = Array.isArray(message.content) ? message.content : [];
		const hasToolCall = content.some((part) => part.type === "toolCall");
		if (hasToolCall) return false;
		const hasText = content.some((part) => part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0);
		return hasText;
	};

	const assistantMessageContainsXmlLeak = (message: AssistantMessage): boolean => {
		const content = Array.isArray(message.content) ? message.content : [];
		const hasStructuredToolCall = content.some((part) => part.type === "toolCall");
		if (hasStructuredToolCall) return false;
		const xmlText = content
			.filter((part) => part.type === "text" || part.type === "thinking")
			.map((part) => (part.type === "thinking" ? part.thinking || "" : part.text || ""))
			.join("\n");
		if (!xmlText.trim()) return false;
		const xmlRecoveryToolNames =
			activeRuntimeToolLock && configuredActiveToolNames.length > 0
				? configuredActiveToolNames
				: session.getActiveToolNames();
		return parseXmlToolCalls(xmlText, xmlRecoveryToolNames).length > 0;
	};

	const assistantMessageNeedsContinuationRecovery = (message: AssistantMessage): boolean => {
		const content = Array.isArray(message.content) ? message.content : [];
		if (content.some((part) => part.type === "toolCall")) return false;
		const hasText = content.some((part) => part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0);
		const hasThinking = content.some((part) => part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim().length > 0);
		if (message.stopReason === "length" && hasThinking && !hasText) {
			return true;
		}
		if (
			message.stopReason === "length" &&
			activeRuntimeToolLock === "answer_now" &&
			(hasText || hasThinking)
		) {
			return true;
		}
		if (message.stopReason !== "stop") return false;
		if (hasText) return false;
		return hasThinking;
	};

	const promptWithRuntimeSteering = async (
		message: string,
		prepareNextTurn: boolean,
		promptOptions?: { images?: ImageContent[]; systemPromptAddendum?: string },
	): Promise<void> => {
		restoreConfiguredActiveTools();
		configuredActiveToolNames = session.getActiveToolNames();
		finalAssistantSeenThisPrompt = false;
		finalAssistantMessageForPrompt = undefined;
		activePromptText = message;
		const addenda = [
			buildPromptIntentAddendum(message),
			consumeRuntimePromptAddendum(promptOptions?.systemPromptAddendum),
		].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
		const systemPromptAddendum = addenda.length > 0 ? addenda.join("\n\n") : undefined;
		const turnCompleted = beginTurnCompletionWait();
		let promptError: unknown;
		let promptSettled = false;
		const promptPromise = (async () => {
			if (promptOptions?.images || systemPromptAddendum) {
				await session.prompt(message, {
					...promptOptions,
					systemPromptAddendum,
				});
			} else {
				await session.prompt(message);
			}
		})()
			.catch((error) => {
				promptError = error;
			})
			.finally(() => {
				promptSettled = true;
			});
		await Promise.race([promptPromise, turnCompleted]);
		if (promptError) {
			throw promptError;
		}
		if (!prepareNextTurn && finalAssistantMessageForPrompt) {
			lastCompletedAssistantMessage = finalAssistantMessageForPrompt;
		}
		if (mode === "text" && !prepareNextTurn && finalAssistantSeenThisPrompt) {
			exitedAfterFinalAssistant = true;
			return;
		}
		if (!promptSettled) {
			await Promise.race([
				promptPromise,
				new Promise((resolve) => {
					setTimeout(resolve, turnCompletionIdleMs);
				}),
			]);
			if (promptError) {
				throw promptError;
			}
		}
		const steeringContext = {
			toolCallHistory: currentTurnToolCallHistory,
			fileAccessHistory: currentTurnFileAccessHistory,
		};
		if (prepareNextTurn) {
			pendingRuntimePromptAddendum = buildLocalEvidencePromptAddendum(steeringContext);
			const continuationMessage = buildRuntimeContinuationMessage(steeringContext);
			if (continuationMessage) {
				await session.sendCustomMessage(
					{
						customType: "runtime_continuation_state",
						content: continuationMessage,
						display: false,
						details: { kind: "runtime_continuation_state" },
					},
					{ deliverAs: "nextTurn" },
				);
			}
		} else {
			pendingRuntimePromptAddendum = undefined;
		}
		currentTurnToolCallHistory = [];
		currentTurnFileAccessHistory = [];
	};

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async (newSessionOptions) => {
					const result = await runtimeHost.newSession(newSessionOptions);
					if (!result.cancelled) {
						await rebindSession();
					}
					return result;
				},
				fork: async (entryId) => {
					const result = await runtimeHost.fork(entryId);
					if (!result.cancelled) {
						await rebindSession();
					}
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath) => {
					const result = await runtimeHost.switchSession(sessionPath);
					if (!result.cancelled) {
						await rebindSession();
					}
					return result;
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		unsubscribe?.();
		unsubscribe = session.subscribe((event) => {
			if (shouldCancelPendingTurnCompletion(event)) {
				clearPendingTurnCompletionTimer();
			}
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(event)}\n`);
			}
			switch (event.type) {
				case "agent_start":
					restoreConfiguredActiveTools();
					currentTurnToolCallHistory = [];
					currentTurnFileAccessHistory = [];
					xmlRecoverySteerQueuedThisTurn = false;
					continuationRecoveryCountThisPrompt = 0;
					lastRuntimeSteerSent = undefined;
					finalAssistantSeenThisPrompt = false;
					lastDecisiveRuntimeControlMode = undefined;
					runtimeToolLockViolatedThisTurn = false;
					break;
				case "agent_end":
					scheduleTurnCompletion();
					break;
				case "message_end":
					let continuationRecoveryQueued = false;
					if (
						event.message.role === "assistant" &&
						assistantMessageNeedsContinuationRecovery(event.message as AssistantMessage) &&
						!finalAssistantSeenThisPrompt &&
						continuationRecoveryCountThisPrompt < maxContinuationRecoveriesPerPrompt
					) {
						continuationRecoveryCountThisPrompt += 1;
						continuationRecoveryQueued = true;
						const repeatedRecovery = continuationRecoveryCountThisPrompt > 1;
						const continuationMessage = activeRuntimeToolLock === "answer_now"
							? (
								(event.message as AssistantMessage).stopReason === "length"
									? [
											"<runtime-continuation-state>",
											"- The previous answer was cut off mid-response.",
											"- Continue the direct answer from where it stopped using the evidence already gathered.",
											"- Do not restart the answer or call more tools.",
											"</runtime-continuation-state>",
										].join("\n")
									: [
											"<runtime-continuation-state>",
											"- The previous assistant step stopped at internal reasoning only.",
											"- Answer now from the evidence already gathered.",
											"- Do not stop again without either an answer or a concrete tool call.",
											"</runtime-continuation-state>",
										].join("\n")
								)
							: repeatedRecovery
								? [
										"<runtime-continuation-state>",
										"- Repeated planning-only continuations are not allowed.",
										"- Do not emit more internal reasoning or planning text.",
										"- Output exactly one concrete next tool call now, or the direct answer if no tool is needed.",
										"</runtime-continuation-state>",
									].join("\n")
								: [
										"<runtime-continuation-state>",
										"- The previous assistant step stopped at internal reasoning only.",
										"- Continue immediately with either one concrete next tool call or a direct answer.",
										"- Do not stop again without externalizing the next action.",
										"</runtime-continuation-state>",
									].join("\n");
						void session
							.sendCustomMessage(
								{
									customType: "runtime_continuation_state",
									content: continuationMessage,
									display: false,
									details: { kind: "runtime_continuation_state", mode: "continue_now" },
								},
								{ deliverAs: "followUp" },
							)
							.catch(() => {});
					}
					if (
						event.message.role === "assistant" &&
						assistantMessageContainsXmlLeak(event.message as AssistantMessage) &&
						!finalAssistantSeenThisPrompt
					) {
						restoreConfiguredActiveTools();
						if (!xmlRecoverySteerQueuedThisTurn) {
							xmlRecoverySteerQueuedThisTurn = true;
							void session
								.sendCustomMessage(
									{
										customType: "runtime_continuation_state",
										content: [
											"<runtime-continuation-state>",
											"- XML tool-call recovery is active for this turn.",
											"- After the appended tool results arrive, answer directly if they already resolve the user's question.",
											"- Do not call more tools unless a concrete missing detail remains.",
											"</runtime-continuation-state>",
										].join("\n"),
										display: false,
										details: { kind: "runtime_continuation_state" },
									},
									{ deliverAs: "steer" },
								)
								.catch(() => {});
						}
						void (session as XmlRecoverableSession).recoverXmlToolCallsNow?.().catch(() => {});
					}
					if (
						event.message.role === "assistant" &&
						!continuationRecoveryQueued &&
						assistantMessageLooksFinal(event.message as AssistantMessage)
					) {
						if (!finalAssistantSeenThisPrompt) {
							finalAssistantMessageForPrompt = event.message as AssistantMessage;
						}
						finalAssistantSeenThisPrompt = true;
						scheduleTurnCompletion();
					}
					break;
				case "tool_execution_start":
					pendingToolArgs.set(event.toolCallId, event.args ?? {});
					if (!finalAssistantSeenThisPrompt && activeRuntimeToolLock) {
						const normalizedToolName = normalizeToolName(event.toolName);
						const allowedTool =
							activeRuntimeToolLock === "read_then_answer"
								? normalizedToolName === "read"
								: false;
						if (!allowedTool) {
							runtimeToolLockViolatedThisTurn = true;
							applyRuntimeToolLock(activeRuntimeToolLock);
							const correctiveMessage = activeRuntimeToolLock === "answer_now"
								? "Runtime control: Answer now from the evidence already gathered. No more tool calls are needed for this turn."
								: "Runtime control: One targeted read is the only remaining tool step for this turn. Do not run another grep, find, ls, webSearch, or webFetch.";
							if (correctiveMessage !== lastRuntimeSteerSent) {
								lastRuntimeSteerSent = correctiveMessage;
								void session
									.sendCustomMessage(
										{
											customType: "runtime_continuation_state",
											content: correctiveMessage,
											display: false,
											details: { kind: "runtime_continuation_state", mode: activeRuntimeToolLock },
										},
										{ deliverAs: "steer" },
									)
									.catch(() => {});
							}
						}
					}
					break;
				case "tool_execution_end": {
					const toolName = normalizeToolName(event.toolName);
					const args = pendingToolArgs.get(event.toolCallId);
					pendingToolArgs.delete(event.toolCallId);
					const filePath = extractTrackedFileFromToolResult(toolName, args, event.result, session.sessionManager.getCwd());
					const toolOutcome: ToolOutcome = {
						tool: toolName,
						success: !event.isError,
						file: filePath,
						detail: extractToolDetail(toolName, args),
						estimatedTokens: estimateToolResultTokens(event.result),
						metadata: extractToolMetadata(event.result),
					};
					currentTurnToolCallHistory.push(toolOutcome);
					if (filePath) currentTurnFileAccessHistory.push(toolOutcome);
					if (
						!finalAssistantSeenThisPrompt &&
						!toolOutcome.success &&
						isRecoverableToolValidationError(toolName, event.result)
					) {
						const recoveryMessage = buildToolValidationRecoveryMessage(toolName);
						if (recoveryMessage !== lastRuntimeSteerSent) {
							lastRuntimeSteerSent = recoveryMessage;
							void session
								.sendCustomMessage(
									{
										customType: "runtime_continuation_state",
										content: recoveryMessage,
										display: false,
										details: { kind: "runtime_continuation_state", mode: "continue_now" },
									},
									{ deliverAs: "followUp" },
								)
								.catch(() => {});
						}
					}
					if (!finalAssistantSeenThisPrompt && activeRuntimeToolLock === "read_then_answer" && toolName === "read" && toolOutcome.success) {
						sendRuntimeControlMessage(
							"answer_now",
							"Runtime control: The targeted read already completed. Answer now from the local evidence you have. No more tool calls are needed for this turn.",
						);
						break;
					}
					const steeringContext = {
						toolCallHistory: currentTurnToolCallHistory,
						fileAccessHistory: currentTurnFileAccessHistory,
						userPrompt: activePromptText,
					};
					pendingRuntimePromptAddendum = buildLocalEvidencePromptAddendum(steeringContext);
					const runtimeControl = buildLocalEvidenceControl(steeringContext);
					if (!finalAssistantSeenThisPrompt && runtimeControl && shouldSendDecisiveRuntimeControl(runtimeControl.mode)) {
						sendRuntimeControlMessage(runtimeControl.mode, runtimeControl.message);
						break;
					}
					const runtimeAddendum = buildLocalEvidencePromptAddendum(steeringContext);
					if (!runtimeAddendum) {
						break;
					}
					if (runtimeAddendum === lastRuntimeSteerSent) {
						break;
					}
					lastRuntimeSteerSent = runtimeAddendum;
					if (!finalAssistantSeenThisPrompt) {
						void session
							.sendCustomMessage(
								{
									customType: "runtime_continuation_state",
									content: runtimeAddendum,
									display: false,
									details: { kind: "runtime_continuation_state", mode: "steer" },
								},
								{ deliverAs: "followUp" },
							)
							.catch(() => {});
					}
					break;
				}
			}
		});
	};

	try {
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();
		debugLogger = new SessionDebugLogger({
			session: session,
			projectRoot: session.sessionManager.getCwd(),
		});
		debugLogger.start();
		const totalPrompts = (initialMessage ? 1 : 0) + messages.length;
		let promptIndex = 0;

		if (initialMessage) {
			promptIndex += 1;
			await promptWithRuntimeSteering(initialMessage, promptIndex < totalPrompts, { images: initialImages });
		}

		for (const message of messages) {
			promptIndex += 1;
			await promptWithRuntimeSteering(message, promptIndex < totalPrompts);
		}

		if (mode === "text") {
			const state = session.state;
			const lastMessage = lastCompletedAssistantMessage ?? state.messages[state.messages.length - 1];

			if (lastMessage?.role === "assistant") {
				const assistantMsg = lastMessage as AssistantMessage;
				if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					const classifiedFailure =
						assistantMsg.stopReason === "error" ? classifyRequestFailure(assistantMsg) : undefined;
					console.error(
						classifiedFailure
							? `${classifiedFailure.message}\n${classifiedFailure.recoveryHint}`
							: (assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`),
					);
					exitCode = 1;
				} else {
					for (const content of assistantMsg.content) {
						if (content.type === "text") {
							writeRawStdout(`${content.text}\n`);
						}
					}
				}
			}
		}

		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		clearPendingTurnCompletionTimer();
		unsubscribe?.();
		debugLogger?.dispose();
		if (!exitedAfterFinalAssistant) {
			await (session as XmlRecoverableSession).abort?.().catch(() => {});
		}
		await runtimeHost.dispose();
		await flushRawStdout();
	}
}
