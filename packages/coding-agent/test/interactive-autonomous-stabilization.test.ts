import { describe, expect, test } from "vitest";
import type { AutonomousRunSnapshot } from "../src/core/auton/ledger.js";
import type { RuntimeStabilizationProfile } from "../src/core/runtime-health.js";
import {
	type AutonomousExecutionConfig,
	buildAutonomousStabilizedUserMessage,
	buildInteractiveStabilizedUserMessage,
	buildPlanningGuidanceMessage,
	buildPlanningUserMessage,
	getInteractiveAutonomousResumeSnapshot,
	isInteractiveAutonomousResumeRequest,
	resolveInteractiveAutonomousRunConfig,
} from "../src/modes/interactive/interactive-autonomous-stabilization.js";

function createProfile(overrides: Partial<RuntimeStabilizationProfile> = {}): RuntimeStabilizationProfile {
	return {
		level: "guarded",
		reasons: ["recent degradation"],
		recommendedMaxOutputPerTurn: 4000,
		forceBehavioralPrompt: true,
		forceNudges: true,
		...overrides,
	};
}

function createSnapshot(overrides: Partial<AutonomousRunSnapshot> = {}): AutonomousRunSnapshot {
	return {
		phase: "final",
		stopReason: "blocked",
		iterations: 2,
		budgetStatus: "ok",
		costSummary: {
			totalTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalCostUsd: 0,
		},
		checkpointState: { controlState: "blocked_stop" },
		ledger: {
			goal: "fix the failing tests",
		},
		...overrides,
	} as AutonomousRunSnapshot;
}

describe("interactive-autonomous-stabilization", () => {
	test("tightens autonomous run config based on stabilization profile", () => {
		const config: AutonomousExecutionConfig = {
			maxOutputPerTurn: 8000,
			enableBehavioralPrompt: false,
			enableNudges: false,
		};

		const resolved = resolveInteractiveAutonomousRunConfig(config, createProfile());

		expect(resolved.maxOutputPerTurn).toBe(4000);
		expect(resolved.enableBehavioralPrompt).toBe(true);
		expect(resolved.enableNudges).toBe(true);
	});

	test("builds stabilized autonomous and interactive prompts", () => {
		const profile = createProfile();

		const autonomous = buildAutonomousStabilizedUserMessage("fix it", profile);
		const interactive = buildInteractiveStabilizedUserMessage("fix it", profile);
		const planning = buildPlanningUserMessage("fix it", profile);
		const planningGuidance = buildPlanningGuidanceMessage(profile);

		expect(autonomous).toContain("Autonomous stabilization for this run:");
		expect(autonomous).toContain("4,000");
		expect(interactive).toContain("Runtime stabilization for this turn:");
		expect(interactive).toContain("do not emit XML fallback");
		expect(planning).toBe("fix it");
		expect(planningGuidance).toContain("Planning mode guidance:");
		expect(planningGuidance).toContain("do not edit files");
		expect(planningGuidance).toContain("do not invent the language, framework, platform, or library");
		expect(planningGuidance).toContain(
			"do not inspect files or search the web before asking the clarifying questions",
		);
		expect(planningGuidance).toContain("deliver the plan by calling the `submit_plan` tool exactly once");
		expect(planningGuidance).toContain("do not print the plan as markdown text");
		expect(planningGuidance).toContain("call submit_plan with only `summary` and `openQuestions` (no steps)");
		expect(planningGuidance).toContain("after submit_plan returns, stop");
	});

	test("does not force terse stabilization wording on expansion follow-ups", () => {
		const profile = createProfile();

		const autonomous = buildAutonomousStabilizedUserMessage("broaden this and give me the whole picture", profile);
		const interactive = buildInteractiveStabilizedUserMessage("go deeper and give me more detail", profile);

		expect(autonomous).toContain("keep the answer focused and evidence-backed");
		expect(autonomous).toContain("do not collapse the answer into a one-line summary");
		expect(autonomous).not.toContain("keep responses terse and tool-driven");
		expect(autonomous).not.toContain("4,000");

		expect(interactive).toContain("keep the reply focused and evidence-backed");
		expect(interactive).toContain("do not compress the reply into a headline-length answer");
		expect(interactive).not.toContain("keep the reply terse and tool-driven");
		expect(interactive).not.toContain("4,000");
	});

	test("recognizes autonomous resume requests by continuation wording or exact goal", () => {
		const snapshot = createSnapshot();

		expect(isInteractiveAutonomousResumeRequest("continue", snapshot)).toBe(true);
		expect(isInteractiveAutonomousResumeRequest("fix the failing tests", snapshot)).toBe(true);
		expect(isInteractiveAutonomousResumeRequest("start a new frontend redesign", snapshot)).toBe(false);
	});

	test("returns only resumable snapshots", () => {
		const resumable = createSnapshot();
		const complete = createSnapshot({ stopReason: "complete" });

		expect(getInteractiveAutonomousResumeSnapshot("continue", resumable)).toBe(resumable);
		expect(getInteractiveAutonomousResumeSnapshot("continue", complete)).toBeUndefined();
		expect(getInteractiveAutonomousResumeSnapshot("new task", resumable)).toBeUndefined();
	});
});
