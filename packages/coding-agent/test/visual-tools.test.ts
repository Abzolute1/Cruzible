import { describe, expect, test, vi } from "vitest";
import { AgentSessionToolRegistryCoordinator } from "../src/core/agent-session-tool-registry-coordinator.js";
import { evaluateInteractiveNudges, hasUnverifiedFrontendWork } from "../src/core/nudge-warnings.js";
import type { ScreenshotResult } from "../src/core/tools/visual/index.js";
import { createVerifyUiToolDefinition, parseJudgeVerdict } from "../src/core/tools/visual/verify-ui.js";

const visionModel = { provider: "test", id: "vision-m", input: ["image"] } as any;
const textOnlyModel = { provider: "test", id: "text-m", input: ["text"] } as any;

function makeCoordinator(options: { model: any; mode?: "auto" | "on" | "off"; verdict?: "yes" | "no" }) {
	const state = {
		registry: new Map<string, unknown>(),
		activeNames: [] as string[],
		model: options.model,
	};
	const coordinator = new AgentSessionToolRegistryCoordinator({
		getModel: () => state.model,
		getVisualToolsMode: () => options.mode ?? "auto",
		getVisionVerdict: () => options.verdict,
		getExtensionRunner: () => undefined,
		getBaseToolDefinitions: () => new Map(),
		getCustomTools: () => [],
		getCurrentToolRegistryNames: () => [...state.registry.keys()],
		getCurrentActiveToolNames: () => [...state.activeNames],
		normalizePromptSnippet: (text) => text,
		normalizePromptGuidelines: (guidelines) => guidelines ?? [],
		setState: ({ toolRegistry }) => {
			state.registry = toolRegistry as Map<string, unknown>;
		},
		applyActiveToolNames: (names) => {
			// Mirror AgentSession.setActiveToolsByName: only registry members stay active
			state.activeNames = names.filter((name) => state.registry.has(name));
		},
	});
	return { coordinator, state };
}

describe("visual tool gating", () => {
	test("auto mode registers visual tools for vision models", () => {
		const { coordinator, state } = makeCoordinator({ model: visionModel });
		coordinator.refresh();
		expect(state.registry.has("screenshot_url")).toBe(true);
		expect(state.registry.has("interact_then_screenshot")).toBe(true);
		expect(state.registry.has("verify_ui")).toBe(true);
		expect(state.activeNames).toContain("verify_ui");
	});

	test("auto mode skips visual tools for text-only models", () => {
		const { coordinator, state } = makeCoordinator({ model: textOnlyModel });
		coordinator.refresh();
		expect(state.registry.has("screenshot_url")).toBe(false);
		expect(state.registry.has("verify_ui")).toBe(false);
	});

	test("visual tools appear after switching to a vision model and refreshing", () => {
		const { coordinator, state } = makeCoordinator({ model: textOnlyModel });
		coordinator.refresh();
		expect(state.registry.has("verify_ui")).toBe(false);

		state.model = visionModel;
		coordinator.refresh();
		expect(state.registry.has("verify_ui")).toBe(true);
		expect(state.activeNames).toContain("verify_ui");
	});

	test("visual tools disappear after switching away from a vision model", () => {
		const { coordinator, state } = makeCoordinator({ model: visionModel });
		coordinator.refresh();
		expect(state.activeNames).toContain("verify_ui");

		state.model = textOnlyModel;
		coordinator.refresh();
		expect(state.registry.has("verify_ui")).toBe(false);
		expect(state.activeNames).not.toContain("verify_ui");
	});

	test("on mode force-enables visual tools for text-only models", () => {
		const { coordinator, state } = makeCoordinator({ model: textOnlyModel, mode: "on" });
		coordinator.refresh();
		expect(state.registry.has("verify_ui")).toBe(true);
	});

	test("off mode disables visual tools even for vision models", () => {
		const { coordinator, state } = makeCoordinator({ model: visionModel, mode: "off" });
		coordinator.refresh();
		expect(state.registry.has("verify_ui")).toBe(false);
	});

	test("probed yes verdict enables visual tools for undeclared models", () => {
		const { coordinator, state } = makeCoordinator({ model: textOnlyModel, verdict: "yes" });
		coordinator.refresh();
		expect(state.registry.has("verify_ui")).toBe(true);
		expect(state.activeNames).toContain("verify_ui");
	});

	test("probed no verdict wins over declared vision metadata", () => {
		const { coordinator, state } = makeCoordinator({ model: visionModel, verdict: "no" });
		coordinator.refresh();
		expect(state.registry.has("verify_ui")).toBe(false);
	});

	test("no verdict falls back to declared metadata", () => {
		const withMetadata = makeCoordinator({ model: visionModel, verdict: undefined });
		withMetadata.coordinator.refresh();
		expect(withMetadata.state.registry.has("verify_ui")).toBe(true);

		const withoutMetadata = makeCoordinator({ model: textOnlyModel, verdict: undefined });
		withoutMetadata.coordinator.refresh();
		expect(withoutMetadata.state.registry.has("verify_ui")).toBe(false);
	});
});

const fakeScreenshot: ScreenshotResult = {
	image: { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
	url: "http://localhost:5173/",
	title: "App",
	consoleErrors: [],
	failedRequests: [],
	loadTimeMs: 120,
};

function makeVerifyUi(options: { judgeModel?: any; judgeText?: string; judgeError?: Error; screenshotError?: Error }) {
	const runJudge = vi.fn(async () => {
		if (options.judgeError) throw options.judgeError;
		return options.judgeText ?? "VERDICT: PASS\nEVIDENCE: The submit button is visible and enabled.";
	});
	const runScreenshot = vi.fn(async () => {
		if (options.screenshotError) throw options.screenshotError;
		return fakeScreenshot;
	});
	const tool = createVerifyUiToolDefinition({
		getJudgeModel: () => options.judgeModel,
		runScreenshot: runScreenshot as any,
		runJudge,
	});
	return { tool, runJudge, runScreenshot };
}

describe("verify_ui", () => {
	test("returns a PASS verdict without putting the image in the main context", async () => {
		const { tool, runJudge } = makeVerifyUi({ judgeModel: visionModel });
		const result = await tool.execute(
			"call1",
			{ url: "http://localhost:5173", claim: "submit button visible" },
			undefined,
			undefined,
			{} as any,
		);

		expect(result.details?.verdict).toBe("PASS");
		expect(result.details?.judgeModel).toBe("test/vision-m");
		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("text");
		const first = result.content[0];
		expect(first.type === "text" && first.text.includes("PASS")).toBe(true);
		expect(runJudge).toHaveBeenCalledOnce();
	});

	test("parses FAIL verdicts with evidence", async () => {
		const { tool } = makeVerifyUi({
			judgeModel: visionModel,
			judgeText: "VERDICT: FAIL\nEVIDENCE: The page shows a blank white screen.",
		});
		const result = await tool.execute(
			"call1",
			{ url: "http://localhost:5173", claim: "grid renders" },
			undefined,
			undefined,
			{} as any,
		);

		expect(result.details?.verdict).toBe("FAIL");
		expect(result.details?.evidence).toContain("blank white screen");
	});

	test("degrades to self-verification with the image when no vision judge exists", async () => {
		const { tool, runJudge } = makeVerifyUi({ judgeModel: textOnlyModel });
		const result = await tool.execute(
			"call1",
			{ url: "http://localhost:5173", claim: "grid renders" },
			undefined,
			undefined,
			{} as any,
		);

		expect(result.details?.verdict).toBe("UNVERIFIABLE");
		expect(result.content.some((c) => c.type === "image")).toBe(true);
		expect(runJudge).not.toHaveBeenCalled();
	});

	test("returns UNCLEAR when the judge call fails", async () => {
		const { tool } = makeVerifyUi({ judgeModel: visionModel, judgeError: new Error("rate limited") });
		const result = await tool.execute(
			"call1",
			{ url: "http://localhost:5173", claim: "grid renders" },
			undefined,
			undefined,
			{} as any,
		);

		expect(result.details?.verdict).toBe("UNCLEAR");
		expect(result.details?.error).toBe("rate limited");
	});

	test("returns UNVERIFIABLE when the screenshot fails", async () => {
		const { tool } = makeVerifyUi({ judgeModel: visionModel, screenshotError: new Error("connection refused") });
		const result = await tool.execute(
			"call1",
			{ url: "http://localhost:9", claim: "grid renders" },
			undefined,
			undefined,
			{} as any,
		);

		expect(result.details?.verdict).toBe("UNVERIFIABLE");
		expect(result.details?.error).toBe("connection refused");
	});

	test("rejects an empty claim", async () => {
		const { tool } = makeVerifyUi({ judgeModel: visionModel });
		await expect(
			tool.execute("call1", { url: "http://localhost:5173", claim: "   " }, undefined, undefined, {} as any),
		).rejects.toThrow("non-empty claim");
	});
});

describe("parseJudgeVerdict", () => {
	test("parses well-formed verdicts case-insensitively", () => {
		expect(parseJudgeVerdict("verdict: pass\nevidence: looks right", "")).toEqual({
			verdict: "PASS",
			evidence: "looks right",
		});
	});

	test("degrades to UNCLEAR when the verdict line is missing", () => {
		const parsed = parseJudgeVerdict("I think it looks fine", "fallback reason");
		expect(parsed.verdict).toBe("UNCLEAR");
		expect(parsed.evidence).toBe("fallback reason");
	});
});

describe("hasUnverifiedFrontendWork", () => {
	const edit = (file: string, success = true) => ({ tool: "edit", success, file });
	const verify = () => ({ tool: "verify_ui", success: true });

	test("flags frontend edits without subsequent verification", () => {
		expect(hasUnverifiedFrontendWork([edit("src/App.tsx")])).toBe(true);
		expect(hasUnverifiedFrontendWork([edit("src/style.css"), edit("src/index.html")])).toBe(true);
	});

	test("clears when a visual verification happened after the edit", () => {
		expect(hasUnverifiedFrontendWork([edit("src/App.tsx"), verify()])).toBe(false);
		expect(hasUnverifiedFrontendWork([edit("src/App.tsx"), verify(), edit("src/App.tsx")])).toBe(true);
	});

	test("ignores non-frontend files and failed edits", () => {
		expect(hasUnverifiedFrontendWork([edit("src/util.py")])).toBe(false);
		expect(hasUnverifiedFrontendWork([edit("src/App.tsx", false)])).toBe(false);
	});
});

describe("ui_unverified nudge", () => {
	test("warns when visual tools are active and frontend work is unverified", () => {
		const warnings = evaluateInteractiveNudges({
			turnIndex: 3,
			toolCallHistory: [{ tool: "edit", success: true, file: "src/App.tsx" }],
			fileAccessHistory: [],
			lastOutputTokens: 200,
			visualToolsActive: true,
		});
		const warning = warnings.find((w) => w.type === "ui_unverified");
		expect(warning).toBeDefined();
		expect(warning?.message).toContain("verify_ui");
	});

	test("stays silent when visual tools are inactive or work is verified", () => {
		const base = {
			turnIndex: 3,
			fileAccessHistory: [],
			lastOutputTokens: 200,
		};
		expect(
			evaluateInteractiveNudges({
				...base,
				toolCallHistory: [{ tool: "edit", success: true, file: "src/App.tsx" }],
				visualToolsActive: false,
			}).some((w) => w.type === "ui_unverified"),
		).toBe(false);
		expect(
			evaluateInteractiveNudges({
				...base,
				toolCallHistory: [
					{ tool: "edit", success: true, file: "src/App.tsx" },
					{ tool: "verify_ui", success: true },
				],
				visualToolsActive: true,
			}).some((w) => w.type === "ui_unverified"),
		).toBe(false);
	});
});
