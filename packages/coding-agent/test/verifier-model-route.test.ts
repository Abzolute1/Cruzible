import type { Model } from "@ag1/ai";
import { describe, expect, test } from "vitest";
import { createHarness, fauxModel } from "./test-harness.js";

const verifierModel: Model<any> = {
	...fauxModel,
	provider: "verifier-provider",
	id: "verifier-1",
	name: "Verifier Model",
};

describe("AgentSession.resolveVerifierModel", () => {
	test("falls back to the active model when no verifier route is configured", () => {
		const harness = createHarness({});
		try {
			expect(harness.session.resolveVerifierModel()?.id).toBe(fauxModel.id);
		} finally {
			harness.cleanup();
		}
	});

	test("resolves a configured verifier ref against scoped models", () => {
		const harness = createHarness({});
		try {
			harness.session.setScopedModels([{ model: fauxModel }, { model: verifierModel }]);
			harness.session.settingsManager.setVerifierModel("verifier-provider/verifier-1");

			const resolved = harness.session.resolveVerifierModel();
			expect(resolved?.provider).toBe("verifier-provider");
			expect(resolved?.id).toBe("verifier-1");
		} finally {
			harness.cleanup();
		}
	});

	test("falls back to the active model when the configured ref does not resolve", () => {
		const harness = createHarness({});
		try {
			harness.session.setScopedModels([{ model: fauxModel }]);
			harness.session.settingsManager.setVerifierModel("verifier-provider/not-a-real-model");

			expect(harness.session.resolveVerifierModel()?.id).toBe(fauxModel.id);
		} finally {
			harness.cleanup();
		}
	});
});
