import { afterEach, describe, expect, it } from "vitest";
import { getEnvApiKey } from "../src/env-api-keys.js";

describe("getEnvApiKey", () => {
	const originalNimKey = process.env.NVIDIA_NIM_API_KEY;
	const originalNvidiaKey = process.env.NVIDIA_API_KEY;

	afterEach(() => {
		if (originalNimKey === undefined) {
			delete process.env.NVIDIA_NIM_API_KEY;
		} else {
			process.env.NVIDIA_NIM_API_KEY = originalNimKey;
		}

		if (originalNvidiaKey === undefined) {
			delete process.env.NVIDIA_API_KEY;
		} else {
			process.env.NVIDIA_API_KEY = originalNvidiaKey;
		}
	});

	it("maps kimi-coding and openrouter to their env vars", () => {
		process.env.KIMI_API_KEY = "kimi-key";
		process.env.OPENROUTER_API_KEY = "openrouter-key";

		expect(getEnvApiKey("kimi-coding")).toBe("kimi-key");
		expect(getEnvApiKey("openrouter")).toBe("openrouter-key");
	});

	it("prefers NVIDIA_NIM_API_KEY for nvidia-nim", () => {
		process.env.NVIDIA_NIM_API_KEY = "nim-key";
		process.env.NVIDIA_API_KEY = "nvidia-key";

		expect(getEnvApiKey("nvidia-nim")).toBe("nim-key");
	});

	it("falls back to NVIDIA_API_KEY for nvidia-nim", () => {
		delete process.env.NVIDIA_NIM_API_KEY;
		process.env.NVIDIA_API_KEY = "nvidia-key";

		expect(getEnvApiKey("nvidia-nim")).toBe("nvidia-key");
	});
});
