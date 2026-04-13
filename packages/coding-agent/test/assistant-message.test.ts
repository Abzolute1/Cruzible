import { beforeAll, describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("AssistantMessageComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renders configuration failures with recovery guidance", () => {
		const component = new AssistantMessageComponent(
			{
				role: "assistant",
				content: [{ type: "text", text: "" }],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5.4",
				stopReason: "error",
				errorMessage: "401 Your authentication token is not from a valid issuer.",
				timestamp: Date.now(),
			},
			false,
		);

		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("Authentication failed for openai");
		expect(rendered).toContain("Run '/login openai' to re-authenticate");
		expect(rendered).toContain("Ctrl+L");
	});
});
