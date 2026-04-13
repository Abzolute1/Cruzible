/**
 * Screenshot engine — shared internal function that both visual tools call.
 *
 * Handles:
 * - Browser context creation with isolated session per call
 * - Console error and HTTP failure capture
 * - Page navigation (domcontentloaded, not networkidle — avoids polling/WebSocket hangs)
 * - Sequential action execution via the modern locator API
 * - Viewport-only or full-page screenshot (fullPage defaults to false)
 * - Context window protection: automatic JPEG fallback when PNG exceeds size threshold
 * - Guaranteed context cleanup in finally block (browser stays alive for reuse)
 */

import type { BrowserContext, Page } from "playwright";
import { getBrowser } from "./browser.js";
import type { PageAction, ScreenshotOptions, ScreenshotResult } from "./types.js";

const DEFAULT_VIEWPORT = { width: 1280, height: 900 } as const;
const DEFAULT_TIMEOUT_MS = 15_000;

/** Hard limit for base64 image payload before auto-compression kicks in. */
const MAX_IMAGE_BYTES = 1_500_000; // ~1.5 MB — safe for most context windows

/**
 * Navigate to a URL, optionally perform interactions, then capture a screenshot.
 *
 * Each call creates a fresh browser context (isolated cookies, localStorage, auth).
 * The singleton browser is reused — only the context is torn down.
 *
 * Context window protection: if the raw PNG exceeds MAX_IMAGE_BYTES, the image
 * is automatically re-captured as JPEG. If JPEG still exceeds the limit, it is
 * scaled down iteratively (halving the viewport dimensions) until it fits.
 */
export async function runScreenshot(
	url: string,
	actions: PageAction[] = [],
	opts: ScreenshotOptions = {},
): Promise<ScreenshotResult> {
	const {
		viewport = DEFAULT_VIEWPORT,
		fullPage = false,
		timeoutMs = DEFAULT_TIMEOUT_MS,
	} = opts;

	const browserResult = await getBrowser();
	if (!browserResult.browser) {
		throw new Error(browserResult.error ?? "Failed to launch browser");
	}

	const browser = browserResult.browser;
	const ctx = await browser.newContext({ viewport });

	const consoleErrors: string[] = [];
	const failedRequests: string[] = [];

	try {
		const page = await ctx.newPage();

		// Capture JS console errors
		page.on("console", (msg) => {
			if (msg.type() === "error") {
				consoleErrors.push(msg.text());
			}
		});

		// Capture network-level failures (DNS, connection refused, etc.)
		page.on("requestfailed", (req) => {
			failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? "unknown"}`);
		});

		// Capture HTTP 4xx/5xx responses (requestfailed alone misses these)
		page.on("response", (res) => {
			if (res.status() >= 400) {
				failedRequests.push(`${res.request().method()} ${res.url()} — HTTP ${res.status()}`);
			}
		});

		const start = Date.now();

		// Navigate — domcontentloaded over networkidle because networkidle never
		// resolves on apps with polling intervals or Vite's hot-reload WebSocket.
		await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });

		// Execute sequential interactions
		for (const action of actions) {
			switch (action.type) {
				case "fill":
					await page.locator(action.selector).fill(action.value);
					break;
				case "click":
					await page.locator(action.selector).click();
					break;
				case "wait":
					// Use setTimeout instead of deprecated page.waitForTimeout()
					await new Promise<void>((resolve) => setTimeout(resolve, action.ms));
					break;
				case "navigate":
					await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
					break;
			}
		}

		const loadTimeMs = Date.now() - start;
		const title = await page.title();
		const currentUrl = page.url();

		// Capture screenshot with context-window protection
		const { data, mimeType } = await captureWithSizeProtection(page, fullPage);

		return {
			image: { type: "image", data, mimeType },
			url: currentUrl,
			title,
			consoleErrors,
			failedRequests,
			loadTimeMs,
		};
	} finally {
		// Context always closes — browser stays alive for reuse
		await ctx.close();
	}
}

/**
 * Capture a screenshot and automatically compress/scale if it exceeds the
 * maximum payload size. Strategy:
 * 1. Try PNG first (lossless, best quality for UI screenshots)
 * 2. If PNG > MAX_IMAGE_BYTES, retry as JPEG at 0.8 quality
 * 3. If JPEG still too large, retry JPEG at 0.6 quality
 * 4. As last resort, halve the viewport and try JPEG at 0.6 quality
 */
async function captureWithSizeProtection(
	page: Page,
	fullPage: boolean,
): Promise<{ data: string; mimeType: string }> {
	// Step 1: PNG
	const pngBuf = await page.screenshot({ type: "png", fullPage });
	if (pngBuf.length <= MAX_IMAGE_BYTES) {
		return { data: pngBuf.toString("base64"), mimeType: "image/png" };
	}

	// Step 2: JPEG at 0.8 quality
	const jpeg08Buf = await page.screenshot({ type: "jpeg", quality: 80, fullPage });
	if (jpeg08Buf.length <= MAX_IMAGE_BYTES) {
		return { data: jpeg08Buf.toString("base64"), mimeType: "image/jpeg" };
	}

	// Step 3: JPEG at 0.6 quality
	const jpeg06Buf = await page.screenshot({ type: "jpeg", quality: 60, fullPage });
	if (jpeg06Buf.length <= MAX_IMAGE_BYTES) {
		return { data: jpeg06Buf.toString("base64"), mimeType: "image/jpeg" };
	}

	// Step 4: Scale down viewport and retry JPEG
	const currentViewport = page.viewportSize();
	if (currentViewport && (currentViewport.width > 400 || currentViewport.height > 400)) {
		await page.setViewportSize({
			width: Math.max(400, Math.floor(currentViewport.width / 2)),
			height: Math.max(400, Math.floor(currentViewport.height / 2)),
		});
		const scaledBuf = await page.screenshot({ type: "jpeg", quality: 60, fullPage });
		return { data: scaledBuf.toString("base64"), mimeType: "image/jpeg" };
	}

	// Last resort: return the smallest JPEG we have
	return { data: jpeg06Buf.toString("base64"), mimeType: "image/jpeg" };
}
