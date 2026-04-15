import { type AssistantMessage } from "@mariozechner/pi-ai";
import type { TUI } from "@mariozechner/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test } from "vitest";
import type { InteractivePlanArtifact } from "../src/modes/interactive/interactive-plan-artifacts.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { NoticeCardComponent } from "../src/modes/interactive/components/notice-card.js";
import { PlanReviewCardComponent } from "../src/modes/interactive/components/plan-review-card.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

function createArtifact(overrides: Partial<InteractivePlanArtifact> = {}): InteractivePlanArtifact {
	return {
		version: 1,
		planId: "ui_card_plan",
		revision: 7,
		status: "accepted",
		goal: "Tighten the interactive UI",
		summary: "Improve card hierarchy and status visibility.",
		assumptions: [],
		constraints: [],
		steps: ["Refresh card headers", "Clarify action dialogs"],
		risks: [],
		verification: [],
		openQuestions: [],
		rawPlan: "Plan:\n1. Refresh card headers\n2. Clarify action dialogs",
		completedStepIndexes: [0],
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("interactive ui cards", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("user messages stay visually distinct while assistant text stays unframed", () => {
		const user = new UserMessageComponent("Ship the UI cleanup.");
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "I updated the console surfaces." }],
		};
		const assistant = new AssistantMessageComponent(assistantMessage);

		const userRendered = stripAnsi(user.render(120).join("\n"));
		const assistantRendered = stripAnsi(assistant.render(120).join("\n"));
		expect(userRendered).toContain("Ship the UI cleanup.");
		expect(userRendered).not.toContain("YOU");
		expect(userRendered).not.toContain("input");
		expect(assistantRendered).toContain("I updated the console surfaces.");
		expect(assistantRendered).not.toContain("AGENT");
		expect(assistantRendered).not.toContain("response");
	});

	test("tool execution cards expose lifecycle state in the header", () => {
		const component = new ToolExecutionComponent("custom_tool", "tool-9", { foo: "bar" }, {}, undefined, createFakeTui());
		expect(stripAnsi(component.render(120).join("\n"))).toContain("● CUSTOM_TOOL");

		component.markExecutionStarted();
		expect(stripAnsi(component.render(120).join("\n"))).toContain("● CUSTOM_TOOL");
		expect(stripAnsi(component.render(120).join("\n"))).not.toContain("RUNNING");

		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		expect(stripAnsi(component.render(120).join("\n"))).not.toContain("DONE");
	});

	test("plan review cards render explicit plan chrome and progress context", () => {
		const component = new PlanReviewCardComponent(createArtifact(), { expanded: true });
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("PLAN");
		expect(rendered).toContain("Approved Plan");
		expect(rendered).toContain("1/2 complete");
		expect(rendered).toContain("STEPS");
	});

	test("notice cards present warnings as structured runtime surfaces", () => {
		const component = new NoticeCardComponent({
			badge: "warning",
			badgeColor: "warning",
			title: "Attention",
			lines: ["Warning: workspace permissions changed"],
			tone: "warning",
		});
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("WARNING");
		expect(rendered).toContain("Attention");
		expect(rendered).toContain("Warning: workspace permissions changed");
	});
});
