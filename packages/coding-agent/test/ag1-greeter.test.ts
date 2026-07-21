import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test } from "vitest";
import { Ag1GreeterComponent } from "../src/modes/interactive/components/ag1-greeter.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("Ag1GreeterComponent", () => {
	beforeAll(() => {
		initTheme("dark", false);
	});

	test("renders the AG1 wordmark and compact session panel", () => {
		const component = new Ag1GreeterComponent({
			version: "0.65.2",
			cwd: "/home/alex/project",
			modeLine: "interactive · planning · autonomous",
			providerLabel: "local",
			modelLabel: "lm-studio",
		});

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("█████");
		expect(rendered).toContain(">_ AG1");
		expect(rendered).toContain("(v0.65.2)");
		expect(rendered).toContain("local | lm-studio");
		expect(rendered).toContain("interactive · planning · autonomous");
		expect(rendered).toContain("/home/alex/project");
	});

	test("stacks cleanly in narrow terminals", () => {
		const component = new Ag1GreeterComponent({
			version: "0.65.2",
			cwd: "/home/alex/project",
			modeLine: "interactive",
			providerLabel: "local",
			modelLabel: "lm-studio",
		});

		const rendered = stripAnsi(component.render(48).join("\n"));
		expect(rendered).toContain(">_ AG1");
		expect(rendered).toContain("local | lm-studio");
	});
});
