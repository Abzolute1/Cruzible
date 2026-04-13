import { describe, expect, test, vi } from "vitest";
import {
	applyInteractiveScopedModelSelection,
	createInteractiveScopedModelsCallbacks,
	deriveInteractiveScopedModelSelection,
	getInteractiveScopedModelId,
} from "../src/modes/interactive/interactive-model-scope.js";

describe("interactive-model-scope", () => {
	test("builds ids from scoped models", () => {
		expect(getInteractiveScopedModelId({ provider: "lm-studio", id: "qwen" })).toBe("lm-studio/qwen");
	});

	test("prefers session-scoped models over saved settings", async () => {
		const resolveModelScope = vi.fn(async () => [
			{ model: { provider: "api", id: "ignored" }, thinkingLevel: "medium" },
		]);

		const result = await deriveInteractiveScopedModelSelection({
			sessionScopedModels: [{ model: { provider: "local", id: "model-a" }, thinkingLevel: "low" }],
			settingsEnabledModels: ["api/ignored"],
			resolveModelScope,
		});

		expect(result.hasFilter).toBe(true);
		expect(Array.from(result.enabledModelIds)).toEqual(["local/model-a"]);
		expect(resolveModelScope).not.toHaveBeenCalled();
	});

	test("falls back to saved settings when no session scope exists", async () => {
		const resolveModelScope = vi.fn(async () => [
			{ model: { provider: "api", id: "model-a" }, thinkingLevel: "medium" },
			{ model: { provider: "api", id: "model-b" }, thinkingLevel: "high" },
		]);

		const result = await deriveInteractiveScopedModelSelection({
			sessionScopedModels: [],
			settingsEnabledModels: ["api/model-a", "api/model-b"],
			resolveModelScope,
		});

		expect(result.hasFilter).toBe(true);
		expect(Array.from(result.enabledModelIds)).toEqual(["api/model-a", "api/model-b"]);
		expect(resolveModelScope).toHaveBeenCalledWith(["api/model-a", "api/model-b"]);
	});

	test("applies partial selection as scoped models and clears full selection", async () => {
		const setScopedModels = vi.fn();
		const onUpdated = vi.fn(async () => {});
		const resolveModelScope = vi.fn(async (patterns: string[]) =>
			patterns.map((pattern) => {
				const [provider, id] = pattern.split("/");
				return {
					model: { provider: provider ?? "unknown", id: id ?? "unknown" },
					thinkingLevel: "medium",
				};
			}),
		);

		await applyInteractiveScopedModelSelection({
			enabledIds: new Set(["api/model-a"]),
			allModelCount: 2,
			resolveModelScope,
			setScopedModels,
			onUpdated,
		});

		expect(setScopedModels).toHaveBeenCalledWith([
			{
				model: { provider: "api", id: "model-a" },
				thinkingLevel: "medium",
			},
		]);
		expect(onUpdated).toHaveBeenCalledOnce();

		setScopedModels.mockClear();
		onUpdated.mockClear();

		await applyInteractiveScopedModelSelection({
			enabledIds: new Set(["api/model-a", "api/model-b"]),
			allModelCount: 2,
			resolveModelScope,
			setScopedModels,
			onUpdated,
		});

		expect(setScopedModels).toHaveBeenCalledWith([]);
		expect(onUpdated).toHaveBeenCalledOnce();
	});

	test("creates scoped-model selector callbacks that update and persist state", async () => {
		const currentEnabledIds = new Set<string>(["api/model-a"]);
		let currentHasFilter = true;
		const updateSessionModels = vi.fn(async () => {});
		const persistEnabledModels = vi.fn();
		const showStatus = vi.fn();
		const closeSelector = vi.fn();

		const callbacks = createInteractiveScopedModelsCallbacks({
			currentEnabledIds,
			setCurrentHasFilter: (hasFilter) => {
				currentHasFilter = hasFilter;
			},
			updateSessionModels,
			allModelCount: 2,
			persistEnabledModels,
			showStatus,
			closeSelector,
		});

		await callbacks.onModelToggle("api/model-b", true);
		expect(Array.from(currentEnabledIds)).toEqual(["api/model-a", "api/model-b"]);
		expect(currentHasFilter).toBe(true);
		expect(updateSessionModels).toHaveBeenCalledTimes(1);

		await callbacks.onEnableAll(["api/model-a", "api/model-b"]);
		expect(currentHasFilter).toBe(false);

		callbacks.onPersist(["api/model-a", "api/model-b"]);
		expect(persistEnabledModels).toHaveBeenCalledWith(undefined);
		expect(showStatus).toHaveBeenCalledWith("Model selection saved to settings");

		callbacks.onCancel();
		expect(closeSelector).toHaveBeenCalledOnce();
	});
});
