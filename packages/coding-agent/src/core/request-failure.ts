export interface RequestFailureClassification {
	kind: "configuration" | "backend_unavailable";
	message: string;
	recoveryHint: string;
}

export function classifyRequestFailure(message: {
	provider?: string;
	model?: string;
	errorMessage?: string;
}): RequestFailureClassification | undefined {
	const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
	if (!errorMessage) return undefined;

	const provider = message.provider || "this provider";
	const providerLabel = typeof provider === "string" ? provider : "this provider";
	const model = typeof message.model === "string" ? message.model.trim() : "";
	if (providerLabel === "local" && isLocalBackendUnavailable(errorMessage)) {
		const modelLabel = model ? `${providerLabel}/${model}` : providerLabel;
		return {
			kind: "backend_unavailable",
			message: `Local model backend unavailable for ${modelLabel}: ${errorMessage}`,
			recoveryHint: "Start LM Studio (or the configured local backend), verify LM_STUDIO_URL, or switch models with Ctrl+L.",
		};
	}
	if (!isConfigurationFailure(errorMessage)) return undefined;

	return {
		kind: "configuration",
		message: `Authentication failed for ${providerLabel}: ${errorMessage}`,
		recoveryHint: `Run '/login ${providerLabel}' to re-authenticate, or switch models with Ctrl+L.`,
	};
}

export function isLocalBackendUnavailable(errorMessage: string): boolean {
	if (!errorMessage) return false;
	const normalized = errorMessage.toLowerCase();
	return (
		normalized.includes("connection error") ||
		normalized.includes("connection refused") ||
		normalized.includes("fetch failed") ||
		normalized.includes("socket hang up") ||
		normalized.includes("timed out") ||
		normalized.includes("timeout") ||
		normalized.includes("other side closed") ||
		normalized.includes("reset before headers") ||
		normalized.includes("lm studio") ||
		normalized.includes("upstream connect")
	);
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
