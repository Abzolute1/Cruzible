import { DELEGATION_TOOL_NAMES } from "../delegation-evidence.js";
import type { ToolOutcome } from "./nudges/types.js";

const LAUNDERED_VERIFICATION_PATTERNS = [/\|\|\s*(true|:|exit\s+0|echo\b)/i, /;\s*(true|:)\s*$/i, /\|\|\s*true\b/i];

/**
 * Laundering guard: a command whose shell wrapper swallows failure
 * (`cmd || true`, `cmd; true`, `cmd || echo ok`, ...) has an untrustworthy
 * exit code, so it can never count as a verification outcome.
 */
export function isLaunderedVerificationCommand(command: string): boolean {
	return LAUNDERED_VERIFICATION_PATTERNS.some((pattern) => pattern.test(command));
}

/** Extract a verify_ui verdict: details.verdict first, then leading PASS/FAIL/UNCLEAR text. */
export function getVerifyUiVerdict(outcome: ToolOutcome): string | undefined {
	const metadata = outcome.metadata;
	const verdict = metadata && typeof metadata.verdict === "string" ? metadata.verdict.trim() : "";
	if (verdict) return verdict.toUpperCase();
	const candidates = [
		typeof metadata?.outputPreview === "string" ? metadata.outputPreview : undefined,
		outcome.detail,
	];
	for (const candidate of candidates) {
		const match = candidate?.match(/^\s*(PASS|FAIL|UNCLEAR|UNVERIFIABLE)\b/i);
		if (match) return match[1].toUpperCase();
	}
	return undefined;
}

const VERIFICATION_COMMAND_PATTERNS = [
	/(?:^|[;&]\s*)node\b[^\n;&|]*\b(?:--test|test|check|verify|lint|build)\b/i,
	/(?:^|[;&]\s*)(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|lint|typecheck|build|check)|lint|typecheck|build|check)\b/i,
	/(?:^|[;&]\s*)npx\s+(?:vitest|jest|playwright|eslint|tsc)\b/i,
	/(?:^|[;&]\s*)(?:vitest|jest|pytest|cargo test|go test|playwright test|eslint|tsc|make\s+(?:test|lint|build|check))\b/i,
];
const MUTATING_TOOL_NAMES = new Set(["edit", "write", "str_replace_editor", "notebook_edit"]);
const VERIFICATION_TOOL_NAMES = new Set(["verify"]);
const VISUAL_VERIFICATION_TOOL_NAMES = new Set(["screenshot_url", "interact_then_screenshot", "verify_ui"]);

export interface VerificationCheckpointState {
	hasVerificationCheckpoint: boolean;
	lastVerificationDetail?: string;
	visualFailureDetail?: string;
	visualBlockingIssues: string[];
}

export function getVerificationCheckpointState(
	toolHistory: ToolOutcome[],
	visualVerificationRelevant = false,
	localVerificationCommand?: string,
): VerificationCheckpointState {
	let lastMutationIndex = -1;
	let lastVerificationIndex = -1;
	let lastVerificationDetail: string | undefined;
	let lastVisualVerificationIndex = -1;
	let lastVisualVerificationDetail: string | undefined;
	let lastVisualBlockingIssues: string[] = [];

	for (let i = 0; i < toolHistory.length; i++) {
		const outcome = toolHistory[i];
		if (!outcome.success) continue;
		if (isMutatingOutcome(outcome)) {
			lastMutationIndex = i;
			continue;
		}
		if (isVerificationOutcome(outcome) || isIntendedVerificationOutcome(outcome, localVerificationCommand)) {
			// verify_ui reports a verdict: only PASS satisfies a checkpoint, and a
			// FAIL verdict is an explicit verification failure, not a success.
			if (outcome.tool.toLowerCase() === "verify_ui") {
				const verdict = getVerifyUiVerdict(outcome);
				if (verdict !== "PASS") {
					if (verdict === "FAIL") {
						lastVisualVerificationIndex = i;
						lastVisualVerificationDetail = outcome.detail;
						lastVisualBlockingIssues = [outcome.detail ?? "verify_ui reported FAIL"];
					}
					continue;
				}
			}
			lastVerificationIndex = i;
			lastVerificationDetail = outcome.detail;
			if (isVisualVerificationOutcome(outcome)) {
				lastVisualVerificationIndex = i;
				lastVisualVerificationDetail = outcome.detail;
				lastVisualBlockingIssues = getVisualVerificationBlockingIssues(outcome);
			}
		}
	}

	const hasVerificationAfterMutation = lastVerificationIndex > lastMutationIndex;
	if (visualVerificationRelevant) {
		const hasVisualVerificationAfterMutation = lastVisualVerificationIndex > lastMutationIndex;
		return {
			hasVerificationCheckpoint: hasVisualVerificationAfterMutation && lastVisualBlockingIssues.length === 0,
			lastVerificationDetail: lastVisualVerificationDetail ?? lastVerificationDetail,
			visualFailureDetail:
				hasVisualVerificationAfterMutation && lastVisualBlockingIssues.length > 0
					? summarizeVisualBlockingIssues(lastVisualBlockingIssues)
					: undefined,
			visualBlockingIssues: hasVisualVerificationAfterMutation ? lastVisualBlockingIssues : [],
		};
	}

	return {
		hasVerificationCheckpoint: hasVerificationAfterMutation,
		lastVerificationDetail,
		visualFailureDetail: undefined,
		visualBlockingIssues: [],
	};
}

export function isMutatingOutcome(outcome: ToolOutcome): boolean {
	if (MUTATING_TOOL_NAMES.has(outcome.tool.toLowerCase())) return true;
	// A delegation subagent mutates below the boundary; its file evidence is real.
	if (DELEGATION_TOOL_NAMES.has(outcome.tool.toLowerCase())) {
		return getTaskEvidence(outcome)?.some((entry) => entry.kind === "file") === true;
	}
	return false;
}

interface TaskEvidenceEntry {
	kind?: string;
	command?: string;
	exitCode?: number | null;
	action?: string;
	path?: string;
}

function getTaskEvidence(outcome: ToolOutcome): TaskEvidenceEntry[] | undefined {
	const metadata = outcome.metadata;
	if (!metadata || typeof metadata !== "object") return undefined;
	const evidence = (metadata as { evidence?: unknown }).evidence;
	return Array.isArray(evidence) ? (evidence as TaskEvidenceEntry[]) : undefined;
}

export function isVerificationOutcome(outcome: ToolOutcome): boolean {
	const toolName = outcome.tool.toLowerCase();
	if (VERIFICATION_TOOL_NAMES.has(toolName)) return true;
	if (VISUAL_VERIFICATION_TOOL_NAMES.has(toolName)) return true;
	if (toolName === "task") {
		// Verification honesty: a verify task counts only when it completed with a
		// real recorded bash execution that passes the same reliability check as
		// parent-run bash — structured evidence, not prose.
		const metadata = outcome.metadata as { type?: unknown; state?: unknown } | undefined;
		if (metadata?.type !== "verify" || metadata?.state !== "completed") return false;
		return (getTaskEvidence(outcome) ?? []).some(
			(entry) =>
				entry.kind === "bash" &&
				entry.exitCode === 0 &&
				typeof entry.command === "string" &&
				isReliableVerificationBashCommand(entry.command),
		);
	}
	const detail = outcome.detail;
	if (toolName === "bash" && typeof detail === "string") {
		return isReliableVerificationBashCommand(detail);
	}
	return false;
}

/**
 * Match a bash outcome against the task's declared intended verification
 * command. Tasks can legitimately verify by *running the program* (e.g.
 * `node src/export.mjs`) instead of a recognizable test/build tool — and the
 * harness itself nudges the agent to run that exact command verbatim, so
 * refusing to count it punishes the agent for following instructions (seen in
 * practice: 4 consecutive "did not run a verification step" drifts while the
 * agent ran the intended command on every turn). Honesty guards still apply:
 * laundered or output-truncated variants prove nothing, and the command must
 * appear as a full segment — appended args or a different script do not count.
 */
export function isIntendedVerificationOutcome(
	outcome: ToolOutcome,
	localVerificationCommand: string | undefined,
): boolean {
	if (!localVerificationCommand) return false;
	if (outcome.tool.toLowerCase() !== "bash" || typeof outcome.detail !== "string") return false;
	const command = localVerificationCommand.replace(/\s+/g, " ").trim();
	const detail = outcome.detail.replace(/\s+/g, " ").trim();
	if (!command || !detail) return false;
	if (/\|\s*(head|tail)\b/i.test(detail) && !/\bset\s+-o\s+pipefail\b/i.test(detail)) return false;
	if (isLaunderedVerificationCommand(detail)) return false;
	if (detail === command) return true;
	const detailSegments = detail.split(/&&|;/).map((segment) => segment.trim());
	if (detailSegments.some((segment) => segment === command)) return true;
	// The declared command is often a CHAIN (`bash build.sh && grep -q OK
	// dist/output.txt`); agents legitimately run it as separate calls. Running
	// one exact segment of the declared chain is verification work — otherwise
	// the intent assessor drift-stops a run that verified in pieces (seen in
	// the v4 suite: work done, chain split across two bash calls, 4 false
	// "did not run a verification step" drifts, killed with exit 1).
	const commandSegments = command.split(/&&|;/).map((segment) => segment.trim());
	if (commandSegments.length > 1) {
		return detailSegments.some((segment) => commandSegments.includes(segment));
	}
	return false;
}

export function isReliableVerificationBashCommand(detail: string): boolean {
	const normalized = detail.replace(/\s+/g, " ").trim();
	if (!normalized) return false;
	if (/\|\s*(head|tail)\b/i.test(normalized) && !/\bset\s+-o\s+pipefail\b/i.test(normalized)) {
		return false;
	}
	// Exit-code laundering: `cmd || true` always exits 0, so it proves nothing.
	if (isLaunderedVerificationCommand(normalized)) {
		return false;
	}
	return VERIFICATION_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isVisualVerificationOutcome(outcome: ToolOutcome): boolean {
	return VISUAL_VERIFICATION_TOOL_NAMES.has(outcome.tool.toLowerCase());
}

export function getVisualVerificationBlockingIssues(outcome: ToolOutcome): string[] {
	const metadata = outcome.metadata;
	if (!metadata || typeof metadata !== "object") return [];
	const issues: string[] = [];
	if (typeof metadata.error === "string" && metadata.error.trim().length > 0) {
		issues.push(`capture error: ${metadata.error.trim()}`);
	}
	if (Array.isArray(metadata.consoleErrors) && metadata.consoleErrors.length > 0) {
		const first = metadata.consoleErrors.find(
			(value): value is string => typeof value === "string" && value.trim().length > 0,
		);
		if (first) issues.push(`console errors: ${first.trim()}`);
	}
	if (Array.isArray(metadata.failedRequests) && metadata.failedRequests.length > 0) {
		const first = metadata.failedRequests.find(
			(value): value is string => typeof value === "string" && value.trim().length > 0,
		);
		if (first) issues.push(`failed requests: ${first.trim()}`);
	}
	return issues;
}

export function getVerificationFailurePreview(outcome: ToolOutcome): string | undefined {
	const detail = outcome.detail?.trim();
	const metadata = outcome.metadata;
	const previewCandidates = [
		typeof metadata?.outputPreview === "string" ? metadata.outputPreview : undefined,
		typeof metadata?.summary === "string" ? metadata.summary : undefined,
		typeof metadata?.error === "string" ? metadata.error : undefined,
	];
	for (const candidate of previewCandidates) {
		const normalized = candidate?.trim();
		if (!normalized) continue;
		if (detail && normalized.toLowerCase() === detail.toLowerCase()) continue;
		return normalized.length <= 180 ? normalized : `${normalized.slice(0, 177)}...`;
	}
	return undefined;
}

export function summarizeVisualBlockingIssues(issues: string[]): string {
	return issues.join("; ");
}
