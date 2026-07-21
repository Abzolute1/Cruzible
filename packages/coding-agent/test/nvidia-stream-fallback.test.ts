import type { Model } from "@ag1/ai";
import { describe, expect, it } from "vitest";
import { isNvidiaIntegrateModel } from "../src/core/nvidia-stream-fallback.js";

describe("nvidia-stream-fallback", () => {
	it("detects integrate NVIDIA providers", () => {
		const model = {
			id: "nvidia/nemotron-3-ultra-550b-a55b",
			provider: "nvidia-nim",
			baseUrl: "https://integrate.api.nvidia.com/v1",
		} as Model<"openai-completions">;

		expect(isNvidiaIntegrateModel(model)).toBe(true);
	});

	it("ignores unrelated providers", () => {
		const model = {
			id: "gpt-4o-mini",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
		} as Model<"openai-completions">;

		expect(isNvidiaIntegrateModel(model)).toBe(false);
	});
});
