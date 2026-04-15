import type { SessionStats } from "../../core/agent-session.js";
import type { ResearchArtifactSnapshot } from "../../core/research-artifacts.js";
import type {
	ActivatedAutonomousWorkspace,
	AutonomousWorkspaceDiff,
	PreparedAutonomousWorkspace,
	PromotedAutonomousWorkspace,
} from "../../core/auton/workspace.js";
import { limitPreviewLines } from "../../core/tools/research-output.js";
import { theme } from "./theme/theme.js";

export function formatSessionInfo(options: {
	stats: SessionStats;
	sessionName?: string;
	runtimeHealth?: string;
	runtimeTimeline?: string;
	debugArtifacts?: string;
	runtimeRecovery?: string;
	stabilization?: string;
	workspaceSummary?: string;
	autonomousRunSummary?: string;
}): string {
	const {
		stats,
		sessionName,
		runtimeHealth,
		runtimeTimeline,
		debugArtifacts,
		runtimeRecovery,
		stabilization,
		workspaceSummary,
		autonomousRunSummary,
	} = options;

	let info = `${theme.bold("Session Info")}\n\n`;
	if (sessionName) {
		info += `${theme.fg("dim", "Name:")} ${sessionName}\n`;
	}
	info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
	info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`;
	info += `${theme.bold("Messages")}\n`;
	info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
	info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
	info += `${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}\n`;
	info += `${theme.fg("dim", "Tool Results:")} ${stats.toolResults}\n`;
	info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n\n`;
	info += `${theme.bold("Tokens")}\n`;
	info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
	info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
	if (stats.tokens.cacheRead > 0) {
		info += `${theme.fg("dim", "Cache Read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
	}
	if (stats.tokens.cacheWrite > 0) {
		info += `${theme.fg("dim", "Cache Write:")} ${stats.tokens.cacheWrite.toLocaleString()}\n`;
	}
	info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;

	if (stats.cost > 0) {
		info += `\n${theme.bold("Cost")}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.cost.toFixed(4)}`;
	}

	if (runtimeHealth) info += runtimeHealth;
	if (runtimeTimeline) info += runtimeTimeline;
	if (debugArtifacts) info += debugArtifacts;
	if (runtimeRecovery) info += runtimeRecovery;
	if (stabilization) info += stabilization;
	if (workspaceSummary) info += workspaceSummary;
	if (autonomousRunSummary) info += autonomousRunSummary;
	return info;
}

export function formatResearchArtifactsSummary(artifacts: ResearchArtifactSnapshot[]): string {
	let info = `${theme.bold("Research Artifacts")}\n`;
	for (const artifact of artifacts) {
		info += `${theme.fg("dim", "-")} ${artifact.savedAt} [${artifact.kind}]`;
		if (artifact.compressionMode) info += ` ${theme.fg("dim", `(${artifact.compressionMode})`)}`;
		if (artifact.cacheHit) info += ` ${theme.fg("dim", "[cached]")}`;
		info += "\n";
		if (artifact.kind === "search") {
			if (artifact.query) info += `  ${theme.fg("dim", "Query:")} ${artifact.query}\n`;
			if (typeof artifact.resultCount === "number") {
				info += `  ${theme.fg("dim", "Results:")} ${artifact.resultCount}\n`;
			}
			if (artifact.sourceUrls && artifact.sourceUrls.length > 0) {
				info += `  ${theme.fg("dim", "Sources:")} ${artifact.sourceUrls.slice(0, 3).join(" | ")}\n`;
			}
			continue;
		}

		if (artifact.title) info += `  ${theme.fg("dim", "Title:")} ${artifact.title}\n`;
		if (artifact.url) info += `  ${theme.fg("dim", "URL:")} ${artifact.url}\n`;
		if (artifact.facts && artifact.facts.length > 0) {
			info += `  ${theme.fg("dim", "Facts:")} ${artifact.facts.slice(0, 3).join(" | ")}\n`;
		}
		if (artifact.preview) {
			info += `  ${theme.fg("dim", "Preview:")} ${limitPreviewLines(artifact.preview, 3, 140).replace(/\n/g, "\n  ")}\n`;
		}
	}
	return info.trimEnd();
}

export function formatAutonomousWorkspaceSummary(
	workspace: PreparedAutonomousWorkspace | ActivatedAutonomousWorkspace,
	isActive: boolean,
): string {
	let info = `\n\n${theme.bold("Autonomous Workspace")}\n`;
	info += `${theme.fg("dim", "State:")} ${isActive ? "active" : "preserved"}\n`;
	info += `${theme.fg("dim", "Strategy:")} ${workspace.strategy}\n`;
	info += `${theme.fg("dim", "Root:")} ${workspace.workspaceRoot}\n`;
	info += `${theme.fg("dim", "Active CWD:")} ${workspace.activeCwd}\n`;
	info += `${theme.fg("dim", "Source CWD:")} ${workspace.sourceCwd}\n`;
	return info;
}

export function formatWorkspaceCommandSummary(
	workspace: PreparedAutonomousWorkspace | ActivatedAutonomousWorkspace,
	isActive: boolean,
): string {
	let info = `${theme.bold("Autonomous Workspace")}\n\n`;
	info += `${theme.fg("dim", "State:")} ${isActive ? "active" : "preserved"}\n`;
	info += `${theme.fg("dim", "Strategy:")} ${workspace.strategy}\n`;
	info += `${theme.fg("dim", "Root:")} ${workspace.workspaceRoot}\n`;
	info += `${theme.fg("dim", "Active CWD:")} ${workspace.activeCwd}\n`;
	info += `${theme.fg("dim", "Source CWD:")} ${workspace.sourceCwd}\n`;
	info += `${theme.fg("dim", "Description:")} ${workspace.description}\n`;
	info += `\n${theme.fg("dim", "Tip:")} /workspace diff, /workspace promote, /workspace promote --delete, or /workspace discard`;
	return info;
}

export function formatWorkspaceDiffSummary(diff: AutonomousWorkspaceDiff): string {
	let info = `${theme.bold("Autonomous Workspace Diff")}\n\n`;
	info += `${theme.fg("dim", "Added:")} ${diff.added.length}\n`;
	info += `${theme.fg("dim", "Modified:")} ${diff.modified.length}\n`;
	info += `${theme.fg("dim", "Deleted:")} ${diff.deleted.length}\n`;
	if (diff.added.length > 0) info += `\n${theme.bold("Added")}\n${diff.added.join("\n")}\n`;
	if (diff.modified.length > 0) info += `\n${theme.bold("Modified")}\n${diff.modified.join("\n")}\n`;
	if (diff.deleted.length > 0) info += `\n${theme.bold("Deleted")}\n${diff.deleted.join("\n")}\n`;
	return info.trimEnd();
}

export function formatWorkspacePromotionSummary(
	promoted: PromotedAutonomousWorkspace,
	options: { deleteMissing: boolean },
): string {
	const summary =
		promoted.copiedEntries.length > 0 ? promoted.copiedEntries.join(", ") : "(no entries copied)";
	const deletedSummary =
		promoted.deletedEntries.length > 0 ? `\nDeleted entries: ${promoted.deletedEntries.join(", ")}` : "";
	return `Promoted autonomous workspace into ${promoted.sourceCwd}\nCopied entries: ${summary}${deletedSummary}\nNote: promotion overlays files${options.deleteMissing ? " and removed entries missing from the sandbox." : " and does not delete files missing from the sandbox."}`;
}

export function formatWorkspaceDiscardSummary(workspaceRoot: string): string {
	return `Discarded preserved autonomous workspace: ${workspaceRoot}`;
}
