import type { WorkspaceIndex, WorkspaceManifest } from "./workspace-index.js";
import { selectVerificationCommand } from "./verification-controller.js";
import { buildWorkspaceManifest } from "./workspace-index.js";

export type ControlledTaskIntent =
	| "direct_answer"
	| "code_explanation"
	| "small_patch"
	| "debug_fix"
	| "multi_file_change"
	| "verification_only"
	| "research"
	| "frontend_visual"
	| "ambiguous";

export type ControlledRuntimeMode = "flexible" | "controlled" | "strict_benchmark";

export type TaskPolicy = {
	mode: ControlledRuntimeMode;
	intent: ControlledTaskIntent;
	mutationExpected: boolean;
	webRelevant: boolean;
	allowedPaths: string[];
	expectedChangedPaths: string[];
	likelyTests: string[];
	verification?: string;
	maxReadsBeforePatch: number;
	maxSearchesBeforePatch: number;
	maxPatchAttempts: number;
	stopAfterVerifierPass: boolean;
};

export type InferTaskPolicyOptions = {
	prompt: string;
	index: WorkspaceIndex;
	mode?: ControlledRuntimeMode;
	manifest?: WorkspaceManifest;
};

const RESEARCH_PATTERN =
	/\b(latest|current|today|recent|research|search online|web search|look up|citation|pricing|availability|breaking changes?)\b/i;
const FRONTEND_PATTERN = /\b(frontend|ui|ux|css|tailwind|component|responsive|browser|visual|screenshot|page layout)\b/i;
const VERIFY_PATTERN = /\b(verify|verification|check|validate|run tests?|test only|audit|review)\b/i;
const IMPLEMENT_PATTERN = /\b(fix|debug|bug|patch|repair|implement|add|create|change|modify|edit|update|improve|refactor|rewrite|migrate)\b/i;
const MULTI_FILE_PATTERN = /\b(multi[- ]file|cross[- ]file|refactor|migration|across|all files|entire codebase)\b/i;
const EXPLANATION_PATTERN = /\b(explain|summarize|what does|how does|walk me through|describe)\b/i;
const DIRECT_ANSWER_PATTERN = /\b(hello|hi|what is|which file|which directory|where is|list just|exact path|one[- ]sentence)\b/i;

function extractExplicitVerifier(prompt: string): string | undefined {
	const patterns = [
		/intended verification command is:\s*`?([^`\n]+)`?/i,
		/verification command is:\s*`?([^`\n]+)`?/i,
		/run the targeted verification command:\s*`?([^`\n]+)`?/i,
		/run\s+`([^`]+)`\s+before/i,
	];
	for (const pattern of patterns) {
		const match = prompt.match(pattern);
		if (match?.[1]) return match[1].trim().replace(/\.$/, "");
	}
	return undefined;
}

export function classifyControlledTaskIntent(prompt: string): ControlledTaskIntent {
	const text = prompt.trim();
	if (!text) return "ambiguous";
	if (RESEARCH_PATTERN.test(text)) return "research";
	if (FRONTEND_PATTERN.test(text) && IMPLEMENT_PATTERN.test(text)) return "frontend_visual";
	if (IMPLEMENT_PATTERN.test(text)) {
		if (MULTI_FILE_PATTERN.test(text)) return "multi_file_change";
		if (/\b(fix|debug|bug|repair)\b/i.test(text)) return "debug_fix";
		return "small_patch";
	}
	if (VERIFY_PATTERN.test(text)) return "verification_only";
	if (EXPLANATION_PATTERN.test(text)) return "code_explanation";
	if (DIRECT_ANSWER_PATTERN.test(text)) return "direct_answer";
	return "ambiguous";
}

function inferVerifier(prompt: string, index: WorkspaceIndex, manifest: WorkspaceManifest): string | undefined {
	const explicit = extractExplicitVerifier(prompt);
	if (explicit) return explicit;
	if (index.packageScripts.test) return selectVerificationCommand({ command: "npm test", manifest });
	if (index.packageScripts.check) return selectVerificationCommand({ command: "npm run check", manifest });
	if (manifest.testFiles.some((file) => /\.(mjs|cjs|js)$/.test(file))) {
		return selectVerificationCommand({ command: "node --test", manifest });
	}
	if (index.testFiles.some((file) => /\.(mjs|cjs|js)$/.test(file))) return "node --test";
	return selectVerificationCommand({ command: manifest.likelyVerifier, manifest });
}

function isGeneratedOrSnapshot(path: string): boolean {
	return /(^|\/)(generated|snapshots?|fixtures?|dist|build|coverage)(\/|$)/i.test(path) || /\.snap(?:shot)?\./i.test(path);
}

function taskPolicyPromptTerms(prompt: string): Set<string> {
	return new Set(
		prompt
			.toLowerCase()
			.replace(/[`"'.,:;()[\]{}]/g, " ")
			.split(/[^a-z0-9]+/g)
			.map((term) => term.trim())
			.filter((term) => term.length >= 3),
	);
}

function scoreExpectedChangePath(path: string, terms: Set<string>): number {
	const normalizedPath = path.toLowerCase();
	const pathTerms = new Set(normalizedPath.split(/[^a-z0-9]+/g).filter(Boolean));
	let score = 0;
	for (const term of terms) {
		if (pathTerms.has(term)) score += 8;
		else if (normalizedPath.includes(term)) score += 3;
	}
	return score;
}

function inferExpectedChangedPaths(intent: ControlledTaskIntent, manifest: WorkspaceManifest, prompt: string): string[] {
	if (intent === "direct_answer" || intent === "code_explanation" || intent === "verification_only" || intent === "research") {
		return [];
	}
	const terms = taskPolicyPromptTerms(prompt);
	const candidates = manifest.files
		.filter((file) => !manifest.testFiles.includes(file))
		.filter((file) => !isGeneratedOrSnapshot(file))
		.filter((file) => /\.(mjs|cjs|js|jsx|ts|tsx|json|md|css|html)$/.test(file));
	const directlyRelevant = candidates
		.map((file) => ({ file, score: scoreExpectedChangePath(file, terms) }))
		.filter((entry) => entry.score >= 3)
		.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
		.map((entry) => entry.file);
	return (directlyRelevant.length > 0 ? directlyRelevant : candidates)
		.slice(0, intent === "multi_file_change" ? 6 : 3);
}

function isMutationExpected(intent: ControlledTaskIntent): boolean {
	return intent === "small_patch" || intent === "debug_fix" || intent === "multi_file_change" || intent === "frontend_visual";
}

function policyBudgets(intent: ControlledTaskIntent, mode: ControlledRuntimeMode) {
	const strict = mode === "strict_benchmark";
	if (intent === "direct_answer") return { maxReadsBeforePatch: 2, maxSearchesBeforePatch: 1, maxPatchAttempts: 0 };
	if (intent === "code_explanation" || intent === "verification_only") {
		return { maxReadsBeforePatch: strict ? 3 : 5, maxSearchesBeforePatch: strict ? 1 : 2, maxPatchAttempts: 0 };
	}
	if (intent === "multi_file_change" || intent === "frontend_visual") {
		return { maxReadsBeforePatch: strict ? 6 : 10, maxSearchesBeforePatch: strict ? 2 : 4, maxPatchAttempts: strict ? 2 : 4 };
	}
	if (intent === "research") return { maxReadsBeforePatch: 0, maxSearchesBeforePatch: strict ? 2 : 4, maxPatchAttempts: 0 };
	return { maxReadsBeforePatch: strict ? 4 : 7, maxSearchesBeforePatch: strict ? 1 : 3, maxPatchAttempts: strict ? 2 : 3 };
}

export function inferTaskPolicy(options: InferTaskPolicyOptions): TaskPolicy {
	const mode = options.mode ?? "controlled";
	const manifest = options.manifest ?? buildWorkspaceManifest(options.index, { prompt: options.prompt });
	const intent = classifyControlledTaskIntent(options.prompt);
	const mutationExpected = isMutationExpected(intent);
	const budgets = policyBudgets(intent, mode);
	const verification = mutationExpected || intent === "verification_only" ? inferVerifier(options.prompt, options.index, manifest) : undefined;
	return {
		mode,
		intent,
		mutationExpected,
		webRelevant: intent === "research" || RESEARCH_PATTERN.test(options.prompt),
		allowedPaths: manifest.files,
		expectedChangedPaths: inferExpectedChangedPaths(intent, manifest, options.prompt),
		likelyTests: manifest.testFiles,
		verification,
		...budgets,
		stopAfterVerifierPass: Boolean(verification && (mutationExpected || intent === "verification_only")),
	};
}

export function formatTaskPolicy(policy: TaskPolicy): string {
	const lines = [
		"",
		"Controlled execution policy:",
		`- mode: ${policy.mode}`,
		`- intent: ${policy.intent}`,
		`- mutation expected: ${policy.mutationExpected ? "yes" : "no"}`,
	];
	if (policy.allowedPaths.length > 0) lines.push(`- allowed paths: ${policy.allowedPaths.join(", ")}`);
	if (policy.expectedChangedPaths.length > 0) lines.push(`- expected changed paths: ${policy.expectedChangedPaths.join(", ")}`);
	if (policy.likelyTests.length > 0) lines.push(`- likely tests: ${policy.likelyTests.join(", ")}`);
	if (policy.verification) lines.push(`- verifier: ${policy.verification}`);
	lines.push(`- budgets: reads=${policy.maxReadsBeforePatch}, searches=${policy.maxSearchesBeforePatch}, patches=${policy.maxPatchAttempts}`);
	if (policy.stopAfterVerifierPass) lines.push("- stop after verifier pass: yes");
	return lines.join("\n");
}
