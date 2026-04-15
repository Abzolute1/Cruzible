import { theme } from "./theme/theme.js";

function buildStartupRow(label: string, value: string): string {
	return `${theme.fg("dim", label.padEnd(10))} ${theme.fg("text", value)}`;
}

export function buildInteractiveStartupOverviewLines(cwd: string): string[] {
	return [
		buildStartupRow("Workspace", cwd),
		buildStartupRow("Modes", "interactive · planning · autonomous"),
		buildStartupRow("Prompt", "enter a task or paste files/constraints before first turn"),
		buildStartupRow("Keys", "enter prompt · ! shell · ctrl+t models · alt+m autonomy · alt+r review"),
		buildStartupRow("Quick", "/workspace sandbox · /research saved sources"),
	];
}

export function buildInteractiveQueuedContextLines(options: {
	steering: string[];
	followUp: string[];
	dequeueHint?: string;
}): string[] {
	const lines: string[] = [];
	for (const message of options.steering) {
		lines.push(`Steering: ${message}`);
	}
	for (const message of options.followUp) {
		lines.push(`Follow-up: ${message}`);
	}
	if (lines.length > 0 && options.dequeueHint) {
		lines.push("");
		lines.push(`Edit queue: ${options.dequeueHint}`);
	}
	return lines;
}

export function normalizeInteractiveWorkspaceSummaryLines(summary: string): string[] {
	if (!summary.trim()) return [];
	return summary
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line, index, lines) => {
			if (line.trim().length === 0) return false;
			if (line === "Autonomous Workspace") return false;
			if (index === 0 && line.trim().length === 0) return false;
			return true;
		});
}
