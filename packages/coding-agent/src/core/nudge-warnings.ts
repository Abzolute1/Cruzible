/**
 * Shared nudge detection functions for interactive mode.
 * Standalone - no dependencies on auton modules.
 */
import { detectErrorLoop, detectNoProgressLoop, detectPingPong } from "./auton/nudges/loop-detection.js";
import { normalizeToolName } from "./auton/nudges/types.js";

/** Tool outcome for tracking */
interface ToolOutcome {
	tool: string;
	success: boolean;
	estimatedTokens?: number;
	file?: string;
	detail?: string;
	fingerprint?: string;
	callDigest?: string;
	resultDigest?: string;
}

// Thresholds (matching auton nudge-eval.ts)
const MAX_CONSECUTIVE_SAME_FILE = 4;
const MAX_EXPLORATION_TURNS = 12;
const MAX_FILE_CHURN_TURNS = 8;
const MAX_WASTED_READ_TOKENS = 20_000;

/** Tools whose successful execution mutates files — always progress, never "stuck". */
const MUTATION_TOOLS = new Set(["edit", "write", "str_replace_editor", "patch", "multi_edit"]);

/** Tools that count as visual verification of frontend work. */
const VISUAL_VERIFICATION_TOOLS = new Set(["screenshot_url", "interact_then_screenshot", "verify_ui"]);

const FRONTEND_FILE_RE = /\.(html?|css|scss|sass|less|jsx|tsx|vue|svelte)$/i;

/**
 * True when frontend files were mutated without any visual verification since.
 * Scans backwards: a visual verification call clears everything before it.
 */
export function hasUnverifiedFrontendWork(history: ToolOutcome[]): boolean {
	for (let i = history.length - 1; i >= 0; i--) {
		const entry = history[i];
		const tool = normalizeToolName(entry.tool);
		if (VISUAL_VERIFICATION_TOOLS.has(tool)) return false;
		if (entry.success && MUTATION_TOOLS.has(tool) && entry.file && FRONTEND_FILE_RE.test(entry.file)) {
			return true;
		}
	}
	return false;
}

export interface NudgeWarning {
	type: string;
	message: string;
	severity: "warning" | "error";
}

export interface InteractiveNudgeContext {
	turnIndex: number;
	toolCallHistory: ToolOutcome[];
	fileAccessHistory: ToolOutcome[];
	lastOutputTokens: number;
	/** True when the todo list has open items but hasn't been updated recently. */
	todoStale?: boolean;
	/** True when visual verification tools (screenshot_url, verify_ui) are active. */
	visualToolsActive?: boolean;
}

function hasWastedReadTokens(history: ToolOutcome[]): boolean {
	const reads = history.filter((entry) => {
		const tool = normalizeToolName(entry.tool);
		return tool === "read" || tool === "read_file";
	});
	if (reads.length < 3) return false;
	return reads.reduce((s, t) => s + (t.estimatedTokens || 0), 0) > MAX_WASTED_READ_TOKENS;
}

function hasFileChurn(history: ToolOutcome[], turnIndex: number): boolean {
	if (turnIndex < MAX_FILE_CHURN_TURNS || history.length === 0) return false;
	const recent = history.slice(-MAX_FILE_CHURN_TURNS);
	const uniqueFiles = new Set(recent.map((f) => f.file).filter(Boolean));
	const hasEdits = recent.some((entry) => {
		const tool = normalizeToolName(entry.tool);
		return tool === "edit" || tool === "write" || tool === "str_replace_editor";
	});
	return uniqueFiles.size >= 6 && !hasEdits;
}

function hasStuckFileAccess(history: ToolOutcome[]): boolean {
	if (history.length < MAX_CONSECUTIVE_SAME_FILE) return false;
	const recent = history.slice(-MAX_CONSECUTIVE_SAME_FILE);
	const first = recent[0];
	if (!first?.file) return false;
	if (!recent.every((entry) => entry.file === first.file)) return false;
	// Successful mutations are progress, not stuckness — editing the same file
	// repeatedly is normal work.
	if (recent.some((entry) => entry.success && MUTATION_TOOLS.has(normalizeToolName(entry.tool)))) return false;
	return true;
}

function isDiscoveryTool(tool: string): boolean {
	const normalized = normalizeToolName(tool);
	return normalized === "grep" || normalized === "find" || normalized === "glob" || normalized === "ls";
}

export function evaluateInteractiveNudges(context: InteractiveNudgeContext): NudgeWarning[] {
	const warnings: NudgeWarning[] = [];
	const { turnIndex, toolCallHistory, fileAccessHistory, lastOutputTokens } = context;

	const errorLoop = detectErrorLoop(toolCallHistory);
	if (errorLoop) {
		warnings.push({
			type: "error_loop",
			message: `\`${errorLoop.tool}\` failed ${errorLoop.count}× with identical arguments. The same call will keep failing — change the arguments or fix the underlying problem first.`,
			severity: "warning",
		});
	}

	const noProgress = detectNoProgressLoop(toolCallHistory);
	if (noProgress) {
		warnings.push({
			type: "no_progress",
			message: `\`${noProgress.tool}\` returned the same result ${noProgress.count}× in a row. You already have this information — act on it instead of re-running the call.`,
			severity: "warning",
		});
	}

	const pingPong = detectPingPong(toolCallHistory);
	if (pingPong) {
		warnings.push({
			type: "ping_pong",
			message: `Oscillating between \`${pingPong.toolA}\` and \`${pingPong.toolB}\` without progress. Stop and decide based on the results you already have.`,
			severity: "warning",
		});
	}

	if (context.todoStale) {
		warnings.push({
			type: "todo_stale",
			message: `Todo list is stale — no update in several tool calls. Mark finished items completed and keep exactly one task in progress.`,
			severity: "warning",
		});
	}

	if (context.visualToolsActive && hasUnverifiedFrontendWork(toolCallHistory)) {
		warnings.push({
			type: "ui_unverified",
			message: `Frontend changed without visual verification. Run verify_ui with a concrete claim (e.g. "the submit button is visible and enabled") before wrapping up.`,
			severity: "warning",
		});
	}

	if (hasWastedReadTokens(toolCallHistory)) {
		warnings.push({
			type: "wasted_reads",
			message: `Excessive file reading without editing. Consider using /compact or changing strategy.`,
			severity: "warning",
		});
	}

	if (hasFileChurn(fileAccessHistory, turnIndex)) {
		warnings.push({
			type: "file_churn",
			message: `Reading many files without edits. Consider focusing on specific files.`,
			severity: "warning",
		});
	}

	if (hasStuckFileAccess(fileAccessHistory)) {
		const recent = fileAccessHistory.slice(-MAX_CONSECUTIVE_SAME_FILE);
		const lastFile = recent[recent.length - 1]?.file;
		const discoveryOnly = recent.every((entry) => isDiscoveryTool(entry.tool));
		warnings.push({
			type: "stuck_file",
			message: discoveryOnly
				? `Repeatedly rediscovering \`${lastFile}\`. Reuse the evidence you already have instead of searching again.`
				: `Repeatedly revisiting \`${lastFile}\`. Reuse the evidence you already have, or change files/approach.`,
			severity: "warning",
		});
	}

	if (lastOutputTokens > 0 && lastOutputTokens < 70) {
		warnings.push({
			type: "minimal_output",
			message: `Very short responses detected. Model may be stuck - consider /compact or rephrasing.`,
			severity: "warning",
		});
	}

	if (turnIndex >= MAX_EXPLORATION_TURNS && lastOutputTokens === 0) {
		warnings.push({
			type: "exploration_cap",
			message: `${turnIndex} turns without substantive output. Consider wrapping up or changing approach.`,
			severity: "error",
		});
	}

	return warnings;
}

export function deduplicateWarnings(
	warnings: NudgeWarning[],
	shownWarnings: Map<string, number>,
	currentTurn: number,
	cooldownTurns: number = 8,
): NudgeWarning[] {
	return warnings.filter((w) => {
		const last = shownWarnings.get(w.type);
		return last === undefined || currentTurn - last >= cooldownTurns;
	});
}
