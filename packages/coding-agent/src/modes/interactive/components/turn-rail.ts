import { Container } from "@ag1/tui";
import { theme } from "../theme/theme.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { buildConsoleHeader } from "./console-chrome.js";
import { ToolExecutionComponent } from "./tool-execution.js";

/** Family key for timeline grouping: web research tools collapse into one "research" run. */
export function toolRunFamily(toolName: string): string {
	if (toolName === "webSearch" || toolName === "webFetch") return "research";
	return toolName;
}

function isExpandableChild(obj: unknown): obj is { setExpanded(expanded: boolean): void } {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj;
}

/**
 * Visual grouping rail for one assistant turn: renders the turn's components (thinking,
 * tool calls, answer) behind a muted left border so one unit of work reads as one block.
 *
 * Grouping happens at RENDER time only: consecutive completed calls to the same tool
 * family collapse into a single summary line. Components are never moved, re-parented,
 * or removed — so live, rebuild, replay, and fallback paths can't scramble the order.
 */
export class TurnRail extends Container {
	private groupsExpanded = false;

	/** Global expansion toggle (ctrl+o): expands groups AND member tool outputs. */
	setExpanded(expanded: boolean): void {
		this.groupsExpanded = expanded;
		for (const child of this.children) {
			if (isExpandableChild(child)) child.setExpanded(expanded);
		}
		this.invalidate();
	}

	private groupLine(family: string, members: ToolExecutionComponent[]): string {
		const counts = new Map<string, number>();
		for (const member of members) {
			counts.set(member.name, (counts.get(member.name) ?? 0) + 1);
		}
		const summary =
			counts.size === 1 && counts.has(family)
				? `×${members.length}`
				: [...counts.entries()].map(([name, count]) => `${name} ×${count}`).join(", ");
		const dot = theme.bold(theme.fg("success", "●"));
		const header = buildConsoleHeader({ badge: family, badgeColor: "text" });
		return `${dot} ${header} ${theme.fg("muted", "·")} ${theme.fg("accent", summary)}`;
	}

	override render(width: number): string[] {
		const railWidth = Math.max(1, width - 2);
		const rail = theme.fg("muted", "│");
		const out: string[] = [];
		const children = this.children;

		// Find collapse-able runs: same-family tools with only thinking-only messages between
		// them (never across real text content). Components are never moved — runs are
		// identified at render time, so live/rebuild/replay paths can't scramble order.
		const groups: Array<{ family: string; indices: number[] }> = [];
		if (!this.groupsExpanded) {
			let index = 0;
			while (index < children.length) {
				const child = children[index]!;
				if (!(child instanceof ToolExecutionComponent)) {
					index++;
					continue;
				}
				const family = toolRunFamily(child.name);
				const indices = [index];
				let cursor = index + 1;
				while (cursor < children.length) {
					const next = children[cursor]!;
					if (next instanceof ToolExecutionComponent) {
						if (toolRunFamily(next.name) !== family) break;
						indices.push(cursor++);
						continue;
					}
					if (next instanceof AssistantMessageComponent && next.isThinkingOnly) {
						cursor++;
						continue;
					}
					break;
				}
				if (indices.length >= 2 && indices.every((i) => (children[i] as ToolExecutionComponent).isComplete)) {
					groups.push({ family, indices });
				}
				index = cursor;
			}
		}
		const indexToGroup = new Map<number, (typeof groups)[number]>();
		for (const group of groups) {
			for (const i of group.indices) indexToGroup.set(i, group);
		}

		const emitted = new Set<(typeof groups)[number]>();
		for (let i = 0; i < children.length; i++) {
			const group = indexToGroup.get(i);
			if (group) {
				if (!emitted.has(group)) {
					emitted.add(group);
					out.push(
						`${rail} ${this.groupLine(
							group.family,
							group.indices.map((j) => children[j] as ToolExecutionComponent),
						)}`,
					);
				}
				continue;
			}
			for (const line of children[i]!.render(railWidth)) {
				out.push(`${rail} ${line}`);
			}
		}
		return out;
	}
}
