import * as path from "node:path";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.js";
import { runAutonomousSession } from "../core/auton/runner.js";
import type { AutonConfig } from "../core/auton/auton-hook.js";
import type { AutonomousRunSnapshot } from "../core/auton/ledger.js";

// Legacy note:
// The shipping harness now owns autonomous execution through the shared
// core/auton/runner.ts engine. This file remains only as a compatibility
// wrapper for any direct programmatic imports that still expect
// runAutonomousMode().

export interface AutonomousModeOptions {
	goal: string;
	autonConfig: AutonConfig;
	cwd: string;
}

export async function runAutonomousMode(
	runtimeHost: AgentSessionRuntime,
	options: AutonomousModeOptions,
): Promise<number> {
	const result = await runAutonomousSession({
		runtimeHost,
		userMessage: options.goal,
		config: {
			maxCostUsd: options.autonConfig.maxCost,
			maxTokens: options.autonConfig.maxTokens,
			maxTurns: options.autonConfig.maxTurns,
			enableNudges: options.autonConfig.enableNudges,
			enableBehavioralPrompt: options.autonConfig.enableBehavioralPrompt,
			verbose: options.autonConfig.verbose,
		},
		projectRoot: resolveRepoRootFromModuleUrl(import.meta.url),
		getToolCallHistory: () => [],
		getFileAccessHistory: () => [],
		onStatus: (status) => {
			process.stderr.write(`[Autonomous] ${status}\n`);
		},
		onCheckpoint: (snapshot) => {
			process.stderr.write(`${formatAutonomousCheckpoint(snapshot)}\n`);
		},
		onError: (message) => {
			process.stderr.write(`[Autonomous] ${message}\n`);
		},
	});

	return result.stopReason === "complete" ? 0 : 1;
}

function resolveRepoRootFromModuleUrl(moduleUrl: string): string {
	const thisFileDir = path.dirname(new URL(moduleUrl).pathname);
	return path.resolve(thisFileDir, "../../../..");
}

function formatAutonomousCheckpoint(snapshot: AutonomousRunSnapshot): string {
	const activeSubtask = snapshot.ledger.taskJournal.activeSubtask?.trim();
	const nextAction = snapshot.ledger.taskJournal.nextAction?.trim();
	const checkpoint =
		snapshot.ledger.resume?.lastStableCheckpoint?.trim() ||
		snapshot.ledger.taskJournal.completedCheckpoints.at(-1)?.trim();
	const parts = [
		`[Autonomous] checkpoint phase=${snapshot.phase}`,
		`status=${snapshot.ledger.status}`,
		`turns=${snapshot.budgetStatus.turnsUsed}`,
	];
	if (activeSubtask) parts.push(`active=${activeSubtask}`);
	if (nextAction) parts.push(`next=${nextAction}`);
	if (checkpoint) parts.push(`stable=${checkpoint}`);
	return parts.join(" | ");
}
