import * as path from "node:path";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.js";
import { runAutonomousSession } from "../core/auton/runner.js";
import type { AutonConfig } from "../core/auton/auton-hook.js";

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
