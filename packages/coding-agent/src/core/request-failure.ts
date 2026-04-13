export interface RequestFailureClassification {
	kind: "configuration";
	message: string;
	recoveryHint: string;
}

export function classifyRequestFailure(message: {
	provider?: string;
	errorMessage?: string;
}): RequestFailureClassification | undefined {
	const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
	if (!errorMessage) return undefined;
	if (!isConfigurationFailure(errorMessage)) return undefined;

	const provider = message.provider || "this provider";
	const providerLabel = typeof provider === "string" ? provider : "this provider";
	return {
		kind: "configuration",
		message: `Authentication failed for ${providerLabel}: ${errorMessage}`,
		recoveryHint: `Run '/login ${providerLabel}' to re-authenticate, or switch models with Ctrl+L.`,
	};
}

export function isConfigurationFailure(errorMessage: string): boolean {
	if (!errorMessage) return false;
	const normalized = errorMessage.toLowerCase();
	return (
		normalized.includes("authentication token") ||
		normalized.includes("invalid issuer") ||
		normalized.includes("invalid api key") ||
		normalized.includes("no auth configured") ||
		normalized.includes("unauthorized") ||
		normalized.includes("forbidden") ||
		normalized.includes("oauth") ||
		(normalized.includes("api key") && !normalized.includes("retry")) ||
		normalized.includes("credential") ||
		normalized.includes("not from a valid issuer")
	);
}
