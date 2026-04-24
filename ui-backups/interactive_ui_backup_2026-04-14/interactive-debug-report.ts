import { visibleWidth } from "@ag1/tui";
import type { AgentMessage } from "@ag1/agent-core";
import type { ActivatedAutonomousWorkspace, PreparedAutonomousWorkspace } from "../../core/auton/workspace.js";
import type { RuntimeStabilizationProfile } from "../../core/runtime-health.js";
import type { AgentSessionEvent } from "../../core/agent-session.js";

type XmlFallbackEvent = Extract<AgentSessionEvent, { type: "xml_tool_call" }>;
type DegradedTurnEvent = Extract<AgentSessionEvent, { type: "degraded_turn" }>;

export function buildInteractiveDebugReport(options: {
	timestamp: string;
	width: number;
	height: number;
	renderedLines: string[];
	messages: AgentMessage[];
	modelId: string;
	mode: "interactive" | "planning" | "autonomous";
	stabilization: RuntimeStabilizationProfile;
	xmlFallbackCount: number;
	degradedTurnCount: number;
	lastXmlFallbackEvent?: XmlFallbackEvent;
	lastDegradedTurnEvent?: DegradedTurnEvent;
	formatRuntimeHealthIssue: (event: XmlFallbackEvent | DegradedTurnEvent) => string;
	workspace?: ActivatedAutonomousWorkspace | PreparedAutonomousWorkspace;
	artifacts?: {
		sessionDir?: string;
		sessionMd?: string;
		sessionCompactMd?: string;
		timelineJson?: string;
	};
}): string {
	return [
		`Debug output at ${options.timestamp}`,
		`Terminal: ${options.width}x${options.height}`,
		`Total lines: ${options.renderedLines.length}`,
		"",
		"=== Runtime overview ===",
		`Model: ${options.modelId}`,
		`Mode: ${options.mode}`,
		`Stabilization: ${options.stabilization.level}${
			options.stabilization.reasons.length > 0 ? ` (${options.stabilization.reasons.join(" | ")})` : ""
		}`,
		`XML Fallbacks: ${options.xmlFallbackCount}`,
		`Degraded Turns: ${options.degradedTurnCount}`,
		`Latest XML Fallback: ${
			options.lastXmlFallbackEvent ? options.formatRuntimeHealthIssue(options.lastXmlFallbackEvent) : "none"
		}`,
		`Latest Degraded Turn: ${
			options.lastDegradedTurnEvent ? options.formatRuntimeHealthIssue(options.lastDegradedTurnEvent) : "none"
		}`,
		"",
		"=== Autonomous workspace ===",
		`State: ${options.workspace ? ("restore" in options.workspace ? "active" : "preserved") : "none"}`,
		`Workspace Root: ${options.workspace?.workspaceRoot ?? "unavailable"}`,
		`Active CWD: ${options.workspace?.activeCwd ?? "unavailable"}`,
		`Source CWD: ${options.workspace?.sourceCwd ?? "unavailable"}`,
		"",
		"=== Session debug artifacts ===",
		`Session Dir: ${options.artifacts?.sessionDir ?? "unavailable"}`,
		`Session Log: ${options.artifacts?.sessionMd ?? "unavailable"}`,
		`Compact Log: ${options.artifacts?.sessionCompactMd ?? "unavailable"}`,
		`Timeline: ${options.artifacts?.timelineJson ?? "unavailable"}`,
		"",
		"=== All rendered lines with visible widths ===",
		...options.renderedLines.map((line, idx) => `[${idx}] (w=${visibleWidth(line)}) ${JSON.stringify(line)}`),
		"",
		"=== Agent messages (JSONL) ===",
		...options.messages.map((msg) => JSON.stringify(msg)),
		"",
	].join("\n");
}
