// `task` is safe in headless: the subagent inherits the same headless policy
// below the boundary, so mutations stay blocked while read-only delegation works.
const HEADLESS_SAFE_TOOL_NAMES = ["read", "grep", "find", "ls", "webSearch", "webFetch", "task"] as const;

export function filterHeadlessActiveToolNames(activeToolNames: string[], availableToolNames: string[]): string[] {
	const available = new Set(availableToolNames);
	const filteredActive = activeToolNames.filter(
		(toolName) =>
			HEADLESS_SAFE_TOOL_NAMES.includes(toolName as (typeof HEADLESS_SAFE_TOOL_NAMES)[number]) &&
			available.has(toolName),
	);
	if (filteredActive.length > 0) {
		return filteredActive;
	}

	return HEADLESS_SAFE_TOOL_NAMES.filter((toolName) => available.has(toolName));
}
