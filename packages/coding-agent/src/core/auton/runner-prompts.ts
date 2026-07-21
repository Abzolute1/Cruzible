import {
	hasAutonomousLocalReferenceContext,
	looksLikeAutonomousImplementationTask,
	looksLikeAutonomousLocalAnswerTask,
	looksLikeAutonomousPathLookupTask,
	looksLikeAutonomousResearchTask,
	looksLikeAutonomousVerifyOnlyTask,
} from "../task-intent.js";
import {
	type AutonomousRunLedger,
	type AutonomousRunSnapshot,
	formatAutonomousContinuationLedger,
	formatAutonomousPromptLedger,
} from "./ledger.js";

const EXTERNAL_RESEARCH_PATTERNS = [
	/\b(latest|current|today|recent|release|changelog|breaking changes?)\b/i,
	/\b(research|search online|web search|search the web|look up|external source|citation|source url)\b/i,
	/\b(compare|comparison|pricing|availability|compatibility)\b/i,
];
const DOCUMENTATION_RESEARCH_PATTERNS = [/\b(documentation|docs|api reference|reference|guide|manual|spec)\b/i];
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

export function appendLedgerContext(
	prompt: string,
	ledger: AutonomousRunLedger,
	mode: "continuation" | "full" = "continuation",
): string {
	return `${prompt}\n\n${mode === "full" ? formatAutonomousPromptLedger(ledger) : formatAutonomousContinuationLedger(ledger)}`;
}

export function buildInitialAutonomousPrompt(userMessage: string, researchToolsAvailable: boolean): string {
	if (isSelfContainedWorkspaceTask(userMessage)) {
		const misleadingSiblingGuidance = mentionsMisleadingSiblingWarning(userMessage)
			? " Treat similarly named files as traps: before editing, confirm the real implementation path from the failing test, caller, import path, or reference output. Do not patch a sibling file just because the filename stem matches."
			: "";
		const namedReferencePath = extractNamedWorkspacePath(
			userMessage,
			/^(?:reference|docs?|guides?|manuals?|specs?)\//i,
		);
		const namedReferenceGuidance = namedReferencePath
			? ` The task already names the local reference \`${namedReferencePath}\`; read that exact file before any directory listing or other discovery. Then read the single most likely implementation file under \`src/\` directly. If the file stem is plausible but the exact extension is unknown, list the directory once and read the concrete file you find instead of guessing \`.js\`/\`.mjs\` or using globs.`
			: "";
		const singleFilePrecisionGuidance = isSingleFilePrecisionTask(userMessage)
			? " This is a single-file precision patch. Start by reading the relevant test under `tests/` and the likely implementation file under `src/`. Do not guess wildcard or glob paths like `tests/*.test.js`; if the exact filename is unknown, list the directory once and then read the concrete file you found. Do not inspect `generated/`, `reference/`, `cli/`, or sibling directories unless the test or verifier explicitly points there. Do not call `ls` more than once before the first read, and do not turn the top-level listing into more subdirectory `ls` calls. Once the correct `src/...` file is confirmed, patch only that file."
			: "";
		return `${userMessage}\n\nThis is a self-contained local patch/debug task. Stay inside the workspace and do not use webSearch/webFetch. Treat \`.\` as the workspace root and use relative workspace paths like \`src/...\`, \`tests/...\`, \`reference/...\`, or \`scripts/...\`; do not jump to /home/alex/AG1 or any repo root outside the fixture. After at most one top-level listing, stop shell-style file hunting. If you choose to list once, do it once only, and make your very next tool call a direct \`read\` of one relevant file instead of more \`ls\`. Do not list subdirectories like \`src/\`, \`tests/\`, \`test/\`, \`cli/\`, or \`reference/\` before that first read. Do not grep for descriptive phrases or use bash/find loops to rediscover obvious local files. Prefer one direct read of the most likely implementation file, relevant test, named reference, or verifier script under src/, tests?/, reference/, or scripts/.${namedReferenceGuidance}${misleadingSiblingGuidance}${singleFilePrecisionGuidance} Once the target file is clear, emit one concrete edit immediately instead of narrating the patch.${getExactVerificationOnceRule(extractLocalVerificationCommand(userMessage), userMessage)} Then give a short summary and stop.${getSelfContainedSummaryResponseRule(userMessage)}`;
	}
	if (looksLikeAutonomousVerifyOnlyTask(userMessage)) {
		return `${userMessage}\n\nThis is a local inspection or review task. Do not edit files unless the user explicitly asks for a fix. Start with one directly relevant file, test, or verifier artifact, gather concrete findings, then answer with those findings and stop.`;
	}
	if (looksLikeAutonomousLocalAnswerTask(userMessage)) {
		const answerFirstHint = looksLikeAutonomousPathLookupTask(userMessage)
			? " If the user only asked for the location or exact path, answer as soon as one decisive hit identifies it."
			: "";
		return `${userMessage}\n\nThis is an answer-only local workspace task. Stay in local tools and avoid web research. Externalize one focused discovery or read step first, then answer directly once the evidence is decisive.${answerFirstHint} Do not widen into implementation or extra verification unless the prompt explicitly requires changes.`;
	}
	if (!researchToolsAvailable) return userMessage;
	const localReferenceContext = hasAutonomousLocalReferenceContext(userMessage);
	const externalResearchRequest =
		EXTERNAL_RESEARCH_PATTERNS.some((pattern) => pattern.test(userMessage)) ||
		(!localReferenceContext && looksLikeAutonomousResearchTask(userMessage));
	const documentationResearchRequest =
		DOCUMENTATION_RESEARCH_PATTERNS.some((pattern) => pattern.test(userMessage)) && !localReferenceContext;
	const implementationRequest = looksLikeAutonomousImplementationTask(userMessage);
	if (implementationRequest && !externalResearchRequest && !documentationResearchRequest) return userMessage;
	if (!externalResearchRequest && !documentationResearchRequest) return userMessage;
	return `${userMessage}\n\nIf this requires current or external information, use webSearch first, then webFetch the most relevant URL, and keep the source URLs available in your notes.`;
}

export function buildResumeAutonomousPrompt(
	userMessage: string,
	researchToolsAvailable: boolean,
	resumeSnapshot: AutonomousRunSnapshot,
): string {
	const basePrompt = buildInitialAutonomousPrompt(userMessage, researchToolsAvailable);
	const ledger = resumeSnapshot.ledger;
	const resumeInstruction =
		ledger.resume?.resumeInstruction ??
		ledger.taskJournal.plannedNextStep ??
		ledger.taskJournal.nextAction ??
		"Continue with the next concrete step.";
	const resumeReason =
		ledger.resume?.resumeReason ??
		ledger.taskJournal.stepRationale ??
		"Resume from the saved autonomous state instead of restarting from scratch.";
	const checkpoint = ledger.resume?.lastStableCheckpoint
		? `Last stable checkpoint: ${ledger.resume.lastStableCheckpoint}`
		: "Last stable checkpoint: none recorded yet";
	const resumeMode = ledger.resume?.mode ? `Resume mode: ${ledger.resume.mode}` : undefined;
	const lines = [
		"Resume the interrupted autonomous run from the saved control state.",
		`Original goal: ${ledger.goal}`,
		`Continuation request: ${basePrompt.trim()}`,
		...(resumeMode ? [resumeMode] : []),
		`Resume instruction: ${resumeInstruction}`,
		`Resume reason: ${resumeReason}`,
		checkpoint,
		"Do not restart from scratch or repeat already completed research or verification unless the saved state says it is still required.",
	];
	return appendLedgerContext(lines.join("\n"), ledger, "full");
}

function isSelfContainedWorkspaceTask(userMessage: string): boolean {
	const implementationRequest = IMPLEMENTATION_TASK_PATTERNS.some((pattern) => pattern.test(userMessage));
	return (
		implementationRequest &&
		SELF_CONTAINED_WORKSPACE_PATTERNS.some((pattern) => pattern.test(userMessage)) &&
		LOCAL_VERIFICATION_COMMAND_PATTERNS.some((pattern) => pattern.test(userMessage))
	);
}

function isSingleFilePrecisionTask(userMessage: string): boolean {
	return (
		isSelfContainedWorkspaceTask(userMessage) &&
		SINGLE_FILE_PRECISION_PATTERNS.every((pattern) => pattern.test(userMessage))
	);
}

function requiresTestUpdate(userMessage: string): boolean {
	return /\b(add|update)\b[\s\S]{0,80}\b(regression\s+test|test)\b/i.test(userMessage);
}

function mentionsMisleadingSiblingWarning(userMessage: string): boolean {
	return /\b(misleading|similarly named)\b/i.test(userMessage);
}

function extractLocalVerificationCommand(userMessage: string): string | undefined {
	const fencedMatch = userMessage.match(/intended verification command is:\s*`([^`]+)`/i);
	if (fencedMatch?.[1]) return fencedMatch[1].trim();
	const plainMatch = userMessage.match(/verification command is:\s*([^\n]+)/i);
	if (plainMatch?.[1]) return plainMatch[1].trim();
	return undefined;
}

function extractNamedWorkspacePath(userMessage: string, prefixPattern: RegExp): string | undefined {
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
		if (raw && prefixPattern.test(raw)) return raw;
	}
	return undefined;
}

function getSelfContainedSummaryResponseRule(userMessage: string): string {
	if (!isSelfContainedWorkspaceTask(userMessage)) return "";
	if (SELF_CONTAINED_SUMMARY_FILE_PATTERNS.some((pattern) => pattern.test(userMessage))) return "";
	return " Return the short final summary as visible assistant text, not only in thinking/reasoning. Do not create or edit SUMMARY.md, notes, docs, markdown reports, or any other workspace file unless the task explicitly asks for a file change.";
}

function getVerificationCommandClause(localVerificationCommand: string | undefined): string {
	return localVerificationCommand
		? `the intended verification command exactly once, verbatim (\`${localVerificationCommand}\`)`
		: "the intended verification command once";
}

function getVerificationMisuseWarning(localVerificationCommand: string | undefined): string {
	return localVerificationCommand
		? " Do not rewrite it to a narrower path, append extra args, use previews, subsets, piped variants, or rerun it after the first passing result."
		: " Do not rerun it after the first passing result.";
}

function extractExpectedChangedPathsFromPrompt(userMessage: string): string[] {
	const match = userMessage.match(/^- expected changed paths:\s*([^\n]+)/im);
	if (!match?.[1]) return [];
	return match[1]
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function getExactVerificationOnceRule(localVerificationCommand: string | undefined, userMessage: string): string {
	const expectedChangedPaths = extractExpectedChangedPathsFromPrompt(userMessage);
	const requiresMultipleEdits = expectedChangedPaths.length > 1 || requiresTestUpdate(userMessage);
	const verificationPoint = requiresMultipleEdits
		? "After the required source/test mutations are complete"
		: "After the first successful mutation";
	return ` ${verificationPoint}, run ${getVerificationCommandClause(localVerificationCommand)}.${getVerificationMisuseWarning(localVerificationCommand)}`;
}
