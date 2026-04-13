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
	toolOutcomes?: Array<{ tool: string; success: boolean; detail?: string; file?: string; metadata?: Record<string, unknown> }>;
	outputTokens?: number;
};

function createRuntime(
	responses: MockAssistantResponse[],
	options?: {
		availableToolNames?: string[];
	},
) {
	const subscribers: Array<(event: any) => void> = [];
	const toolHistory: Array<{ tool: string; success: boolean; detail?: string; file?: string; metadata?: Record<string, unknown> }> = [];
	const fileHistory: Array<{ tool: string; success: boolean; detail?: string; file?: string; metadata?: Record<string, unknown> }> = [];
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
						handoffSummary: "Research evidence is sufficient. Stop browsing and synthesize the answer from the saved sources.",
					},
					resume: {
						mode: "resume_summarize",
						resumeInstruction: "Summarize the source-backed answer from the saved research artifacts, cite the supporting URLs, and stop unless a concrete evidence gap remains.",
						resumeReason: "The run already has enough authoritative evidence, so further browsing would waste budget instead of improving the answer.",
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
						plannedNextStep: "Summarize the source-backed answer from the saved research artifacts, cite the supporting URLs, and stop unless a concrete evidence gap remains.",
						stepRationale: "The run already has enough authoritative evidence, so further browsing would waste budget instead of improving the answer.",
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
		const { runtimeHost, session, toolHistory, fileHistory, sessionManager } = createRuntime([
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
		expect(result.ledger.taskJournal.plannedNextStep).toBe("Summarize the verified result and note any residual risks.");
		expect(result.ledger.taskJournal.stepRationale).toBe(
			"Verification is satisfied, so the remaining work is reporting clearly and stopping.",
		);
		expect(result.ledger.taskJournal.expectedVerification).toBe("npm test");
		expect(result.ledger.taskJournal.intentStatus).toBe("on_track");
		expect(result.ledger.taskJournal.lastIntentOutcome).toContain("verification matched intent");
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
					{ tool: "bash", success: false, detail: "npm test" },
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
		expect(result.ledger.verificationFailures).toContain("failed verification: npm test");
		expect(result.ledger.residualRisks).toContain("failed verification: npm test");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("Recover from the blocker before doing anything else");
		expect(session.prompt.mock.calls[1]?.[0]).toContain("verification failed: npm test");
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
		expect(blockerSnapshot?.ledger?.taskJournal?.expectedVerification).toBe("npm test");
		expect(blockerSnapshot?.ledger?.taskJournal?.intentStatus).toBe("pending");
		expect(blockerSnapshot?.ledger?.taskJournal?.planItems).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: "inspect", status: "completed" }),
				expect.objectContaining({ key: "implement", status: "completed" }),
				expect.objectContaining({ key: "verify", status: "blocked" }),
			]),
		);
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
		expect(preTurnSnapshot?.ledger?.taskJournal?.plannedNextStep).toBe("Make the next concrete code change.");
		expect(preTurnSnapshot?.ledger?.taskJournal?.stepRationale).toBe(
			"The run has enough context to move from inspection into implementation.",
		);
		expect(preTurnSnapshot?.ledger?.taskJournal?.expectedVerification).toBe(
			"After the change, run the relevant test, lint, build, or verify command",
		);
		expect(preTurnSnapshot?.ledger?.taskJournal?.intentStatus).toBe("pending");
	});

	test("uses ledger-aware compaction instructions during proactive compaction", async () => {
		const { runtimeHost, session, toolHistory, fileHistory } = createRuntime([
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
		session.getContextUsage = vi
			.fn()
			.mockReturnValueOnce({ tokens: 80_000, contextWindow: 100_000, percent: 80 })
			.mockReturnValueOnce(null);

		await runAutonomousSession({
			runtimeHost,
			userMessage: "fix auth retry path",
			projectRoot: "/tmp",
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(session.compact).toHaveBeenCalledTimes(1);
		expect(session.compact.mock.calls[0]?.[0]).toContain("Preserve the autonomous run state precisely");
		expect(session.compact.mock.calls[0]?.[0]).toContain("Goal: fix auth retry path");
		expect(session.compact.mock.calls[0]?.[0]).toContain("Changed files: src/auth.ts");
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

	test("stops after a passing verification turn without requiring extra completion wording", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime([
			{
				text: "I updated the auth retry path.",
				stopReason: "stop",
				toolOutcomes: [{ tool: "edit", success: true, file: "src/auth.ts", detail: "updated retry logic" }],
			},
			{
				text: "npm test passes for the updated auth retry path.",
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
			getFileAccessHistory: () => [],
		});

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(result.stopReason).toBe("complete");
		expect(result.ledger.verificationSatisfied).toBe(true);
		expect(result.ledger.lastVerificationDetail).toBe("npm test");
	});

	test("stops after a clean visual recapture without requiring extra completion wording", async () => {
		const { runtimeHost, session, toolHistory } = createRuntime(
			[
				{
					text: "I updated the dashboard layout.",
					stopReason: "stop",
					toolOutcomes: [{ tool: "edit", success: true, file: "src/dashboard.tsx", detail: "updated dashboard spacing" }],
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
						{ tool: "edit", success: true, file: "src/homepage.tsx", detail: "fixed hydration mismatch handling" },
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
					toolOutcomes: [{ tool: "read", success: true, file: "src/homepage.tsx", detail: "read landing page layout" }],
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
			.find((snapshot: any) => snapshot?.phase === "pre_turn" && snapshot?.ledger?.visualIteration?.phase === "baseline_capture");
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
					toolOutcomes: [{ tool: "read", success: true, file: "src/checkout.tsx", detail: "read checkout layout" }],
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
					toolOutcomes: [{ tool: "read", success: true, file: "src/checkout.tsx", detail: "read checkout cart drawer state" }],
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
					toolOutcomes: [{ tool: "read", success: true, file: "src/dashboard.tsx", detail: "read dashboard layout" }],
				},
				{
					text: "I captured the current dashboard.",
					stopReason: "stop",
					toolOutcomes: [{ tool: "screenshot_url", success: true, detail: "http://localhost:3000/dashboard-before" }],
				},
				{
					text: "I updated the dashboard layout.",
					stopReason: "stop",
					toolOutcomes: [{ tool: "edit", success: true, file: "src/dashboard.tsx", detail: "updated dashboard spacing" }],
				},
				{
					text: "Task complete. I verified the implementation and no further changes are needed.",
					stopReason: "stop",
					toolOutcomes: [{ tool: "screenshot_url", success: true, detail: "http://localhost:3000/dashboard-after" }],
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
			.find((snapshot: any) => snapshot?.phase === "pre_turn" && snapshot?.ledger?.visualIteration?.phase === "recapture");
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
		expect(result.stopReason).toBe("complete");
		expect(result.checkpointState.replanPromptCount).toBe(1);
		expect(result.checkpointState.narrowScopePromptCount).toBe(1);
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
		expect(result.ledger.taskJournal.blockedReasons.join(" ")).toContain(
			"critically degraded turns",
		);
		expect(result.checkpointState.consecutiveCriticalDegradedTurnCount).toBe(3);
	});
});
