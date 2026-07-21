import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@ag1/agent-core";
import { Text } from "@ag1/tui";
import type { AgentSessionEvent, SessionStats } from "../../core/agent-session.js";
import type { ActivatedAutonomousWorkspace, PreparedAutonomousWorkspace } from "../../core/auton/workspace.js";
import { getRecentResearchArtifacts } from "../../core/research-artifacts.js";
import type { SessionDebugArtifacts } from "../../core/session-debug-logger.js";
import {
	formatAutonomousWorkspaceSummary,
	formatResearchArtifactsSummary,
	formatSessionInfo,
} from "./interactive-command-presenters.js";
import { buildInteractiveDebugReport } from "./interactive-debug-report.js";
import { theme } from "./theme/theme.js";

type XmlFallbackEvent = Extract<AgentSessionEvent, { type: "xml_tool_call" }>;
type DegradedTurnEvent = Extract<AgentSessionEvent, { type: "degraded_turn" }>;

export function renderInteractiveSessionInfo(options: {
	chatContainer: { addChild(component: unknown): void };
	ui: { requestRender(): void };
	stats: SessionStats;
	sessionName?: string;
	runtimeHealth?: string;
	runtimeTimeline?: string;
	debugArtifacts?: string;
	runtimeRecovery?: string;
	stabilization?: string;
	workspaceSummary?: string;
	autonomousRunSummary?: string;
}): void {
	options.chatContainer.addChild(
		new Text(
			formatSessionInfo({
				stats: options.stats,
				sessionName: options.sessionName,
				runtimeHealth: options.runtimeHealth,
				runtimeTimeline: options.runtimeTimeline,
				debugArtifacts: options.debugArtifacts,
				runtimeRecovery: options.runtimeRecovery,
				stabilization: options.stabilization,
				workspaceSummary: options.workspaceSummary,
				autonomousRunSummary: options.autonomousRunSummary,
			}),
			1,
			0,
		),
	);
	options.ui.requestRender();
}

export function renderInteractiveResearchArtifacts(options: {
	chatContainer: { addChild(component: unknown): void };
	ui: { requestRender(): void };
	sessionEntries: unknown[];
	limit: number;
}): boolean {
	const artifacts = getRecentResearchArtifacts(options.sessionEntries as any, options.limit);
	if (artifacts.length === 0) return false;

	options.chatContainer.addChild(new Text(formatResearchArtifactsSummary(artifacts), 1, 0));
	options.ui.requestRender();
	return true;
}

export function getInteractiveWorkspaceSummary(
	workspace: PreparedAutonomousWorkspace | ActivatedAutonomousWorkspace | undefined,
	isActive: boolean,
): string {
	return workspace ? formatAutonomousWorkspaceSummary(workspace, isActive) : "";
}

export function writeInteractiveDebugLog(options: {
	width: number;
	height: number;
	renderedLines: string[];
	messages: AgentMessage[];
	modelId: string;
	mode: "interactive" | "planning" | "autonomous";
	stabilization: {
		level: string;
		reasons: string[];
		recommendedMaxOutputPerTurn?: number;
		forceBehavioralPrompt?: boolean;
		forceNudges?: boolean;
	};
	xmlFallbackCount: number;
	degradedTurnCount: number;
	lastXmlFallbackEvent?: XmlFallbackEvent;
	lastDegradedTurnEvent?: DegradedTurnEvent;
	formatRuntimeHealthIssue: (event: XmlFallbackEvent | DegradedTurnEvent) => string;
	workspace?: PreparedAutonomousWorkspace | ActivatedAutonomousWorkspace;
	artifacts?: SessionDebugArtifacts;
	debugLogPath: string;
}): string {
	const debugData = buildInteractiveDebugReport({
		timestamp: new Date().toISOString(),
		width: options.width,
		height: options.height,
		renderedLines: options.renderedLines,
		messages: options.messages,
		modelId: options.modelId,
		mode: options.mode,
		stabilization: options.stabilization as any,
		xmlFallbackCount: options.xmlFallbackCount,
		degradedTurnCount: options.degradedTurnCount,
		lastXmlFallbackEvent: options.lastXmlFallbackEvent,
		lastDegradedTurnEvent: options.lastDegradedTurnEvent,
		formatRuntimeHealthIssue: options.formatRuntimeHealthIssue,
		workspace: options.workspace,
		artifacts: options.artifacts,
	});

	fs.mkdirSync(path.dirname(options.debugLogPath), { recursive: true });
	fs.writeFileSync(options.debugLogPath, debugData);
	return options.debugLogPath;
}

export function renderInteractiveDebugLogStatus(options: {
	chatContainer: { addChild(component: unknown): void };
	ui: { requestRender(): void };
	debugLogPath: string;
	artifacts?: SessionDebugArtifacts;
}): void {
	options.chatContainer.addChild(
		new Text(
			[
				theme.fg("accent", "✓ Debug log written"),
				theme.fg("muted", options.debugLogPath),
				options.artifacts?.sessionDir
					? theme.fg("muted", `Session artifacts: ${options.artifacts.sessionDir}`)
					: undefined,
			]
				.filter(Boolean)
				.join("\n"),
			1,
			1,
		),
	);
	options.ui.requestRender();
}
