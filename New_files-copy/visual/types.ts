/**
 * Types for visual verification tools (screenshot, interact & screenshot).
 */

/** Actions the model can request before a screenshot is taken. */
export type PageAction =
	| { type: "click"; selector: string }
	| { type: "fill"; selector: string; value: string }
	| { type: "wait"; ms: number }
	| { type: "navigate"; url: string };

/** Per-call options for screenshot operations. */
export interface ScreenshotOptions {
	/** Viewport dimensions. Defaults to 1280x900 (desktop). */
	viewport?: { width: number; height: number };
	/** Capture the full scrollable page height. Defaults to false — viewport-only is the safe default for context size. */
	fullPage?: boolean;
	/** Navigation timeout in milliseconds. Defaults to 15000. */
	timeoutMs?: number;
}

/** Result returned by screenshot tools. */
export interface ScreenshotResult {
	/** Image content block — compatible with AgentToolResult.content format. */
	image: {
		type: "image";
		data: string; // base64
		mimeType: string;
	};
	/** The final URL after navigation/interactions. */
	url: string;
	/** Page title at time of screenshot. */
	title: string;
	/** JavaScript console error messages captured. */
	consoleErrors: string[];
	/** Failed or errored HTTP requests (4xx/5xx and network failures). */
	failedRequests: string[];
	/** Total load time in milliseconds. */
	loadTimeMs: number;
}
