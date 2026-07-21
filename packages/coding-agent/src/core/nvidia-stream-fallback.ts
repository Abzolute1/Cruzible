import type { AssistantMessageEventStream } from "@ag1/ai";
import { type Context, type Model, type SimpleStreamOptions, streamSimple } from "@ag1/ai";
import OpenAI from "openai";
import type { ModelRegistry } from "./model-registry.js";

const OPENROUTER_NEMOTRON_ULTRA_FREE = {
	provider: "openrouter",
	id: "nvidia/nemotron-3-ultra-550b-a55b:free",
} as const;

export function isNvidiaIntegrateModel(model: Model<any>): boolean {
	return (
		model.provider === "nvidia" ||
		model.provider === "nvidia-nim" ||
		model.baseUrl.includes("integrate.api.nvidia.com")
	);
}

function isRetryableNvidiaAuthError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /\b403\b/.test(message);
}

async function probeNvidiaCompletions(model: Model<any>, apiKey: string): Promise<void> {
	const client = new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
	});
	await client.chat.completions.create({
		model: model.id,
		messages: [{ role: "user", content: "ping" }],
		max_completion_tokens: 1,
		stream: false,
	});
}

function resolveNvidiaFallbackModels(registry: ModelRegistry, primary: Model<any>): Model<any>[] {
	const fallbacks: Model<any>[] = [];
	const seen = new Set([`${primary.provider}:${primary.id}`]);

	const addCandidate = (candidate: Model<any> | undefined) => {
		if (!candidate) return;
		const key = `${candidate.provider}:${candidate.id}`;
		if (seen.has(key)) return;
		if (!registry.hasConfiguredAuth(candidate)) return;
		seen.add(key);
		fallbacks.push(candidate);
	};

	addCandidate(registry.find(OPENROUTER_NEMOTRON_ULTRA_FREE.provider, OPENROUTER_NEMOTRON_ULTRA_FREE.id));

	for (const candidate of registry.getAvailable()) {
		if (candidate.provider === "local") {
			addCandidate(candidate);
			break;
		}
	}

	return fallbacks;
}

async function streamWithAuth(
	registry: ModelRegistry,
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessageEventStream> {
	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		throw new Error(auth.error);
	}
	return streamSimple(model, context, {
		...options,
		apiKey: auth.apiKey,
		headers: auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined,
	});
}

export function createResilientStreamFn(registry: ModelRegistry) {
	return async (
		model: Model<any>,
		context: Context,
		options?: SimpleStreamOptions,
	): Promise<AssistantMessageEventStream> => {
		if (!isNvidiaIntegrateModel(model)) {
			return streamWithAuth(registry, model, context, options);
		}

		const candidates = [model, ...resolveNvidiaFallbackModels(registry, model)];
		let lastError: Error | undefined;

		for (const candidate of candidates) {
			const auth = await registry.getApiKeyAndHeaders(candidate);
			if (!auth.ok) {
				lastError = new Error(auth.error);
				continue;
			}

			if (isNvidiaIntegrateModel(candidate)) {
				try {
					await probeNvidiaCompletions(candidate, auth.apiKey!);
				} catch (error) {
					lastError = error instanceof Error ? error : new Error(String(error));
					if (!isRetryableNvidiaAuthError(lastError)) {
						throw lastError;
					}
					console.error(
						`[AG1] NVIDIA blocked chat completions for ${candidate.provider}/${candidate.id} (${lastError.message}). Trying fallback...`,
					);
					continue;
				}
			} else if (candidate !== model) {
				console.error(
					`[AG1] Falling back from ${model.provider}/${model.id} to ${candidate.provider}/${candidate.id}.`,
				);
			}

			return streamSimple(candidate, context, {
				...options,
				apiKey: auth.apiKey,
				headers: auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined,
			});
		}

		throw new Error(
			lastError?.message ??
				`NVIDIA blocked chat completions for ${model.provider}/${model.id}, and no fallback model was available. ` +
					`Request "Public API Endpoints" on build.nvidia.com, set OPENROUTER_API_KEY, or start LM Studio locally.`,
		);
	};
}
