/**
 * Browser singleton for visual verification tools.
 *
 * A single Chromium instance is reused across all screenshot calls.
 * Each call gets its own browser context (isolated cookies, localStorage, sessions).
 * The browser is launched lazily and must be explicitly shut down on AG1 exit.
 *
 * Concurrency safety: the initial launch promise is cached so concurrent tool
 * calls await the same instance instead of racing and spawning duplicate browsers.
 */

import type { Browser } from "playwright";
import { chromium } from "playwright";

let _browser: Browser | null = null;
let _launchPromise: Promise<Browser> | null = null;

/**
 * Get (or lazily launch) the singleton Chromium browser.
 *
 * Concurrency: if a launch is already in progress, all callers await the same
 * promise so only one browser instance is ever created.
 *
 * Resilience: if Playwright or its OS dependencies are missing, returns a clear
 * error string instead of throwing a hard crash.
 */
export async function getBrowser(): Promise<{ browser: Browser | null; error?: string }> {
	if (_browser?.isConnected()) {
		return { browser: _browser };
	}

	// Reuse in-flight launch promise to prevent race conditions
	if (_launchPromise) {
		try {
			const browser = await _launchPromise;
			return { browser };
		} catch {
			_launchPromise = null;
			// Fall through to retry once
		}
	}

	_launchPromise = chromium.launch({ headless: true }).catch((err: unknown) => {
		_launchPromise = null;
		const message = err instanceof Error ? err.message : String(err);

		// Detect common missing-dependency scenarios
		if (message.includes("Executable doesn't exist") || message.includes("chromium")) {
			throw new Error(
				`Playwright browser not installed. Run: npx playwright install chromium\n\nOriginal error: ${message}`,
			);
		}
		if (
			message.includes("libnss") ||
			message.includes("libatk") ||
			message.includes("libgbm") ||
			message.includes("libasound")
		) {
			throw new Error(
				`Playwright OS dependencies are missing. Run: npx playwright install-deps chromium\n\nOriginal error: ${message}`,
			);
		}
		throw err;
	});

	try {
		_browser = await _launchPromise;
		return { browser: _browser };
	} catch (err: unknown) {
		_launchPromise = null;
		const message = err instanceof Error ? err.message : "Failed to launch browser";
		return { browser: null, error: message };
	}
}

/**
 * Close the singleton browser if it exists.
 * Called on AG1 shutdown so Chromium doesn't linger as a zombie process.
 */
export async function closeBrowser(): Promise<void> {
	if (_browser) {
		try {
			await _browser.close();
		} catch {
			// Browser may have already been closed externally — ignore
		}
		_browser = null;
	}
	_launchPromise = null;
}
