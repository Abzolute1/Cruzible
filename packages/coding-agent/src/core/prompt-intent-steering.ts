function looksLikeExplicitWebRequest(text: string): boolean {
	return /\b(search the web|websearch|web fetch|webfetch|online|internet|latest|current news|today|research)\b/i.test(
		text,
	);
}

function looksLikeNoWebDirective(text: string): boolean {
	return /\b(do not browse the web|don't browse the web|do not use the web|don't use the web|without using tools? from the web|do not search the web|no web\b|without browsing the web)\b/i.test(
		text,
	);
}

function looksLikeConversationalRequest(text: string): boolean {
	return /^\s*(hello|hi|hey|yo|sup|good morning|good afternoon|good evening|thanks|thank you)\b/i.test(text)
		|| /\b(can you help|help me|what can you do|are you there|how can you help|need assistance)\b/i.test(text);
}

function looksLikeLocalCodeLookup(text: string): boolean {
	return /\b(find the file|find where|which file|which directory|where is|where's|defines?|definition of|in this repo|in the codebase|in the project|workspace|local file|source file|function\b|class\b|symbol\b|grep\b|what files are in it|contains the .*scripts?|under\s+(src|packages|app|lib|test)\b|summarize what it does)\b/i.test(
		text,
	);
}

function looksLikeLocalPathAnswerRequest(text: string): boolean {
	return /\b(which file|which source file|which directory|which directory holds|where is|where's|contains the .*scripts?|contains the .*files?|defines the .*script|implements the .*command)\b/i.test(text);
}

function looksLikeLiteralPathNeedle(text: string): boolean {
	return /(?:\/[A-Za-z0-9._-]+){2,}/.test(text)
		|| /`[^`\n]*\/[^`\n]*`/.test(text);
}

function looksLikeDefinitionLookup(text: string): boolean {
	return /\b(where is .* defined|where .* is defined|find where .* is defined|which file defines|which source file implements|definition of|defines?|implemented in this repo|where is .* implemented|where .* is implemented|find where .* is implemented|where is .* computed|where .* is computed|find where .* is computed)\b/i.test(
		text,
	);
}

function looksLikeComparativeDefinitionRequest(text: string): boolean {
	return /\b(differs? from|difference between|compare .* with|compare .* and|how .* differs?)\b/i.test(text);
}

function looksLikeDirectoryInventoryRequest(text: string): boolean {
	return /\b(which directory contains|which directory holds|what files are in it|list just those filenames|list the files|contains the .*scripts?)\b/i.test(text);
}

function looksLikeDocsReferenceRequest(text: string): boolean {
	return /\b(docs?|documentation|reference|manual|guide|api)\b/i.test(text);
}

function looksLikeBriefSummaryRequest(text: string): boolean {
	return /\b(summar(?:ize|ise)|brief(?:ly)?|quick(?:ly)?|short(?:ly)?|concise|one sentence|single sentence)\b/i.test(text);
}

function looksLikeSelfContainedBenchmarkWorkspaceTask(text: string): boolean {
	return /\bself-contained benchmark workspace\b/i.test(text);
}

function looksLikeLocalImplementationTask(text: string): boolean {
	return /\b(fix|debug|patch|migrate|update|refactor|repair)\b/i.test(text)
		&& /\b(workspace|verification command|node --test|keep the patch minimal|stay inside this workspace)\b/i.test(text);
}

function mentionsMisleadingSiblingWarning(text: string): boolean {
	return /\b(misleading|similarly named)\b/i.test(text);
}

function looksLikeStrongestSourcesResearchRequest(text: string): boolean {
	return /\b(strongest|best|authoritative|independent)\s+sources?\b/i.test(text)
		|| /\bcite\b.*\bsources?\b/i.test(text)
		|| /\bcorroborat(?:e|ion|ing)\b/i.test(text);
}

export function buildPromptIntentAddendum(text: string): string | undefined {
	const trimmed = text.trim();
	if (trimmed.length === 0) return undefined;
	const noWebDirective = looksLikeNoWebDirective(trimmed);
	const noWebOnly = noWebDirective && !looksLikeExplicitWebRequest(trimmed);

	if (
		looksLikeConversationalRequest(trimmed)
		&& !looksLikeExplicitWebRequest(trimmed)
		&& !looksLikeLocalCodeLookup(trimmed)
	) {
		return "Intent steering: This is a conversational or simple assistance request. Answer directly in natural language. Do not use tools unless the user explicitly asks for information or actions that require them.";
	}

	if (noWebOnly && !looksLikeLocalCodeLookup(trimmed)) {
		return "Intent steering: The user explicitly does not want web browsing. Do not use webSearch or webFetch. Stay inside the local workspace/tools only, and answer directly when the needed local evidence is already available.";
	}

	if (looksLikeExplicitWebRequest(trimmed)) {
		const openAiPricingHint =
			/\bopenai\b/i.test(trimmed) && /\bapi\b/i.test(trimmed) && /\bpricing\b/i.test(trimmed)
				? " For OpenAI API pricing queries, prefer official OpenAI sources like `developers.openai.com/api/docs/pricing` or `platform.openai.com/pricing` before third-party pricing aggregators or recap pages."
				: "";
		if (looksLikeStrongestSourcesResearchRequest(trimmed)) {
			return `Intent steering: This request is about external or current information. Prefer webSearch/webFetch first, and use local repo tools only if the user explicitly asks for local code or files. For strongest-source research, keep the search query anchored to the concrete incident/topic terms from the user prompt rather than drifting into generic scandal/breach wording. Preserve distinctive product names exactly, for example \`Claude Code\`, instead of broadening them into generic phrases like \`Claude AI\` or \`data breach\`. If the user named a specific incident phrase like \`Claude Code leak\`, keep that exact phrase in the first search query instead of paraphrasing it into looser terms like \`breach\`, \`data disclosure\`, or \`security incident\`. Prefer stable reporting or technical analysis sources first; treat social posts, LinkedIn articles, mirrors, and GitHub archives as secondary corroboration rather than primary evidence.${openAiPricingHint}`;
		}
		return `Intent steering: This request is about external or current information. Prefer webSearch/webFetch first, and use local repo tools only if the user explicitly asks for local code or files. Keep the first search query anchored to the concrete incident/topic terms the user gave. Preserve distinctive product names exactly, for example \`Claude Code\`, and avoid broadening a specific leak/incident prompt into looser terms like \`security vulnerability\`, \`data breach\`, or \`data disclosure\` unless the user explicitly asked for that angle.${openAiPricingHint}`;
	}

	if (looksLikeDocsReferenceRequest(trimmed) && !looksLikeLocalCodeLookup(trimmed)) {
		const domainSpecificHints: string[] = [];
		if (/\breact\b/i.test(trimmed) && /\bactions?\b/i.test(trimmed)) {
			domainSpecificHints.push(
				"For React docs on actions, prefer the official docs concepts `useActionState`, `Server Functions`, or the older term `Server Actions` before generic Hooks/tutorial landing pages.",
			);
		}
		if (/\bopenai\b/i.test(trimmed) && /\bapi\b/i.test(trimmed) && /\bpricing\b/i.test(trimmed)) {
			domainSpecificHints.push(
				"For OpenAI API pricing queries, prefer official OpenAI sources like `developers.openai.com/api/docs/pricing` or `platform.openai.com/pricing` before third-party pricing aggregators or recap pages.",
			);
		}
		if (looksLikeBriefSummaryRequest(trimmed)) {
			return `Intent steering: This is a docs/reference lookup. Use a focused docs query with the core concept terms from the user's request, not a generic docs landing-page query. If the user asked about a specific concept, hook, API, action, or server feature, prefer an official reference page for that exact concept over top-level pages like /learn or general getting-started docs. If the user named a specific parameter, option, argument, or signature token such as \`permalink\`, keep that exact token in the first docs query instead of dropping it from a broader concept-only search. If the first authoritative docs search snippet already includes that exact named token or signature detail, answer from that snippet directly instead of fetching the page first. ${domainSpecificHints.join(" ")} Prefer one authoritative documentation page first, then answer from that page. Do not broaden into multiple searches or fetches unless the first official page is clearly thin, placeholder-only, generic, or missing the core concept the user asked about.`;
		}
		return `Intent steering: This is a docs/reference lookup. Use a focused docs query with the concept terms from the user's request, and prefer an authoritative reference page for that exact concept over generic landing pages. If the user named a specific parameter, option, argument, or signature token, preserve that exact token in the first docs query instead of broadening immediately. If the first authoritative docs search snippet already includes that exact named token or signature detail, answer from the snippet before fetching. ${domainSpecificHints.join(" ")} Only broaden into more searches/fetches if the first official source is clearly missing the needed information.`;
	}

	if (looksLikeSelfContainedBenchmarkWorkspaceTask(trimmed) && looksLikeLocalImplementationTask(trimmed)) {
		const misleadingFileGuidance = mentionsMisleadingSiblingWarning(trimmed)
			? "The task explicitly warns about a misleading similarly named file. Treat filename similarity as a trap, not evidence. Verify the actual import/call path and expected output before editing, and do not copy semantics from a sibling file just because the stem matches."
			: "If there are multiple similarly named local files, verify the actual import/call path and expected output before editing; do not assume the first filename match is the right behavior source.";
		return [
			"Intent steering: This is a self-contained local implementation task. Stay inside the workspace and do not use webSearch/webFetch.",
			"Start with one targeted local inspection step: read the most likely implementation file, importing caller, failing test, or explicitly named local reference path before broad shell discovery.",
			"If the task already names a local reference path such as `reference/...`, read that exact file directly before searching elsewhere.",
			"If the workspace listing is already small and script-like, do not burn turns on shell `find` commands that only search one extension family like `*.js`. Prefer likely local files with extensions such as `.mjs`, `.js`, `.ts`, or `.py`.",
			"Before editing, confirm the real execution path from the caller or test expectation instead of copying behavior from the first similarly named file you find.",
			misleadingFileGuidance,
			"After the concrete change, run the specified verification command promptly and stop after a short verified summary.",
		].join(" ");
	}

	if (looksLikeLocalCodeLookup(trimmed) && looksLikeLocalPathAnswerRequest(trimmed) && looksLikeLiteralPathNeedle(trimmed)) {
		const noWebPrefix = noWebOnly
			? "Intent steering: The user explicitly does not want web browsing. Do not use webSearch or webFetch. "
			: "";
		return [
			`${noWebPrefix}Intent steering: This is a narrow local workspace path lookup.`,
			"Prefer one exact local discovery step first and externalize it immediately instead of planning aloud.",
			"Because the prompt already includes an exact slash-rich path or destination literal, start with one exact grep for that literal in likely implementation files or repo-root `scripts/` before any wildcard find or broad ls.",
			"Do not queue backup grep, find, or ls calls before the first result comes back.",
			"If that exact grep lands on one decisive implementation file, answer immediately with that path; only read it if the user also asked for behavior or purpose.",
		].join(" ");
	}

	if (looksLikeLocalCodeLookup(trimmed)) {
		const noWebPrefix = noWebOnly
			? "Intent steering: The user explicitly does not want web browsing. Do not use webSearch or webFetch. "
			: "";
		return [
			`${noWebPrefix}Intent steering: This request is about the local workspace/repository.`,
			"Stay in local tools and do not use webSearch/webFetch unless the user explicitly asks for external/current information.",
			"Start with one focused local discovery step.",
			"After a decisive file/path or definition hit, either do one targeted read if the user asked for behavior, or answer directly if they only asked for the location.",
			"Do not keep broadening discovery once the local evidence is already decisive.",
		].join(" ");
	}

	return undefined;
}
