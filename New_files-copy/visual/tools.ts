/**
 * Visual verification tool definitions: screenshot_url and interact_then_screenshot.
 *
 * These tools are registered conditionally — only when the active model has
 * vision capability (input includes "image"). The harness gates registration
 * via a vision capability check.
 *
 * Each tool returns an AgentToolResult with:
 *   - content: [{ type: "text", text: metadata }, { type: "image", data: base64, mimeType: "image/png" }]
 *   - details: structured metadata for logs/UI (console errors, failed requests, load time)
 */

import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@ag1/agent-core";
import type { ImageContent, TextContent } from "@ag1/ai";
import { type Static, Type } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "../../extensions/types.js";
import { wrapToolDefinition } from "../tool-definition-wrapper.js";
import { runScreenshot } from "./engine.js";
import type { PageAction, ScreenshotOptions } from "./types.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const screenshotUrlSchema = Type.Object({
	url: Type.String({
		description: "Full URL including protocol, e.g. http://localhost:5173 or http://localhost:3000",
	}),
	fullPage: Type.Optional(
		Type.Boolean({
			description:
				"Capture the full scrollable page height. Defaults to false — only the viewport is captured. Set true when you need to see content below the fold. Full-page screenshots are large and consume significant context.",
		}),
	),
	viewport: Type.Optional(
		Type.Object(
			{
				width: Type.Number({ description: "Viewport width in pixels. Defaults to 1280." }),
				height: Type.Number({ description: "Viewport height in pixels. Defaults to 900." }),
			},
			{ description: "Viewport dimensions. Defaults to 1280x900 (desktop). Use e.g. { width: 390, height: 844 } for mobile." },
		),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description: "Navigation timeout in milliseconds. Defaults to 15000. Increase for slow apps.",
		}),
	),
});

const pageActionSchema = Type.Object({
	type: Type.String({ enum: ["fill", "click", "wait", "navigate"] }),
	selector: Type.Optional(
		Type.String({ description: "CSS selector. Required for 'fill' and 'click' actions." }),
	),
	value: Type.Optional(Type.String({ description: "Text to type. Required for 'fill' action." })),
	ms: Type.Optional(Type.Number({ description: "Milliseconds to wait. Required for 'wait' action." })),
	url: Type.Optional(Type.String({ description: "URL to navigate to. Required for 'navigate' action." })),
});

const interactThenScreenshotSchema = Type.Object({
	url: Type.String({
		description: "URL to navigate to first, e.g. http://localhost:5173/login",
	}),
	actions: Type.Array(pageActionSchema, {
		description:
			"Ordered list of actions to perform before screenshotting. Use this for login flows, form submissions, or any UI state requiring interaction.",
	}),
	fullPage: Type.Optional(
		Type.Boolean({
			description:
				"Capture the full scrollable page height. Defaults to false. Only set true when you need to see content below the fold.",
		}),
	),
	viewport: Type.Optional(
		Type.Object(
			{
				width: Type.Number({ description: "Viewport width in pixels. Defaults to 1280." }),
				height: Type.Number({ description: "Viewport height in pixels. Defaults to 900." }),
			},
			{ description: "Viewport dimensions. Defaults to 1280x900 (desktop)." },
		),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description: "Navigation timeout in milliseconds. Defaults to 15000.",
		}),
	),
});

export type ScreenshotUrlInput = Static<typeof screenshotUrlSchema>;
export type InteractThenScreenshotInput = Static<typeof interactThenScreenshotSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build human-readable metadata text to accompany the screenshot image. */
function buildMetadataText(
	url: string,
	title: string,
	loadTimeMs: number,
	consoleErrors: string[],
	failedRequests: string[],
): string {
	const lines = [
		`URL: ${url}`,
		`Title: ${title}`,
		`Load time: ${loadTimeMs}ms`,
	];

	if (consoleErrors.length > 0) {
		lines.push(`Console errors:`);
		for (const e of consoleErrors) {
			lines.push(`  - ${e}`);
		}
	} else {
		lines.push("Console errors: none");
	}

	if (failedRequests.length > 0) {
		lines.push(`Failed requests:`);
		for (const r of failedRequests) {
			lines.push(`  - ${r}`);
		}
	} else {
		lines.push("Failed requests: none");
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

export function createScreenshotUrlToolDefinition(): ToolDefinition<typeof screenshotUrlSchema> {
	return {
		name: "screenshot_url",
		label: "Screenshot URL",
		description:
			"Navigate to a URL and take a screenshot. Returns the screenshot image and page metadata including console errors and failed network requests. The fullPage flag defaults to false — only the viewport is captured unless you explicitly request full-page capture for content below the fold.",
		promptSnippet: "Capture screenshots of web pages for visual verification",
		promptGuidelines: [
			"Use screenshot_url to verify UI rendering, layout, and styling",
			"Default is viewport-only — set fullPage: true only when you need to see content below the fold",
			"Use viewport option to simulate mobile (e.g. { width: 390, height: 844 }) or other screen sizes",
			"Check console errors and failed requests in the metadata to diagnose issues",
		],
		parameters: screenshotUrlSchema,
		async execute(
			_toolCallId: string,
			{ url, fullPage, viewport, timeoutMs }: ScreenshotUrlInput,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			try {
				const opts: ScreenshotOptions = {};
				if (fullPage !== undefined) opts.fullPage = fullPage;
				if (viewport !== undefined) opts.viewport = viewport;
				if (timeoutMs !== undefined) opts.timeoutMs = timeoutMs;

				const result = await runScreenshot(url, [], opts);

				const content: (TextContent | ImageContent)[] = [
					{ type: "text", text: buildMetadataText(result.url, result.title, result.loadTimeMs, result.consoleErrors, result.failedRequests) },
					{ type: "image", data: result.image.data, mimeType: result.image.mimeType },
				];

				return {
					content,
					details: {
						url: result.url,
						title: result.title,
						loadTimeMs: result.loadTimeMs,
						consoleErrors: result.consoleErrors,
						failedRequests: result.failedRequests,
					},
				};
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : "unknown error";
				return {
					content: [{ type: "text", text: `Screenshot failed: ${message}` }],
					details: { error: message },
				};
			}
		},
	};
}

export function createInteractThenScreenshotToolDefinition(): ToolDefinition<typeof interactThenScreenshotSchema> {
	return {
		name: "interact_then_screenshot",
		label: "Interact & Screenshot",
		description:
			"Perform a sequence of interactions on a page then take a screenshot of the resulting state. Use for login flows, form submissions, navigation to protected routes, or any UI state that requires user actions to reach. Each browser session is isolated — you must perform login and navigation in a single call to reach authenticated state.",
		promptSnippet: "Interact with a page (click, fill, navigate) then take a screenshot",
		promptGuidelines: [
			"Use interact_then_screenshot for any flow requiring user actions — login, form submission, modal dialogs",
			"Each call starts with a fresh browser session — you must log in within the same call to reach protected routes",
			"Actions are executed sequentially: fill → click → wait → navigate",
			"After login, add a navigate action to reach the protected page you want to verify",
		],
		parameters: interactThenScreenshotSchema,
		async execute(
			_toolCallId: string,
			{ url, actions, fullPage, viewport, timeoutMs }: InteractThenScreenshotInput,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			try {
				const mappedActions: PageAction[] = actions.map((a) => {
					switch (a.type) {
						case "fill":
							return { type: "fill" as const, selector: a.selector ?? "", value: a.value ?? "" };
						case "click":
							return { type: "click" as const, selector: a.selector ?? "" };
						case "wait":
							return { type: "wait" as const, ms: a.ms ?? 1000 };
						case "navigate":
							return { type: "navigate" as const, url: a.url ?? url };
						default:
							return { type: "wait" as const, ms: 500 };
					}
				});

				const opts: ScreenshotOptions = {};
				if (fullPage !== undefined) opts.fullPage = fullPage;
				if (viewport !== undefined) opts.viewport = viewport;
				if (timeoutMs !== undefined) opts.timeoutMs = timeoutMs;

				const result = await runScreenshot(url, mappedActions, opts);

				const content: (TextContent | ImageContent)[] = [
					{ type: "text", text: buildMetadataText(result.url, result.title, result.loadTimeMs, result.consoleErrors, result.failedRequests) },
					{ type: "image", data: result.image.data, mimeType: result.image.mimeType },
				];

				return {
					content,
					details: {
						url: result.url,
						title: result.title,
						loadTimeMs: result.loadTimeMs,
						consoleErrors: result.consoleErrors,
						failedRequests: result.failedRequests,
					},
				};
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : "unknown error";
				return {
					content: [{ type: "text", text: `Screenshot failed: ${message}` }],
					details: { error: message },
				};
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Pre-built instances (for direct use)
// ---------------------------------------------------------------------------

export const screenshotUrlToolDefinition = createScreenshotUrlToolDefinition();
export const interactThenScreenshotToolDefinition = createInteractThenScreenshotToolDefinition();

export const screenshotUrlTool: AgentTool<typeof screenshotUrlSchema> =
	wrapToolDefinition(screenshotUrlToolDefinition);
export const interactThenScreenshotTool: AgentTool<typeof interactThenScreenshotSchema> =
	wrapToolDefinition(interactThenScreenshotToolDefinition);
