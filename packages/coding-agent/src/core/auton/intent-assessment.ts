import { hasAutonomousLocalReferenceContext } from "../task-intent.js";
import type { TurnAssessmentKind } from "./checkpoint-control.js";
import { type AutonomousRunLedger, hasSufficientResearchEvidence } from "./ledger.js";
import type { ToolOutcome } from "./nudges/types.js";
import { hasIncompleteContinuationSignal } from "./turn-state.js";
import {
	getVerificationFailurePreview,
	getVisualVerificationBlockingIssues,
	isIntendedVerificationOutcome,
	isMutatingOutcome,
	isVerificationOutcome,
	isVisualVerificationOutcome,
	summarizeVisualBlockingIssues,
	type VerificationCheckpointState,
} from "./verification-control.js";

const VERIFIED_SUMMARY_CHANGE_PATTERNS = [
	/\b(change[sd]?|fix(?:ed)?|update[sd]?|patch(?:ed)?|modif(?:y|ied)|preserv(?:e|ed)|implement(?:ed)?)\b/i,
	/\b(file|parser|function|module|config|banner|test)\b/i,
];
const VERIFIED_SUMMARY_VERIFICATION_PATTERNS = [
	/\b(verif(?:y|ied|ication)|test(?:s)?|passed|pass(?:ing)?|node --test|npm test|check(?:ed)?)\b/i,
];
const VERIFIED_SUMMARY_FILE_PATTERNS = [
	/`[^`\n]+\.[a-z0-9]+`/i,
	/\b(?:src|tests?|reference|docs|generated|cli)\/[^\s)`]+/i,
	/\b[a-z0-9_-]+\.(?:mjs|cjs|js|ts|tsx|jsx|json|md)\b/i,
];
const DIRECT_ANSWER_PAYLOAD_PATTERNS = [
	/`[^`\n]+`/,
	/\b(?:src|tests?|packages|scripts|docs?|reference)\/[^\s)`]+/i,
	/\bhttps?:\/\/\S+/i,
	/\b(?:defined|implemented|located|found|lives)\s+(?:in|at)\b/i,
	/\bthe\s+(?:file|directory|function|definition|path|difference|answer)\b/i,
	/\bit\s+(?:is|lives|sits)\b/i,
	/\bbecause\b/i,
];
const DIRECT_ANSWER_META_ONLY_PATTERNS = [
	/\b(i|we)\s+(?:inspected|checked|looked(?:\s+through)?|reviewed|investigated|analyzed)\b/i,
	/\bidentified\s+the\s+next\s+changes?\b/i,
	/\bnext\s+changes?\b/i,
	/\bnext\s+steps?\b/i,
	/\bready\s+for\s+the\s+next\s+step\b/i,
];
export const READ_TOOL_NAMES = new Set(["read", "read_file"]);
const RESEARCH_TOOL_NAMES = new Set(["webSearch", "webFetch"]);
const FRONTEND_TASK_PATTERNS = [
	/\b(frontend|ui|ux|layout|styling|style|css|tailwind|component|responsive|mobile|browser|page|visual|screenshot)\b/i,
	/\b(html|jsx|tsx|react|vue|svelte|next\.js|vite)\b/i,
];
const FRONTEND_FILE_PATTERNS = [/\.(css|scss|sass|less|html|tsx|jsx|vue|svelte)$/i];
const EXTERNAL_RESEARCH_PATTERNS = [
	/\b(latest|current|today|recent|release|changelog|breaking changes?)\b/i,
	/\b(research|search online|web search|search the web|look up|external source|citation|source url)\b/i,
	/\b(compare|comparison|pricing|availability|compatibility)\b/i,
];
const DOCUMENTATION_RESEARCH_PATTERNS = [/\b(documentation|docs|api reference|reference|guide|manual|spec)\b/i];
const VERIFY_ONLY_TASK_PATTERNS = [/\b(verify|verification|check|validate|review|inspect|assess|audit|confirm)\b/i];
const IMPLEMENTATION_TASK_PATTERNS = [
	/\b(fix|debug|patch|repair|migrate|improve|update|change|modify|edit|implement|build|add|create|refactor|tighten|rewrite|replace)\b/i,
];
const SELF_CONTAINED_WORKSPACE_PATTERNS = [
	/\bself-contained [a-z-]*\s*workspace\b/i,
	/\bstay inside this workspace\b/i,
];
const LOCAL_VERIFICATION_COMMAND_PATTERNS = [
	/\bverification command\b/i,
	/\bintended verification command\b/i,
	/\bnode --test\b/i,
];
const SINGLE_FILE_PRECISION_PATTERNS = [
	/\bonly the implementation file should need to change\b/i,
	/\bdo not touch generated files\b/i,
];
const SELF_CONTAINED_SUMMARY_FILE_PATTERNS = [/\bsummary\.md\b/i, /\bnotes?\b/i, /\bdocs?\b/i, /\breport\b/i];

export function sessionHasVisualVerificationTools(session: unknown): boolean {
	if (!session || typeof session !== "object") return false;
	const maybeSession = session as {
		getToolDefinition?: (name: string) => unknown;
		getActiveToolNames?: () => string[];
	};
	if (typeof maybeSession.getToolDefinition === "function") {
		return (
			maybeSession.getToolDefinition("screenshot_url") !== undefined ||
			maybeSession.getToolDefinition("interact_then_screenshot") !== undefined
		);
	}
	if (typeof maybeSession.getActiveToolNames === "function") {
		const active = new Set(maybeSession.getActiveToolNames());
		return active.has("screenshot_url") || active.has("interact_then_screenshot");
	}
	return false;
}

export function sessionHasResearchTools(session: unknown): boolean {
	if (!session || typeof session !== "object") return false;
	const maybeSession = session as {
		getToolDefinition?: (name: string) => unknown;
		getActiveToolNames?: () => string[];
	};
	if (typeof maybeSession.getToolDefinition === "function") {
		for (const toolName of RESEARCH_TOOL_NAMES) {
			if (maybeSession.getToolDefinition(toolName) !== undefined) return true;
		}
		return false;
	}
	if (typeof maybeSession.getActiveToolNames === "function") {
		const active = new Set(maybeSession.getActiveToolNames());
		for (const toolName of RESEARCH_TOOL_NAMES) {
			if (active.has(toolName)) return true;
		}
	}
	return false;
}

export function shouldUseVisualVerification(
	ledger: AutonomousRunLedger,
	visualVerificationAvailable: boolean,
	userMessage: string,
): boolean {
	if (!visualVerificationAvailable) return false;
	if (FRONTEND_TASK_PATTERNS.some((pattern) => pattern.test(userMessage))) return true;
	if (ledger.residualRisks.some((risk) => /\bbrowser|ui|layout|visual|responsive|styling\b/i.test(risk))) return true;
	if (ledger.currentFocus && /\bui|layout|browser|visual|frontend|page|responsive\b/i.test(ledger.currentFocus))
		return true;
	if (ledger.touchedFiles.some((file) => FRONTEND_FILE_PATTERNS.some((pattern) => pattern.test(file)))) return true;
	if (ledger.readFiles.some((file) => FRONTEND_FILE_PATTERNS.some((pattern) => pattern.test(file)))) return true;
	return false;
}

export function shouldUseResearch(
	ledger: AutonomousRunLedger,
	researchToolsAvailable: boolean,
	userMessage: string,
): boolean {
	if (!researchToolsAvailable) return false;
	const localReferenceContext = hasAutonomousLocalReferenceContext(userMessage);
	const externalResearchRequest = EXTERNAL_RESEARCH_PATTERNS.some((pattern) => pattern.test(userMessage));
	const documentationResearchRequest =
		DOCUMENTATION_RESEARCH_PATTERNS.some((pattern) => pattern.test(userMessage)) && !localReferenceContext;
	const implementationRequest = IMPLEMENTATION_TASK_PATTERNS.some((pattern) => pattern.test(userMessage));
	if (implementationRequest && !externalResearchRequest && !documentationResearchRequest) return false;
	if (externalResearchRequest || documentationResearchRequest) return true;
	if (ledger.research && (ledger.research.searchQueries.length > 0 || ledger.research.fetchedUrls.length > 0))
		return true;
	if (
		ledger.currentFocus &&
		/\b(docs|documentation|api|reference|research|source|latest|current)\b/i.test(ledger.currentFocus) &&
		!localReferenceContext
	) {
		return true;
	}
	if (
		ledger.residualRisks.some((risk) =>
			/\b(source|citation|documentation|api|current|latest|release)\b/i.test(risk),
		) &&
		!localReferenceContext
	) {
		return true;
	}
	return false;
}

export function extractNamedWorkspacePath(userMessage: string, prefixPattern: RegExp): string | undefined {
	for (const match of userMessage.matchAll(/`((?:\.\/)?[^`\n]+)`/g)) {
		const raw = match[1]?.trim();
		if (!raw) continue;
		const normalized = raw.replace(/^\.\//, "");
		if (prefixPattern.test(normalized)) return normalized;
	}
	for (const match of userMessage.matchAll(
		/\b((?:reference|docs?|guides?|manuals?|specs?|src|tests?|scripts)\/[^\s)`]+)/g,
	)) {
		const raw = match[1]?.trim();
		if (!raw) continue;
		if (prefixPattern.test(raw)) return raw;
	}
	return undefined;
}

export function hasReusableResearchSource(ledger: AutonomousRunLedger): boolean {
	return (ledger.research?.fetchedUrls.length ?? 0) > 0 || (ledger.research?.preferredSourceUrls.length ?? 0) > 0;
}

export function summarizeResearchFindingsForPrompt(ledger: AutonomousRunLedger): string {
	const findings = ledger.research?.recentFindings ?? [];
	if (findings.length === 0) return "";

	const factLike = findings.filter((finding) => finding.includes(": ") && !finding.includes(" — http"));
	const selected = (factLike.length > 0 ? factLike : findings).slice(0, 2);
	return selected.length > 0 ? ` Reuse saved findings such as ${selected.join(" | ")}.` : "";
}

function isVerificationOnlyTask(goal: string): boolean {
	return (
		VERIFY_ONLY_TASK_PATTERNS.some((pattern) => pattern.test(goal)) &&
		!IMPLEMENTATION_TASK_PATTERNS.some((pattern) => pattern.test(goal))
	);
}

export function hasSufficientCodingVerificationEvidence(ledger: AutonomousRunLedger, goal: string): boolean {
	if (!hasVerifiedImplementationReadyToSummarize(ledger, goal)) return false;
	const summarizeItem = ledger.taskJournal.planItems.find((item) => item.key === "summarize");
	if (summarizeItem?.status !== "active" && summarizeItem?.status !== "completed") return false;
	return true;
}

function hasVerifiedImplementationReadyToSummarize(ledger: AutonomousRunLedger, goal: string): boolean {
	if (!ledger.verificationSatisfied) return false;
	if (ledger.lastActionType !== "verification") return false;
	if (taskStillNeedsRequestedTestCoverage(ledger, goal)) return false;
	return (
		ledger.touchedFiles.length > 0 ||
		ledger.recentMutations.length > 0 ||
		ledger.verificationFailures.length > 0 ||
		isVerificationOnlyTask(goal)
	);
}

export function hasVerifiedSummaryAnswer(
	text: string,
	goal: string,
	options: { verificationSatisfied?: boolean } = {},
): boolean {
	const normalized = text.trim();
	if (normalized.length < 40) return false;
	if (hasIncompleteContinuationSignal(normalized)) return false;
	const mentionsChange = VERIFIED_SUMMARY_CHANGE_PATTERNS.some((pattern) => pattern.test(normalized));
	const mentionsVerification = VERIFIED_SUMMARY_VERIFICATION_PATTERNS.some((pattern) => pattern.test(normalized));
	if (!mentionsChange || !mentionsVerification) return false;
	const mentionsConcreteTarget = VERIFIED_SUMMARY_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
	return Boolean(options.verificationSatisfied) || isVerificationOnlyTask(goal) || mentionsConcreteTarget;
}

export function hasSufficientDirectAnswer(text: string, goal: string): boolean {
	const normalized = text.trim();
	if (normalized.length < 35) return false;
	if (IMPLEMENTATION_TASK_PATTERNS.some((pattern) => pattern.test(goal))) return false;
	if (hasIncompleteContinuationSignal(normalized)) return false;
	const hasPayload = DIRECT_ANSWER_PAYLOAD_PATTERNS.some((pattern) => pattern.test(normalized));
	if (!hasPayload) return false;
	const isMetaOnly = DIRECT_ANSWER_META_ONLY_PATTERNS.some((pattern) => pattern.test(normalized));
	if (!isMetaOnly) return true;
	return /(?:\b(?:src|tests?|packages|scripts|docs?|reference)\/[^\s)`]+|`[^`\n]+`|\bhttps?:\/\/\S+)/i.test(
		normalized,
	);
}

export function hasSufficientVisualEvidence(ledger: AutonomousRunLedger, goal: string): boolean {
	if (!ledger.verificationSatisfied) return false;
	if (ledger.lastActionType !== "verification") return false;
	if (!ledger.visualIteration?.enabled) return false;
	if (ledger.visualIteration.phase !== "verified") return false;
	if (ledger.visualAssessment?.latestJudgment !== "pass") return false;
	return ledger.touchedFiles.length > 0 || ledger.recentMutations.length > 0 || isVerificationOnlyTask(goal);
}

export function shouldBypassStopNudgeForVerifiedSummary(options: {
	ledger: AutonomousRunLedger;
	userMessage: string;
	visualVerificationRelevant: boolean;
	researchRelevant: boolean;
}): boolean {
	const summarizeReady =
		options.ledger.taskJournal.planItems.find((item) => item.key === "summarize")?.status === "active";
	if (!summarizeReady) return false;
	if (options.visualVerificationRelevant) {
		return hasSufficientVisualEvidence(options.ledger, options.userMessage);
	}
	if (options.researchRelevant && isResearchOnlyLedger(options.ledger)) {
		return hasSufficientResearchEvidence(options.ledger.research);
	}
	return hasVerifiedImplementationReadyToSummarize(options.ledger, options.userMessage);
}

function plannedStepPrefersConcreteMutation(plannedStep: string): boolean {
	return (
		plannedStep.includes("execute only that slice") ||
		plannedStep.includes("make the next concrete code change") ||
		plannedStep.includes("execute it immediately") ||
		plannedStep.includes("finish the current slice without exploring new scope")
	);
}

export function isSelfContainedWorkspaceTask(userMessage: string): boolean {
	const implementationRequest = IMPLEMENTATION_TASK_PATTERNS.some((pattern) => pattern.test(userMessage));
	return (
		implementationRequest &&
		SELF_CONTAINED_WORKSPACE_PATTERNS.some((pattern) => pattern.test(userMessage)) &&
		LOCAL_VERIFICATION_COMMAND_PATTERNS.some((pattern) => pattern.test(userMessage))
	);
}

export function isSingleFilePrecisionTask(userMessage: string): boolean {
	return (
		isSelfContainedWorkspaceTask(userMessage) &&
		SINGLE_FILE_PRECISION_PATTERNS.every((pattern) => pattern.test(userMessage))
	);
}

export function requiresTestUpdate(userMessage: string): boolean {
	return /\b(add|update)\b[\s\S]{0,80}\b(regression\s+test|test)\b/i.test(userMessage);
}

export function taskNeedsInitialTestUpdate(ledger: AutonomousRunLedger, userMessage: string): boolean {
	if (!requiresTestUpdate(userMessage)) return false;
	return ledger.touchedFiles.length > 0 && !ledger.touchedFiles.some((file) => /^tests?\//i.test(file));
}

function taskStillNeedsRequestedTestCoverage(ledger: AutonomousRunLedger, userMessage: string): boolean {
	return (
		taskNeedsInitialTestUpdate(ledger, userMessage) ||
		getRequestedTestCoverageRepair(ledger, userMessage) !== undefined
	);
}

export function mentionsMisleadingSiblingWarning(userMessage: string): boolean {
	return /\b(misleading|similarly named)\b/i.test(userMessage);
}

export function extractLocalVerificationCommand(userMessage: string): string | undefined {
	const fencedMatch = userMessage.match(/intended verification command is:\s*`([^`]+)`/i);
	if (fencedMatch?.[1]) return fencedMatch[1].trim();
	// "The verification command is: `cmd ..."` — the plain variant must strip
	// surrounding backticks too, or every downstream verbatim comparison fails
	// and the intent assessor drift-stops runs that verified exactly as asked.
	const plainMatch = userMessage.match(/verification command is:\s*([^\n]+)/i);
	if (plainMatch?.[1])
		return plainMatch[1]
			.trim()
			.replace(/^`+|`+$/g, "")
			.trim();
	return undefined;
}

export function extractWorkspaceVerifierScriptPath(localVerificationCommand: string | undefined): string | undefined {
	if (!localVerificationCommand) return undefined;
	const match = localVerificationCommand.match(/\b(scripts\/[^\s&;|`]+)/i);
	return match?.[1];
}

export function getLatestReadWorkspaceFile(ledger: AutonomousRunLedger, prefixPattern: RegExp): string | undefined {
	for (let i = ledger.readFiles.length - 1; i >= 0; i--) {
		const candidate = ledger.readFiles[i];
		if (prefixPattern.test(candidate)) return candidate;
	}
	return undefined;
}

function getLatestTouchedWorkspaceFile(ledger: AutonomousRunLedger, prefixPattern: RegExp): string | undefined {
	for (let i = ledger.touchedFiles.length - 1; i >= 0; i--) {
		const candidate = ledger.touchedFiles[i];
		if (prefixPattern.test(candidate)) return candidate;
	}
	return undefined;
}

export function getLatestKnownWorkspaceFile(ledger: AutonomousRunLedger, prefixPattern: RegExp): string | undefined {
	if (ledger.discoveryTargetFile && prefixPattern.test(ledger.discoveryTargetFile)) {
		return ledger.discoveryTargetFile;
	}
	const discoveredFiles = ledger.discoveredFiles ?? [];
	for (let i = discoveredFiles.length - 1; i >= 0; i--) {
		const candidate = discoveredFiles[i];
		if (prefixPattern.test(candidate)) return candidate;
	}
	return getLatestTouchedWorkspaceFile(ledger, prefixPattern) ?? getLatestReadWorkspaceFile(ledger, prefixPattern);
}

export function getCommittedReferenceSourceFile(ledger: AutonomousRunLedger): string | undefined {
	const readFiles = ledger.readFiles ?? [];
	const firstReferenceIndex = readFiles.findIndex((file) => /^reference\//i.test(file));
	if (firstReferenceIndex < 0) return undefined;
	for (let i = firstReferenceIndex + 1; i < readFiles.length; i++) {
		const candidate = readFiles[i];
		if (/^src\//i.test(candidate)) return candidate;
	}
	return undefined;
}

export function getFailedRepairTargetFile(ledger: AutonomousRunLedger): string | undefined {
	const candidates = [
		ledger.taskJournal.activeSubtask,
		ledger.currentFocus,
		ledger.taskJournal.nextAction,
		ledger.taskJournal.plannedNextStep,
	];
	for (const candidate of candidates) {
		if (!candidate || !/failed change|valid edit on the same target/i.test(candidate)) continue;
		const match = candidate.match(/\b((?:src|tests?|scripts|reference|cli|generated)\/[^\s`:)]+)/i);
		if (match?.[1]) return match[1];
	}
	return undefined;
}

export function getWorkspaceFilesByPrefix(files: string[], prefixPattern: RegExp): string[] {
	const seen = new Set<string>();
	const matches: string[] = [];
	for (const file of files) {
		if (!prefixPattern.test(file) || seen.has(file)) continue;
		seen.add(file);
		matches.push(file);
	}
	return matches;
}

function extractLatestVerificationFailureCue(ledger: AutonomousRunLedger): string | undefined {
	const latestFailure = ledger.verificationFailures[ledger.verificationFailures.length - 1];
	if (!latestFailure) return undefined;
	const withoutPrefix = latestFailure.replace(/^failed verification:\s*/i, "").trim();
	if (withoutPrefix.length === 0) return undefined;
	const parts = withoutPrefix.split(/\s+—\s+/);
	const candidate = (parts.at(-1) ?? withoutPrefix).trim();
	return candidate.length > 0 ? candidate : undefined;
}

export function getRequestedTestCoverageRepair(
	ledger: AutonomousRunLedger,
	userMessage: string,
): { blocker: string; testFile: string; sourceFile?: string } | undefined {
	if (!requiresTestUpdate(userMessage)) return undefined;
	const failureCue = extractLatestVerificationFailureCue(ledger);
	if (!failureCue) return undefined;
	if (
		!/\b(missing|expected|required|needs?)\b[\s\S]{0,80}\b(regression\s+test|test|coverage|case|assert(?:ion)?|snapshot|fixture)\b/i.test(
			failureCue,
		)
	) {
		return undefined;
	}
	const testFile = getLatestKnownWorkspaceFile(ledger, /^tests?\//i);
	if (!testFile) return undefined;
	return {
		blocker: failureCue,
		testFile,
		sourceFile: getLatestKnownWorkspaceFile(ledger, /^src\//i),
	};
}

export function getSelfContainedSummaryResponseRule(userMessage: string): string {
	if (!isSelfContainedWorkspaceTask(userMessage)) return "";
	if (SELF_CONTAINED_SUMMARY_FILE_PATTERNS.some((pattern) => pattern.test(userMessage))) return "";
	return " Return the short final summary as visible assistant text, not only in thinking/reasoning. Do not create or edit SUMMARY.md, notes, docs, markdown reports, or any other workspace file unless the task explicitly asks for a file change.";
}

export function assessTurnIntent(options: {
	plannedLedger: AutonomousRunLedger;
	turnToolHistory: ToolOutcome[];
	turnFileAccessHistory: ToolOutcome[];
	assessment: TurnAssessmentKind;
	verificationState: VerificationCheckpointState;
	lastAssistantText: string;
	localVerificationCommand?: string;
}): { outcome: "on_track" | "drifted" | "failed"; detail: string } {
	const verifyItem = options.plannedLedger.taskJournal.planItems.find((item) => item.key === "verify");
	const implementItem = options.plannedLedger.taskJournal.planItems.find((item) => item.key === "implement");
	const summarizeItem = options.plannedLedger.taskJournal.planItems.find((item) => item.key === "summarize");
	const inspectItem = options.plannedLedger.taskJournal.planItems.find((item) => item.key === "inspect");
	const plannedStep = options.plannedLedger.taskJournal.plannedNextStep?.toLowerCase() ?? "";
	const verificationAttempt = options.turnToolHistory.find(
		(outcome) =>
			isVerificationOutcome(outcome) || isIntendedVerificationOutcome(outcome, options.localVerificationCommand),
	);
	const visualVerificationAttempt = options.turnToolHistory.find(
		(outcome) => isVisualVerificationOutcome(outcome) && outcome.success,
	);
	const webSearchAttempt = options.turnToolHistory.find((outcome) => outcome.tool.toLowerCase() === "websearch");
	const webFetchAttempt = options.turnToolHistory.find((outcome) => outcome.tool.toLowerCase() === "webfetch");
	const mutation = options.turnToolHistory.find((outcome) => isMutatingOutcome(outcome) && outcome.success);
	const failedMutation = options.turnToolHistory.find((outcome) => isMutatingOutcome(outcome) && !outcome.success);
	const inspection = options.turnFileAccessHistory.find(
		(outcome) => READ_TOOL_NAMES.has(outcome.tool.toLowerCase()) && outcome.success,
	);
	const visualPhase = options.plannedLedger.visualIteration?.phase;
	const selfContainedWorkspaceTask = isSelfContainedWorkspaceTask(options.plannedLedger.goal);
	const hasReadTestFile = options.plannedLedger.readFiles.some((file) => /^tests?\//i.test(file));
	const readSourceFileCount = getWorkspaceFilesByPrefix(options.plannedLedger.readFiles, /^src\//i).length;

	if (visualPhase === "baseline_capture") {
		if (visualVerificationAttempt) {
			return {
				outcome: "on_track",
				detail: `baseline visual capture matched intent: ${visualVerificationAttempt.detail ?? visualVerificationAttempt.file ?? visualVerificationAttempt.tool}`,
			};
		}
		if (mutation) {
			return {
				outcome: "drifted",
				detail: "expected a baseline visual capture before further UI changes",
			};
		}
	}
	if (visualPhase === "recapture") {
		if (visualVerificationAttempt) {
			const issues = getVisualVerificationBlockingIssues(visualVerificationAttempt);
			if (issues.length > 0) {
				return {
					outcome: "failed",
					detail: `visual verification found blocking issues: ${summarizeVisualBlockingIssues(issues)}`,
				};
			}
			return {
				outcome: "on_track",
				detail: `visual recapture matched intent: ${visualVerificationAttempt.detail ?? visualVerificationAttempt.file ?? visualVerificationAttempt.tool}`,
			};
		}
	}

	if (verificationAttempt) {
		if (verificationAttempt.success && isVisualVerificationOutcome(verificationAttempt)) {
			const issues = getVisualVerificationBlockingIssues(verificationAttempt);
			if (issues.length > 0) {
				return {
					outcome: "failed",
					detail: `visual verification found blocking issues: ${summarizeVisualBlockingIssues(issues)}`,
				};
			}
		}
		if (verificationAttempt.success) {
			return {
				outcome: "on_track",
				detail: `verification matched intent: ${verificationAttempt.detail ?? verificationAttempt.file ?? verificationAttempt.tool}`,
			};
		}
		const verificationFailurePreview = getVerificationFailurePreview(verificationAttempt);
		return {
			outcome: "failed",
			detail: verificationFailurePreview
				? `verification failed: ${verificationFailurePreview}`
				: `verification failed: ${verificationAttempt.detail ?? verificationAttempt.file ?? verificationAttempt.tool}`,
		};
	}
	if (verifyItem?.status === "blocked") {
		return {
			outcome: "failed",
			detail: options.plannedLedger.taskJournal.blockedReasons[0] ?? "verification blocker was not resolved",
		};
	}
	if (verifyItem?.status === "active") {
		return {
			outcome: "drifted",
			detail: "expected verification work, but the turn did not run a verification step",
		};
	}
	if (plannedStep.includes("websearch")) {
		if (webSearchAttempt?.success) {
			return {
				outcome: "on_track",
				detail: `research search matched intent: ${webSearchAttempt.detail ?? webSearchAttempt.file ?? webSearchAttempt.tool}`,
			};
		}
		if (webFetchAttempt?.success) {
			return {
				outcome: "drifted",
				detail: "expected a webSearch step before fetching a source",
			};
		}
		if (webSearchAttempt && !webSearchAttempt.success) {
			return {
				outcome: "failed",
				detail: `research search failed: ${webSearchAttempt.detail ?? webSearchAttempt.file ?? webSearchAttempt.tool}`,
			};
		}
	}
	if (plannedStep.includes("webfetch")) {
		if (webFetchAttempt?.success) {
			return {
				outcome: "on_track",
				detail: `research fetch matched intent: ${webFetchAttempt.detail ?? webFetchAttempt.file ?? webFetchAttempt.tool}`,
			};
		}
		if (webFetchAttempt && !webFetchAttempt.success) {
			return {
				outcome: "failed",
				detail: `research fetch failed: ${webFetchAttempt.detail ?? webFetchAttempt.file ?? webFetchAttempt.tool}`,
			};
		}
		if (webSearchAttempt?.success) {
			return {
				outcome: "drifted",
				detail: "expected a webFetch step to read the chosen source",
			};
		}
	}
	if (
		hasReusableResearchSource(options.plannedLedger) &&
		!plannedStep.includes("websearch") &&
		!plannedStep.includes("webfetch") &&
		(webSearchAttempt?.success || webFetchAttempt?.success)
	) {
		return {
			outcome: "drifted",
			detail: "expected reuse of an existing authoritative source instead of another web research step",
		};
	}
	if (mutation) {
		return {
			outcome:
				implementItem?.status === "active" ||
				implementItem?.status === "completed" ||
				plannedStepPrefersConcreteMutation(plannedStep)
					? "on_track"
					: "drifted",
			detail: `mutation matched intent: ${mutation.detail ?? mutation.file ?? mutation.tool}`,
		};
	}
	if (failedMutation) {
		return {
			outcome: "failed",
			detail: `edit failed: ${failedMutation.detail ?? failedMutation.file ?? failedMutation.tool}`,
		};
	}
	if (inspection) {
		if (
			selfContainedWorkspaceTask &&
			implementItem?.status === "active" &&
			options.plannedLedger.recentMutations.length === 0 &&
			hasReadTestFile &&
			readSourceFileCount > 0
		) {
			return {
				outcome: "drifted",
				detail: `expected a concrete edit after local test+src inspection, but got another inspection: ${inspection.detail ?? inspection.file ?? inspection.tool}`,
			};
		}
		return {
			outcome: inspectItem?.status === "active" || implementItem?.status === "active" ? "on_track" : "drifted",
			detail: `inspection matched intent: ${inspection.detail ?? inspection.file ?? inspection.tool}`,
		};
	}
	if (
		options.assessment === "complete" &&
		(summarizeItem?.status === "active" || options.verificationState.hasVerificationCheckpoint)
	) {
		return {
			outcome: "on_track",
			detail: "completion matched the planned summarize step",
		};
	}
	if (
		hasVerifiedSummaryAnswer(options.lastAssistantText, options.plannedLedger.goal, {
			verificationSatisfied: options.verificationState.hasVerificationCheckpoint,
		})
	) {
		return {
			outcome: "on_track",
			detail: "verified summary matched the intended completion step",
		};
	}
	if (
		options.assessment === "complete" &&
		plannedStep.includes("summarize the source-backed answer") &&
		hasSufficientResearchEvidence(options.plannedLedger.research)
	) {
		return {
			outcome: "on_track",
			detail: "completion matched the planned source-backed summarize step",
		};
	}
	return {
		outcome: "drifted",
		detail: options.plannedLedger.taskJournal.plannedNextStep
			? `turn drifted from intent: ${options.plannedLedger.taskJournal.plannedNextStep}`
			: "turn drifted from the expected next step",
	};
}

export function isResearchOnlyLedger(ledger: AutonomousRunLedger): boolean {
	return ledger.touchedFiles.length === 0 && ledger.recentMutations.length === 0;
}
