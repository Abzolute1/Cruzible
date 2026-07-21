import { Box, Container, Spacer, Text } from "@ag1/tui";
import type { InteractivePlanArtifact } from "../interactive-plan-artifacts.js";
import { buildInteractiveExpandedPlanCardLines, buildInteractivePlanCardLines } from "../interactive-plan-review-ui.js";
import { theme } from "../theme/theme.js";
import { buildConsoleBadge, buildConsoleHeader, buildConsoleMeta } from "./console-chrome.js";
import { DynamicBorder } from "./dynamic-border.js";

export class PlanReviewCardComponent extends Container {
	private artifact: InteractivePlanArtifact;
	private box: Box;
	private expanded: boolean;

	constructor(artifact: InteractivePlanArtifact, options?: { expanded?: boolean }) {
		super();
		this.artifact = artifact;
		this.expanded = options?.expanded ?? false;
		this.box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		this.rebuild();
	}

	setArtifact(artifact: InteractivePlanArtifact, options?: { expanded?: boolean }): void {
		this.artifact = artifact;
		this.expanded = options?.expanded ?? this.expanded;
		this.rebuild();
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		const borderColor = this.getBorderColor();
		this.box.setBgFn(this.getBackgroundColor());
		this.addChild(new DynamicBorder((text) => borderColor(text)));
		this.addChild(
			new Text(
				buildConsoleHeader({
					badge: "plan",
					badgeColor: this.getStatusColor(),
					title: this.getTitle(),
					meta: [`v${this.artifact.revision}`, this.artifact.status],
				}),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(this.box);
		this.box.clear();
		this.box.addChild(
			new Text(
				buildConsoleMeta(
					[
						`${this.getCompletedSteps()}/${this.artifact.steps.length} complete`,
						this.artifact.executionStep ? `executing ${this.artifact.executionStep}` : undefined,
						this.artifact.feedback ? "feedback attached" : undefined,
					],
					"dim",
				),
				0,
				0,
			),
		);
		this.box.addChild(new Spacer(1));
		for (const line of this.getLines()) {
			if (line === "") {
				this.box.addChild(new Spacer(1));
				continue;
			}
			if (this.isSectionHeading(line)) {
				this.box.addChild(new Text(buildConsoleBadge(line, this.getStatusColor()), 0, 0));
				continue;
			}
			this.box.addChild(new Text(theme.fg("customMessageText", line), 0, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((text) => borderColor(text)));
	}

	private getLines(): string[] {
		return this.expanded
			? buildInteractiveExpandedPlanCardLines(this.artifact)
			: buildInteractivePlanCardLines(this.artifact);
	}

	private getTitle(): string {
		switch (this.artifact.status) {
			case "clarifying":
				return "Planning Interview";
			case "accepted":
				return "Approved Plan";
			case "executing":
				return "Plan Execution";
			case "completed":
				return "Completed Plan";
			case "rejected":
				return "Rejected Plan";
			case "superseded":
				return "Superseded Plan";
			default:
				return "Plan Review";
		}
	}

	private getBorderColor(): (text: string) => string {
		switch (this.artifact.status) {
			case "clarifying":
				return (text) => theme.fg("warning", text);
			case "accepted":
			case "completed":
				return (text) => theme.fg("success", text);
			case "rejected":
				return (text) => theme.fg("error", text);
			case "superseded":
				return (text) => theme.fg("muted", text);
			default:
				return (text) => theme.fg("accent", text);
		}
	}

	private getBackgroundColor(): (text: string) => string {
		switch (this.artifact.status) {
			case "accepted":
			case "completed":
				return (text) => theme.bg("toolSuccessBg", text);
			case "rejected":
				return (text) => theme.bg("toolErrorBg", text);
			case "clarifying":
				return (text) => theme.bg("toolPendingBg", text);
			default:
				return (text) => theme.bg("customMessageBg", text);
		}
	}

	private getStatusColor(): "accent" | "warning" | "success" | "error" | "muted" {
		switch (this.artifact.status) {
			case "clarifying":
				return "warning";
			case "accepted":
			case "completed":
				return "success";
			case "rejected":
				return "error";
			case "superseded":
				return "muted";
			default:
				return "accent";
		}
	}

	private getCompletedSteps(): number {
		return new Set(this.artifact.completedStepIndexes ?? []).size;
	}

	private isSectionHeading(line: string): boolean {
		return PLAN_CARD_SECTION_HEADINGS.has(line.trim().toLowerCase());
	}
}

/** Standalone heading lines emitted by the plan card/review line builders. */
const PLAN_CARD_SECTION_HEADINGS = new Set([
	"summary",
	"steps",
	"assumptions",
	"constraints",
	"risks",
	"verification",
	"questions",
	"guidance",
	"open questions",
	"clarifying questions",
	"clarification answers",
	"latest step review",
	"review actions",
	"execution actions",
]);
