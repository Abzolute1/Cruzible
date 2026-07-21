import type { Api, Model } from "@ag1/ai";
import { describe, expect, test } from "vitest";
import { inferModelCapabilityProfile } from "../src/core/model-capability-profile.js";

function model(overrides: Partial<Model<Api>>): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		...overrides,
	};
}

describe("inferModelCapabilityProfile", () => {
	test("derives low tool-call reliability only from a cramped context window", () => {
		const profile = inferModelCapabilityProfile(
			model({
				provider: "lmstudio",
				baseUrl: "http://127.0.0.1:1234/v1",
				contextWindow: 8192,
			}),
		);

		expect(profile).toMatchObject({
			toolCallReliability: "low",
			maxUsefulToolResultTokens: 1200,
			maxPlanHorizonSteps: 2,
			needsStrictEditSchema: true,
			needsShortVerifierOutput: true,
			recommendedCompactionPolicy: "local_small",
		});
	});

	test("derives medium reliability for mid-size context windows", () => {
		const profile = inferModelCapabilityProfile(
			model({
				provider: "custom",
				baseUrl: "https://models.example.com/v1",
				contextWindow: 32768,
			}),
		);

		expect(profile).toMatchObject({
			toolCallReliability: "medium",
			maxUsefulToolResultTokens: 1800,
			maxPlanHorizonSteps: 3,
			needsStrictEditSchema: false,
			needsShortVerifierOutput: false,
			recommendedCompactionPolicy: "small",
		});
	});

	test("derives medium reliability for large context windows", () => {
		const profile = inferModelCapabilityProfile(
			model({
				provider: "custom",
				baseUrl: "https://models.example.com/v1",
				contextWindow: 128000,
			}),
		);

		expect(profile).toMatchObject({
			toolCallReliability: "medium",
			maxUsefulToolResultTokens: 2400,
			maxPlanHorizonSteps: 4,
			recommendedCompactionPolicy: "standard",
		});
	});

	test("never classifies by model name: a 9b-named model with a large window is not low", () => {
		const profile = inferModelCapabilityProfile(
			model({
				id: "qwen/qwen3.5-9b",
				provider: "lmstudio",
				baseUrl: "http://127.0.0.1:1234/v1",
				contextWindow: 128000,
			}),
		);

		expect(profile.toolCallReliability).toBe("medium");
		expect(profile.maxPlanHorizonSteps).toBe(4);
		// Locality (transport fact) still drives provider-behavior preferences.
		expect(profile.prefersXmlFallback).toBe(true);
	});

	test("never infers locality from model name: a qwen id on a hosted endpoint is not local", () => {
		const profile = inferModelCapabilityProfile(
			model({
				id: "qwen/qwen3-32b",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				contextWindow: 128000,
			}),
		);

		expect(profile.prefersXmlFallback).toBe(false);
		expect(profile.needsStrictEditSchema).toBe(false);
		expect(profile.needsShortVerifierOutput).toBe(false);
		expect(profile.recommendedCompactionPolicy).toBe("standard");
	});

	test("never tiers by model name: a frontier-named model classifies by its context window", () => {
		const profile = inferModelCapabilityProfile(
			model({
				id: "gpt-5.2",
				provider: "openai",
				reasoning: true,
				contextWindow: 400000,
			}),
		);

		expect(profile.toolCallReliability).toBe("medium");
		expect(profile.recommendedCompactionPolicy).toBe("large");
	});

	test("preserves model image and reasoning signals", () => {
		const profile = inferModelCapabilityProfile(
			model({
				id: "local-vision",
				provider: "ollama",
				baseUrl: "http://localhost:11434/v1",
				reasoning: true,
				input: ["text", "image"],
			}),
		);

		expect(profile.supportsImages).toBe(true);
		expect(profile.supportsReasoningBudget).toBe(true);
	});

	test("ties XML fallback preference to locality, not size", () => {
		const local = inferModelCapabilityProfile(
			model({ provider: "ollama", baseUrl: "http://localhost:11434/v1", contextWindow: 128000 }),
		);
		const hosted = inferModelCapabilityProfile(model({ provider: "custom", contextWindow: 128000 }));

		expect(local.prefersXmlFallback).toBe(true);
		expect(hosted.prefersXmlFallback).toBe(false);
	});

	test("derives compaction policy from context window and locality", () => {
		const hostedMid = inferModelCapabilityProfile(
			model({ provider: "custom", baseUrl: "https://models.example.com/v1", contextWindow: 32768 }),
		);
		const localMid = inferModelCapabilityProfile(
			model({ provider: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1", contextWindow: 32768 }),
		);
		const localLarge = inferModelCapabilityProfile(
			model({ provider: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1", contextWindow: 128000 }),
		);

		expect(hostedMid.recommendedCompactionPolicy).toBe("small");
		expect(localMid.recommendedCompactionPolicy).toBe("local_small");
		expect(localLarge.recommendedCompactionPolicy).toBe("small");
	});

	test("assumes a default context window when the registry value is unusable", () => {
		const profile = inferModelCapabilityProfile(
			model({ provider: "custom", baseUrl: "https://models.example.com/v1", contextWindow: Number.NaN }),
		);

		expect(profile.toolCallReliability).toBe("medium");
		expect(profile.maxUsefulToolResultTokens).toBe(2400);
	});
});
