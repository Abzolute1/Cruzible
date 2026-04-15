import { Box, Container, Spacer, Text } from "@mariozechner/pi-tui";
import type { InteractivePlanArtifact } from "../interactive-plan-artifacts.js";
import {
	buildInteractiveExpandedPlanCardLines,
	buildInteractivePlanCardLines,
} from "../interactive-plan-review-ui.js";
import { DynamicBorder } from "./dynamic-border.js";
import { theme } from "../theme/theme.js";

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
		this.addChild(new DynamicBorder((text) => borderColor(text)));
		this.addChild(new Text(borderColor(theme.bold(this.getTitle())), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.box);
		this.box.clear();
		for (const line of this.getLines()) {
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
				return (text) => theme.fg("success", text);
			case "rejected":
				return (text) => theme.fg("error", text);
			case "superseded":
				return (text) => theme.fg("muted", text);
			default:
				return (text) => theme.fg("accent", text);
		}
	}
}
