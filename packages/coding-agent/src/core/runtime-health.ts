import type { AgentSessionEvent } from "./agent-session.js";
import type { SessionEntry } from "./session-manager.js";

export type RuntimeHealthXmlFallbackEvent = Extract<AgentSessionEvent, { type: "xml_tool_call" }>;
export type RuntimeHealthDegradedTurnEvent = Extract<AgentSessionEvent, { type: "degraded_turn" }>;

export interface RuntimeHealthSnapshot {
	version: 1;
	savedAt: string;
	modelId?: string;
	xmlFallbackCount: number;
	degradedTurnCount: number;
	lastXmlFallbackEvent?: RuntimeHealthXmlFallbackEvent;
	lastDegradedTurnEvent?: RuntimeHealthDegradedTurnEvent;
}

export interface RuntimeStabilizationProfile {
	level: "none" | "guarded" | "strict";
	reasons: string[];
	recommendedMaxOutputPerTurn?: number;
	forceBehavioralPrompt: boolean;
	forceNudges: boolean;
}

export const RUNTIME_HEALTH_SNAPSHOT_ENTRY_TYPE = "runtime_health_snapshot";

export function createRuntimeHealthSnapshotFromState(state: {
	modelId?: string;
	xmlFallbackCount: number;
	degradedTurnCount: number;
	lastXmlFallbackEvent?: RuntimeHealthXmlFallbackEvent;
	lastDegradedTurnEvent?: RuntimeHealthDegradedTurnEvent;
}): RuntimeHealthSnapshot {
	return {
		version: 1,
		savedAt: new Date().toISOString(),
		modelId: state.modelId,
		xmlFallbackCount: state.xmlFallbackCount,
		degradedTurnCount: state.degradedTurnCount,
		lastXmlFallbackEvent: state.lastXmlFallbackEvent,
		lastDegradedTurnEvent: state.lastDegradedTurnEvent,
	};
}

export function appendRuntimeHealthSnapshotState(
	sessionManager: { appendCustomEntry: (customType: string, data?: unknown) => string },
	snapshot: RuntimeHealthSnapshot,
): void {
	sessionManager.appendCustomEntry(RUNTIME_HEALTH_SNAPSHOT_ENTRY_TYPE, snapshot);
}

export function appendRuntimeHealthSnapshotIfChanged(
	sessionManager: {
		appendCustomEntry: (customType: string, data?: unknown) => string;
		getEntries: () => SessionEntry[];
	},
	snapshot: RuntimeHealthSnapshot,
): boolean {
	const latest = getLatestRuntimeHealthSnapshot(sessionManager.getEntries());
	if (latest && areRuntimeHealthSnapshotsEquivalent(latest, snapshot)) {
		return false;
	}
	appendRuntimeHealthSnapshotState(sessionManager, snapshot);
	return true;
}

export function getLatestRuntimeHealthSnapshot(entries: SessionEntry[]): RuntimeHealthSnapshot | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== RUNTIME_HEALTH_SNAPSHOT_ENTRY_TYPE) continue;
		if (isRuntimeHealthSnapshot(entry.data)) return entry.data;
	}
	return undefined;
}

export function getRecentRuntimeHealthSnapshots(entries: SessionEntry[], limit = 3, modelId?: string): RuntimeHealthSnapshot[] {
	const snapshots: RuntimeHealthSnapshot[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== RUNTIME_HEALTH_SNAPSHOT_ENTRY_TYPE) continue;
		if (!isRuntimeHealthSnapshot(entry.data)) continue;
		if (modelId && entry.data.modelId !== modelId) continue;
		snapshots.push(entry.data);
		if (snapshots.length >= limit) break;
	}
	return snapshots.reverse();
}

export function deriveRuntimeStabilizationProfile(entries: SessionEntry[], modelId?: string): RuntimeStabilizationProfile {
	const snapshots = getRecentRuntimeHealthSnapshots(entries, 5, modelId);
	if (snapshots.length === 0) {
		return {
			level: "none",
			reasons: [],
			forceBehavioralPrompt: false,
			forceNudges: false,
		};
	}

	const relevantDegradedTurns = snapshots
		.map((snapshot) => snapshot.lastDegradedTurnEvent)
		.filter((event): event is RuntimeHealthDegradedTurnEvent => Boolean(event))
		.filter(isStabilizationRelevantDegradedTurn);
	const criticalXmlFallbacks = snapshots.filter((snapshot) => snapshot.lastXmlFallbackEvent?.severity === "critical").length;
	const criticalDegradedTurns = relevantDegradedTurns.filter((event) => event.severity === "critical").length;
	const degradedTurns = relevantDegradedTurns.length;
	const reasons: string[] = [];

	if (criticalXmlFallbacks > 0) {
		reasons.push(`${criticalXmlFallbacks} recent critical XML fallback${criticalXmlFallbacks === 1 ? "" : "s"}`);
	}
	if (criticalDegradedTurns > 0) {
		reasons.push(`${criticalDegradedTurns} recent critical degraded turn${criticalDegradedTurns === 1 ? "" : "s"}`);
	}
	if (degradedTurns > criticalDegradedTurns) {
		const nonCritical = degradedTurns - criticalDegradedTurns;
		reasons.push(`${nonCritical} recent elevated degraded turn${nonCritical === 1 ? "" : "s"}`);
	}

	if (criticalXmlFallbacks >= 2 || criticalDegradedTurns >= 2) {
		return {
			level: "strict",
			reasons,
			recommendedMaxOutputPerTurn: 2500,
			forceBehavioralPrompt: true,
			forceNudges: true,
		};
	}
	if (criticalXmlFallbacks >= 1 || criticalDegradedTurns >= 1 || degradedTurns >= 2) {
		return {
			level: "guarded",
			reasons,
			recommendedMaxOutputPerTurn: 4000,
			forceBehavioralPrompt: true,
			forceNudges: true,
		};
	}
	return {
		level: "none",
		reasons: [],
		forceBehavioralPrompt: false,
		forceNudges: false,
	};
}

function isStabilizationRelevantDegradedTurn(event: RuntimeHealthDegradedTurnEvent): boolean {
	if (event.stopReason !== "error") {
		return true;
	}

	const reasons = event.reasons ?? [];
	if (reasons.length !== 1 || reasons[0] !== "error_turn") {
		return true;
	}

	return (event.outputTokens ?? 0) > 0 || (event.textLength ?? 0) > 0;
}

function isRuntimeHealthSnapshot(value: unknown): value is RuntimeHealthSnapshot {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<RuntimeHealthSnapshot>;
	return (
		candidate.version === 1 &&
		typeof candidate.savedAt === "string" &&
		typeof candidate.xmlFallbackCount === "number" &&
		typeof candidate.degradedTurnCount === "number"
	);
}

function areRuntimeHealthSnapshotsEquivalent(a: RuntimeHealthSnapshot, b: RuntimeHealthSnapshot): boolean {
	return JSON.stringify({
		xmlFallbackCount: a.xmlFallbackCount,
		degradedTurnCount: a.degradedTurnCount,
		lastXmlFallbackEvent: a.lastXmlFallbackEvent,
		lastDegradedTurnEvent: a.lastDegradedTurnEvent,
	}) ===
		JSON.stringify({
			xmlFallbackCount: b.xmlFallbackCount,
			degradedTurnCount: b.degradedTurnCount,
			lastXmlFallbackEvent: b.lastXmlFallbackEvent,
			lastDegradedTurnEvent: b.lastDegradedTurnEvent,
		});
}
