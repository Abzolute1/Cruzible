const AUTONOMOUS_EXTERNAL_RESEARCH_PATTERNS = [
	/\b(latest|current|today|recent|release|version|changelog|breaking changes?)\b/i,
	/\b(research|search online|web search|search the web|look up|external source|citation|source url)\b/i,
	/\b(compare|comparison|pricing|availability|compatibility)\b/i,
];

const AUTONOMOUS_DOCUMENTATION_RESEARCH_PATTERNS = [
	/\b(documentation|docs|api reference|reference|guide|manual|spec)\b/i,
];

const AUTONOMOUS_IMPLEMENTATION_PATTERNS = [
	/\b(fix|debug|patch|repair|migrate|improve|update|change|modify|edit|implement|build|add|create|refactor|rewrite|replace|tighten|adjust|tweak)\b/i,
	/\b(frontend|ui|ux|layout|styling|style|css|tailwind|component|responsive|mobile|browser|page|visual|screenshot)\b/i,
];

const AUTONOMOUS_VERIFY_ONLY_PATTERNS = [
	/\b(verify|verification|check|validate|review|inspect|assess|audit|confirm)\b/i,
];

const AUTONOMOUS_LOCAL_ANSWER_PATTERNS = [
	/\b(which file|which source file|which directory|where is|where's|find where)\b/i,
	/\b(defines?|definition of|implemented in this repo|computed in this repo)\b/i,
	/\b(in this repo|in the codebase|in the project|inside this workspace)\b/i,
	/\b(explain|summarize)\b.*\b(what it does|how it works|purpose)\b/i,
	/\b(list just those filenames|exact path|one-sentence purpose)\b/i,
];

const AUTONOMOUS_PATH_LOOKUP_PATTERNS = [
	/\b(which file|which source file|which directory|where is|where's|find where)\b/i,
	/\b(exact path|path only|location only)\b/i,
];

export function hasAutonomousLocalReferenceContext(text: string): boolean {
	return (
		/\bprovided\s+(docs?\s+)?excerpt\b/i.test(text) ||
		/\bprovided\s+(reference|guide|manual|spec)\b/i.test(text) ||
		/\b(stay inside|inside)\s+this\s+workspace\b/i.test(text) ||
		/`(?:\.\/)?(?:reference|docs?|guides?|manuals?|specs?)\/[^`]+`/.test(text) ||
		/\b(?:reference|docs?|guides?|manuals?|specs?)\/[^\s)`]+/i.test(text)
	);
}

export function looksLikeAutonomousResearchTask(text: string): boolean {
	if (AUTONOMOUS_EXTERNAL_RESEARCH_PATTERNS.some((pattern) => pattern.test(text))) return true;
	if (AUTONOMOUS_DOCUMENTATION_RESEARCH_PATTERNS.some((pattern) => pattern.test(text))) {
		return !hasAutonomousLocalReferenceContext(text);
	}
	return false;
}

export function looksLikeAutonomousImplementationTask(text: string): boolean {
	return AUTONOMOUS_IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(text));
}

export function looksLikeAutonomousVerifyOnlyTask(text: string): boolean {
	if (looksLikeAutonomousResearchTask(text) || looksLikeAutonomousImplementationTask(text)) return false;
	return AUTONOMOUS_VERIFY_ONLY_PATTERNS.some((pattern) => pattern.test(text));
}

export function looksLikeAutonomousLocalAnswerTask(text: string): boolean {
	if (looksLikeAutonomousResearchTask(text) || looksLikeAutonomousImplementationTask(text)) return false;
	if (looksLikeAutonomousVerifyOnlyTask(text)) return true;
	return AUTONOMOUS_LOCAL_ANSWER_PATTERNS.some((pattern) => pattern.test(text));
}

export function looksLikeAutonomousPathLookupTask(text: string): boolean {
	return AUTONOMOUS_PATH_LOOKUP_PATTERNS.some((pattern) => pattern.test(text));
}
