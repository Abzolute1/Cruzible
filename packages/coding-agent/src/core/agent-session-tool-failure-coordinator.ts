import type { CustomMessage } from "./messages.js";

export interface ToolFailureWarning {
	toolName: string;
	failureCount: number;
	correctiveMessage: string;
}

export class AgentSessionToolFailureCoordinator {
	private readonly failureCounts = new Map<string, number>();
	private readonly notifiedTools = new Set<string>();
	private readonly threshold = 3;

	recordFailure(toolName: string): void {
		const count = this.failureCounts.get(toolName) || 0;
		this.failureCounts.set(toolName, count + 1);
	}

	recordSuccess(toolName: string): void {
		this.failureCounts.delete(toolName);
		this.notifiedTools.delete(toolName);
	}

	reset(): void {
		this.failureCounts.clear();
		this.notifiedTools.clear();
	}

	preparePromptInjection(activeTools: string[]): {
		message: CustomMessage | undefined;
		warnings: ToolFailureWarning[];
	} {
		const toolsToNotify: Array<{ toolName: string; failureCount: number }> = [];

		for (const [toolName, count] of this.failureCounts.entries()) {
			if (count >= this.threshold && !this.notifiedTools.has(toolName)) {
				toolsToNotify.push({ toolName, failureCount: count });
			}
		}

		if (toolsToNotify.length === 0) {
			return { message: undefined, warnings: [] };
		}

		const suggestions = toolsToNotify
			.map(({ toolName, failureCount }) => {
				const similarTools = activeTools.filter((activeTool) => {
					const normalizedActive = activeTool.toLowerCase();
					const normalizedFailed = toolName.toLowerCase();
					return (
						normalizedActive.includes(normalizedFailed.slice(0, 4)) ||
						normalizedFailed.includes(normalizedActive.slice(0, 4))
					);
				});

				const suggestion =
					similarTools.length > 0 ? ` Consider using: ${similarTools.slice(0, 3).join(", ")}.` : "";
				return `- \`${toolName}\` failed ${failureCount} times.${suggestion}`;
			})
			.join("\n");

		const availableToolsList = activeTools.length > 0 ? `\n\nAvailable tools: ${activeTools.join(", ")}` : "";
		const correctiveMessage = `<tool_failure_warning>\nThe following tools have failed repeatedly with "not found" errors:${suggestions}${availableToolsList}\n</tool_failure_warning>`;

		for (const { toolName } of toolsToNotify) {
			this.notifiedTools.add(toolName);
		}

		return {
			message: {
				role: "custom",
				customType: "tool_failure_warning",
				content: correctiveMessage,
				display: true,
				details: `Tool failures detected: ${toolsToNotify.map((tool) => tool.toolName).join(", ")}`,
				timestamp: Date.now(),
			},
			warnings: toolsToNotify.map(({ toolName, failureCount }) => ({
				toolName,
				failureCount,
				correctiveMessage,
			})),
		};
	}
}
