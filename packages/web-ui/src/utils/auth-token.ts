import PromptDialog from "@mariozechner/mini-lit/dist/PromptDialog.js";
import { i18n } from "./i18n.js";

export async function getAuthToken(): Promise<string | undefined> {
	let authToken: string | undefined = localStorage.getItem(`auth-token`) || "";
	if (authToken) return authToken;

	authToken = (
		await PromptDialog.ask(i18n("Enter Auth Token"), i18n("Please enter your auth token."), "", true)
	)?.trim();
	// Cancelled or empty input - don't trap the user in a re-ask loop
	if (!authToken) return undefined;

	localStorage.setItem(`auth-token`, authToken);
	return authToken;
}

export async function clearAuthToken() {
	localStorage.removeItem(`auth-token`);
}
