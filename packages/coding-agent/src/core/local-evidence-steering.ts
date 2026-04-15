import { normalizeToolName, type ToolOutcome } from "./auton/nudges/types.js";

export interface LocalEvidenceSteeringContext {
	toolCallHistory: ToolOutcome[];
	fileAccessHistory: ToolOutcome[];
}

function recentSuccessful(outcomes: ToolOutcome[], limit: number = 6): ToolOutcome[] {
	return outcomes.filter((outcome) => outcome.success).slice(-limit);
}

function isDiscoveryTool(tool: string): boolean {
	const normalized = normalizeToolName(tool);
	return normalized === "grep" || normalized === "find" || normalized === "glob" || normalized === "ls";
}

function quotePath(filePath: string): string {
	return `\`${filePath}\``;
}

export function buildLocalEvidencePromptAddendum(context: LocalEvidenceSteeringContext): string | undefined {
	const recentTools = recentSuccessful(context.toolCallHistory);
	const recentFiles = recentSuccessful(context.fileAccessHistory).filter(
		(outcome): outcome is ToolOutcome & { file: string } => typeof outcome.file === "string" && outcome.file.length > 0,
	);
	if (recentTools.length === 0) return undefined;

	const lastTool = recentTools[recentTools.length - 1];
	const lastFile = recentFiles[recentFiles.length - 1];

	if (recentFiles.length >= 2) {
		const sameFile = recentFiles.every((outcome) => outcome.file === lastFile?.file);
		if (sameFile && lastFile) {
			const discoveryOnly = recentFiles.every((outcome) => isDiscoveryTool(outcome.tool));
			if (discoveryOnly) {
				return `Runtime steering: The last turn already isolated ${quotePath(lastFile.file)} via discovery tools. Reuse that evidence. Prefer reading that file or answering directly instead of repeating grep/find/ls for the same target unless ambiguity remains.`;
			}

			const repeatedReads = recentFiles.every((outcome) => normalizeToolName(outcome.tool) === "read");
			if (repeatedReads) {
				return `Runtime steering: The last turn already read ${quotePath(lastFile.file)}. Reuse that evidence. Continue with offset only if more lines are needed, or answer directly instead of rereading from the top.`;
			}
		}
	}

	if (lastFile) {
		const normalizedTool = normalizeToolName(lastFile.tool);
		if (normalizedTool === "grep") {
			return `Runtime steering: The last turn already found a decisive grep match in ${quotePath(lastFile.file)}. Read that file near the matched range or answer from the evidence you already have before searching again.`;
		}
		if (normalizedTool === "find" || normalizedTool === "glob") {
			return `Runtime steering: The last turn already found ${quotePath(lastFile.file)}. Reuse that path. Read it directly, inspect it with ls if it is a directory, or answer from it before running another broad search.`;
		}
		if (normalizedTool === "ls") {
			return `Runtime steering: The last turn already inspected ${quotePath(lastFile.file)}. Reuse that listing and switch to read, find, or grep for specifics instead of repeating ls.`;
		}
	}

	if (lastTool && normalizeToolName(lastTool.tool) === "bash" && typeof lastTool.detail === "string") {
		const normalizedDetail = lastTool.detail.replace(/\s+/g, " ").trim();
		if (/(^|[;&|]\s*)(pwd\b|ls\b|find\b|fd\b|rg\s+--files\b|git\s+status(\s|$)|which\b)/.test(normalizedDetail)) {
			return "Runtime steering: The last turn already used inspection-style shell discovery. Reuse that evidence and switch to a targeted read/grep/find step or answer directly instead of repeating shell listing commands.";
		}
	}

	return undefined;
}
