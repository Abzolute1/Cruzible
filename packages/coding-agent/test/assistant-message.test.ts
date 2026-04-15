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

	test("renders local backend failures with recovery guidance", () => {
		const component = new AssistantMessageComponent(
			{
				role: "assistant",
				content: [{ type: "text", text: "" }],
				api: "openai-responses",
				provider: "local",
				model: "lm-studio",
				stopReason: "error",
				errorMessage: "Connection error.",
				timestamp: Date.now(),
			},
			false,
		);

		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("Local model backend unavailable for local/lm-studio");
		expect(rendered).toContain("Start LM Studio");
		expect(rendered).toContain("Ctrl+L");
	});

	test("strips XML tool call artifacts from visible assistant text", () => {
		const component = new AssistantMessageComponent(
			{
				role: "assistant",
				content: [
					{
						type: "text",
						text: [
							"I found the folder. Let me check it.",
							"",
							"<tool_call>",
							"<function-bash>",
							"<parameter-command>ls -lh /home/alex/Downloads/</parameter-command>",
							"</function-bash>",
							"</tool_call>",
						].join("\n"),
					},
				],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5.4",
				stopReason: "stop",
				timestamp: Date.now(),
			},
			false,
		);

		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("I found the folder. Let me check it.");
		expect(rendered).not.toContain("<tool_call>");
		expect(rendered).not.toContain("<function-bash>");
	});

	test("strips equals-style XML tool call artifacts from visible assistant text", () => {
		const component = new AssistantMessageComponent(
			{
				role: "assistant",
				content: [
					{
						type: "text",
						text: [
							"I found relevant results. Let me fetch the first URL.",
							"",
							"<tool_call>",
							"<function=webFetch>",
							"<parameter=url>https://tech-insider.org/anthropic-claude-code-source-code-leak-npm-2026/</parameter>",
							"</function>",
							"</tool_call>",
						].join("\n"),
					},
				],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5.4",
				stopReason: "stop",
				timestamp: Date.now(),
			},
			false,
		);

		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("I found relevant results. Let me fetch the first URL.");
		expect(rendered).not.toContain("<tool_call>");
		expect(rendered).not.toContain("<function=webFetch>");
		expect(rendered).not.toContain("<parameter=url>");
	});
});
