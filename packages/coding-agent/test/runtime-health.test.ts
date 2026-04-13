import { describe, expect, test } from "vitest";
import {
	appendRuntimeHealthSnapshotIfChanged,
	appendRuntimeHealthSnapshotState,
	createRuntimeHealthSnapshotFromState,
	deriveRuntimeStabilizationProfile,
	getLatestRuntimeHealthSnapshot,
	getRecentRuntimeHealthSnapshots,
	RUNTIME_HEALTH_SNAPSHOT_ENTRY_TYPE,
} from "../src/core/runtime-health.js";

describe("runtime-health snapshots", () => {
	test("appends and restores the latest runtime-health snapshot", () => {
		const entries: any[] = [
			{ type: "message", id: "m1" },
			{
				type: "custom",
				customType: RUNTIME_HEALTH_SNAPSHOT_ENTRY_TYPE,
				data: createRuntimeHealthSnapshotFromState({
					modelId: "provider/model-a",
					xmlFallbackCount: 1,
					degradedTurnCount: 0,
					lastXmlFallbackEvent: {
						type: "xml_tool_call",
						toolName: "bash",
						arguments: { command: "npm test" },
						severity: "elevated",
						reasons: ["truncated_turn"],
					},
				}),
			},
		];
		const sessionManager = {
			appendCustomEntry: (_customType: string, data?: unknown) => {
				entries.push({
					type: "custom",
					customType: RUNTIME_HEALTH_SNAPSHOT_ENTRY_TYPE,
					data,
				});
				return "c2";
			},
		};

		appendRuntimeHealthSnapshotState(
			sessionManager,
			createRuntimeHealthSnapshotFromState({
				modelId: "provider/model-a",
				xmlFallbackCount: 2,
				degradedTurnCount: 1,
				lastXmlFallbackEvent: {
					type: "xml_tool_call",
					toolName: "bash",
					arguments: { command: "npm test" },
					severity: "critical",
					reasons: ["truncated_turn", "multiple_xml_calls"],
					continuationMode: "guided",
				},
				lastDegradedTurnEvent: {
					type: "degraded_turn",
					severity: "critical",
					stopReason: "max_tokens",
					outputTokens: 15000,
					textLength: 52000,
					reasons: ["truncated_turn", "very_high_output_tokens"],
					recoveryHint:
						"Continue from the last concrete point only, keep the next response short, and avoid repeating prior analysis.",
				},
			}),
		);

		const snapshot = getLatestRuntimeHealthSnapshot(entries as any);
		expect(snapshot?.xmlFallbackCount).toBe(2);
		expect(snapshot?.modelId).toBe("provider/model-a");
		expect(snapshot?.degradedTurnCount).toBe(1);
		expect(snapshot?.lastXmlFallbackEvent?.severity).toBe("critical");
		expect(snapshot?.lastDegradedTurnEvent?.severity).toBe("critical");
		expect(getRecentRuntimeHealthSnapshots(entries as any, 2)).toHaveLength(2);
	});

	test("skips duplicate runtime-health snapshots", () => {
		const entries: any[] = [];
		const sessionManager = {
			appendCustomEntry: (_customType: string, data?: unknown) => {
				entries.push({
					type: "custom",
					customType: RUNTIME_HEALTH_SNAPSHOT_ENTRY_TYPE,
					data,
				});
				return "c1";
			},
			getEntries: () => entries,
		};
		const snapshot = createRuntimeHealthSnapshotFromState({
			modelId: "provider/model-a",
			xmlFallbackCount: 1,
			degradedTurnCount: 1,
			lastDegradedTurnEvent: {
				type: "degraded_turn",
				severity: "critical",
				stopReason: "max_tokens",
				outputTokens: 15000,
				textLength: 52000,
				reasons: ["truncated_turn"],
			},
		});

		expect(appendRuntimeHealthSnapshotIfChanged(sessionManager as any, snapshot)).toBe(true);
		expect(appendRuntimeHealthSnapshotIfChanged(sessionManager as any, snapshot)).toBe(false);
		expect(getRecentRuntimeHealthSnapshots(entries as any, 3)).toHaveLength(1);
	});

	test("derives a strict stabilization profile from repeated critical degradation", () => {
		const entries: any[] = [
			{
				type: "custom",
				customType: RUNTIME_HEALTH_SNAPSHOT_ENTRY_TYPE,
				data: createRuntimeHealthSnapshotFromState({
					modelId: "provider/model-a",
					xmlFallbackCount: 1,
					degradedTurnCount: 1,
					lastXmlFallbackEvent: {
						type: "xml_tool_call",
						toolName: "bash",
						arguments: { command: "npm test" },
						severity: "critical",
						reasons: ["truncated_turn"],
					},
				}),
			},
			{
				type: "custom",
				customType: RUNTIME_HEALTH_SNAPSHOT_ENTRY_TYPE,
				data: createRuntimeHealthSnapshotFromState({
					modelId: "provider/model-a",
					xmlFallbackCount: 1,
					degradedTurnCount: 1,
					lastDegradedTurnEvent: {
						type: "degraded_turn",
						severity: "critical",
						stopReason: "max_tokens",
						outputTokens: 15000,
						textLength: 52000,
						reasons: ["truncated_turn"],
					},
				}),
			},
			{
				type: "custom",
				customType: RUNTIME_HEALTH_SNAPSHOT_ENTRY_TYPE,
				data: createRuntimeHealthSnapshotFromState({
					modelId: "provider/model-a",
					xmlFallbackCount: 2,
					degradedTurnCount: 2,
					lastDegradedTurnEvent: {
						type: "degraded_turn",
						severity: "critical",
						stopReason: "max_tokens",
						outputTokens: 16000,
						textLength: 54000,
						reasons: ["truncated_turn", "very_high_output_tokens"],
					},
				}),
			},
		];

		const profile = deriveRuntimeStabilizationProfile(entries as any, "provider/model-a");
		expect(profile.level).toBe("strict");
		expect(profile.recommendedMaxOutputPerTurn).toBe(2500);
		expect(profile.forceBehavioralPrompt).toBe(true);
		expect(profile.forceNudges).toBe(true);
	});

	test("ignores degradation from other models when deriving stabilization", () => {
		const entries: any[] = [
			{
				type: "custom",
				customType: RUNTIME_HEALTH_SNAPSHOT_ENTRY_TYPE,
				data: createRuntimeHealthSnapshotFromState({
					modelId: "provider/model-a",
					xmlFallbackCount: 1,
					degradedTurnCount: 1,
					lastDegradedTurnEvent: {
						type: "degraded_turn",
						severity: "critical",
						stopReason: "max_tokens",
						outputTokens: 15000,
						textLength: 52000,
						reasons: ["truncated_turn"],
					},
				}),
			},
			{
				type: "custom",
				customType: RUNTIME_HEALTH_SNAPSHOT_ENTRY_TYPE,
				data: createRuntimeHealthSnapshotFromState({
					modelId: "provider/model-b",
					xmlFallbackCount: 0,
					degradedTurnCount: 0,
				}),
			},
		];

		expect(deriveRuntimeStabilizationProfile(entries as any, "provider/model-b").level).toBe("none");
		expect(deriveRuntimeStabilizationProfile(entries as any, "provider/model-a").level).toBe("guarded");
	});

	test("ignores old auth/config-only degraded turns when deriving stabilization", () => {
		const entries: any[] = [
			{
				type: "custom",
				customType: RUNTIME_HEALTH_SNAPSHOT_ENTRY_TYPE,
				data: createRuntimeHealthSnapshotFromState({
					modelId: "openai/gpt-5.4",
					xmlFallbackCount: 0,
					degradedTurnCount: 1,
					lastDegradedTurnEvent: {
						type: "degraded_turn",
						severity: "critical",
						stopReason: "error",
						outputTokens: 0,
						textLength: 0,
						reasons: ["error_turn"],
					},
				}),
			},
		];

		expect(deriveRuntimeStabilizationProfile(entries as any, "openai/gpt-5.4").level).toBe("none");
	});
});
