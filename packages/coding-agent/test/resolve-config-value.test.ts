import { afterEach, describe, expect, it } from "vitest";
import { resolveConfigValueUncached } from "../src/core/resolve-config-value.js";

describe("resolveConfigValueUncached", () => {
	const original = process.env.TEST_PROVIDER_API_KEY;

	afterEach(() => {
		if (original === undefined) {
			delete process.env.TEST_PROVIDER_API_KEY;
		} else {
			process.env.TEST_PROVIDER_API_KEY = original;
		}
	});

	it("returns env values when configured", () => {
		process.env.TEST_PROVIDER_API_KEY = "resolved-key";
		expect(resolveConfigValueUncached("TEST_PROVIDER_API_KEY")).toBe("resolved-key");
	});

	it("does not treat unresolved env-var names as literal API keys", () => {
		delete process.env.TEST_PROVIDER_API_KEY;
		expect(resolveConfigValueUncached("TEST_PROVIDER_API_KEY")).toBeUndefined();
	});

	it("still returns literal non-env config values", () => {
		expect(resolveConfigValueUncached("nvapi-abc123")).toBe("nvapi-abc123");
	});
});
