// Auton — Nudge evaluation
// Ported from Kairos src/agent/nudges.ts (evaluateNudge, getNudgeMessage)

import { detectErrorLoop, detectNoProgressLoop, detectPingPong } from "./loop-detection.js";
import type { OutputTrendTracker } from "./output-trend.js";
import {
	buildToolOutcomeCallKey,
	type NudgeCooldownState,
	type NudgeEvaluation,
	type NudgeType,
	normalizeToolName,
	type OutputTrend,
	type ToolOutcome,
} from "./types.js";

// ── Thresholds ─────────────────────────────────────────────────────────

export const MAX_CONSECUTIVE_SAME_FILE = 4;
export const MAX_EXPLORATION_TURNS = 12;
export const MAX_FORCED_WRAP_TURNS = 20;
export const MIN_TEXT_LENGTH = 50;

// ── Circuit breaker thresholds ──────────────────────────────────────

export const MAX_CONSECUTIVE_VERIFY_FAILURES = 3;
export const MAX_WASTED_READ_TOKENS = 20_000;
export const MAX_FILE_CHURN_TURNS = 8;

// ── Cooldown and escalation ─────────────────────────────────────────

export const NUDGE_COOLDOWN_TURNS = 4;
export const MAX_ESCALATION_LEVEL = 3;

// ── Types ──────────────────────────────────────────────────────────────

export interface NudgeContext {
	turnIndex: number;
	toolCallHistory: ToolOutcome[]; // outcome-aware tool names called each turn
	fileAccessHistory: ToolOutcome[]; // outcome-aware file paths accessed each turn
	outputTrend?: OutputTrend;
	isContinuation: boolean;
	trendTracker?: OutputTrendTracker;
}

// ── Evaluation ─────────────────────────────────────────────────────────

/**
 * Evaluates whether to nudge the agent based on its recent behavior.
 */
export function evaluateNudge(context: NudgeContext): NudgeEvaluation {
	const {
		turnIndex,
		toolCallHistory,
		fileAccessHistory,
		outputTrend: _outputTrend,
		isContinuation,
		trendTracker,
	} = context;

	// ── Budget / forced stop checks (highest priority) ──

	// Exploration cap: too many turns of pure tool-calling
	if (turnIndex >= MAX_EXPLORATION_TURNS && !hasRecentText(context)) {
		if (
			hasRecentConcreteTaskProgress(toolCallHistory) ||
			hasRecentFailedMutation(toolCallHistory) ||
			hasRecentFailedVerification(toolCallHistory)
		) {
			return {
				shouldNudge: true,
				nudgeType: "continue",
				shouldStop: false,
				explanation:
					"Turn count is high, but there is recent concrete progress, a failed verification, or a recoverable failed change attempt. Finish the next smallest repair-or-verify step instead of stopping mid-recovery.",
			};
		}
		return {
			shouldNudge: true,
			nudgeType: "break_loop",
			shouldStop: true,
			stopReason: `Exploration cap reached: ${turnIndex} turns without substantive output.`,
			explanation: "Too many turns of pure exploration. Time to wrap up findings.",
		};
	}

	// Forced wrap-up: too many turns elapsed
	if (turnIndex >= MAX_FORCED_WRAP_TURNS) {
		return {
			shouldNudge: true,
			nudgeType: "wrap_up",
			shouldStop: true,
			stopReason: `Forced wrap-up: ${turnIndex} turns exceeded maximum.`,
			explanation: "Session has run too long. Wrap up and report.",
		};
	}

	// ── Circuit breaker: consecutive Verify failures (HIGHEST priority behavioral check) ──
	if (hasConsecutiveVerifyFailures(toolCallHistory)) {
		return {
			shouldNudge: true,
			nudgeType: "pivot",
			shouldStop: false,
			explanation: `Verify tool failed ${MAX_CONSECUTIVE_VERIFY_FAILURES} consecutive times. The current approach is broken — try a fundamentally different strategy.`,
		};
	}

	// ── Loop detection (progress-based: identical calls, identical outcomes) ──
	const errorLoop = detectErrorLoop(toolCallHistory);
	if (errorLoop) {
		return {
			shouldNudge: true,
			nudgeType: "pivot",
			shouldStop: false,
			explanation: `\`${errorLoop.tool}\` failed ${errorLoop.count} consecutive times with identical arguments. The same call will keep failing — change the arguments or fix the underlying problem first.`,
		};
	}

	const noProgressLoop = detectNoProgressLoop(toolCallHistory);
	if (noProgressLoop) {
		return {
			shouldNudge: true,
			nudgeType: "pivot",
			shouldStop: false,
			explanation: `\`${noProgressLoop.tool}\` returned the same result ${noProgressLoop.count} consecutive times. You already have this information — act on it instead of repeating the call.`,
		};
	}

	const pingPong = detectPingPong(toolCallHistory);
	if (pingPong) {
		return {
			shouldNudge: true,
			nudgeType: "pivot",
			shouldStop: false,
			explanation: `Oscillating between \`${pingPong.toolA}\` and \`${pingPong.toolB}\` without progress. Break the cycle and decide based on the results you already have.`,
		};
	}

	// ── Wasted read budget ──
	if (hasWastedFileReadTokens(toolCallHistory)) {
		return {
			shouldNudge: true,
			nudgeType: "break_loop",
			shouldStop: true,
			stopReason: "Excessive token wasted on duplicate file reads. Time to stop and reassess.",
			explanation: "Too many tokens spent re-reading the same files. Stop and summarize what you know.",
		};
	}

	// ── File churn / scattered attention ──
	if (hasFileChurn(toolCallHistory)) {
		return {
			shouldNudge: true,
			nudgeType: "pivot",
			shouldStop: false,
			explanation: "You've read many files without editing any. Focus on one file and make changes.",
		};
	}

	// ── Stuck file access detection ──
	if (hasStuckFileAccess(fileAccessHistory, MAX_CONSECUTIVE_SAME_FILE)) {
		return {
			shouldNudge: true,
			nudgeType: "pivot",
			shouldStop: false,
			explanation: "Model is stuck accessing the same file repeatedly.",
		};
	}

	// ── Diminishing output detection ──
	if (trendTracker?.isDiminishing()) {
		if (hasRecentUnverifiedImplementationProgress(toolCallHistory)) {
			return {
				shouldNudge: true,
				nudgeType: "continue",
				shouldStop: false,
				explanation:
					"Output is shrinking, but there is recent unverified implementation progress. Finish the next concrete verify-or-patch step instead of stopping.",
			};
		}
		if (hasRecentFailedMutation(toolCallHistory)) {
			return {
				shouldNudge: true,
				nudgeType: "continue",
				shouldStop: false,
				explanation:
					"Output is shrinking after a failed change attempt. Recover with the smallest valid edit or verification step next.",
			};
		}
		if (hasRecentFailedVerification(toolCallHistory)) {
			return {
				shouldNudge: true,
				nudgeType: "continue",
				shouldStop: false,
				explanation:
					"Output is shrinking right after a failed verification. Repair the reported blocker and rerun verification before stopping.",
			};
		}
		if (!hasConcreteTaskProgress(toolCallHistory)) {
			return {
				shouldNudge: true,
				nudgeType: "continue",
				shouldStop: false,
				explanation:
					"Output is shrinking, but no concrete task progress has happened yet. Keep going and make a change or run verification.",
			};
		}
		return {
			shouldNudge: true,
			nudgeType: "break_loop",
			shouldStop: true,
			stopReason: "Diminishing output: last continuations produced minimal content.",
			explanation: "Output has diminished significantly. Time to stop and summarize.",
		};
	}

	// ── Minimal text detection ──
	if (!isContinuation && hasMinimalText(context)) {
		return {
			shouldNudge: true,
			nudgeType: "continue",
			shouldStop: false,
			explanation: "Model produced minimal text. Encourage continuation.",
		};
	}

	// ── Default: no nudge needed ──
	return {
		shouldNudge: false,
		nudgeType: "none",
		shouldStop: false,
	};
}

/**
 * Returns a steering message corresponding to the nudge type.
 */
export function getNudgeMessage(nudgeType: NudgeType): string {
	switch (nudgeType) {
		case "continue":
			return "Continue working on the task. Elaborate on your findings and proceed with the next steps.";
		case "wrap_up":
			return "Please wrap up your work and provide a comprehensive summary of what you've accomplished, what remains, and any issues encountered.";
		case "break_loop":
			return "Stop the current loop. Summarize what you've accomplished so far, what issues you encountered, and what you'd recommend as next steps.";
		case "pivot":
			return "Your current approach isn't working. Try a fundamentally different strategy. Think about what you've tried and what alternative paths exist.";
		case "none":
			return "";
	}
}

// ── Helpers ────────────────────────────────────────────────────────────

function classifyBashDetail(detail: string | undefined): "inspection" | "mutating" | "verification" | "other" {
	if (!detail) return "other";
	const normalized = detail.replace(/\s+/g, " ").trim();
	if (isReliableVerificationBashCommand(normalized)) {
		return "verification";
	}
	if (/(?:^|[;&]\s*)node\b/i.test(normalized)) {
		return "other";
	}
	if (
		/(^|[;&|]\s*)(rm\b|mv\b|cp\b|touch\b|mkdir\b|pnpm\b|yarn\b|npm\s+(install|run|exec)\b|node\b|python\b|chmod\b|chown\b|git\s+(apply|checkout|reset|commit|rebase|merge)\b)/.test(
			normalized,
		)
	) {
		return "mutating";
	}
	if (
		/(^|[;&|]\s*)(pwd\b|ls\b|find\b|fd\b|rg\b|grep\b|git\s+status(\s|$)|git\s+diff(\s|$)|which\b|cat\b|head\b|tail\b|sed\b|awk\b)/.test(
			normalized,
		)
	) {
		return "inspection";
	}
	return "other";
}

function isReliableVerificationBashCommand(command: string): boolean {
	if (!command) return false;
	if (/\|\s*(head|tail)\b/i.test(command) && !/\bset\s+-o\s+pipefail\b/i.test(command)) {
		return false;
	}
	return (
		/(?:^|[;&]\s*)node\b[^\n;&|]*\b(?:--test|test|check|verify|lint|build)\b/i.test(command) ||
		/(?:^|[;&]\s*)(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|lint|typecheck|build|check)|lint|typecheck|build|check)\b/i.test(
			command,
		) ||
		/(?:^|[;&]\s*)npx\s+(?:vitest|jest|playwright|eslint|tsc)\b/i.test(command) ||
		/(?:^|[;&]\s*)(?:vitest|jest|pytest|cargo test|go test|playwright test|eslint|tsc|make\s+(?:test|lint|build|check))\b/i.test(
			command,
		)
	);
}

function hasConsecutiveVerifyFailures(history: ToolOutcome[]): boolean {
	if (history.length < MAX_CONSECUTIVE_VERIFY_FAILURES) return false;
	const recent = history.slice(-MAX_CONSECUTIVE_VERIFY_FAILURES);
	return recent.every((entry) => normalizeToolName(entry.tool) === "verify" && !entry.success);
}

function hasWastedFileReadTokens(history: ToolOutcome[]): boolean {
	// Track per-file read tokens, resetting when that file is edited/written
	const fileReadTokens = new Map<string, number>();
	for (const entry of history) {
		if (entry.file) {
			const toolName = normalizeToolName(entry.tool);
			if (toolName === "edit" || toolName === "write" || toolName === "str_replace_editor") {
				// File was modified — reset its read counter
				fileReadTokens.delete(entry.file);
			} else if ((toolName === "read" || toolName === "read_file") && entry.success && entry.estimatedTokens) {
				fileReadTokens.set(entry.file, (fileReadTokens.get(entry.file) ?? 0) + entry.estimatedTokens);
			}
		}
	}
	for (const tokens of fileReadTokens.values()) {
		if (tokens > MAX_WASTED_READ_TOKENS) return true;
	}
	return false;
}

function hasFileChurn(history: ToolOutcome[]): boolean {
	if (history.length < MAX_FILE_CHURN_TURNS) return false;
	const recent = history.slice(-MAX_FILE_CHURN_TURNS);
	const fileOps = recent.filter((e) => e.file);
	const editOps = recent.filter((e) => {
		const toolName = normalizeToolName(e.tool);
		return toolName === "edit" || toolName === "write" || toolName === "str_replace_editor";
	});
	const uniqueFiles = new Set(fileOps.map((e) => e.file));
	return uniqueFiles.size >= 6 && editOps.length === 0;
}

/** Tools whose successful execution mutates files — always progress, never "stuck". */
const MUTATION_TOOLS = new Set(["edit", "write", "str_replace_editor", "patch", "multi_edit"]);

function hasStuckFileAccess(history: ToolOutcome[], threshold: number): boolean {
	const fileEntries = history.filter((e) => e.file);
	if (fileEntries.length < threshold) return false;
	const recent = fileEntries.slice(-threshold);
	// Successful mutations are progress, not stuckness — editing the same file
	// repeatedly is normal work.
	if (recent.some((entry) => entry.success && MUTATION_TOOLS.has(normalizeToolName(entry.tool)))) return false;
	const firstKey = buildToolOutcomeCallKey(recent[0]);
	return recent.every((entry) => buildToolOutcomeCallKey(entry) === firstKey);
}

/**
 * Checks if the agent produced meaningful text output in its most recent turn.
 * Uses the trend tracker's output token data to determine if the last turn
 * had substantive content (not just acknowledgments or tiny responses).
 */
function hasRecentText(context: NudgeContext): boolean {
	// If trend tracker says we have recent output, that counts as substantive
	if (context.trendTracker?.hasRecentOutput()) return true;
	// If the output trend is explicitly "diminishing" or unknown, do NOT count
	// it as substantive — the agent is producing negligible content.
	return false;
}

/**
 * Checks if the agent produced minimal text output (< MIN_TEXT_LENGTH chars)
 * in its most recent turn. This detects "wheel-spinning" where the model
 * produces tiny acknowledgments instead of real work.
 */
function hasMinimalText(context: NudgeContext): boolean {
	const lastOutput = context.trendTracker?.getLastOutputTokens() ?? 0;
	if (lastOutput > 0) {
		const estimatedChars = lastOutput * 3;
		return estimatedChars < MIN_TEXT_LENGTH;
	}
	return false;
}

function hasConcreteTaskProgress(history: ToolOutcome[]): boolean {
	return history.some((entry) => {
		const toolName = normalizeToolName(entry.tool);
		return (
			toolName === "write" ||
			toolName === "edit" ||
			toolName === "patch" ||
			toolName === "multi_edit" ||
			toolName === "str_replace_editor" ||
			(toolName === "bash" &&
				(classifyBashDetail(entry.detail) === "mutating" || classifyBashDetail(entry.detail) === "verification")) ||
			toolName === "run" ||
			toolName === "verify"
		);
	});
}

function hasRecentConcreteTaskProgress(history: ToolOutcome[], windowSize = 4): boolean {
	return hasConcreteTaskProgress(history.slice(-windowSize));
}

function hasRecentFailedMutation(history: ToolOutcome[], windowSize = 4): boolean {
	return history.slice(-windowSize).some((entry) => {
		const toolName = normalizeToolName(entry.tool);
		return (
			!entry.success &&
			(toolName === "edit" || toolName === "write" || toolName === "patch" || toolName === "str_replace_editor")
		);
	});
}

function hasRecentFailedVerification(history: ToolOutcome[], windowSize = 4): boolean {
	return history.slice(-windowSize).some((entry) => {
		const toolName = normalizeToolName(entry.tool);
		return (
			!entry.success &&
			(toolName === "verify" || (toolName === "bash" && classifyBashDetail(entry.detail) === "verification"))
		);
	});
}

function hasRecentUnverifiedImplementationProgress(history: ToolOutcome[], windowSize = 6): boolean {
	const recent = history.slice(-windowSize);
	let sawRecentMutation = false;
	for (let index = recent.length - 1; index >= 0; index--) {
		const entry = recent[index];
		const toolName = normalizeToolName(entry.tool);
		if (
			entry.success &&
			(toolName === "verify" || (toolName === "bash" && classifyBashDetail(entry.detail) === "verification"))
		) {
			return false;
		}
		if (
			entry.success &&
			(toolName === "edit" || toolName === "write" || toolName === "patch" || toolName === "str_replace_editor")
		) {
			sawRecentMutation = true;
			break;
		}
	}
	return sawRecentMutation;
}

// ── Cooldown and Escalation ────────────────────────────────────────

/**
 * Evaluates nudge with cooldown and escalation logic.
 * Call this instead of evaluateNudge() from autonomous-mode.ts.
 * Mutates cooldownState in place.
 */
export function evaluateNudgeWithCooldown(context: NudgeContext, cooldownState: NudgeCooldownState): NudgeEvaluation {
	// Step 1: Run base evaluation
	const base = evaluateNudge(context);

	// No nudge needed → reset escalation
	if (!base.shouldNudge) {
		cooldownState.escalationLevel = 0;
		return base;
	}

	// Step 2: Check cooldown — suppress identical nudges within window
	const turnsSinceLastNudge = context.turnIndex - cooldownState.lastNudgeTurn;
	const isSameType = base.nudgeType === cooldownState.lastNudgeType;

	if (isSameType && turnsSinceLastNudge < NUDGE_COOLDOWN_TURNS) {
		// Within cooldown window and same type → suppress
		return {
			shouldNudge: false,
			nudgeType: "none",
			shouldStop: false,
		};
	}

	// Step 3: Escalation — if same condition persists past cooldown
	if (isSameType && turnsSinceLastNudge >= NUDGE_COOLDOWN_TURNS) {
		cooldownState.escalationLevel = Math.min(cooldownState.escalationLevel + 1, MAX_ESCALATION_LEVEL);

		// At max escalation, force stop
		if (cooldownState.escalationLevel >= MAX_ESCALATION_LEVEL) {
			return {
				shouldNudge: true,
				nudgeType: "break_loop",
				shouldStop: true,
				stopReason: `Escalation cap reached: "${base.nudgeType}" condition persisted after ${MAX_ESCALATION_LEVEL} escalations.`,
				explanation: base.explanation,
			};
		}
	} else if (!isSameType) {
		// Different nudge type → reset escalation
		cooldownState.escalationLevel = 0;
	}

	// Step 4: Update cooldown state
	cooldownState.lastNudgeType = base.nudgeType;
	cooldownState.lastNudgeTurn = context.turnIndex;

	return base;
}
