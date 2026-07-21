/**
 * verify_ui — claim-driven visual verification with an LLM judge.
 *
 * The main agent states a concrete, checkable claim ("the login button is
 * visible and enabled"); the tool screenshots the page and asks a judge model
 * for a verdict. Only the verdict returns to the main context — the screenshot
 * itself never pollutes it, which keeps verification cheap. If no vision-capable
 * judge is available, the tool degrades to returning the screenshot for
 * self-verification by the calling model.
 */

import type { AgentToolResult, AgentToolUpdateCallback } from "@ag1/agent-core";
import { completeSimple, type ImageContent, type Model, type TextContent } from "@ag1/ai";
import { type Static, Type } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "../../extensions/types.js";
import { runScreenshot } from "./engine.js";
import type { PageAction, ScreenshotOptions, ScreenshotResult } from "./types.js";
import { modelSupportsVision } from "./vision.js";

const pageActionSchema = Type.Union([
	Type.Object(
		{ type: Type.Literal("fill"), selector: Type.String(), value: Type.String() },
		{ additionalProperties: false },
	),
	Type.Object({ type: Type.Literal("click"), selector: Type.String() }, { additionalProperties: false }),
	Type.Object({ type: Type.Literal("wait"), ms: Type.Number() }, { additionalProperties: false }),
	Type.Object({ type: Type.Literal("navigate"), url: Type.String() }, { additionalProperties: false }),
]);

const verifyUiSchema = Type.Object({
	url: Type.String({ description: "Full URL including protocol, e.g. http://localhost:5173" }),
	claim: Type.String({
		description:
			'Concrete, checkable claim about the page, e.g. "the login button is visible and enabled" or "the snake game canvas renders a grid". One claim per call.',
	}),
	actions: Type.Optional(
		Type.Array(pageActionSchema, {
			description: "Optional interactions (fill/click/wait/navigate) to reach the state under test before judging.",
		}),
	),
	viewport: Type.Optional(
		Type.Object(
			{ width: Type.Number(), height: Type.Number() },
			{ description: "Viewport dimensions. Defaults to 1280x900. Use 390x844 for mobile." },
		),
	),
	fullPage: Type.Optional(
		Type.Boolean({ description: "Capture the full scrollable page height. Defaults to false (viewport only)." }),
	),
	timeoutMs: Type.Optional(Type.Number({ description: "Navigation timeout in milliseconds. Defaults to 15000." })),
});

export type VerifyUiInput = Static<typeof verifyUiSchema>;

export type VerifyUiVerdict = "PASS" | "FAIL" | "UNCLEAR" | "UNVERIFIABLE";

export interface VerifyUiDetails {
	verdict: VerifyUiVerdict;
	claim: string;
	evidence: string;
	url?: string;
	title?: string;
	consoleErrors?: string[];
	failedRequests?: string[];
	judgeModel?: string;
	error?: string;
}

export interface VerifyUiDeps {
	/** The model used to judge the screenshot against the claim (typically the active model). */
	getJudgeModel: () => Model<any> | undefined;
	/** Injectable for tests. */
	runScreenshot?: (
		url: string,
		actions: PageAction[],
		options: ScreenshotOptions,
		signal?: AbortSignal,
	) => Promise<ScreenshotResult>;
	/** Injectable for tests: returns the judge's raw text response. */
	runJudge?: (model: Model<any>, systemPrompt: string, userText: string, image: ImageContent) => Promise<string>;
}

const JUDGE_SYSTEM_PROMPT = [
	"You are a strict UI verification judge. You receive a screenshot of a web page plus one claim about it.",
	"Answer PASS only when the screenshot clearly and unambiguously supports the claim.",
	"Answer FAIL when the screenshot clearly contradicts the claim, or when the page failed to render (console errors / failed requests indicate a broken page) for a positive rendering claim.",
	"Answer UNCLEAR when the screenshot cannot settle the claim.",
	"Respond with exactly two lines:",
	"VERDICT: PASS|FAIL|UNCLEAR",
	"EVIDENCE: <one sentence citing what is actually visible>",
].join("\n");

const MAX_CLAIM_CHARS = 1000;

function buildJudgeUserText(result: ScreenshotResult, claim: string): string {
	const meta: string[] = [`URL: ${result.url}`, `Title: ${result.title}`];
	if (result.consoleErrors.length > 0) {
		meta.push(`Console errors (${result.consoleErrors.length}): ${result.consoleErrors.slice(0, 5).join(" | ")}`);
	}
	if (result.failedRequests.length > 0) {
		meta.push(`Failed requests (${result.failedRequests.length}): ${result.failedRequests.slice(0, 5).join(" | ")}`);
	}
	return `${meta.join("\n")}\n\nClaim to verify: ${claim}`;
}

/** Parse the judge's two-line response; anything unparseable degrades to UNCLEAR. */
export function parseJudgeVerdict(
	text: string,
	fallbackEvidence: string,
): { verdict: "PASS" | "FAIL" | "UNCLEAR"; evidence: string } {
	const verdictMatch = text.match(/VERDICT:\s*(PASS|FAIL|UNCLEAR)/i);
	const evidenceMatch = text.match(/EVIDENCE:\s*(.+)/i);
	if (!verdictMatch) {
		return { verdict: "UNCLEAR", evidence: fallbackEvidence || "Judge response did not follow the verdict format." };
	}
	return {
		verdict: verdictMatch[1].toUpperCase() as "PASS" | "FAIL" | "UNCLEAR",
		evidence: evidenceMatch?.[1]?.trim() || "No evidence given.",
	};
}

async function defaultRunJudge(
	model: Model<any>,
	systemPrompt: string,
	userText: string,
	image: ImageContent,
): Promise<string> {
	const response = await completeSimple(model, {
		systemPrompt,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: userText } as TextContent, image],
				timestamp: Date.now(),
			},
		],
	});
	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "Judge model call failed");
	}
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

export function createVerifyUiToolDefinition(
	deps: VerifyUiDeps,
): ToolDefinition<typeof verifyUiSchema, VerifyUiDetails> {
	const screenshot = deps.runScreenshot ?? runScreenshot;
	const judge = deps.runJudge ?? defaultRunJudge;

	return {
		name: "verify_ui",
		label: "Verify UI claim",
		description:
			"Verify a concrete claim about a web page by screenshotting it and judging the image against the claim. Returns PASS, FAIL, or UNCLEAR with one line of evidence — the screenshot itself is not returned unless no vision-capable judge is available. Use after building or modifying UI to confirm the result before claiming the work is done. State one specific, visible claim per call.",
		promptSnippet: "Verify a concrete UI claim against a real screenshot (LLM judge)",
		promptGuidelines: [
			"After creating or modifying frontend code, verify the result with verify_ui before claiming the task is done",
			"State one concrete, visible claim per call (e.g. 'the submit button is visible and enabled'), not vague ones like 'the page looks good'",
			"On FAIL: read the evidence, fix the cause, then re-verify — do not retry the same claim unchanged",
			"On UNCLEAR: make the claim more specific or interact first (login, navigate) with the actions option",
			"Use screenshot_url instead when you want to see the image yourself rather than get a verdict",
		],
		parameters: verifyUiSchema,
		async execute(
			_toolCallId: string,
			input: VerifyUiInput,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<VerifyUiDetails> | undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<VerifyUiDetails>> {
			const claim = input.claim.trim().slice(0, MAX_CLAIM_CHARS);
			if (!claim) {
				throw new Error("verify_ui requires a non-empty claim.");
			}

			const opts: ScreenshotOptions = {};
			if (input.fullPage !== undefined) opts.fullPage = input.fullPage;
			if (input.viewport !== undefined) opts.viewport = input.viewport;
			if (input.timeoutMs !== undefined) opts.timeoutMs = input.timeoutMs;

			let result: ScreenshotResult;
			try {
				result = await screenshot(input.url, (input.actions ?? []) as PageAction[], opts, _signal);
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : "unknown error";
				return {
					content: [{ type: "text", text: `UNVERIFIABLE · screenshot failed: ${message}` }],
					details: { verdict: "UNVERIFIABLE", claim, evidence: `Screenshot failed: ${message}`, error: message },
				};
			}

			const judgeModel = deps.getJudgeModel();
			if (!judgeModel || !modelSupportsVision(judgeModel)) {
				// No vision-capable judge: hand the screenshot to the caller for self-verification.
				const text = [
					`No vision-capable judge model available — evaluate the claim yourself from this screenshot.`,
					buildJudgeUserText(result, claim),
				].join("\n\n");
				const content: (TextContent | ImageContent)[] = [{ type: "text", text }, result.image];
				return {
					content,
					details: {
						verdict: "UNVERIFIABLE",
						claim,
						evidence: "No vision-capable judge model available; screenshot returned for self-verification.",
						url: result.url,
						title: result.title,
						consoleErrors: result.consoleErrors,
						failedRequests: result.failedRequests,
					},
				};
			}

			const judgeModelRef = `${judgeModel.provider}/${judgeModel.id}`;
			try {
				const raw = await judge(judgeModel, JUDGE_SYSTEM_PROMPT, buildJudgeUserText(result, claim), result.image);
				const { verdict, evidence } = parseJudgeVerdict(raw, "Judge response did not follow the verdict format.");
				return {
					content: [{ type: "text", text: `${verdict} · ${evidence}` }],
					details: {
						verdict,
						claim,
						evidence,
						url: result.url,
						title: result.title,
						consoleErrors: result.consoleErrors,
						failedRequests: result.failedRequests,
						judgeModel: judgeModelRef,
					},
				};
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : "unknown error";
				return {
					content: [{ type: "text", text: `UNCLEAR · judge call failed: ${message}` }],
					details: {
						verdict: "UNCLEAR",
						claim,
						evidence: `Judge call failed: ${message}`,
						url: result.url,
						title: result.title,
						consoleErrors: result.consoleErrors,
						failedRequests: result.failedRequests,
						judgeModel: judgeModelRef,
						error: message,
					},
				};
			}
		},
	};
}
