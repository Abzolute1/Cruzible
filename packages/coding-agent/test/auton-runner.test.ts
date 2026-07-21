import { beforeEach, describe, expect, test, vi } from "vitest";

const { evaluateNudgeWithCooldownMock, getNudgeMessageMock } = vi.hoisted(() => ({
	evaluateNudgeWithCooldownMock: vi.fn(),
	getNudgeMessageMock: vi.fn(() => "NUDGE_MESSAGE"),
}));

vi.mock("../src/core/session-debug-logger.js", () => ({
	SessionDebugLogger: class {
		start(): void {}
		dispose(): void {}
	},
}));

vi.mock("../src/core/auton/nudges/nudge-eval.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/auton/nudges/nudge-eval.js")>();
	return {
		...actual,
		evaluateNudgeWithCooldown: evaluateNudgeWithCooldownMock,
		getNudgeMessage: getNudgeMessageMock,
	};
});

import { runAutonomousSession } from "../src/core/auton/runner.js";

type MockAssistantResponse = {
	text: string;
	stopReason: string;
	emitToolCallStart?: boolean;
	emitDegradedTurn?: {
		severity: "elevated" | "critical";
		stopReason?: string;
		outputTokens?: number;
		textLength?: number;
		reasons?: string[];
		recoveryHint?: string;
	};
	toolOutcomes?: Array<{
		tool: string;
		success: boolean;
		detail?: string;
		file?: string;
		metadata?: Record<string, unknown>;
	}>;
	outputTokens?: number;
};

function createRuntime(
	responses: MockAssistantResponse[],
	options?: {
		availableToolNames?: string[];
	},
) {
	const subscribers: Array<(event: any) => void> = [];
	const toolHistory: Array<{
		tool: string;
		success: boolean;
		detail?: string;
		file?: string;
		metadata?: Record<string, unknown>;
	}> = [];
	const fileHistory: Array<{
		tool: string;
		success: boolean;
		detail?: string;
		file?: string;
		metadata?: Record<string, unknown>;
	}> = [];
	const availableToolNames = new Set(options?.availableToolNames ?? []);
	const sessionManager = {
		appendCustomEntry: vi.fn(),
		getEntries: vi.fn(() => []),
	};
	const session: any = {
		model: { id: "openai/test-model" },
		sessionManager,
		agent: {
			state: {
				systemPrompt: "BASE_PROMPT",
				messages: [],
			},
		},
		subscribe(listener: (event: any) => void) {
			subscribers.push(listener);
			return () => {
				const index = subscribers.indexOf(listener);
				if (index >= 0) subscribers.splice(index, 1);
			};
		},
		prompt: vi.fn(async (_message: string, _options?: unknown) => {
			const next = responses.shift();
			if (!next) throw new Error("No mock response available");

			if (next.toolOutcomes) {
				toolHistory.push(...next.toolOutcomes);
				for (const outcome of next.toolOutcomes) {
					if (outcome.file) {
						fileHistory.push(outcome);
					}
				}
			}

			if (next.emitToolCallStart) {
				for (const subscriber of subscribers) {
					subscriber({
						type: "tool_execution_start",
						toolCallId: "tool-1",
						toolName: "bash",
						args: { command: "echo ok" },
					});
				}
			}

			const assistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: next.text }],
				stopReason: next.stopReason,
				usage: {
					input: 10,
					output: next.outputTokens ?? 20,
					cacheRead: 0,
					cacheWrite: 0,
					cost: { input: 0, output: 0, total: 0 },
				},
			};

			session.agent.state.messages.push(assistantMessage);
			for (const subscriber of subscribers) {
				subscriber({ type: "message_end", message: assistantMessage });
			}
			if (next.emitDegradedTurn) {
				for (const subscriber of subscribers) {
					subscriber({
						type: "degraded_turn",
						severity: next.emitDegradedTurn.severity,
						stopReason: next.emitDegradedTurn.stopReason ?? next.stopReason,
						outputTokens: next.emitDegradedTurn.outputTokens ?? next.outputTokens ?? 0,
						textLength: next.emitDegradedTurn.textLength ?? next.text.length,
						reasons: next.emitDegradedTurn.reasons ?? [],
						recoveryHint: next.emitDegradedTurn.recoveryHint,
					});
				}
			}
			for (const subscriber of subscribers) {
				subscriber({ type: "agent_end" });
			}
		}),
		getContextUsage: vi.fn(() => null),
		compact: vi.fn(async () => undefined),
		getToolDefinition: vi.fn((name: string) => (availableToolNames.has(name) ? { name } : undefined)),
	};

	return {
		runtimeHost: { session } as any,
		session,
		sessionManager,
		toolHistory,
		fileHistory,
	};
}

describe("runAutonomousSession", () => {
	beforeEach(() => {
		evaluateNudgeWithCooldownMock.mockReset();
		getNudgeMessageMock.mockClear();
		evaluateNudgeWithCooldownMock.mockReturnValue({
			shouldNudge: false,
			nudgeType: "none",
			shouldStop: false,
		});
	});

	test("stops immediately on explicit completion with no tool calls", async () => {
		const { runtimeHost, session, toolHistory, fileHistory } = createRuntime([
			{
				text: "Task complete. I verified the implementation and no further changes are needed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "npm test" }],
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix it",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("complete");
		expect(session.agent.state.systemPrompt).toBe("BASE_PROMPT");
	});

	test("does not treat truncated no-tool turns as completion", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I started the fix but this response was cut off.",
				stopReason: "max_tokens",
			},
			{
				text: "Task complete. I verified the implementation and no further changes are needed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "npm test" }],
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix it",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.prompt.mock.calls[1]?.[0]).toContain("truncated");
		expect(result.stopReason).toBe("complete");
	});

	test("does not misclassify generic exceeded errors as budget failures", async () => {
		const { runtimeHost, session, toolHistory, fileHistory } = createRuntime([]);
		session.prompt = vi.fn(async () => {
			throw new Error("Provider output size exceeded hard limit");
		});
		const onError = vi.fn();

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix it",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
			onError,
		});

		expect(result.stopReason).toBe("error");
		expect(result.ledger.status).toBe("error");
		expect(onError).toHaveBeenCalledWith("Autonomous mode error: Provider output size exceeded hard limit");
	});

	test("asks for explicit completion evidence on ambiguous no-tool turns", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I inspected the codebase and identified the next changes.",
				stopReason: "stop",
			},
			{
				text: "Task complete. I verified the implementation and no further changes are needed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "npm test" }],
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix it",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.prompt.mock.calls[1]?.[0]).toContain("If the task is complete");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("Run ledger:");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("Goal: fix it");
		expect(result.stopReason).toBe("complete");
	});

	test("stops after a sufficient direct local answer without explicit completion wording", async () => {
		const { runtimeHost, session, toolHistory, fileHistory } = createRuntime([
			{
				text: "The benchmark archive command is implemented in `scripts/harness-benchmark-archive.mjs`. It archives benchmark run JSON artifacts into the benchmark history/archive flow.",
				stopReason: "stop",
				toolOutcomes: [
					{
						tool: "read",
						success: true,
						file: "scripts/harness-benchmark-archive.mjs",
						detail: "read archive command",
					},
				],
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage:
				"which source file implements the benchmark archive command? give the exact path and one-sentence purpose",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("complete");
		expect(result.ledger.taskMode).toBe("answer");
	});

	test("adds answer-first steering to local path lookups in the initial autonomous prompt", async () => {
		const { runtimeHost, session, toolHistory, fileHistory } = createRuntime([
			{
				text: "The benchmark archive command is implemented in `scripts/harness-benchmark-archive.mjs`.",
				stopReason: "stop",
			},
		]);

		await runAutonomousSession({
			runtimeHost,
			userMessage: "which source file implements the benchmark archive command? give the exact path only",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(session.prompt.mock.calls[0]?.[0]).toContain("answer-only local workspace task");
		expect(session.prompt.mock.calls[0]?.[0]).toContain("answer as soon as one decisive hit identifies it");
		expect(session.prompt.mock.calls[0]?.[0]).toContain("Do not widen into implementation or extra verification");
	});

	test("adds no-edit review steering to verify-only autonomous tasks", async () => {
		const { runtimeHost, session, toolHistory, fileHistory } = createRuntime([
			{
				text: "The main risk is that the retry counter resets too early after a transient failure.",
				stopReason: "stop",
			},
		]);

		await runAutonomousSession({
			runtimeHost,
			userMessage: "review the retry-path implementation in this repo and list the main risks without changing code",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(session.prompt.mock.calls[0]?.[0]).toContain("local inspection or review task");
		expect(session.prompt.mock.calls[0]?.[0]).toContain(
			"Do not edit files unless the user explicitly asks for a fix",
		);
		expect(session.prompt.mock.calls[0]?.[0]).toContain("answer with those findings and stop");
	});

	test("does not treat answer-only status updates as a sufficient direct answer", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I inspected the codebase and identified the next changes.",
				stopReason: "stop",
			},
			{
				text: "The benchmark archive command is implemented in `scripts/harness-benchmark-archive.mjs`.",
				stopReason: "stop",
				toolOutcomes: [
					{
						tool: "read",
						success: true,
						file: "scripts/harness-benchmark-archive.mjs",
						detail: "read archive command",
					},
				],
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "which source file implements the benchmark archive command? give the exact path only",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.prompt.mock.calls[1]?.[0]).toContain("provide the direct answer now and stop");
		expect(result.stopReason).toBe("complete");
	});

	test("adds self-contained workspace steering to the initial autonomous prompt", async () => {
		const task = `You are in a self-contained benchmark workspace.

Task:

1. Fix the configuration parser so explicit falsey values from user input are preserved.
2. Do not rewrite the tests.
3. Run the targeted verification command before you finish.

Constraints:

- Stay inside this workspace.
- Keep the fix minimal.
- The intended verification command is: \`node --test\``;
		const { runtimeHost, session, toolHistory, fileHistory } = createRuntime([
			{
				text: "Task complete. I verified the implementation and no further changes are needed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "node --test" }],
			},
		]);

		await runAutonomousSession({
			runtimeHost,
			userMessage: task,
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(session.prompt.mock.calls[0]?.[0]).toContain("stop shell-style file hunting");
		expect(session.prompt.mock.calls[0]?.[0]).toContain("make your very next tool call a direct `read`");
		expect(session.prompt.mock.calls[0]?.[0]).toContain("Treat `.` as the workspace root");
		expect(session.prompt.mock.calls[0]?.[0]).toContain("emit one concrete edit immediately");
		expect(session.prompt.mock.calls[0]?.[0]).toContain(
			"run the intended verification command exactly once, verbatim (`node --test`)",
		);
		expect(session.prompt.mock.calls[0]?.[0]).toContain("Do not rewrite it to a narrower path, append extra args");
		expect(session.prompt.mock.calls[0]?.[0]).toContain("Do not create or edit SUMMARY.md");
	});

	test("uses tighter continuation prompts for self-contained workspace drift", async () => {
		const task = `You are in a self-contained benchmark workspace.

Task:

1. Fix the session state bug so saved scopes can be listed correctly for a user.
2. Run the verification command before your final answer.

Constraints:

- Stay inside this workspace.
- The intended verification command is: \`node --test\``;
		const { runtimeHost, session, toolHistory, fileHistory } = createRuntime([
			{
				text: "I should inspect more files before I make the change.",
				stopReason: "stop",
			},
			{
				text: "Task complete. I verified the implementation and no further changes are needed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "node --test" }],
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: task,
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(session.prompt.mock.calls[1]?.[0]).toContain("Stop broad shell discovery");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("your next tool call must be one direct read");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("do not jump to /home/alex/AG1");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("src/, tests?/, reference/, or scripts/");
		expect(result.stopReason).toBe("complete");
	});

	test("uses a decisive single-file directory hit to force the direct src read", async () => {
		const task = `You are in a self-contained benchmark workspace.

Task:

1. Fix the configuration parser so explicit falsey values from user input are preserved.
2. Do not rewrite the tests.
3. Run the targeted verification command before you finish.

Constraints:

- Stay inside this workspace.
- Keep the fix minimal.
- The intended verification command is: \`node --test\``;
		const { runtimeHost, session, toolHistory, fileHistory } = createRuntime([
			{
				text: "I identified the likely implementation file from the workspace structure.",
				stopReason: "stop",
				toolOutcomes: [
					{
						tool: "ls",
						success: true,
						detail: "src",
						metadata: { directoryPath: "src", entryCount: 1, entriesSample: ["config-parser.mjs"] },
					},
				],
			},
			{
				text: "Fixed src/config-parser.mjs and node --test passed.",
				stopReason: "stop",
				toolOutcomes: [
					{ tool: "read", success: true, file: "src/config-parser.mjs", detail: "read parser" },
					{
						tool: "edit",
						success: true,
						file: "src/config-parser.mjs",
						detail: "preserved explicit falsey values",
					},
					{ tool: "bash", success: true, detail: "node --test" },
				],
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: task,
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.prompt.mock.calls[1]?.[0]).toContain(
			"The concrete implementation target is already known as `src/config-parser.mjs`",
		);
		expect(session.prompt.mock.calls[1]?.[0]).toContain("Do not use ls, find, grep, or bash discovery again");
		expect(result.stopReason).toBe("complete");
	});

	test("uses the discovered exact test path for required regression-test follow-up", async () => {
		const userMessage = [
			"You are in a self-contained benchmark workspace.",
			"Fix the search URL builder so an explicit limit of `0` is preserved.",
			"Add a regression test for that case.",
			"Run the verification command before your final answer.",
			"Stay inside this workspace.",
			"The intended verification command is: `node --test && node scripts/check-regression-test.mjs`",
		].join("\n");
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I fixed the implementation and still need to add the regression test.",
				stopReason: "stop",
				toolOutcomes: [
					{ tool: "read", success: true, file: "src/search-url.mjs", detail: "read implementation file" },
					{
						tool: "ls",
						success: true,
						detail: "tests",
						metadata: { directoryPath: "tests", entryCount: 1, entriesSample: ["search-url.test.mjs"] },
					},
					{ tool: "edit", success: true, file: "src/search-url.mjs", detail: "preserved explicit zero limit" },
				],
			},
			{
				text: "I added the regression test and verification passed.",
				stopReason: "stop",
				toolOutcomes: [
					{
						tool: "edit",
						success: true,
						file: "tests/search-url.test.mjs",
						detail: "added explicit zero-limit regression test",
					},
					{ tool: "bash", success: true, detail: "node --test && node scripts/check-regression-test.mjs" },
				],
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage,
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => toolHistory.filter((entry) => entry.tool === "read"),
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.prompt.mock.calls[1]?.[0]).toContain("patch `tests/search-url.test.mjs` now");
		expect(result.stopReason).toBe("complete");
	});

	test("carries misleading-sibling warnings into self-contained workspace prompts", async () => {
		const task = `You are in a self-contained benchmark workspace.

Task:

1. Fix the report rendering bug so the CLI output uses line breaks between summary items.
2. Be careful: there is a misleading similarly named formatter file in the workspace.
3. Run the verification command before your final answer.

Constraints:

- Stay inside this workspace.
- Keep the patch minimal.
- The intended verification command is: \`node --test\``;
		const { runtimeHost, session, toolHistory, fileHistory } = createRuntime([
			{
				text: "Task complete. I verified the implementation and no further changes are needed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "node --test" }],
			},
		]);

		await runAutonomousSession({
			runtimeHost,
			userMessage: task,
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(session.prompt.mock.calls[0]?.[0]).toContain("Treat similarly named files as traps");
		expect(session.prompt.mock.calls[0]?.[0]).toContain("reference output");
	});

	test("steers research tasks toward webSearch and then webFetch", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime(
			[
				{
					text: "I should look up the current documentation before I answer.",
					stopReason: "stop",
				},
				{
					text: "I searched the docs but still need to read the best source.",
					stopReason: "stop",
					toolOutcomes: [
						{
							tool: "webSearch",
							success: true,
							detail: "latest React 19 docs",
							metadata: {
								query: "latest React 19 docs",
								results: [{ title: "React Docs", url: "https://react.dev/" }],
							},
						},
					],
				},
				{
					text: "Task complete. I fetched the docs, verified the answer, and no further changes are needed.",
					stopReason: "stop",
					toolOutcomes: [
						{
							tool: "webFetch",
							success: true,
							detail: "https://react.dev/",
							metadata: { url: "https://react.dev/", title: "React", facts: ["React 19 is now stable."] },
						},
						{ tool: "bash", success: true, detail: "npm test" },
					],
				},
			],
			{
				availableToolNames: ["webSearch", "webFetch"],
			},
		);

		await runAutonomousSession({
			runtimeHost,
			userMessage: "Research the latest React 19 docs and update the integration notes",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt.mock.calls[0]?.[0]).toContain("use webSearch first");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("Use webSearch first");
		expect(session.prompt.mock.calls[2]?.[0]).toContain("Use webFetch now");
		expect(session.prompt.mock.calls[2]?.[0]).toContain("https://react.dev/");
	});

	test("treats a successful webSearch step as on-track research progress", async () => {
		const { runtimeHost, toolHistory } = createRuntime(
			[
				{
					text: "I searched the docs but still need to read the best source.",
					stopReason: "stop",
					toolOutcomes: [
						{
							tool: "webSearch",
							success: true,
							detail: "latest React 19 docs",
							metadata: {
								query: "latest React 19 docs",
								results: [{ title: "React Docs", url: "https://react.dev/" }],
							},
						},
					],
				},
				{
					text: "Task complete. I fetched the docs, verified the answer, and no further changes are needed.",
					stopReason: "stop",
					toolOutcomes: [
						{
							tool: "webFetch",
							success: true,
							detail: "https://react.dev/",
							metadata: { url: "https://react.dev/", title: "React", facts: ["React 19 is now stable."] },
						},
						{ tool: "bash", success: true, detail: "npm test" },
					],
				},
			],
			{
				availableToolNames: ["webSearch", "webFetch"],
			},
		);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "Research the latest React 19 docs and update the integration notes",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(result.ledger.research?.searchQueries).toContain("latest React 19 docs");
		expect(result.ledger.research?.fetchedUrls).toContain("https://react.dev/");
		expect(result.checkpointState.consecutiveIntentDriftCount).toBe(0);
	});

	test("reuses an existing fetched source during mixed implementation work instead of prompting for more web churn", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime(
			[
				{
					text: "I searched and fetched the source. Next I should reuse it to update the notes.",
					stopReason: "stop",
					toolOutcomes: [
						{
							tool: "webSearch",
							success: true,
							detail: "latest React 19 docs",
							metadata: {
								query: "latest React 19 docs",
								results: [{ title: "React Docs", url: "https://react.dev/" }],
							},
						},
						{
							tool: "webFetch",
							success: true,
							detail: "https://react.dev/",
							metadata: { url: "https://react.dev/", title: "React" },
						},
						{
							tool: "edit",
							success: true,
							file: "docs/integration-notes.md",
							detail: "updated integration notes draft",
						},
					],
				},
				{
					text: "Task complete. I reused the fetched documentation source and updated the notes.",
					stopReason: "stop",
					toolOutcomes: [{ tool: "bash", success: true, detail: "npm test" }],
				},
			],
			{
				availableToolNames: ["webSearch", "webFetch"],
			},
		);

		await runAutonomousSession({
			runtimeHost,
			userMessage: "Research the latest React 19 docs and update the integration notes",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt.mock.calls[1]?.[0]).toContain("Reuse the authoritative source already fetched");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("https://react.dev/");
	});

	test("stops browsing and synthesizes once research evidence is sufficient", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime(
			[
				{
					text: "I searched and fetched the source. I have enough to answer now.",
					stopReason: "stop",
					toolOutcomes: [
						{
							tool: "webSearch",
							success: true,
							detail: "latest React 19 docs",
							metadata: {
								query: "latest React 19 docs",
								results: [{ title: "React Docs", url: "https://react.dev/" }],
							},
						},
						{
							tool: "webFetch",
							success: true,
							detail: "https://react.dev/",
							metadata: { url: "https://react.dev/", title: "React", facts: ["React 19 is now stable."] },
						},
					],
				},
				{
					text: "Task complete. I summarized the source-backed answer and cited the supporting URLs.",
					stopReason: "stop",
				},
			],
			{
				availableToolNames: ["webSearch", "webFetch"],
			},
		);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "Research the latest React 19 docs and summarize the changes",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt.mock.calls[1]?.[0]).toContain("Stop browsing, synthesize the answer");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("React 19 is now stable.");
		expect(result.stopReason).toBe("complete");
		expect(result.ledger.research?.evidence?.status).toBe("sufficient");
	});

	test("keeps local implementation tasks out of research mode when they only mention versioned code", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime(
			[
				{
					text: "I inspected the local version banner implementation.",
					stopReason: "stop",
					toolOutcomes: [
						{ tool: "read", success: true, file: "src/version-banner.mjs", detail: "inspected banner logic" },
					],
				},
				{
					text: "I updated src/version-banner.mjs and node --test passed.",
					stopReason: "stop",
					toolOutcomes: [
						{ tool: "edit", success: true, file: "src/version-banner.mjs", detail: "uppercased staging label" },
						{ tool: "bash", success: true, detail: "node --test" },
					],
				},
			],
			{ availableToolNames: ["read", "edit", "bash", "webSearch", "webFetch"] },
		);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix the version banner so the staging label is uppercased",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => toolHistory.filter((entry) => entry.tool === "read"),
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.prompt.mock.calls[1]?.[0]).not.toContain("webSearch");
		expect(result.stopReason).toBe("complete");
	});

	test("keeps local fixture docs tasks out of research mode when the docs are provided in-workspace", async () => {
		const { runtimeHost, session, toolHistory, fileHistory } = createRuntime(
			[
				{
					text: "I read the provided docs excerpt and inspected the local request helper.",
					stopReason: "stop",
					toolOutcomes: [
						{
							tool: "read",
							success: true,
							file: "reference/abort-signal-timeout.md",
							detail: "read local migration note",
						},
						{ tool: "read", success: true, file: "src/request.mjs", detail: "inspected request helper" },
					],
				},
				{
					text: "I updated src/request.mjs, verified the migration with node --test, and no further changes are needed.",
					stopReason: "stop",
					toolOutcomes: [
						{ tool: "edit", success: true, file: "src/request.mjs", detail: "migrated timeout handling" },
						{ tool: "bash", success: true, detail: "node --test" },
					],
				},
			],
			{ availableToolNames: ["read", "edit", "bash", "webSearch", "webFetch"] },
		);

		const userMessage = [
			"You are in a self-contained benchmark workspace.",
			"Read the provided docs excerpt in `reference/abort-signal-timeout.md`.",
			"Migrate the request helper to follow that guidance.",
			"Stay inside this workspace.",
		].join("\n");

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage,
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(session.prompt.mock.calls[0]?.[0]).not.toContain("webSearch first");
		expect(session.prompt.mock.calls[1]?.[0]).not.toContain("Use webSearch first");
		expect(result.stopReason).toBe("complete");
	});

	test("adds single-file precision steering to self-contained workspace prompts", async () => {
		const { runtimeHost, session, toolHistory, fileHistory } = createRuntime([
			{
				text: "Updated `src/version-banner.mjs` and node --test passed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "node --test" }],
			},
		]);

		const userMessage = [
			"You are in a self-contained benchmark workspace.",
			"Fix the version banner so the staging environment label is uppercased.",
			"Do not touch generated files.",
			"Run the verification command before your final answer.",
			"Stay inside this workspace.",
			"Only the implementation file should need to change.",
			"The intended verification command is: `node --test`",
		].join("\n");

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage,
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(session.prompt.mock.calls[0]?.[0]).toContain("This is a single-file precision patch.");
		expect(session.prompt.mock.calls[0]?.[0]).toContain("Do not guess wildcard or glob paths like `tests/*.test.js`");
		expect(session.prompt.mock.calls[0]?.[0]).toContain(
			"do not turn the top-level listing into more subdirectory `ls` calls",
		);
		expect(session.prompt.mock.calls[0]?.[0]).toContain(
			"Do not inspect `generated/`, `reference/`, `cli/`, or sibling directories",
		);
		expect(result.stopReason).toBe("complete");
	});

	test("reads an explicitly named local reference before other self-contained discovery", async () => {
		const { runtimeHost, session, toolHistory, fileHistory } = createRuntime([
			{
				text: "Updated `src/request.mjs` and the verification command passed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "node --test" }],
			},
		]);

		const userMessage = [
			"You are in a self-contained benchmark workspace.",
			"Read the provided docs excerpt in `reference/abort-signal-timeout.md`.",
			"Migrate the request helper to follow that guidance.",
			"Stay inside this workspace.",
			"The intended verification command is: `node --test`",
		].join("\n");

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage,
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(session.prompt.mock.calls[0]?.[0]).toContain("`reference/abort-signal-timeout.md`");
		expect(session.prompt.mock.calls[0]?.[0]).toContain(
			"read that exact file before any directory listing or other discovery",
		);
		expect(result.stopReason).toBe("complete");
	});

	test("pushes self-contained patch tasks from the test file directly to the matching src file", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I read the failing test first.",
				stopReason: "stop",
				toolOutcomes: [
					{
						tool: "read",
						success: true,
						file: "tests/config-parser.test.mjs",
						detail: "read failing parser test",
					},
				],
			},
			{
				text: "I updated src/config-parser.mjs and node --test passed.",
				stopReason: "stop",
				toolOutcomes: [
					{
						tool: "read",
						success: true,
						file: "src/config-parser.mjs",
						detail: "read matching implementation file",
					},
					{
						tool: "edit",
						success: true,
						file: "src/config-parser.mjs",
						detail: "preserved explicit falsey values",
					},
					{ tool: "bash", success: true, detail: "node --test" },
				],
			},
		]);

		const userMessage = [
			"You are in a self-contained benchmark workspace.",
			"Fix the configuration parser so explicit falsey values from user input are preserved.",
			"Do not rewrite the tests.",
			"Run the verification command before your final answer.",
			"Stay inside this workspace.",
			"The intended verification command is: `node --test`",
		].join("\n");

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage,
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => toolHistory.filter((entry) => entry.tool === "read"),
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.prompt.mock.calls[1]?.[0]).toContain("Derive the matching implementation path from that test");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("Do not use ls, find, or bash discovery again");
		expect(result.stopReason).toBe("complete");
	});

	test("pushes docs-guided self-contained tasks from the named reference directly to src", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I listed the workspace first.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "ls", success: true, detail: "listed workspace files" }],
			},
			{
				text: "I read the reference, patched the implementation, and node --test passed.",
				stopReason: "stop",
				toolOutcomes: [
					{
						tool: "read",
						success: true,
						file: "reference/abort-signal-timeout.md",
						detail: "read named local reference",
					},
					{ tool: "read", success: true, file: "src/request.mjs", detail: "read implementation file" },
					{ tool: "edit", success: true, file: "src/request.mjs", detail: "migrated timeout helper" },
					{ tool: "bash", success: true, detail: "node --test" },
				],
			},
		]);

		const userMessage = [
			"You are in a self-contained benchmark workspace.",
			"Read the provided docs excerpt in `reference/abort-signal-timeout.md`.",
			"Migrate the request helper to follow that guidance.",
			"Stay inside this workspace.",
			"The intended verification command is: `node --test`",
		].join("\n");

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage,
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => toolHistory.filter((entry) => entry.tool === "read"),
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.prompt.mock.calls[1]?.[0]).toContain("`reference/abort-signal-timeout.md`");
		expect(session.prompt.mock.calls[1]?.[0]).toContain(
			"Read that exact file now before any more ls, find, grep, or bash discovery",
		);
		expect(session.prompt.mock.calls[1]?.[0]).toContain("instead of guessing alternate extensions or using globs");
		expect(result.stopReason).toBe("complete");
	});

	test("keeps docs-guided local migrations pinned to the first plausible src implementation file", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I read the reference, request helper, and then a helper file.",
				stopReason: "stop",
				toolOutcomes: [
					{
						tool: "read",
						success: true,
						file: "reference/abort-signal-timeout.md",
						detail: "read named local reference",
					},
					{ tool: "read", success: true, file: "src/request.mjs", detail: "read request helper implementation" },
					{ tool: "read", success: true, file: "src/fake-fetch.mjs", detail: "read helper dependency" },
				],
			},
			{
				text: "I patched src/request.mjs and node --test passed.",
				stopReason: "stop",
				toolOutcomes: [
					{
						tool: "edit",
						success: true,
						file: "src/request.mjs",
						detail: "migrated request helper to AbortSignal.timeout",
					},
					{ tool: "bash", success: true, detail: "node --test" },
				],
			},
		]);

		const userMessage = [
			"You are in a self-contained benchmark workspace.",
			"Read the provided docs excerpt in `reference/abort-signal-timeout.md`.",
			"Migrate the request helper to follow that guidance.",
			"Stay inside this workspace.",
			"The intended verification command is: `node --test`",
		].join("\n");

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage,
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => toolHistory.filter((entry) => entry.tool === "read"),
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.prompt.mock.calls[1]?.[0]).toContain("first plausible implementation file `src/request.mjs`");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("Do not pivot to `src/fake-fetch.mjs`");
		expect(result.stopReason).toBe("complete");
	});

	test("reads a custom local verifier script before patching regression-test tasks", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I listed the workspace and know this needs a code patch plus a regression test.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "ls", success: true, detail: "listed workspace files" }],
			},
			{
				text: "I read the verifier script, updated the patch and regression test, and the checks passed.",
				stopReason: "stop",
				toolOutcomes: [
					{
						tool: "read",
						success: true,
						file: "scripts/check-regression-test.mjs",
						detail: "read verifier script",
					},
					{ tool: "read", success: true, file: "tests/search-url.test.mjs", detail: "read regression test file" },
					{ tool: "read", success: true, file: "src/search-url.mjs", detail: "read implementation file" },
					{ tool: "edit", success: true, file: "src/search-url.mjs", detail: "preserved explicit zero limit" },
					{
						tool: "edit",
						success: true,
						file: "tests/search-url.test.mjs",
						detail: "added verifier-compatible regression test",
					},
					{ tool: "bash", success: true, detail: "node --test && node scripts/check-regression-test.mjs" },
				],
			},
		]);

		const userMessage = [
			"You are in a self-contained benchmark workspace.",
			"Fix the search URL builder so an explicit limit of `0` is preserved.",
			"Add a regression test for that case.",
			"Run the verification command before your final answer.",
			"Stay inside this workspace.",
			"The intended verification command is: `node --test && node scripts/check-regression-test.mjs`",
		].join("\n");

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage,
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => toolHistory.filter((entry) => entry.tool === "read"),
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.prompt.mock.calls[1]?.[0]).toContain(
			"custom verifier script at `scripts/check-regression-test.mjs`",
		);
		expect(session.prompt.mock.calls[1]?.[0]).toContain("exact regression-test expectations");
		expect(result.stopReason).toBe("complete");
	});

	test("keeps verifier-specific regression-test repair instructions inside self-contained nudges", async () => {
		evaluateNudgeWithCooldownMock.mockReturnValue({
			shouldNudge: true,
			nudgeType: "continue",
			shouldStop: false,
		});

		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I fixed the source path, but the verifier still reports a missing regression test.",
				stopReason: "stop",
				toolOutcomes: [
					{ tool: "read", success: true, file: "tests/search-url.test.mjs", detail: "read regression test file" },
					{ tool: "read", success: true, file: "src/search-url.mjs", detail: "read implementation file" },
					{
						tool: "read",
						success: true,
						file: "scripts/check-regression-test.mjs",
						detail: "read verifier script",
					},
					{ tool: "edit", success: true, file: "src/search-url.mjs", detail: "preserved explicit zero limit" },
					{
						tool: "bash",
						success: false,
						detail:
							"node --test && node scripts/check-regression-test.mjs — missing regression test for explicit zero limit",
					},
				],
			},
			{
				text: "Task complete. I updated the regression test, reran the checks, and no further changes are needed.",
				stopReason: "stop",
				toolOutcomes: [
					{
						tool: "edit",
						success: true,
						file: "tests/search-url.test.mjs",
						detail: "added verifier-compatible regression test",
					},
					{ tool: "bash", success: true, detail: "node --test && node scripts/check-regression-test.mjs" },
				],
			},
		]);

		const userMessage = [
			"You are in a self-contained benchmark workspace.",
			"Fix the search URL builder so an explicit limit of `0` is preserved.",
			"Add a regression test for that case.",
			"Run the verification command before your final answer.",
			"Stay inside this workspace.",
			"The intended verification command is: `node --test && node scripts/check-regression-test.mjs`",
		].join("\n");

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage,
			projectRoot: "/tmp",
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => toolHistory.filter((entry) => entry.tool === "read"),
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.prompt.mock.calls[1]?.[0]).toContain("remaining regression-test mismatch");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("tests/search-url.test.mjs");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("Do not reread or rediscover files first");
		expect(session.prompt.mock.calls[1]?.[0]).not.toContain("Edit `scripts/check-regression-test.mjs`");
		expect(result.stopReason).toBe("complete");
	});

	test("does not move self-contained regression-test tasks to verification before a test file changes", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I fixed the implementation and should verify now.",
				stopReason: "stop",
				toolOutcomes: [
					{ tool: "read", success: true, file: "tests/search-url.test.mjs", detail: "read regression test file" },
					{ tool: "read", success: true, file: "src/search-url.mjs", detail: "read implementation file" },
					{ tool: "edit", success: true, file: "src/search-url.mjs", detail: "preserved explicit zero limit" },
				],
			},
			{
				text: "I added the regression test and node --test passed.",
				stopReason: "stop",
				toolOutcomes: [
					{
						tool: "edit",
						success: true,
						file: "tests/search-url.test.mjs",
						detail: "added explicit zero-limit regression test",
					},
					{ tool: "bash", success: true, detail: "node --test && node scripts/check-regression-test.mjs" },
				],
			},
		]);

		const userMessage = [
			"You are in a self-contained benchmark workspace.",
			"Fix the search URL builder so an explicit limit of `0` is preserved.",
			"Add a regression test for that case.",
			"Run the verification command before your final answer.",
			"Stay inside this workspace.",
			"The intended verification command is: `node --test && node scripts/check-regression-test.mjs`",
		].join("\n");

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage,
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => toolHistory.filter((entry) => entry.tool === "read"),
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.prompt.mock.calls[1]?.[0]).toContain("explicitly requires a regression test change");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("patch `tests/search-url.test.mjs` now");
		expect(result.stopReason).toBe("complete");
	});

	test("pushes self-contained patch tasks from test-plus-src inspection into editing", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I read the test and the implementation file.",
				stopReason: "stop",
				toolOutcomes: [
					{
						tool: "read",
						success: true,
						file: "tests/config-parser.test.mjs",
						detail: "read failing parser test",
					},
					{
						tool: "read",
						success: true,
						file: "src/config-parser.mjs",
						detail: "read matching implementation file",
					},
				],
			},
			{
				text: "I updated src/config-parser.mjs and node --test passed.",
				stopReason: "stop",
				toolOutcomes: [
					{
						tool: "edit",
						success: true,
						file: "src/config-parser.mjs",
						detail: "preserved explicit falsey values",
					},
					{ tool: "bash", success: true, detail: "node --test" },
				],
			},
		]);

		const userMessage = [
			"You are in a self-contained benchmark workspace.",
			"Fix the configuration parser so explicit falsey values from user input are preserved.",
			"Do not rewrite the tests.",
			"Run the verification command before your final answer.",
			"Stay inside this workspace.",
			"The intended verification command is: `node --test`",
		].join("\n");

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage,
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => toolHistory.filter((entry) => entry.tool === "read"),
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.prompt.mock.calls[1]?.[0]).toContain("Stop discovery and patch the smallest required change now");
		expect(result.stopReason).toBe("complete");
	});

	test("forces same-file edit retries for single-file precision tasks after source inspection", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I read the test and source file.",
				stopReason: "stop",
				toolOutcomes: [
					{
						tool: "read",
						success: true,
						file: "tests/version-banner.test.mjs",
						detail: "read staging banner test",
					},
					{ tool: "read", success: true, file: "src/version-banner.mjs", detail: "read banner implementation" },
				],
			},
			{
				text: "Updated src/version-banner.mjs and node --test passed.",
				stopReason: "stop",
				toolOutcomes: [
					{ tool: "edit", success: true, file: "src/version-banner.mjs", detail: "uppercased staging label" },
					{ tool: "bash", success: true, detail: "node --test" },
				],
			},
		]);

		const userMessage = [
			"You are in a self-contained benchmark workspace.",
			"Fix the version banner so the staging environment label is uppercased.",
			"Do not touch generated files.",
			"Run the verification command before your final answer.",
			"Stay inside this workspace.",
			"Only the implementation file should need to change.",
			"The intended verification command is: `node --test`",
		].join("\n");

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage,
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => toolHistory.filter((entry) => entry.tool === "read"),
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.prompt.mock.calls[1]?.[0]).toContain("Only edit `src/version-banner.mjs`");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("emit one minimal valid edit tool call");
		expect(result.stopReason).toBe("complete");
	});

	test("treats failed edit attempts as blockers during single-file precision recovery", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I read the test and source file.",
				stopReason: "stop",
				toolOutcomes: [
					{
						tool: "read",
						success: true,
						file: "tests/version-banner.test.mjs",
						detail: "read staging banner test",
					},
					{ tool: "read", success: true, file: "src/version-banner.mjs", detail: "read banner implementation" },
				],
			},
			{
				text: "I tried the edit, but it did not apply.",
				stopReason: "stop",
				toolOutcomes: [
					{ tool: "edit", success: false, file: "src/version-banner.mjs", detail: "invalid edit command" },
				],
			},
			{
				text: "Updated src/version-banner.mjs and node --test passed.",
				stopReason: "stop",
				toolOutcomes: [
					{ tool: "edit", success: true, file: "src/version-banner.mjs", detail: "uppercased staging label" },
					{ tool: "bash", success: true, detail: "node --test" },
				],
			},
		]);

		const userMessage = [
			"You are in a self-contained benchmark workspace.",
			"Fix the version banner so the staging environment label is uppercased.",
			"Do not touch generated files.",
			"Run the verification command before your final answer.",
			"Stay inside this workspace.",
			"Only the implementation file should need to change.",
			"The intended verification command is: `node --test`",
		].join("\n");

		await runAutonomousSession({
			runtimeHost,
			userMessage,
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => toolHistory.filter((entry) => entry.tool === "read"),
		});

		expect(session.prompt).toHaveBeenCalledTimes(3);
		expect(session.prompt.mock.calls.at(-1)?.[0]).toContain(
			"The previous edit on `src/version-banner.mjs` did not apply",
		);
		expect(session.prompt.mock.calls.at(-1)?.[0]).toContain("Do not reread other files");
		expect(session.prompt.mock.calls.at(-1)?.[0]).toContain(
			"Emit one valid edit tool call on `src/version-banner.mjs` now",
		);
		expect(session.prompt.mock.calls.at(-1)?.[0]).toContain(
			"Use one native `edit` tool call with `path` and an `edits` array",
		);
	});

	test("resumes an interrupted autonomous run from the saved control state", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime(
			[
				{
					text: "Task complete. I summarized the source-backed answer and cited the supporting URLs.",
					stopReason: "stop",
				},
			],
			{
				availableToolNames: ["webSearch", "webFetch"],
			},
		);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "continue",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			resumeSnapshot: {
				version: 1,
				savedAt: "2026-04-12T12:00:00.000Z",
				phase: "post_turn",
				iterations: 2,
				stopReason: "unknown",
				costSummary: "$0.0004 | 20 in / 40 out",
				budgetStatus: {
					costUsed: 0.0004,
					costAuthoritative: false,
					tokensUsed: 40,
					turnsUsed: 2,
					exceeded: { cost: false, tokens: false, turns: false },
				},
				checkpointState: {
					consecutiveNoToolTurns: 0,
					completionPromptCount: 0,
					verificationPromptCount: 0,
					truncatedTurnCount: 0,
					outputCapPromptCount: 0,
					consecutiveIntentDriftCount: 0,
					consecutiveIntentFailureCount: 0,
					replanPromptCount: 0,
					narrowScopePromptCount: 0,
					budgetPressureLevel: "normal",
					budgetTrimPromptCount: 0,
					budgetSqueezePromptCount: 0,
					lastAssessment: "continue",
					verificationSatisfied: false,
					lastVerificationDetail: undefined,
				},
				ledger: {
					goal: "research the latest React 19 docs",
					status: "running",
					turnsObserved: 2,
					planner: {
						phase: "summarizing",
						lane: "research",
						planRevision: 1,
						executionAttempts: 1,
						handoffSummary:
							"Research evidence is sufficient. Stop browsing and synthesize the answer from the saved sources.",
					},
					resume: {
						mode: "resume_summarize",
						resumeInstruction:
							"Summarize the source-backed answer from the saved research artifacts, cite the supporting URLs, and stop unless a concrete evidence gap remains.",
						resumeReason:
							"The run already has enough authoritative evidence, so further browsing would waste budget instead of improving the answer.",
						lastStableCheckpoint: "Fetched React — https://react.dev/",
					},
					research: {
						searchQueries: ["React 19 documentation"],
						fetchedUrls: ["https://react.dev/"],
						sourceUrls: ["https://react.dev/"],
						preferredSourceUrls: ["https://react.dev/"],
						recentFindings: ["React Docs — https://react.dev/"],
						evidence: {
							status: "sufficient",
							authoritativeSourceCount: 1,
							fetchedSourceCount: 1,
							citedSourceCount: 1,
							findingCount: 1,
							citationReady: true,
							summaryReady: true,
							gaps: [],
						},
					},
					taskJournal: {
						activeSubtask: "Finalize and report verified completion",
						nextAction: "Stop and present the verified result",
						plannedNextStep:
							"Summarize the source-backed answer from the saved research artifacts, cite the supporting URLs, and stop unless a concrete evidence gap remains.",
						stepRationale:
							"The run already has enough authoritative evidence, so further browsing would waste budget instead of improving the answer.",
						expectedVerification: "Cite supporting source URLs such as https://react.dev/",
						intentStatus: "pending",
						lastIntentOutcome: undefined,
						planItems: [],
						completedCheckpoints: [],
						blockedReasons: [],
					},
					currentFocus: "synthesizing source-backed answer",
					progressDetail: undefined,
					lastActionType: "other",
					lastActionDetail: undefined,
					touchedFiles: [],
					readFiles: [],
					recentMutations: [],
					verificationAttempts: 0,
					verificationSatisfied: false,
					lastVerificationDetail: undefined,
					verificationFailures: [],
					residualRisks: [],
					discoveredFiles: [],
				},
			},
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(session.prompt.mock.calls[0]?.[0]).toContain("Resume the interrupted autonomous run");
		expect(session.prompt.mock.calls[0]?.[0]).toContain("Resume mode: resume_summarize");
		expect(session.prompt.mock.calls[0]?.[0]).toContain("Resume instruction:");
		expect(session.prompt.mock.calls[0]?.[0]).toContain("Do not restart from scratch");
		expect(result.stopReason).toBe("complete");
	});

	test("tracks structured run ledger state across mutations, verification, and risks", async () => {
		const { runtimeHost, toolHistory, fileHistory, sessionManager } = createRuntime([
			{
				text: "I updated the auth retry path, but remaining browser coverage is still a risk.",
				stopReason: "stop",
				toolOutcomes: [
					{ tool: "edit", success: true, file: "src/auth.ts", detail: "updated retry logic" },
					{ tool: "read", success: true, file: "src/auth.test.ts", detail: "read existing tests" },
					{ tool: "bash", success: true, detail: "npm test" },
				],
			},
			{
				text: "Task complete. I verified the implementation and no further changes are needed.",
				stopReason: "stop",
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix auth retry path",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(result.ledger.goal).toBe("fix auth retry path");
		expect(result.ledger.status).toBe("complete");
		expect(result.ledger.taskJournal.activeSubtask).toBe("Finalize and report verified completion");
		expect(result.ledger.taskJournal.nextAction).toBe("Stop and present the verified result");
		expect(result.ledger.taskJournal.plannedNextStep).toBe(
			"Summarize the verified result and note any residual risks.",
		);
		expect(result.ledger.taskJournal.stepRationale).toBe(
			"Verification is satisfied, so the remaining work is reporting clearly and stopping.",
		);
		expect(result.ledger.taskJournal.expectedVerification).toBe("npm test");
		expect(result.ledger.taskJournal.intentStatus).toBe("on_track");
		expect(result.ledger.taskJournal.lastIntentOutcome).toContain("completion matched the planned summarize step");
		expect(result.ledger.taskJournal.planItems).toEqual([
			{ key: "inspect", title: "Inspect relevant files", status: "completed" },
			{ key: "implement", title: "Apply workspace changes", status: "completed" },
			{ key: "verify", title: "Verify latest changes", status: "completed" },
			{ key: "summarize", title: "Summarize verified result", status: "completed" },
		]);
		expect(result.ledger.taskJournal.completedCheckpoints).toContain("workspace changes applied");
		expect(result.ledger.taskJournal.completedCheckpoints).toContain("verification passed: npm test");
		expect(result.ledger.taskJournal.blockedReasons).toEqual([]);
		expect(result.ledger.touchedFiles).toContain("src/auth.ts");
		expect(result.ledger.readFiles).toContain("src/auth.test.ts");
		expect(result.ledger.recentMutations).toContain("updated retry logic");
		expect(result.ledger.progressDetail).toBe("npm test");
		expect(result.ledger.lastActionType).toBe("verification");
		expect(result.ledger.lastActionDetail).toBe("npm test");
		expect(result.ledger.verificationAttempts).toBe(1);
		expect(result.ledger.verificationSatisfied).toBe(true);
		expect(result.ledger.lastVerificationDetail).toBe("npm test");
		expect(result.ledger.verificationFailures).toEqual([]);
		expect(result.ledger.residualRisks.join(" ")).toContain("remaining browser coverage");
		expect(sessionManager.appendCustomEntry.mock.calls.length).toBeGreaterThan(0);
		expect(sessionManager.appendCustomEntry.mock.calls.at(-1)?.[0]).toBe("autonomous_run_snapshot");
		expect(sessionManager.appendCustomEntry.mock.calls.at(-1)?.[1]?.phase).toBe("final");
	});

	test("derives focus and verification failure state from tool outcomes instead of assistant prose", async () => {
		const { runtimeHost, session, toolHistory, fileHistory, sessionManager } = createRuntime([
			{
				text: "I looked around.",
				stopReason: "stop",
				toolOutcomes: [
					{ tool: "edit", success: true, file: "src/auth.ts", detail: "updated retry logic" },
					{
						tool: "bash",
						success: false,
						detail: "npm test",
						metadata: { outputPreview: "missing regression test for explicit zero limit" },
					},
				],
			},
			{
				text: "Task complete. I verified the implementation and no further changes are needed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "npm test" }],
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix auth retry path",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(result.ledger.currentFocus).toContain("Running verification");
		expect(result.ledger.progressDetail).toBe("npm test");
		expect(result.ledger.verificationAttempts).toBe(2);
		expect(result.ledger.verificationFailures).toContain(
			"failed verification: npm test — missing regression test for explicit zero limit",
		);
		expect(result.ledger.residualRisks).toContain(
			"failed verification: npm test — missing regression test for explicit zero limit",
		);
		expect(session.prompt.mock.calls[1]?.[0]).toContain("Recover from the blocker before doing anything else");
		expect(session.prompt.mock.calls[1]?.[0]).toContain(
			"verification failed: missing regression test for explicit zero limit",
		);
		const blockerSnapshot = sessionManager.appendCustomEntry.mock.calls
			.map((call: any[]) => call[1])
			.find(
				(snapshot: any) =>
					snapshot?.phase === "pre_turn" &&
					snapshot?.ledger?.taskJournal?.plannedNextStep?.includes("Resolve blocker"),
			);
		expect(blockerSnapshot?.ledger?.taskJournal?.activeSubtask).toContain("Resolve verification failure");
		expect(blockerSnapshot?.ledger?.taskJournal?.nextAction).toContain("Resolve blocker");
		expect(blockerSnapshot?.ledger?.taskJournal?.plannedNextStep).toContain("Resolve blocker");
		expect(blockerSnapshot?.ledger?.taskJournal?.expectedVerification).toContain("npm test");
		expect(blockerSnapshot?.ledger?.taskJournal?.intentStatus).toBe("pending");
		expect(blockerSnapshot?.ledger?.taskJournal?.planItems).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: "inspect", status: "completed" }),
				expect.objectContaining({ key: "implement", status: "completed" }),
				expect.objectContaining({ key: "verify", status: "blocked" }),
			]),
		);
	});

	test("normalizes failed workspace edit targets back to relative paths in repair prompts", async () => {
		const task = `You are in a self-contained benchmark workspace.

Task:

1. Fix the session state bug so saved scopes can be listed correctly for a user.
2. Keep the fix focused.
3. Run the verification command before your final answer.

Constraints:

- Stay inside this workspace.
- The intended verification command is: \`node --test\``;
		const { runtimeHost, toolHistory } = createRuntime([
			{
				text: "I found the bug but the edit path was malformed.",
				stopReason: "stop",
				toolOutcomes: [
					{ tool: "read", success: true, file: "tests/session-store.test.mjs", detail: "read failing test" },
					{ tool: "read", success: true, file: "src/session-index.mjs", detail: "read index helper" },
					{ tool: "read", success: true, file: "src/key-normalizer.mjs", detail: "read key parser" },
					{
						tool: "edit",
						success: false,
						file: "tmp/harness-benchmark-v3-smoke-cross-file-rerun37/ag1/debug_cross_file_state_bug/fixture/workspace/src/key-normalizer.mjs",
					},
				],
			},
			{
				text: "Task complete. I fixed the parser and verified the implementation.",
				stopReason: "stop",
				toolOutcomes: [
					{ tool: "edit", success: true, file: "src/key-normalizer.mjs", detail: "fixed key separator mismatch" },
					{ tool: "bash", success: true, detail: "node --test" },
				],
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: task,
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => toolHistory.filter((entry) => entry.tool === "read"),
		});

		expect(result.ledger.currentFocus ?? "").not.toContain("fixture/workspace/src/key-normalizer.mjs");
		expect(result.stopReason).toBe("complete");
	});

	test("turns concrete verifier complaints on required-test tasks into direct test-file repair guidance", async () => {
		const task = `You are in a self-contained benchmark workspace.

Task:

1. Fix the search URL builder so an explicit limit of \`0\` is preserved.
2. Add a regression test for that case.
3. Run the verification command before your final answer.

Constraints:

- Stay inside this workspace.
- The intended verification command is: \`node --test && node scripts/check-regression-test.mjs\``;
		const { runtimeHost, session, toolHistory, fileHistory, sessionManager } = createRuntime([
			{
				text: "I fixed the source code and verification now points at the remaining test mismatch.",
				stopReason: "stop",
				toolOutcomes: [
					{ tool: "read", success: true, file: "tests/search-url.test.mjs", detail: "read regression test file" },
					{ tool: "read", success: true, file: "src/search-url.mjs", detail: "read source file" },
					{ tool: "edit", success: true, file: "src/search-url.mjs", detail: "preserved explicit zero limit" },
					{
						tool: "bash",
						success: false,
						detail: "node --test && node scripts/check-regression-test.mjs",
						metadata: { outputPreview: "missing regression test for explicit zero limit" },
					},
				],
			},
			{
				text: "Task complete. I updated the regression test, reran verification, and no further changes are needed.",
				stopReason: "stop",
				toolOutcomes: [
					{
						tool: "edit",
						success: true,
						file: "tests/search-url.test.mjs",
						detail: "matched verifier-required regression test wording",
					},
					{ tool: "bash", success: true, detail: "node --test && node scripts/check-regression-test.mjs" },
				],
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: task,
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(session.prompt.mock.calls[1]?.[0]).toContain(
			"Verification already identified the remaining regression-test mismatch",
		);
		expect(session.prompt.mock.calls[1]?.[0]).toContain("tests/search-url.test.mjs");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("Do not reread or rediscover files first");
		expect(sessionManager.appendCustomEntry.mock.calls.length).toBeGreaterThan(0);
		expect(result.stopReason).toBe("complete");
	});

	test("writes explicit turn intent into pre-turn checkpoints", async () => {
		const { runtimeHost, toolHistory, fileHistory, sessionManager } = createRuntime([
			{
				text: "I inspected the auth flow and identified the next change.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "read", success: true, file: "src/auth.ts", detail: "read auth flow" }],
			},
			{
				text: "Task complete. I verified the implementation and no further changes are needed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "npm test" }],
			},
		]);

		await runAutonomousSession({
			runtimeHost,
			userMessage: "fix auth retry path",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		const preTurnSnapshot = sessionManager.appendCustomEntry.mock.calls
			.map((call: any[]) => call[1])
			.find((snapshot: any) => snapshot?.phase === "pre_turn" && snapshot?.ledger?.taskJournal?.plannedNextStep);
		expect(preTurnSnapshot?.ledger?.taskJournal?.plannedNextStep).toBe(
			"Patch src/auth.ts now. Do not rediscover files first.",
		);
		expect(preTurnSnapshot?.ledger?.taskJournal?.stepRationale).toBe(
			"The run already has the relevant implementation context in hand, so the next step should be a direct code change rather than more inspection.",
		);
		expect(preTurnSnapshot?.ledger?.taskJournal?.expectedVerification).toBe(
			"After the change, run the relevant test, lint, build, or verify command",
		);
		expect(preTurnSnapshot?.ledger?.taskJournal?.intentStatus).toBe("pending");
	});

	test("does not proactively compact before the minimum maturity window", async () => {
		const { runtimeHost, session, toolHistory, fileHistory } = createRuntime([
			{
				text: "I verified the auth retry path and captured the latest test result.",
				stopReason: "stop",
				toolOutcomes: [
					{ tool: "edit", success: true, file: "src/auth.ts", detail: "updated retry logic" },
					{ tool: "bash", success: true, detail: "npm test" },
				],
			},
			{
				text: "I double-checked the auth guard path and kept the verification notes ready.",
				stopReason: "stop",
			},
			{
				text: "Task complete. I verified the implementation and no further changes are needed.",
				stopReason: "stop",
			},
		]);
		session.getContextUsage = vi
			.fn()
			.mockReturnValueOnce({ tokens: 80_000, contextWindow: 100_000, percent: 80 })
			.mockReturnValueOnce(null);

		await runAutonomousSession({
			runtimeHost,
			userMessage: "fix auth retry path",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			resumeSnapshot: {
				version: 1,
				savedAt: "2026-04-12T12:00:00.000Z",
				phase: "post_turn",
				iterations: 4,
				stopReason: "unknown",
				costSummary: "$0.0008 | 40 in / 80 out",
				budgetStatus: {
					costUsed: 0.0008,
					costAuthoritative: false,
					tokensUsed: 80,
					turnsUsed: 4,
					exceeded: { cost: false, tokens: false, turns: false },
				},
				checkpointState: {
					consecutiveNoToolTurns: 0,
					completionPromptCount: 0,
					verificationPromptCount: 0,
					truncatedTurnCount: 0,
					outputCapPromptCount: 0,
					consecutiveIntentDriftCount: 0,
					consecutiveIntentFailureCount: 0,
					replanPromptCount: 0,
					narrowScopePromptCount: 0,
					budgetPressureLevel: "normal",
					budgetTrimPromptCount: 0,
					budgetSqueezePromptCount: 0,
					lastAssessment: "continue",
					verificationSatisfied: false,
					lastVerificationDetail: undefined,
				},
				ledger: {
					goal: "fix auth retry path",
					status: "running",
					turnsObserved: 4,
					planner: {
						phase: "executing",
						lane: "generic",
						planRevision: 1,
						executionAttempts: 1,
						handoffSummary: "Finish verification and summarize the auth retry fix.",
					},
					taskJournal: {
						activeSubtask: "Verify the auth retry fix",
						nextAction: "Run the latest verification and summarize the result",
						plannedNextStep: "Run the latest verification and summarize the result",
						stepRationale: "The file is already patched; the next step is preserving verification state.",
						intentStatus: "pending",
						planItems: [
							{ key: "implement", title: "Apply workspace changes", status: "completed" },
							{ key: "verify", title: "Verify latest changes", status: "active" },
							{ key: "summarize", title: "Summarize verified result", status: "pending" },
						],
						completedCheckpoints: [],
						blockedReasons: [],
					},
					touchedFiles: ["src/auth.ts"],
					readFiles: ["src/auth.ts"],
					recentMutations: ["src/auth.ts"],
					verificationAttempts: 0,
					verificationSatisfied: false,
					verificationFailures: [],
					residualRisks: [],
					discoveredFiles: [],
					resume: {
						mode: "resume_execute",
						resumeInstruction: "Run the latest verification and summarize the result",
						resumeReason: "The file is already patched; preserve verification state before summarizing.",
					},
				},
			},
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(session.compact).not.toHaveBeenCalled();
	});

	test("persists incremental autonomous checkpoints during the run", async () => {
		const { runtimeHost, sessionManager, toolHistory, fileHistory } = createRuntime([
			{
				text: "I updated the auth retry path.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "edit", success: true, file: "src/auth.ts", detail: "updated retry logic" }],
			},
			{
				text: "I inspected the remaining checks and identified the next verification step.",
				stopReason: "stop",
			},
			{
				text: "Task complete. I verified the implementation and no further changes are needed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "npm test" }],
			},
		]);

		await runAutonomousSession({
			runtimeHost,
			userMessage: "fix auth retry path",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		const phases = sessionManager.appendCustomEntry.mock.calls.map((call: any[]) => call[1]?.phase);
		expect(phases[0]).toBe("initial");
		expect(phases).toContain("pre_turn");
		expect(phases).toContain("post_turn");
		expect(phases.at(-1)).toBe("final");
	});

	test("emits live checkpoints through the callback during the run", async () => {
		const { runtimeHost, toolHistory, fileHistory } = createRuntime([
			{
				text: "I updated the auth retry path.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "edit", success: true, file: "src/auth.ts", detail: "updated retry logic" }],
			},
			{
				text: "Task complete. I verified the implementation and no further changes are needed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "npm test" }],
			},
		]);
		const snapshots: Array<{ phase: string; stopReason: string }> = [];

		await runAutonomousSession({
			runtimeHost,
			userMessage: "fix auth retry path",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
			onCheckpoint: (snapshot) => {
				snapshots.push({ phase: snapshot.phase, stopReason: snapshot.stopReason });
			},
		});

		expect(snapshots[0]?.phase).toBe("initial");
		expect(snapshots.some((snapshot) => snapshot.phase === "pre_turn")).toBe(true);
		expect(snapshots.some((snapshot) => snapshot.phase === "post_turn")).toBe(true);
		expect(snapshots.at(-1)).toEqual(expect.objectContaining({ phase: "final", stopReason: "complete" }));
	});

	test("requires verification evidence before accepting completion", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "Task complete. I finished the implementation.",
				stopReason: "stop",
			},
			{
				text: "Task complete. I verified the implementation and no further changes are needed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "npm test" }],
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix it",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.prompt.mock.calls[1]?.[0]).toContain("concrete verification");
		expect(result.stopReason).toBe("complete");
	});

	test("escalates repeated completion claims that still lack verification", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "Task complete. I finished the implementation.",
				stopReason: "stop",
			},
			{
				text: "Task complete. The changes are done.",
				stopReason: "stop",
			},
			{
				text: "Task complete. I verified the implementation and no further changes are needed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "npm test" }],
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix it",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt).toHaveBeenCalledTimes(3);
		expect(session.prompt.mock.calls[1]?.[0]).toContain("did not provide concrete verification");
		expect(session.prompt.mock.calls[2]?.[0]).toContain("Replan into 1-2 concrete steps");
		expect(result.stopReason).toBe("complete");
		expect(result.checkpointState.verificationPromptCount).toBe(2);
	});

	test("honors enableNudges=false in the shared runner", async () => {
		evaluateNudgeWithCooldownMock.mockReturnValue({
			shouldNudge: true,
			nudgeType: "pivot",
			shouldStop: false,
		});

		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I inspected the codebase and identified the next changes.",
				stopReason: "stop",
			},
			{
				text: "Task complete. I verified the implementation and no further changes are needed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "npm test" }],
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix it",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.prompt.mock.calls[1]?.[0]).not.toBe("NUDGE_MESSAGE");
		expect(evaluateNudgeWithCooldownMock).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("complete");
	});

	test("uses workspace-direct nudge wording for self-contained local tasks", async () => {
		evaluateNudgeWithCooldownMock.mockReturnValue({
			shouldNudge: true,
			nudgeType: "continue",
			shouldStop: false,
		});

		const task = `You are in a self-contained benchmark workspace.

Task:

1. Fix the report rendering bug so the CLI output uses line breaks between summary items.
2. Run the verification command before your final answer.

Constraints:

- Stay inside this workspace.
- The intended verification command is: \`node --test\``;
		const { runtimeHost, session, toolHistory, fileHistory } = createRuntime([
			{
				text: "I listed the workspace and now know where to look next.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "ls", success: true, detail: ".", file: "." }],
			},
			{
				text: "Task complete. I verified the implementation and no further changes are needed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "node --test" }],
			},
		]);

		await runAutonomousSession({
			runtimeHost,
			userMessage: task,
			projectRoot: "/tmp",
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(session.prompt.mock.calls[1]?.[0]).toContain("Continue with the next direct workspace step only");
		expect(session.prompt.mock.calls[1]?.[0]).not.toContain("Elaborate on your findings");
	});

	test("keeps self-contained continue nudges focused on the required test update before verification", async () => {
		evaluateNudgeWithCooldownMock.mockReturnValue({
			shouldNudge: true,
			nudgeType: "continue",
			shouldStop: false,
		});

		const userMessage = [
			"You are in a self-contained benchmark workspace.",
			"Fix the search URL builder so an explicit limit of `0` is preserved.",
			"Add a regression test for that case.",
			"Run the verification command before your final answer.",
			"Stay inside this workspace.",
			"The intended verification command is: `node --test && node scripts/check-regression-test.mjs`",
		].join("\n");
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I fixed the implementation and still need to add the regression test.",
				stopReason: "stop",
				toolOutcomes: [
					{ tool: "read", success: true, file: "src/search-url.mjs", detail: "read implementation file" },
					{
						tool: "ls",
						success: true,
						detail: "tests",
						metadata: { directoryPath: "tests", entryCount: 1, entriesSample: ["search-url.test.mjs"] },
					},
					{ tool: "edit", success: true, file: "src/search-url.mjs", detail: "preserved explicit zero limit" },
				],
			},
			{
				text: "I added the regression test and verification passed.",
				stopReason: "stop",
				toolOutcomes: [
					{
						tool: "edit",
						success: true,
						file: "tests/search-url.test.mjs",
						detail: "added explicit zero-limit regression test",
					},
					{ tool: "bash", success: true, detail: "node --test && node scripts/check-regression-test.mjs" },
				],
			},
		]);

		await runAutonomousSession({
			runtimeHost,
			userMessage,
			projectRoot: "/tmp",
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => toolHistory.filter((entry) => entry.tool === "read"),
		});

		expect(session.prompt.mock.calls[1]?.[0]).toContain("regression test update");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("`tests/search-url.test.mjs`");
		expect(session.prompt.mock.calls[1]?.[0]).not.toContain("Run the intended local verification now");
	});

	test("uses maxOutputPerTurn to push the next continuation toward concise output", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I explored a lot of context and explained too much.",
				stopReason: "stop",
				outputTokens: 500,
			},
			{
				text: "Task complete. I verified the implementation and no further changes are needed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "npm test" }],
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix it",
			projectRoot: "/tmp",
			config: { enableNudges: false, maxOutputPerTurn: 200 },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.prompt.mock.calls[1]?.[0]).toContain("output budget");
		expect(result.checkpointState.outputCapPromptCount).toBe(1);
		expect(result.stopReason).toBe("complete");
	});

	test("trims scope under high budget pressure before exploring further", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I inspected the codebase and identified the next implementation step.",
				stopReason: "stop",
				outputTokens: 20,
			},
			{
				text: "Task complete. I verified the implementation and no further changes are needed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "npm test" }],
				outputTokens: 20,
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix it",
			projectRoot: "/tmp",
			config: { enableNudges: false, maxTokens: 35 },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.prompt.mock.calls[1]?.[0]).toContain("Budget pressure is rising");
		expect(result.checkpointState.budgetPressureLevel).toBe("high");
		expect(result.checkpointState.budgetTrimPromptCount).toBe(1);
		expect(result.stopReason).toBe("complete");
	});

	test("forces verify-and-stop behavior under critical budget pressure", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I inspected the codebase and identified the next implementation step.",
				stopReason: "stop",
				outputTokens: 20,
			},
			{
				text: "Task complete. I verified the implementation and no further changes are needed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "npm test" }],
				outputTokens: 20,
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix it",
			projectRoot: "/tmp",
			config: { enableNudges: false, maxTokens: 32 },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.prompt.mock.calls[1]?.[0]).toContain("Budget is nearly exhausted");
		expect(result.checkpointState.budgetPressureLevel).toBe("critical");
		expect(result.checkpointState.budgetSqueezePromptCount).toBe(1);
		expect(result.stopReason).toBe("complete");
	});

	test("uses visual verification prompts for frontend work when screenshot tools are available", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime(
			[
				{
					text: "I updated the UI styling.",
					stopReason: "stop",
					toolOutcomes: [{ tool: "edit", success: true, file: "src/app.tsx", detail: "updated dashboard layout" }],
				},
				{
					text: "Task complete. I verified the implementation and no further changes are needed.",
					stopReason: "stop",
					toolOutcomes: [{ tool: "screenshot_url", success: true, detail: "http://localhost:3000/dashboard" }],
				},
			],
			{ availableToolNames: ["screenshot_url", "interact_then_screenshot"] },
		);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix the frontend dashboard layout",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.prompt.mock.calls[1]?.[0]).toContain("screenshot_url");
		expect(result.stopReason).toBe("complete");
		expect(result.checkpointState.verificationSatisfied).toBe(true);
	});

	test("accepts screenshot-based verification for frontend runs", async () => {
		const { runtimeHost, toolHistory } = createRuntime(
			[
				{
					text: "I updated the landing page layout.",
					stopReason: "stop",
					toolOutcomes: [
						{ tool: "edit", success: true, file: "src/homepage.tsx", detail: "updated hero layout" },
						{
							tool: "screenshot_url",
							success: true,
							detail: "http://localhost:3000",
							metadata: {
								url: "http://localhost:3000",
								title: "Landing",
								loadTimeMs: 380,
								consoleErrors: [],
								failedRequests: [],
							},
						},
					],
				},
				{
					text: "Task complete. I verified the implementation and no further changes are needed.",
					stopReason: "stop",
				},
			],
			{ availableToolNames: ["screenshot_url"] },
		);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "improve the landing page UI",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(result.stopReason).toBe("complete");
		expect(result.ledger.lastVerificationDetail).toBe("http://localhost:3000");
		expect(result.ledger.verificationSatisfied).toBe(true);
		expect(result.ledger.taskJournal.expectedVerification).toBe("http://localhost:3000");
		expect(result.ledger.visualTarget).toEqual(
			expect.objectContaining({
				surface: "landing page",
				goalSummary: "improve the landing page UI",
			}),
		);
		expect(result.ledger.visualTarget?.viewportProfile).toBeUndefined();
		expect(result.ledger.visualTarget?.acceptanceCriteria).toEqual(
			expect.arrayContaining([
				"render without console or network issues",
				"the landing page layout should reflect the requested visual change",
			]),
		);
		expect(result.ledger.visualIteration).toEqual(
			expect.objectContaining({
				enabled: true,
				phase: "verified",
			}),
		);
		expect(result.ledger.visualIteration?.observationSummary).toContain("no console or network issues");
		expect(result.ledger.visualIteration?.outstandingIssues).toEqual([]);
		expect(result.ledger.visualAssessment).toEqual(
			expect.objectContaining({
				latestJudgment: "pass",
			}),
		);
		expect(result.ledger.visualIteration?.recentArtifacts[0]).toEqual(
			expect.objectContaining({
				url: "http://localhost:3000",
				title: "Landing",
				loadTimeMs: 380,
			}),
		);
		expect(result.ledger.residualRisks).not.toEqual(expect.arrayContaining(["console errors: hydration mismatch"]));
	});

	test("asks for a final verified summary after a passing verification turn", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I updated the auth retry path.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "edit", success: true, file: "src/auth.ts", detail: "updated retry logic" }],
			},
			{
				text: "npm test passed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "npm test" }],
			},
			{
				text: "Updated src/auth.ts to fix the auth retry path, and npm test passed.",
				stopReason: "stop",
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix auth retry path",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt).toHaveBeenCalledTimes(3);
		expect(session.prompt.mock.calls[2]?.[0]).toContain(
			"Summarize the verified result, note any residual risks, and stop.",
		);
		expect(session.prompt.mock.calls[2]?.[0]).toContain("Do not call any more tools");
		expect(result.stopReason).toBe("complete");
		expect(result.ledger.verificationSatisfied).toBe(true);
		expect(result.ledger.lastVerificationDetail).toBe("npm test");
	});

	test("stops after a verified summary turn without requiring explicit completion wording", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I updated the config parser implementation.",
				stopReason: "stop",
				toolOutcomes: [
					{
						tool: "edit",
						success: true,
						file: "src/config-parser.mjs",
						detail: "preserved explicit falsey values",
					},
				],
			},
			{
				text: "Updated src/config-parser.mjs to preserve explicit falsey values, and node --test passed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "node --test" }],
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix the config parser",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(result.stopReason).toBe("complete");
		expect(result.ledger.verificationSatisfied).toBe(true);
	});

	test("stops after a concrete verified summary even when the ledger has not recorded the change yet", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "Updated `src/version-banner.mjs` to uppercase the staging label, and node --test passed.",
				stopReason: "stop",
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix the version banner so the staging environment label is uppercased",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("complete");
	});

	test("does not treat a diagnostic summary with future verification language as complete", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "The fix should be in src/formatter.mjs. Let me run node --test first.",
				stopReason: "stop",
			},
			{
				text: "Updated src/formatter.mjs and node --test passed.",
				stopReason: "stop",
				toolOutcomes: [
					{ tool: "edit", success: true, file: "src/formatter.mjs", detail: "joined summary items with newline" },
					{ tool: "bash", success: true, detail: "node --test" },
				],
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: [
				"You are in a self-contained benchmark workspace.",
				"Fix the report rendering bug.",
				"Run the verification command before your final answer.",
				"Stay inside this workspace.",
				"The intended verification command is: `node --test`",
			].join("\n"),
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(result.stopReason).toBe("complete");
		expect(result.ledger.verificationSatisfied).toBe(true);
	});

	test("treats fixed plus verification-passed summaries as explicit completion", async () => {
		const { runtimeHost, session, toolHistory, fileHistory } = createRuntime([
			{
				text: "Bug fixed. Verification passed: node --test passes and the patch is complete.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "node --test" }],
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix it",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("complete");
	});

	test("stops after a clean visual recapture without requiring extra completion wording", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime(
			[
				{
					text: "I updated the dashboard layout.",
					stopReason: "stop",
					toolOutcomes: [
						{ tool: "edit", success: true, file: "src/dashboard.tsx", detail: "updated dashboard spacing" },
					],
				},
				{
					text: "The updated dashboard recapture is clean and has no runtime issues.",
					stopReason: "stop",
					toolOutcomes: [
						{
							tool: "screenshot_url",
							success: true,
							detail: "http://localhost:3000/dashboard-after",
							metadata: {
								url: "http://localhost:3000/dashboard-after",
								title: "Dashboard",
								loadTimeMs: 220,
								consoleErrors: [],
								failedRequests: [],
							},
						},
					],
				},
			],
			{ availableToolNames: ["screenshot_url"] },
		);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "tighten the dashboard layout spacing",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(result.stopReason).toBe("complete");
		expect(result.ledger.visualAssessment).toEqual(
			expect.objectContaining({
				latestJudgment: "pass",
			}),
		);
	});

	test("does not stop on a baseline screenshot alone for change-oriented frontend tasks", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime(
			[
				{
					text: "I captured the current landing page baseline.",
					stopReason: "stop",
					toolOutcomes: [
						{
							tool: "screenshot_url",
							success: true,
							detail: "http://localhost:3000/baseline",
							metadata: {
								url: "http://localhost:3000/baseline",
								title: "Landing",
								loadTimeMs: 210,
								consoleErrors: [],
								failedRequests: [],
							},
						},
					],
				},
				{
					text: "I updated the landing page hero layout.",
					stopReason: "stop",
					toolOutcomes: [{ tool: "edit", success: true, file: "src/homepage.tsx", detail: "updated hero layout" }],
				},
				{
					text: "The updated landing page recapture is clean and stable.",
					stopReason: "stop",
					toolOutcomes: [
						{
							tool: "screenshot_url",
							success: true,
							detail: "http://localhost:3000/final",
							metadata: {
								url: "http://localhost:3000/final",
								title: "Landing",
								loadTimeMs: 200,
								consoleErrors: [],
								failedRequests: [],
							},
						},
					],
				},
			],
			{ availableToolNames: ["screenshot_url"] },
		);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "improve the landing page UI",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt).toHaveBeenCalledTimes(3);
		expect(result.stopReason).toBe("complete");
		expect(result.ledger.touchedFiles).toContain("src/homepage.tsx");
	});

	test("blocks frontend completion when visual verification finds runtime issues", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime(
			[
				{
					text: "I updated the landing page layout and verified it.",
					stopReason: "stop",
					toolOutcomes: [
						{ tool: "edit", success: true, file: "src/homepage.tsx", detail: "updated hero layout" },
						{
							tool: "screenshot_url",
							success: true,
							detail: "http://localhost:3000",
							metadata: {
								url: "http://localhost:3000",
								title: "Landing",
								loadTimeMs: 380,
								consoleErrors: ["hydration mismatch"],
								failedRequests: ["GET http://localhost:3000/api/hero — HTTP 500"],
							},
						},
					],
				},
				{
					text: "Task complete. I fixed the visual issues and verified the updated UI.",
					stopReason: "stop",
					toolOutcomes: [
						{
							tool: "edit",
							success: true,
							file: "src/homepage.tsx",
							detail: "fixed hydration mismatch handling",
						},
						{
							tool: "screenshot_url",
							success: true,
							detail: "http://localhost:3000/final",
							metadata: {
								url: "http://localhost:3000/final",
								title: "Landing",
								loadTimeMs: 360,
								consoleErrors: [],
								failedRequests: [],
							},
						},
					],
				},
			],
			{ availableToolNames: ["screenshot_url"] },
		);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "improve the landing page UI",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.prompt.mock.calls[1]?.[0]).toContain("Recover from the blocker");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("console errors: hydration mismatch");
		expect(result.stopReason).toBe("complete");
		expect(result.ledger.visualAssessment).toEqual(
			expect.objectContaining({
				latestJudgment: "pass",
			}),
		);
		expect(result.ledger.visualIteration?.lastScreenshotDetail).toBe("http://localhost:3000/final");
	});

	test("captures a visual baseline before further frontend changes", async () => {
		const { runtimeHost, session, toolHistory, fileHistory, sessionManager } = createRuntime(
			[
				{
					text: "I inspected the landing page structure and identified the first UI change.",
					stopReason: "stop",
					toolOutcomes: [
						{ tool: "read", success: true, file: "src/homepage.tsx", detail: "read landing page layout" },
					],
				},
				{
					text: "I captured the baseline and updated the hero layout.",
					stopReason: "stop",
					toolOutcomes: [
						{ tool: "screenshot_url", success: true, detail: "http://localhost:3000/baseline" },
						{ tool: "edit", success: true, file: "src/homepage.tsx", detail: "updated hero layout" },
					],
				},
				{
					text: "Task complete. I verified the implementation and no further changes are needed.",
					stopReason: "stop",
					toolOutcomes: [{ tool: "screenshot_url", success: true, detail: "http://localhost:3000/final" }],
				},
			],
			{ availableToolNames: ["screenshot_url"] },
		);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "improve the landing page UI",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(session.prompt.mock.calls[1]?.[0]).toContain("Capture a baseline screenshot");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("landing page");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("render without console or network issues");
		const baselineSnapshot = sessionManager.appendCustomEntry.mock.calls
			.map((call: any[]) => call[1])
			.find(
				(snapshot: any) =>
					snapshot?.phase === "pre_turn" && snapshot?.ledger?.visualIteration?.phase === "baseline_capture",
			);
		expect(baselineSnapshot?.ledger?.taskJournal?.plannedNextStep).toContain("Capture a baseline screenshot");
		expect(baselineSnapshot?.ledger?.visualTarget?.surface).toBe("landing page");
		expect(result.ledger.visualIteration).toEqual(
			expect.objectContaining({
				enabled: true,
				phase: "verified",
				screenshotAttempts: 2,
				lastScreenshotDetail: "http://localhost:3000/final",
			}),
		);
		expect(result.stopReason).toBe("complete");
	});

	test("guides visual verification toward the intended mobile viewport", async () => {
		const { runtimeHost, session, toolHistory, fileHistory, sessionManager } = createRuntime(
			[
				{
					text: "I inspected the checkout page and identified the first responsive fix.",
					stopReason: "stop",
					toolOutcomes: [
						{ tool: "read", success: true, file: "src/checkout.tsx", detail: "read checkout layout" },
					],
				},
				{
					text: "Task complete. I verified the implementation and no further changes are needed.",
					stopReason: "stop",
					toolOutcomes: [{ tool: "screenshot_url", success: true, detail: "http://localhost:3000/checkout" }],
				},
			],
			{ availableToolNames: ["screenshot_url"] },
		);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix the mobile checkout layout so it is responsive",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(session.prompt.mock.calls[1]?.[0]).toContain("mobile viewport");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("390x844");
		const preTurnSnapshot = sessionManager.appendCustomEntry.mock.calls
			.map((call: any[]) => call[1])
			.find((snapshot: any) => snapshot?.phase === "pre_turn" && snapshot?.ledger?.visualTarget);
		expect(preTurnSnapshot?.ledger?.visualTarget).toEqual(
			expect.objectContaining({
				viewportProfile: "mobile",
				viewportHint: "mobile viewport (for example 390x844)",
			}),
		);
		expect(result.ledger.visualTarget?.acceptanceCriteria).toEqual(
			expect.arrayContaining(["look correct at the intended mobile viewport and breakpoint"]),
		);
		expect(result.stopReason).toBe("complete");
	});

	test("guides visual verification toward interactive UI state when needed", async () => {
		const { runtimeHost, session, toolHistory, fileHistory, sessionManager } = createRuntime(
			[
				{
					text: "I inspected the checkout page and identified the cart drawer issue.",
					stopReason: "stop",
					toolOutcomes: [
						{ tool: "read", success: true, file: "src/checkout.tsx", detail: "read checkout cart drawer state" },
					],
				},
				{
					text: "I captured the checkout drawer and found the exact interaction flow needed.",
					stopReason: "stop",
					toolOutcomes: [
						{
							tool: "interact_then_screenshot",
							success: true,
							detail: "http://localhost:3000/checkout",
							metadata: {
								url: "http://localhost:3000/checkout",
								title: "Checkout",
								loadTimeMs: 280,
								consoleErrors: [],
								failedRequests: [],
								actions: [
									{ type: "click", selector: "[data-testid='cart-toggle']" },
									{ type: "wait", ms: 500 },
								],
							},
						},
					],
				},
				{
					text: "Task complete. I verified the implementation and no further changes are needed.",
					stopReason: "stop",
				},
			],
			{ availableToolNames: ["screenshot_url", "interact_then_screenshot"] },
		);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "verify the cart drawer checkout state and fix the layout if needed",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(session.prompt.mock.calls[1]?.[0]).toContain("interact_then_screenshot");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("open the drawer");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("Recommended interaction recipe");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("click the control that opens");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("wait 500ms");
		expect(session.prompt.mock.calls[2]?.[0]).toContain("[data-testid='cart-toggle']");
		expect(session.prompt.mock.calls[2]?.[0]).toContain("click [data-testid='cart-toggle']");
		const preTurnSnapshot = sessionManager.appendCustomEntry.mock.calls
			.map((call: any[]) => call[1])
			.reverse()
			.find(
				(snapshot: any) =>
					snapshot?.phase === "pre_turn" &&
					snapshot?.ledger?.visualTarget?.actionRecipe?.some(
						(step: any) => step?.source === "recorded" || typeof step?.selector === "string",
					),
			);
		expect(preTurnSnapshot?.ledger?.visualTarget).toEqual(
			expect.objectContaining({
				interactionMode: "interactive",
				recommendedTool: "interact_then_screenshot",
			}),
		);
		expect(preTurnSnapshot?.ledger?.visualTarget?.interactionHint).toContain("[data-testid='cart-toggle']");
		expect(preTurnSnapshot?.ledger?.visualTarget?.actionRecipe).toEqual([
			expect.objectContaining({ type: "click", selector: "[data-testid='cart-toggle']", source: "recorded" }),
			expect.objectContaining({ type: "wait", ms: 500 }),
		]);
		expect(result.ledger.visualTarget?.acceptanceCriteria.join(" ")).toContain("intended state");
		expect(result.stopReason).toBe("complete");
	});

	test("requires a fresh visual recapture after a frontend mutation", async () => {
		const { runtimeHost, session, toolHistory, fileHistory, sessionManager } = createRuntime(
			[
				{
					text: "I inspected the dashboard UI and found the target component.",
					stopReason: "stop",
					toolOutcomes: [
						{ tool: "read", success: true, file: "src/dashboard.tsx", detail: "read dashboard layout" },
					],
				},
				{
					text: "I captured the current dashboard.",
					stopReason: "stop",
					toolOutcomes: [
						{ tool: "screenshot_url", success: true, detail: "http://localhost:3000/dashboard-before" },
					],
				},
				{
					text: "I updated the dashboard layout.",
					stopReason: "stop",
					toolOutcomes: [
						{ tool: "edit", success: true, file: "src/dashboard.tsx", detail: "updated dashboard spacing" },
					],
				},
				{
					text: "Task complete. I verified the implementation and no further changes are needed.",
					stopReason: "stop",
					toolOutcomes: [
						{ tool: "screenshot_url", success: true, detail: "http://localhost:3000/dashboard-after" },
					],
				},
			],
			{ availableToolNames: ["screenshot_url", "interact_then_screenshot"] },
		);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "tighten the dashboard layout spacing",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(
			session.prompt.mock.calls.some((call: any[]) => String(call?.[0] ?? "").includes("Recapture the updated UI")),
		).toBe(true);
		const recaptureSnapshot = sessionManager.appendCustomEntry.mock.calls
			.map((call: any[]) => call[1])
			.find(
				(snapshot: any) =>
					snapshot?.phase === "pre_turn" && snapshot?.ledger?.visualIteration?.phase === "recapture",
			);
		expect(recaptureSnapshot?.ledger?.taskJournal?.plannedNextStep).toContain("Recapture the updated UI");
		expect(result.ledger.visualIteration).toEqual(
			expect.objectContaining({
				enabled: true,
				phase: "verified",
				screenshotAttempts: 2,
				lastScreenshotDetail: "http://localhost:3000/dashboard-after",
			}),
		);
		expect(result.stopReason).toBe("complete");
	});

	test("requires verification after the most recent mutation", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I made the changes.",
				stopReason: "stop",
				toolOutcomes: [
					{ tool: "bash", success: true, detail: "npm test" },
					{ tool: "edit", success: true, file: "src/app.ts" },
				],
			},
			{
				text: "Task complete. I verified the implementation and no further changes are needed.",
				stopReason: "stop",
			},
			{
				text: "Task complete. I verified the implementation and no further changes are needed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "npm test" }],
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix it",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt).toHaveBeenCalledTimes(3);
		expect(session.prompt.mock.calls[1]?.[0]).toContain("running verification on the latest changes");
		expect(session.prompt.mock.calls[2]?.[0]).toContain("did not provide concrete verification");
		expect(result.stopReason).toBe("complete");
		expect(result.checkpointState.verificationSatisfied).toBe(true);
	});

	test("replans after repeated drift from the intended next step", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I updated the retry path.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "edit", success: true, file: "src/app.ts", detail: "updated retry path" }],
			},
			{
				text: "I am still looking at it.",
				stopReason: "stop",
			},
			{
				text: "I am still looking at it.",
				stopReason: "stop",
			},
			{
				text: "Task complete. I verified the implementation and no further changes are needed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "npm test" }],
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix it",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt).toHaveBeenCalledTimes(4);
		expect(session.prompt.mock.calls[2]?.[0]).toContain("Replan into 1-2 concrete steps");
		expect(session.prompt.mock.calls[3]?.[0]).toContain("Narrow scope to the smallest verifiable slice");
		expect(session.prompt.mock.calls[3]?.[0]).toContain("emit one valid edit tool call");
		expect(result.stopReason).toBe("complete");
		expect(result.checkpointState.replanPromptCount).toBe(1);
		expect(result.checkpointState.narrowScopePromptCount).toBe(1);
	});

	test("treats a concrete mutation during narrow-scope recovery as back on track", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I am still looking at it.",
				stopReason: "stop",
			},
			{
				text: "I am still looking at it.",
				stopReason: "stop",
			},
			{
				text: "I am still looking at it.",
				stopReason: "stop",
			},
			{
				text: "I updated src/request.mjs.",
				stopReason: "stop",
				toolOutcomes: [
					{ tool: "edit", success: true, file: "src/request.mjs", detail: "migrated timeout handling" },
				],
			},
			{
				text: "Updated src/request.mjs and node --test passed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "node --test" }],
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix the request helper migration",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt).toHaveBeenCalledTimes(5);
		expect(session.prompt.mock.calls[2]?.[0]).toContain("Replan into 1-2 concrete steps");
		expect(session.prompt.mock.calls[3]?.[0]).toContain("Narrow scope to the smallest verifiable slice");
		expect(session.prompt.mock.calls[4]?.[0]).toContain("Planned next step: Run verification on the latest changes");
		expect(result.stopReason).toBe("complete");
		expect(result.checkpointState.consecutiveIntentDriftCount).toBe(0);
	});

	test("narrows scope after repeated failed steps", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I tried the fix.",
				stopReason: "stop",
				toolOutcomes: [
					{ tool: "edit", success: true, file: "src/app.ts", detail: "updated retry path" },
					{ tool: "bash", success: false, detail: "npm test" },
				],
			},
			{
				text: "I tried another fix.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: false, detail: "npm test" }],
			},
			{
				text: "Task complete. I verified the implementation and no further changes are needed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "npm test" }],
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix it",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt).toHaveBeenCalledTimes(3);
		expect(session.prompt.mock.calls[2]?.[0]).toContain("Narrow scope to the smallest verifiable slice");
		expect(result.stopReason).toBe("complete");
		expect(result.checkpointState.narrowScopePromptCount).toBe(1);
	});

	test("stops with a blocker summary after persistent failed steps", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I tried the fix.",
				stopReason: "stop",
				toolOutcomes: [
					{ tool: "edit", success: true, file: "src/app.ts", detail: "updated retry path" },
					{ tool: "bash", success: false, detail: "npm test" },
				],
			},
			{
				text: "I tried another fix.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: false, detail: "npm test" }],
			},
			{
				text: "I tried one more fix.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: false, detail: "npm test" }],
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix it",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt).toHaveBeenCalledTimes(3);
		expect(result.stopReason).toBe("error");
		expect(result.ledger.taskJournal.blockedReasons.join(" ")).toContain(
			"Autonomous run stopped after 3 consecutive failed steps",
		);
		expect(result.checkpointState.consecutiveIntentFailureCount).toBe(3);
	});

	test("stabilizes after a degraded turn instead of continuing with a generic prompt", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "Here is a very long analysis that started to sprawl.",
				stopReason: "max_tokens",
				outputTokens: 15000,
				emitDegradedTurn: {
					severity: "critical",
					reasons: ["truncated_turn", "very_high_output_tokens"],
					recoveryHint:
						"Continue from the last concrete point only, keep the next response short, and avoid repeating prior analysis.",
				},
			},
			{
				text: "Task complete. I verified the implementation and no further changes are needed.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "bash", success: true, detail: "npm test" }],
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix it",
			projectRoot: "/tmp",
			config: { enableNudges: false, maxOutputPerTurn: 4000 },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(session.prompt.mock.calls[1]?.[0]).toContain("The previous turn degraded");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("keep the next response terse");
		expect(result.stopReason).toBe("complete");
		expect(result.checkpointState.consecutiveDegradedTurnCount).toBe(0);
		expect(result.checkpointState.lastDegradedTurnSeverity).toBeUndefined();
	});

	test("stops after repeated critically degraded turns", async () => {
		const { runtimeHost, toolHistory } = createRuntime([
			{
				text: "Long unstable response one.",
				stopReason: "max_tokens",
				outputTokens: 15000,
				emitDegradedTurn: {
					severity: "critical",
					reasons: ["truncated_turn", "very_high_output_tokens"],
				},
			},
			{
				text: "Long unstable response two.",
				stopReason: "max_tokens",
				outputTokens: 15500,
				emitDegradedTurn: {
					severity: "critical",
					reasons: ["truncated_turn", "very_high_output_tokens"],
				},
			},
			{
				text: "Long unstable response three.",
				stopReason: "max_tokens",
				outputTokens: 16000,
				emitDegradedTurn: {
					severity: "critical",
					reasons: ["truncated_turn", "very_high_output_tokens"],
				},
			},
		]);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: "fix it",
			projectRoot: "/tmp",
			config: { enableNudges: false, maxOutputPerTurn: 4000 },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => [],
		});

		expect(result.stopReason).toBe("error");
		expect(result.ledger.taskJournal.blockedReasons.join(" ")).toContain("critically degraded turns");
		expect(result.checkpointState.consecutiveCriticalDegradedTurnCount).toBe(3);
	});
});
