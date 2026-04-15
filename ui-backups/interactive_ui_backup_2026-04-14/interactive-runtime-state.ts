import type { AgentSessionEvent } from "../../core/agent-session.js";
import { getLatestAutonomousRunSnapshot } from "../../core/auton/ledger.js";
import type { AutonomousRunResult } from "../../core/auton/runner.js";
import { getLatestRuntimeHealthSnapshot } from "../../core/runtime-health.js";
import type { SessionEntry } from "../../core/session-manager.js";

export type XmlFallbackEvent = Extract<AgentSessionEvent, { type: "xml_tool_call" }>;
export type DegradedTurnEvent = Extract<AgentSessionEvent, { type: "degraded_turn" }>;

export interface RestoredInteractiveRuntimeState {
	lastAutonomousRunResult: AutonomousRunResult | undefined;
	xmlFallbackCount: number;
	degradedTurnCount: number;
	lastXmlFallbackEvent: XmlFallbackEvent | undefined;
	lastDegradedTurnEvent: DegradedTurnEvent | undefined;
}

export function restoreInteractiveRuntimeState(entries: SessionEntry[]): RestoredInteractiveRuntimeState {
	const snapshot = getLatestAutonomousRunSnapshot(entries);
	const runtimeHealth = getLatestRuntimeHealthSnapshot(entries);

	return {
		lastAutonomousRunResult: snapshot
			? {
					iterations: snapshot.iterations,
					stopReason: snapshot.stopReason,
					budgetStatus: snapshot.budgetStatus,
					costSummary: snapshot.costSummary,
					checkpointState: snapshot.checkpointState,
					ledger: snapshot.ledger,
				}
			: undefined,
		xmlFallbackCount: runtimeHealth?.xmlFallbackCount ?? 0,
		degradedTurnCount: runtimeHealth?.degradedTurnCount ?? 0,
		lastXmlFallbackEvent: runtimeHealth?.lastXmlFallbackEvent,
		lastDegradedTurnEvent: runtimeHealth?.lastDegradedTurnEvent,
	};
}
