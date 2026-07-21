import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function envFileName(providerId: string): string {
	return `AG1_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY_FILE`;
}

export function getProviderSecretFilePath(
	providerId: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const providerEnvFile = env[envFileName(providerId)];
	if (providerEnvFile?.trim()) return providerEnvFile;

	if (providerId === "nvidia" || providerId === "nvidia-nim") {
		const ag1Home = env.AG1_HOME?.trim() || join(homedir(), "AG1");
		return join(ag1Home, ".ag1-secrets", `${providerId}-api-key`);
	}

	return undefined;
}

export function readProviderSecretFileApiKey(
	providerId: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const secretPath = getProviderSecretFilePath(providerId, env);
	if (secretPath && existsSync(secretPath)) {
		try {
			const key = readFileSync(secretPath, "utf-8").trim();
			if (key) return key;
		} catch {
			// Fall through to provider-specific fallback paths.
		}
	}

	if (providerId === "nvidia-nim") {
		const nvidiaSecretPath = getProviderSecretFilePath("nvidia", env);
		if (nvidiaSecretPath && existsSync(nvidiaSecretPath)) {
			try {
				const key = readFileSync(nvidiaSecretPath, "utf-8").trim();
				return key || undefined;
			} catch {
				return undefined;
			}
		}
	}

	return undefined;
}
