/**
 * Shared nudge detection functions for interactive mode.
 * Standalone - no dependencies on auton modules.
 */

/** Tool outcome for tracking */
interface ToolOutcome {
	tool: string;
	success: boolean;
	estimatedTokens?: number;
	file?: string;
}

// Thresholds (matching auton nudge-eval.ts)
const MAX_CONSECUTIVE_DUPLICATE_TOOLS = 3;
const MAX_CONSECUTIVE_SAME_FILE = 4;
const MAX_EXPLORATION_TURNS = 12;
const MAX_FILE_CHURN_TURNS = 8;
const MAX_WASTED_READ_TOKENS = 20_000;
const MIN_TEXT_CHARS = 50;

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
}

function hasDuplicateToolCalls(history: ToolOutcome[], threshold: number): boolean {
	if (history.length < threshold) return false;
	const recent = history.slice(-threshold);
	const first = recent[0]?.tool;
	if (!first) return false;
	return recent.every((t) => t.tool === first);
}

function hasWastedReadTokens(history: ToolOutcome[]): boolean {
	const reads = history.filter((t) => t.tool === "read" || t.tool === "read_file");
	if (reads.length < 3) return false;
	return reads.reduce((s, t) => s + (t.estimatedTokens || 0), 0) > MAX_WASTED_READ_TOKENS;
}

function hasFileChurn(history: ToolOutcome[], turnIndex: number): boolean {
	if (turnIndex < MAX_FILE_CHURN_TURNS || history.length === 0) return false;
	const recent = history.slice(-MAX_FILE_CHURN_TURNS);
	const uniqueFiles = new Set(recent.map((f) => f.file).filter(Boolean));
	const hasEdits = recent.some((f) => f.tool === "edit" || f.tool === "write");
	return uniqueFiles.size >= 6 && !hasEdits;
}

function hasStuckFileAccess(history: ToolOutcome[]): boolean {
	if (history.length < MAX_CONSECUTIVE_SAME_FILE) return false;
	const recent = history.slice(-MAX_CONSECUTIVE_SAME_FILE);
	const first = recent[0]?.file;
	if (!first) return false;
	return recent.every((f) => f.file === first);
}

export function evaluateInteractiveNudges(context: InteractiveNudgeContext): NudgeWarning[] {
	const warnings: NudgeWarning[] = [];
	const { turnIndex, toolCallHistory, fileAccessHistory, lastOutputTokens } = context;

	if (hasDuplicateToolCalls(toolCallHistory, MAX_CONSECUTIVE_DUPLICATE_TOOLS)) {
		const lastTool = toolCallHistory[toolCallHistory.length - 1]?.tool;
		warnings.push({
			type: "duplicate_tools",
			message: `Tool repetition detected: \`${lastTool}\` called ${MAX_CONSECUTIVE_DUPLICATE_TOOLS}+ times. Consider a different approach.`,
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
		const lastFile = fileAccessHistory[fileAccessHistory.length - 1]?.file;
		warnings.push({
			type: "stuck_file",
			message: `Repeatedly accessing \`${lastFile}\`. Consider a different file or approach.`,
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
