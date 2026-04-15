import stripAnsi from "strip-ansi";
import { describe, expect, test } from "vitest";
import { SplitPanelBannerComponent } from "../src/modes/interactive/components/centered-banner.js";

describe("SplitPanelBannerComponent", () => {
	test("renders a bordered split panel with both sections", () => {
		const component = new SplitPanelBannerComponent(
			"Crucible v0.65.2",
			"Directory",
			["/home/alex", "interactive · planning · autonomous"],
			"Quick Start",
			["enter prompt or ! shell", "ctrl+l models · alt+m autonomy"],
		);

		const rendered = stripAnsi(component.render(100).join("\n"));
		expect(rendered).toContain("Crucible v0.65.2");
		expect(rendered).toContain("Directory");
		expect(rendered).toContain("/home/alex");
		expect(rendered).toContain("Quick Start");
		expect(rendered).toContain("enter prompt or ! shell");
		expect(rendered).toContain("╭");
		expect(rendered).toContain("│");
		expect(rendered).toContain("╰");
	});
});
