import type { OAuthProviderId } from "@ag1/ai";

export interface InteractiveAuthStorageLike {
	list(): string[];
	get(providerId: string): { type: string } | undefined;
	getOAuthProviders(): Array<{ id: string; name?: string; usesCallbackServer?: boolean }>;
	login(
		providerId: OAuthProviderId,
		callbacks: {
			onAuth: (info: { url: string; instructions?: string }) => void;
			onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
			onProgress: (message: string) => void;
			onManualCodeInput: () => Promise<string>;
			signal: AbortSignal;
		},
	): Promise<void>;
	logout(providerId: string): void;
}

export interface InteractiveLoginDialogLike {
	showAuth(url: string, instructions?: string): void;
	showManualInput(prompt: string): Promise<string>;
	showWaiting(message: string): void;
	showPrompt(message: string, placeholder?: string): Promise<string>;
	showProgress(message: string): void;
	signal: AbortSignal;
}

export function hasLoggedInOAuthProviders(authStorage: Pick<InteractiveAuthStorageLike, "list" | "get">): boolean {
	return authStorage.list().some((providerId) => authStorage.get(providerId)?.type === "oauth");
}

export async function performInteractiveOAuthLogout(options: {
	authStorage: Pick<InteractiveAuthStorageLike, "getOAuthProviders" | "logout">;
	providerId: string;
	refreshModelRegistry: () => void;
	updateAvailableProviderCount: () => Promise<void>;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
}): Promise<void> {
	const providerInfo = options.authStorage.getOAuthProviders().find((provider) => provider.id === options.providerId);
	const providerName = providerInfo?.name || options.providerId;

	try {
		options.authStorage.logout(options.providerId);
		options.refreshModelRegistry();
		await options.updateAvailableProviderCount();
		options.showStatus(`Logged out of ${providerName}`);
	} catch (error: unknown) {
		options.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function runInteractiveOAuthLogin(options: {
	authStorage: Pick<InteractiveAuthStorageLike, "getOAuthProviders" | "login">;
	providerId: string;
	dialog: InteractiveLoginDialogLike;
	restoreEditor: () => void;
	refreshModelRegistry: () => void;
	updateAvailableProviderCount: () => Promise<void>;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	authPath: string;
}): Promise<void> {
	const providerInfo = options.authStorage.getOAuthProviders().find((provider) => provider.id === options.providerId);
	const providerName = providerInfo?.name || options.providerId;
	const usesCallbackServer = providerInfo?.usesCallbackServer ?? false;

	let manualCodeResolve: ((code: string) => void) | undefined;
	let manualCodeReject: ((error: Error) => void) | undefined;
	const manualCodePromise = new Promise<string>((resolve, reject) => {
		manualCodeResolve = resolve;
		manualCodeReject = reject;
	});

	try {
		await options.authStorage.login(options.providerId as OAuthProviderId, {
			onAuth: (info) => {
				options.dialog.showAuth(info.url, info.instructions);

				if (usesCallbackServer) {
					options.dialog
						.showManualInput("Paste redirect URL below, or complete login in browser:")
						.then((value) => {
							if (value && manualCodeResolve) {
								manualCodeResolve(value);
								manualCodeResolve = undefined;
								manualCodeReject = undefined;
							}
						})
						.catch(() => {
							if (manualCodeReject) {
								manualCodeReject(new Error("Login cancelled"));
								manualCodeResolve = undefined;
								manualCodeReject = undefined;
							}
						});
				} else if (options.providerId === "github-copilot") {
					options.dialog.showWaiting("Waiting for browser authentication...");
				}
			},
			onPrompt: async (prompt) => options.dialog.showPrompt(prompt.message, prompt.placeholder),
			onProgress: (message) => {
				options.dialog.showProgress(message);
			},
			onManualCodeInput: () => manualCodePromise,
			signal: options.dialog.signal,
		});

		options.restoreEditor();
		options.refreshModelRegistry();
		await options.updateAvailableProviderCount();
		options.showStatus(`Logged in to ${providerName}. Credentials saved to ${options.authPath}`);
	} catch (error: unknown) {
		options.restoreEditor();
		const errorMessage = error instanceof Error ? error.message : String(error);
		if (errorMessage !== "Login cancelled") {
			options.showError(`Failed to login to ${providerName}: ${errorMessage}`);
		}
	}
}
