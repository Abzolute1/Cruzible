import { describe, expect, it } from "vitest";
import { buildPromptIntentAddendum } from "../src/core/prompt-intent-steering.js";

describe("buildPromptIntentAddendum", () => {
	it("steers local code lookups toward local tools", () => {
		const addendum = buildPromptIntentAddendum(
			"find the file that defines buildLocalEvidencePromptAddendum and summarize what it does",
		);
		expect(addendum).toContain("local workspace/repository");
		expect(addendum).toContain("Stay in local tools");
		expect(addendum).toContain("do not use webSearch/webFetch");
		expect(addendum).toContain("one focused local discovery step");
	});

	it("adds source-first guidance for local definition lookups", () => {
		const addendum = buildPromptIntentAddendum(
			"find where prompt-intent steering is defined in this repo and summarize it",
		);
		expect(addendum).toContain("local workspace/repository");
		expect(addendum).toContain("one focused local discovery step");
		expect(addendum).toContain("one targeted read");
		expect(addendum).toContain("answer directly");
	});

	it("adds one-symbol-first guidance for comparative local definition requests", () => {
		const addendum = buildPromptIntentAddendum(
			"find where createLiveProviderContext is defined and explain how it differs from createContextHygieneCopy; do not browse the web",
		);
		expect(addendum).toContain("explicitly does not want web browsing");
		expect(addendum).toContain("local workspace/repository");
		expect(addendum).toContain("one focused local discovery step");
	});

	it("adds filename-first guidance for script-definition questions", () => {
		const addendum = buildPromptIntentAddendum("which file defines the benchmark comparison script?");
		expect(addendum).toContain("local workspace/repository");
		expect(addendum).toContain("one focused local discovery step");
		expect(addendum).toContain("answer directly");
	});

	it("treats source-file command implementation prompts as filename/path lookups", () => {
		const addendum = buildPromptIntentAddendum(
			"which source file implements the benchmark archive command? give the exact path and one-sentence purpose",
		);
		expect(addendum).toContain("local workspace/repository");
		expect(addendum).toContain("one focused local discovery step");
		expect(addendum).toContain("one targeted read");
	});

	it("prefers exact grep first when a script-definition prompt already contains a destination path", () => {
		const addendum = buildPromptIntentAddendum(
			"which file defines the script that archives benchmark runs into /home/alex/Desktop/Benchmark?",
		);
		expect(addendum).toContain("narrow local workspace path lookup");
		expect(addendum).toContain("externalize it immediately instead of planning aloud");
		expect(addendum).toContain("exact slash-rich path or destination literal");
		expect(addendum).toContain("one exact grep for that literal");
		expect(addendum).toContain("before any wildcard find or broad ls");
		expect(addendum).toContain("Do not queue backup grep, find, or ls calls");
		expect(addendum).toContain("answer immediately with that path");
	});

	it("adds directory-first guidance for directory inventory prompts", () => {
		const addendum = buildPromptIntentAddendum(
			"which directory contains the benchmark scripts and what files are in it?",
		);
		expect(addendum).toContain("local workspace/repository");
		expect(addendum).toContain("one focused local discovery step");
		expect(addendum).toContain("answer directly");
	});

	it("adds hold-directory guidance for directory prompts with named scripts", () => {
		const addendum = buildPromptIntentAddendum(
			"which directory holds the benchmark runner, compare, and archive scripts? list just those filenames",
		);
		expect(addendum).toContain("local workspace/repository");
		expect(addendum).toContain("one focused local discovery step");
		expect(addendum).toContain("answer directly");
	});

	it("honors explicit no-web directives", () => {
		const addendum = buildPromptIntentAddendum(
			"find where buildSystemPrompt is defined and explain it; do not browse the web",
		);
		expect(addendum).toContain("explicitly does not want web browsing");
		expect(addendum).toContain("Do not use webSearch or webFetch");
	});

	it("steers explicit web/current requests toward web tools", () => {
		const addendum = buildPromptIntentAddendum("research the latest claude code leak and summarize it");
		expect(addendum).toContain("external or current information");
		expect(addendum).toContain("Prefer webSearch/webFetch first");
		expect(addendum).toContain("Keep the first search query anchored");
		expect(addendum).toContain("`Claude Code`");
		expect(addendum).toContain("`security vulnerability`, `data breach`, or `data disclosure`");
	});

	it("adds strongest-source guidance for current-events research prompts", () => {
		const addendum = buildPromptIntentAddendum(
			"research the latest claude code leak, cite the strongest sources, and summarize it briefly",
		);
		expect(addendum).toContain("anchored to the concrete incident/topic terms");
		expect(addendum).toContain("generic scandal/breach wording");
		expect(addendum).toContain("`Claude Code`");
		expect(addendum).toContain("generic phrases like `Claude AI` or `data breach`");
		expect(addendum).toContain("keep that exact phrase in the first search query");
		expect(addendum).toContain("`breach`, `data disclosure`, or `security incident`");
		expect(addendum).toContain("stable reporting or technical analysis sources first");
		expect(addendum).toContain("LinkedIn articles");
		expect(addendum).toContain("GitHub archives");
	});

	it("steers conversational prompts away from tools", () => {
		const addendum = buildPromptIntentAddendum("hello there");
		expect(addendum).toContain("conversational or simple assistance request");
		expect(addendum).toContain("Do not use tools");
	});

	it("steers brief docs summaries toward one authoritative docs page", () => {
		const addendum = buildPromptIntentAddendum("look up React docs on actions and summarize briefly");
		expect(addendum).toContain("docs/reference lookup");
		expect(addendum).toContain("one authoritative documentation page first");
		expect(addendum).toContain("focused docs query");
		expect(addendum).toContain("exact concept");
		expect(addendum).toContain("top-level pages like /learn");
		expect(addendum).toContain("useActionState");
		expect(addendum).toContain("Server Functions");
		expect(addendum).toContain("Do not broaden into multiple searches or fetches");
	});

	it("steers OpenAI pricing lookups toward official OpenAI docs/pages", () => {
		const addendum = buildPromptIntentAddendum(
			"look up the latest OpenAI API pricing page and summarize the current headline structure briefly",
		);
		expect(addendum).toContain("developers.openai.com/api/docs/pricing");
		expect(addendum).toContain("platform.openai.com/pricing");
		expect(addendum).toContain("third-party pricing aggregators");
	});

	it("preserves named docs parameters in the first docs query", () => {
		const addendum = buildPromptIntentAddendum(
			"look up the official React docs for useActionState and explain the permalink parameter in one sentence",
		);
		expect(addendum).toContain("specific parameter");
		expect(addendum).toContain("exact token in the first docs query");
		expect(addendum).toContain("keep that exact token");
		expect(addendum).toContain("answer from that snippet directly instead of fetching the page first");
		expect(addendum).toContain("Do not broaden into multiple searches or fetches");
	});

	it("does not misclassify plain generic prompts", () => {
		expect(buildPromptIntentAddendum("write something interesting")).toBeUndefined();
	});

	it("adds descriptive-phrase guidance for local implementation lookups", () => {
		const addendum = buildPromptIntentAddendum(
			"find where current-events query normalization is implemented in this repo and summarize it; do not browse the web",
		);
		expect(addendum).toContain("explicitly does not want web browsing");
		expect(addendum).toContain("local workspace/repository");
		expect(addendum).toContain("one focused local discovery step");
		expect(addendum).toContain("one targeted read");
	});

	it("adds implementation-only metric guidance for computed value prompts", () => {
		const addendum = buildPromptIntentAddendum(
			"where is score per 1k tokens computed in this repo? answer from the implementation, not benchmark output files",
		);
		expect(addendum).toContain("local workspace/repository");
		expect(addendum).toContain("one focused local discovery step");
		expect(addendum).toContain("one targeted read");
	});

	it("adds repo-root scripts guidance for command implementation lookups", () => {
		const addendum = buildPromptIntentAddendum(
			"which source file implements the benchmark archive command? give the exact path and one-sentence purpose",
		);
		expect(addendum).toContain("local workspace/repository");
		expect(addendum).toContain("one focused local discovery step");
	});

	it("adds repo-root benchmark-script guidance for benchmark runner symbol lookups", () => {
		const addendum = buildPromptIntentAddendum(
			"find the function buildAggregate in the benchmark runner and explain what benchmark-level metrics it computes",
		);
		expect(addendum).toContain("local workspace/repository");
		expect(addendum).toContain("one focused local discovery step");
		expect(addendum).toContain("one targeted read");
	});

	it("adds exact-destination grep guidance for script lookups with a concrete path literal", () => {
		const addendum = buildPromptIntentAddendum(
			"which file defines the script that archives benchmark runs into /home/alex/Desktop/Benchmark?",
		);
		expect(addendum).toContain("narrow local workspace path lookup");
		expect(addendum).toContain("one exact local discovery step first");
		expect(addendum).toContain("start with one exact grep for that literal");
		expect(addendum).toContain("before any wildcard find or broad ls");
	});

	it("adds direct scripts listing guidance for benchmark sibling-directory questions", () => {
		const addendum = buildPromptIntentAddendum(
			"which directory holds the benchmark runner, compare, and archive scripts? list just those filenames",
		);
		expect(addendum).toContain("local workspace/repository");
		expect(addendum).toContain("answer directly");
	});

	it("adds one-symbol-first guidance for local symbol comparisons", () => {
		const addendum = buildPromptIntentAddendum(
			"find where createLiveProviderContext is defined and explain how it differs from createContextHygieneCopy; do not browse the web",
		);
		expect(addendum).toContain("local workspace/repository");
		expect(addendum).toContain("one focused local discovery step");
	});

	it("steers self-contained benchmark patch tasks toward caller and test evidence first", () => {
		const addendum = buildPromptIntentAddendum(
			[
				"You are in a self-contained benchmark workspace.",
				"Fix the report rendering bug so the CLI output uses line breaks between summary items.",
				"Be careful: there is a misleading similarly named formatter file in the workspace.",
				"Run the verification command before your final answer.",
				"Stay inside this workspace.",
				"The intended verification command is: `node --test`",
			].join("\n"),
		);

		expect(addendum).toContain("self-contained local implementation task");
		expect(addendum).toContain("read the most likely implementation file, importing caller, failing test");
		expect(addendum).toContain(
			"do not burn turns on shell `find` commands that only search one extension family like `*.js`",
		);
		expect(addendum).toContain("misleading similarly named file");
		expect(addendum).toContain("Verify the actual import/call path and expected output before editing");
		expect(addendum).toContain("run the specified verification command promptly");
	});
});
