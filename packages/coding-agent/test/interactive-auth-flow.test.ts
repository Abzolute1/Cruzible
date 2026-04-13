import { describe, expect, test, vi } from "vitest";
import {
	hasLoggedInOAuthProviders,
	performInteractiveOAuthLogout,
	runInteractiveOAuthLogin,
} from "../src/modes/interactive/interactive-auth-flow.js";

describe("interactive-auth-flow", () => {
	test("detects when at least one OAuth provider is logged in", () => {
		expect(
			hasLoggedInOAuthProviders({
				list: () => ["github", "anthropic"],
				get: (providerId) =>
					providerId === "github" ? { type: "oauth" } : providerId === "anthropic" ? { type: "api_key" } : undefined,
			}),
		).toBe(true);

		expect(
			hasLoggedInOAuthProviders({
				list: () => ["anthropic"],
				get: () => ({ type: "api_key" }),
			}),
		).toBe(false);
	});

	test("logs out through the shared helper and reports success", async () => {
		const refreshModelRegistry = vi.fn();
		const updateAvailableProviderCount = vi.fn(async () => {});
		const showStatus = vi.fn();
		const showError = vi.fn();

		await performInteractiveOAuthLogout({
			authStorage: {
				getOAuthProviders: () => [{ id: "github", name: "GitHub" }],
				logout: vi.fn(),
			},
			providerId: "github",
			refreshModelRegistry,
			updateAvailableProviderCount,
			showStatus,
			showError,
		});

		expect(refreshModelRegistry).toHaveBeenCalledOnce();
		expect(updateAvailableProviderCount).toHaveBeenCalledOnce();
		expect(showStatus).toHaveBeenCalledWith("Logged out of GitHub");
		expect(showError).not.toHaveBeenCalled();
	});

	test("runs the interactive login flow and reports success", async () => {
		const restoreEditor = vi.fn();
		const refreshModelRegistry = vi.fn();
		const updateAvailableProviderCount = vi.fn(async () => {});
		const showStatus = vi.fn();
		const showError = vi.fn();
		const showAuth = vi.fn();
		const showPrompt = vi.fn(async () => "ok");
		const showProgress = vi.fn();

		await runInteractiveOAuthLogin({
			authStorage: {
				getOAuthProviders: () => [{ id: "anthropic", name: "Anthropic", usesCallbackServer: false }],
				login: vi.fn(async (_providerId, callbacks) => {
					callbacks.onAuth({ url: "https://example.com/login", instructions: "open browser" });
					await callbacks.onPrompt({ message: "enter code", placeholder: "123" });
					callbacks.onProgress("Waiting");
				}),
			},
			providerId: "anthropic",
			dialog: {
				showAuth,
				showManualInput: vi.fn(async () => "manual"),
				showWaiting: vi.fn(),
				showPrompt,
				showProgress,
				signal: new AbortController().signal,
			},
			restoreEditor,
			refreshModelRegistry,
			updateAvailableProviderCount,
			showStatus,
			showError,
			authPath: "/tmp/auth.json",
		});

		expect(showAuth).toHaveBeenCalledWith("https://example.com/login", "open browser");
		expect(showPrompt).toHaveBeenCalledWith("enter code", "123");
		expect(showProgress).toHaveBeenCalledWith("Waiting");
		expect(restoreEditor).toHaveBeenCalledOnce();
		expect(refreshModelRegistry).toHaveBeenCalledOnce();
		expect(updateAvailableProviderCount).toHaveBeenCalledOnce();
		expect(showStatus).toHaveBeenCalledWith("Logged in to Anthropic. Credentials saved to /tmp/auth.json");
		expect(showError).not.toHaveBeenCalled();
	});

	test("supports callback-server flows and suppresses cancelled-login errors", async () => {
		const restoreEditor = vi.fn();
		const showStatus = vi.fn();
		const showError = vi.fn();
		const showManualInput = vi.fn(async () => "http://localhost/callback?code=123");

		await runInteractiveOAuthLogin({
			authStorage: {
				getOAuthProviders: () => [{ id: "github", name: "GitHub", usesCallbackServer: true }],
				login: vi.fn(async (_providerId, callbacks) => {
					callbacks.onAuth({ url: "https://example.com/oauth" });
					await expect(callbacks.onManualCodeInput()).resolves.toBe("http://localhost/callback?code=123");
					throw new Error("Login cancelled");
				}),
			},
			providerId: "github",
			dialog: {
				showAuth: vi.fn(),
				showManualInput,
				showWaiting: vi.fn(),
				showPrompt: vi.fn(async () => "unused"),
				showProgress: vi.fn(),
				signal: new AbortController().signal,
			},
			restoreEditor,
			refreshModelRegistry: vi.fn(),
			updateAvailableProviderCount: vi.fn(async () => {}),
			showStatus,
			showError,
			authPath: "/tmp/auth.json",
		});

		expect(showManualInput).toHaveBeenCalledWith("Paste redirect URL below, or complete login in browser:");
		expect(restoreEditor).toHaveBeenCalledOnce();
		expect(showStatus).not.toHaveBeenCalled();
		expect(showError).not.toHaveBeenCalled();
	});
});
