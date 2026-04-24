import type { AutonomousRunSnapshot } from "../../core/auton/ledger.js";
import type { AutonomousRunConfig } from "../../core/auton/runner.js";
import { buildTaggedPromptBundle } from "../../core/prompt-sections.js";
import type { RuntimeStabilizationProfile } from "../../core/runtime-health.js";

export interface AutonomousExecutionConfig extends AutonomousRunConfig {
	startInAutonomousMode?: boolean;
}

function looksLikeExpansionFollowUpPrompt(text: string): boolean {
	return /\b(broaden|broader|whole picture|full picture|bigger picture|more detail|more details|more information|go deeper|dig deeper|expand|elaborate|full context|fuller context|in depth|comprehensive|unpack)\b/i.test(
		text,
	);
}

export function resolveInteractiveAutonomousRunConfig(
	autonomousConfig: AutonomousExecutionConfig,
	profile: RuntimeStabilizationProfile,
): AutonomousExecutionConfig {
	const resolved: AutonomousExecutionConfig = { ...autonomousConfig };

	if (
		profile.recommendedMaxOutputPerTurn &&
		((resolved.maxOutputPerTurn ?? 0) === 0 ||
			(resolved.maxOutputPerTurn ?? 0) > profile.recommendedMaxOutputPerTurn)
	) {
		resolved.maxOutputPerTurn = profile.recommendedMaxOutputPerTurn;
	}
	if (profile.forceBehavioralPrompt) {
		resolved.enableBehavioralPrompt = true;
	}
	if (profile.forceNudges) {
		resolved.enableNudges = true;
	}
	return resolved;
}

export function buildAutonomousStabilizedUserMessage(
	userMessage: string,
	profile: RuntimeStabilizationProfile,
): string {
	if (profile.level === "none") return userMessage;
	const expansionFollowUpPrompt = looksLikeExpansionFollowUpPrompt(userMessage);

	const lines = [
		userMessage.trim(),
		"",
		"Autonomous stabilization for this run:",
		expansionFollowUpPrompt ? "- keep the answer focused and evidence-backed" : "- keep responses terse and tool-driven",
		"- do not repeat prior analysis",
		expansionFollowUpPrompt
			? "- expand from the strongest evidence already in hand before deciding whether one targeted follow-up is needed"
			: "- execute only the next smallest concrete step before reassessing",
	];
	if (profile.recommendedMaxOutputPerTurn && !expansionFollowUpPrompt) {
		lines.push(
			`- keep the next response under ${profile.recommendedMaxOutputPerTurn.toLocaleString()} output tokens unless a final verified summary is required`,
		);
	} else if (expansionFollowUpPrompt) {
		lines.push("- the user asked for more depth, so do not collapse the answer into a one-line summary");
	}
	if (profile.reasons.length > 0) {
		lines.push(`- stabilization reason: ${profile.reasons.join(" | ")}`);
	}
	return lines.join("\n");
}

export function buildInteractiveStabilizedUserMessage(
	userMessage: string,
	profile: RuntimeStabilizationProfile,
): string {
	if (profile.level === "none") return userMessage;
	const expansionFollowUpPrompt = looksLikeExpansionFollowUpPrompt(userMessage);

	const lines = [
		userMessage.trim(),
		"",
		"Runtime stabilization for this turn:",
		expansionFollowUpPrompt ? "- keep the reply focused and evidence-backed" : "- keep the reply terse and tool-driven",
		"- do not emit XML fallback or raw tool markup",
		expansionFollowUpPrompt
			? "- expand the answer from the strongest evidence already in hand before deciding whether one targeted follow-up is needed"
			: "- finish the next smallest concrete step, then stop",
	];
	if (profile.recommendedMaxOutputPerTurn && !expansionFollowUpPrompt) {
		lines.push(
			`- keep the next response under ${profile.recommendedMaxOutputPerTurn.toLocaleString()} output tokens unless a final answer is required`,
		);
	} else if (expansionFollowUpPrompt) {
		lines.push("- the user explicitly asked for more detail, so do not compress the reply into a headline-length answer");
	}
	if (profile.reasons.length > 0) {
		lines.push(`- stabilization reason: ${profile.reasons.join(" | ")}`);
	}
	return lines.join("\n");
}

export function buildPlanningUserMessage(userMessage: string, _profile: RuntimeStabilizationProfile): string {
	return userMessage.trim();
}

export function buildPlanningGuidanceMessage(profile: RuntimeStabilizationProfile): string {
	const lines = [
		"Planning mode guidance:",
		"- stay read-only: do not edit files and do not execute bash commands",
		"- inspect the codebase, session state, and available context as needed, but do not narrate that inspection",
		"- do not say that you will inspect files, list directories, or run commands",
		"- do not attempt bash commands; if bash would help, account for that in the plan instead",
		"- if critical implementation choices are missing, ask 1-3 concrete clarifying questions and stop",
		"- for greenfield or generic requests, do not invent the language, framework, platform, or library if code/context does not already decide them",
		"- for greenfield or generic requests, do not inspect files or search the web before asking the clarifying questions",
		"- if foundational choices like language, platform, runtime, framework, or library are still open, do not output a draft plan yet",
		"- never return a full draft plan plus open questions in the same planning response for a greenfield request",
		"- examples of questions worth asking first: target language, runtime/platform, UI vs terminal vs web, required libraries, deployment target",
		"- batch related questions together and ask only what the codebase cannot answer",
		"- when asking clarifying questions, use a numbered list under `Clarifying Questions`",
		"- each clarifying item must be a full question or decision label, never a bare option fragment",
		"- when choices are obvious, include them inline in brackets like `Target language [Python, TypeScript, Rust]`",
		"- do not output standalone option bullets without the question they belong to",
		"- otherwise produce a concrete execution plan immediately",
		"- structure the plan exactly with these markdown headings: Summary, Assumptions, Constraints, Steps, Risks, Verification",
		"- under Steps, use a numbered list like `1. ...`, `2. ...`, not `Step 1:` labels",
		"- if you need clarification, output only: Summary and Clarifying Questions",
		"- stop after the plan unless the user explicitly asks to execute it",
	];
	if (profile.recommendedMaxOutputPerTurn) {
		lines.push(
			`- keep the response under ${profile.recommendedMaxOutputPerTurn.toLocaleString()} output tokens unless a fuller plan is necessary`,
		);
	}
	if (profile.reasons.length > 0) {
		lines.push(`- stabilization reason: ${profile.reasons.join(" | ")}`);
	}
	return lines.join("\n");
}

export function buildPlanningSystemPromptAddendum(
	profile: RuntimeStabilizationProfile,
	hiddenPromptAddendum?: string,
): string {
	return buildTaggedPromptBundle([
		{ tag: "planning-mode-guidance", content: buildPlanningGuidanceMessage(profile) },
		{ tag: "hidden-planning-context", content: hiddenPromptAddendum },
	]);
}

export function isInteractiveAutonomousResumeRequest(
	userMessage: string,
	snapshot: AutonomousRunSnapshot,
): boolean {
	const normalizedMessage = userMessage.replace(/\s+/g, " ").trim().toLowerCase();
	const normalizedGoal = snapshot.ledger.goal.replace(/\s+/g, " ").trim().toLowerCase();
	if (!normalizedMessage) return false;
	if (normalizedMessage === normalizedGoal) return true;
	if (
		/\b(resume|continue|continuing|continued|keep going|keep working|carry on|pick up|proceed|finish|retry|recover)\b/i.test(
			userMessage,
		)
	) {
		return true;
	}
	return false;
}

export function getInteractiveAutonomousResumeSnapshot(
	userMessage: string,
	snapshot: AutonomousRunSnapshot | undefined,
): AutonomousRunSnapshot | undefined {
	if (!snapshot) return undefined;
	if (snapshot.stopReason === "complete") return undefined;
	if (!isInteractiveAutonomousResumeRequest(userMessage, snapshot)) return undefined;
	return snapshot;
}
