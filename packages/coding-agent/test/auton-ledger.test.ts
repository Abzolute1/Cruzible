import { describe, expect, test, vi } from "vitest";
import {
	AUTONOMOUS_RUN_SNAPSHOT_ENTRY_TYPE,
	applyAutonomousLedgerEvents,
	appendAutonomousRunSnapshotState,
	buildAutonomousCompactionInstructions,
	createAutonomousRunSnapshot,
	createAutonomousRunLedger,
	createAutonomousRunSnapshotFromState,
	formatAutonomousContinuationLedger,
	formatAutonomousPromptLedger,
	formatAutonomousRunLedger,
	getLatestAutonomousRunSnapshot,
	updateAutonomousRunLedger,
} from "../src/core/auton/ledger.js";

describe("autonomous ledger helpers", () => {
	test("classifies verify-only local review tasks as answer mode", () => {
		const ledger = createAutonomousRunLedger(
			"review the retry-path implementation in this repo and list the main risks without changing code",
		);

		expect(ledger.taskMode).toBe("answer");
		expect(ledger.taskJournal.plannedNextStep).toContain("answer directly and stop");
		expect(ledger.taskJournal.stepRationale).toContain("answer-first task");
	});

	test("classifies local implementation lookups as answer mode", () => {
		const ledger = createAutonomousRunLedger(
			"which source file implements the benchmark archive command? give the exact path and one-sentence purpose",
		);

		expect(ledger.taskMode).toBe("answer");
		expect(ledger.taskJournal.nextAction).toContain("focused inspection step");
	});

	test("classifies self-contained docs-guided migrations as implementation mode", () => {
		const ledger = createAutonomousRunLedger(
			"You are in a self-contained benchmark workspace. Task: 1. Read the provided docs excerpt in `reference/abort-signal-timeout.md`. 2. Migrate the request helper to follow that guidance. 3. Verify with `node --test tests/request.test.mjs`. Stay inside this workspace.",
		);

		expect(ledger.taskMode).toBe("implementation");
		expect(ledger.taskJournal.plannedNextStep).toContain("concrete implementation step");
		expect(ledger.taskJournal.stepRationale).toContain("changing code");
	});

	test("builds focused compaction instructions from the run ledger", () => {
		const instructions = buildAutonomousCompactionInstructions({
			goal: "fix auth retry path",
			status: "running",
			turnsObserved: 2,
			taskJournal: {
				activeSubtask: "Validate the recent change: updated retry logic",
				nextAction: "Run verification on the latest changes",
				plannedNextStep: "Run verification on the latest changes.",
				stepRationale: "The implementation phase is done enough to justify verification before more changes.",
				expectedVerification: "A passing test, lint, build, or verify command after the latest mutation",
				intentStatus: "failed",
				lastIntentOutcome: "verification failed: npm test",
				planItems: [
					{ key: "inspect", title: "Inspect relevant files", status: "completed" },
					{ key: "implement", title: "Apply workspace changes", status: "completed" },
					{ key: "verify", title: "Verify latest changes", status: "blocked" },
					{ key: "summarize", title: "Summarize verified result", status: "pending" },
				],
				completedCheckpoints: ["relevant files inspected", "workspace changes applied"],
				blockedReasons: ["failed verification: npm test"],
			},
			research: {
				searchQueries: ["auth retry docs"],
				fetchedUrls: ["https://example.com/auth-retries"],
				sourceUrls: ["https://example.com/auth-retries"],
				preferredSourceUrls: ["https://example.com/auth-retries"],
				recentFindings: ["Fetched Auth Retry Guide — https://example.com/auth-retries"],
			},
			currentFocus: "Reworking retry handling",
			progressDetail: "updated retry logic",
			lastActionType: "mutation",
			lastActionDetail: "updated retry logic",
			touchedFiles: ["src/auth.ts"],
			readFiles: ["src/auth.test.ts"],
			recentMutations: ["updated retry logic"],
			visualTarget: {
				surface: "dashboard",
				goalSummary: "fix auth retry path",
				acceptanceCriteria: [
					"render without console or network issues",
					"the dashboard layout should reflect the requested visual change",
				],
			},
			visualIteration: {
				enabled: true,
				phase: "recapture",
				screenshotAttempts: 1,
				lastScreenshotDetail: "http://localhost:3000/dashboard",
				observationSummary: "latest capture for Dashboard with issues: console errors: hydration mismatch",
				outstandingIssues: ["console errors: hydration mismatch", "failed requests: GET /api/data — HTTP 500"],
				recentArtifacts: [
					{
						tool: "screenshot_url",
						status: "captured",
						detail: "http://localhost:3000/dashboard",
						url: "http://localhost:3000/dashboard",
						title: "Dashboard",
						loadTimeMs: 420,
						consoleErrors: ["hydration mismatch"],
						failedRequests: ["GET /api/data — HTTP 500"],
					},
				],
			},
			visualAssessment: {
				target: "Dashboard",
				latestJudgment: "fail",
				summary: "latest visual verification for Dashboard found blocking issues: console errors: hydration mismatch; failed requests: GET /api/data — HTTP 500",
				blockingIssues: ["console errors: hydration mismatch", "failed requests: GET /api/data — HTTP 500"],
				lastEvaluatedDetail: "http://localhost:3000/dashboard",
				basis: "screenshot_metadata",
			},
			verificationAttempts: 1,
			verificationSatisfied: false,
			lastVerificationDetail: undefined,
			verificationFailures: ["failed verification: npm test"],
			residualRisks: ["browser coverage remains thin"],
		});

		expect(instructions).toContain("Goal: fix auth retry path");
		expect(instructions).toContain("Current focus: Reworking retry handling");
		expect(instructions).toContain("Active subtask: Validate the recent change: updated retry logic");
		expect(instructions).toContain("Next action: Run verification on the latest changes");
		expect(instructions).toContain("Plan state: Inspect relevant files [completed]");
		expect(instructions).toContain("Research queries: auth retry docs");
		expect(instructions).toContain("Fetched sources: https://example.com/auth-retries");
		expect(instructions).toContain("Source URLs: https://example.com/auth-retries");
		expect(instructions).toContain("Preferred sources: https://example.com/auth-retries");
		expect(instructions).toContain("Research findings: Fetched Auth Retry Guide — https://example.com/auth-retries");
		expect(instructions).toContain("Changed files: src/auth.ts");
		expect(instructions).toContain("Visual iteration: recapture via http://localhost:3000/dashboard");
		expect(instructions).toContain("Visual target: fix auth retry path");
		expect(instructions).toContain("Visual surface: dashboard");
		expect(instructions).toContain("Visual acceptance: render without console or network issues");
		expect(instructions).toContain("Visual issues: console errors: hydration mismatch");
		expect(instructions).toContain("Visual assessment: fail");
		expect(instructions).toContain("Visual blockers: console errors: hydration mismatch");
		expect(instructions).toContain("Residual risks: browser coverage remains thin");
	});

	test("loads the latest autonomous run snapshot from custom session entries", () => {
		const snapshot = createAutonomousRunSnapshot({
			iterations: 3,
			stopReason: "complete",
			budgetStatus: {
				costUsed: 0.1,
				tokensUsed: 100,
				turnsUsed: 3,
				exceeded: { cost: false, tokens: false, turns: false },
			},
			costSummary: "$0.0010 | 50 in / 50 out",
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
				lastAssessment: "complete",
				verificationSatisfied: true,
				lastVerificationDetail: "npm test",
			},
			ledger: {
				goal: "fix auth retry path",
				status: "complete",
				turnsObserved: 3,
				taskJournal: {
					activeSubtask: "Finalize and report verified completion",
					nextAction: "Stop and present the verified result",
					plannedNextStep: "Summarize the verified result and note any residual risks.",
					stepRationale: "Verification is satisfied, so the remaining work is reporting clearly and stopping.",
					expectedVerification: "npm test",
					intentStatus: "on_track",
					lastIntentOutcome: "completion matched the planned summarize step",
					planItems: [
						{ key: "inspect", title: "Inspect relevant files", status: "completed" },
						{ key: "implement", title: "Apply workspace changes", status: "completed" },
						{ key: "verify", title: "Verify latest changes", status: "completed" },
						{ key: "summarize", title: "Summarize verified result", status: "completed" },
					],
					completedCheckpoints: ["relevant files inspected", "workspace changes applied", "verification passed: npm test"],
					blockedReasons: [],
				},
				currentFocus: "Finished retry handling",
				progressDetail: "updated retry logic",
				lastActionType: "verification",
				lastActionDetail: "npm test",
				touchedFiles: ["src/auth.ts"],
				readFiles: ["src/auth.test.ts"],
				recentMutations: ["updated retry logic"],
				verificationAttempts: 1,
				verificationSatisfied: true,
				lastVerificationDetail: "npm test",
				verificationFailures: [],
				residualRisks: [],
			},
		});

		const loaded = getLatestAutonomousRunSnapshot([
			{
				type: "custom",
				customType: AUTONOMOUS_RUN_SNAPSHOT_ENTRY_TYPE,
				data: { version: 0 },
				id: "entry-1",
				parentId: null,
				timestamp: new Date().toISOString(),
			} as any,
			{
				type: "custom",
				customType: AUTONOMOUS_RUN_SNAPSHOT_ENTRY_TYPE,
				data: snapshot,
				id: "entry-2",
				parentId: "entry-1",
				timestamp: new Date().toISOString(),
			} as any,
		]);

		expect(loaded).toEqual(snapshot);
	});

	test("creates and appends checkpoint snapshots with explicit phases", () => {
		const snapshot = createAutonomousRunSnapshotFromState({
			phase: "pre_turn",
			iterations: 1,
			stopReason: "unknown",
			costSummary: "$0.0002 | 10 in / 20 out",
			budgetStatus: {
				costUsed: 0.0002,
				tokensUsed: 30,
				turnsUsed: 1,
				exceeded: { cost: false, tokens: false, turns: false },
			},
			checkpointState: {
				consecutiveNoToolTurns: 1,
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
				lastAssessment: "confirm_completion",
				verificationSatisfied: false,
				lastVerificationDetail: undefined,
			},
			ledger: {
				goal: "fix auth retry path",
				status: "running",
				turnsObserved: 1,
				taskJournal: {
					activeSubtask: "Turn inspected context into a concrete change: read auth test coverage",
					nextAction: "Make the next concrete code change",
					plannedNextStep: "Make the next concrete code change.",
					stepRationale: "The run has enough context to move from inspection into implementation.",
					expectedVerification: "After the change, run the relevant test, lint, build, or verify command",
					intentStatus: "pending",
					lastIntentOutcome: undefined,
					planItems: [
						{ key: "inspect", title: "Inspect relevant files", status: "completed" },
						{ key: "implement", title: "Apply workspace changes", status: "active" },
						{ key: "verify", title: "Verify latest changes", status: "pending" },
						{ key: "summarize", title: "Summarize verified result", status: "pending" },
					],
					completedCheckpoints: [],
					blockedReasons: [],
				},
				currentFocus: "Inspecting auth retry handling",
				progressDetail: "read auth test coverage",
				lastActionType: "inspection",
				lastActionDetail: "read auth test coverage",
				touchedFiles: [],
				readFiles: [],
				recentMutations: [],
				verificationAttempts: 0,
				verificationSatisfied: false,
				lastVerificationDetail: undefined,
				verificationFailures: [],
				residualRisks: [],
			},
		});
		const sessionManager = { appendCustomEntry: vi.fn() };

		appendAutonomousRunSnapshotState(sessionManager, snapshot);

		expect(snapshot.phase).toBe("pre_turn");
		expect(sessionManager.appendCustomEntry).toHaveBeenCalledWith(
			AUTONOMOUS_RUN_SNAPSHOT_ENTRY_TYPE,
			expect.objectContaining({ phase: "pre_turn" }),
		);
	});

	test("applies explicit ledger events to transition plan items", () => {
		const next = applyAutonomousLedgerEvents(createAutonomousRunLedger("fix auth retry path"), [
			{ type: "inspection_complete", detail: "read src/auth.ts" },
			{ type: "implementation_changed", detail: "updated retry logic" },
			{ type: "verification_failed", detail: "npm test" },
			{ type: "verification_passed", detail: "npm test" },
			{ type: "completion_confirmed" },
		]);

		expect(next.taskJournal.planItems).toEqual([
			{ key: "inspect", title: "Inspect relevant files", status: "completed" },
			{ key: "implement", title: "Apply workspace changes", status: "completed" },
			{ key: "verify", title: "Verify latest changes", status: "completed" },
			{ key: "summarize", title: "Summarize verified result", status: "completed" },
		]);
		expect(next.taskJournal.blockedReasons).toEqual([]);
		expect(next.taskJournal.completedCheckpoints).toContain("verification passed: npm test");
		expect(next.taskJournal.nextAction).toBe("Stop and present the verified result");
	});

	test("prefers recorded interactive screenshot actions over inferred visual recipes", () => {
		const next = updateAutonomousRunLedger({
			current: createAutonomousRunLedger("fix the mobile checkout drawer"),
			status: "running",
			lastAssistantText: "Captured the checkout drawer after interaction",
			toolHistory: [
				{
					tool: "interact_then_screenshot",
					success: true,
					detail: "http://localhost:3000/checkout",
					metadata: {
						url: "http://localhost:3000/checkout",
						title: "Checkout",
						loadTimeMs: 320,
						consoleErrors: [],
						failedRequests: [],
						actions: [
							{ type: "click", selector: "[data-testid='cart-toggle']" },
							{ type: "fill", selector: "input[name='coupon']", value: "[redacted]" },
							{ type: "wait", ms: 500 },
						],
					},
				},
			],
			fileAccessHistory: [],
			verificationSatisfied: true,
			lastVerificationDetail: "http://localhost:3000/checkout",
			visualVerificationRelevant: true,
		});

		expect(next.visualTarget?.recommendedTool).toBe("interact_then_screenshot");
		expect(next.visualTarget?.actionRecipe).toEqual([
			{
				type: "click",
				selector: "[data-testid='cart-toggle']",
				targetHint: "[data-testid='cart-toggle']",
				valueHint: undefined,
				ms: undefined,
				url: undefined,
				urlHint: undefined,
				source: "recorded",
			},
			{
				type: "fill",
				selector: "input[name='coupon']",
				targetHint: "input[name='coupon']",
				valueHint: "recorded input",
				ms: undefined,
				url: undefined,
				urlHint: undefined,
				source: "recorded",
			},
			{
				type: "wait",
				selector: undefined,
				targetHint: undefined,
				valueHint: undefined,
				ms: 500,
				url: undefined,
				urlHint: undefined,
				source: "recorded",
			},
		]);
		expect(next.visualTarget?.interactionHint).toContain("[data-testid='cart-toggle']");
		expect(next.visualIteration?.recentArtifacts[0]?.actionRecipe).toEqual(next.visualTarget?.actionRecipe);
		expect(JSON.stringify(next.visualTarget?.actionRecipe)).not.toContain("rootme");
		expect(JSON.stringify(next.visualTarget?.actionRecipe)).not.toContain("hunter2");
	});

	test("tracks research provenance from webSearch and webFetch metadata", () => {
		const next = updateAutonomousRunLedger({
			current: createAutonomousRunLedger("research the latest React 19 docs"),
			lastAssistantText: "I found current React documentation and fetched the most relevant page.",
			toolHistory: [
				{
					tool: "webSearch",
					success: true,
					detail: "React 19 documentation",
					metadata: {
						query: "React 19 documentation",
						results: [
							{ title: "React Docs", url: "https://react.dev/" },
							{ title: "React Blog", url: "https://react.dev/blog" },
						],
					},
				},
				{
					tool: "webFetch",
					success: true,
					detail: "https://react.dev/",
					metadata: {
						url: "https://react.dev/",
						title: "React",
						facts: ["React builds user interfaces from components."],
					},
				},
			],
			fileAccessHistory: [],
			verificationSatisfied: false,
			lastVerificationDetail: undefined,
		});

		expect(next.research?.searchQueries).toEqual(["React 19 documentation"]);
		expect(next.research?.fetchedUrls).toEqual(["https://react.dev/"]);
		expect(next.research?.sourceUrls).toContain("https://react.dev/");
		expect(next.research?.preferredSourceUrls).toContain("https://react.dev/");
		expect(next.research?.recentFindings).toContain("React Docs — https://react.dev/");
		expect(next.research?.recentFindings).toContain("Fetched React — https://react.dev/");
		expect(next.research?.recentFindings).toContain("React: React builds user interfaces from components.");
		expect(next.research?.evidence).toEqual(
			expect.objectContaining({
				status: "sufficient",
				authoritativeSourceCount: 2,
				fetchedSourceCount: 1,
				citedSourceCount: 2,
				summaryReady: true,
			}),
		);
		expect(next.planner).toEqual(
			expect.objectContaining({
				phase: "planning",
				lane: "research",
			}),
		);
		expect(next.resume).toEqual(
			expect.objectContaining({
				mode: "resume_research",
				resumeInstruction: "Search for the most relevant authoritative source first.",
			}),
		);
		expect(formatAutonomousRunLedger(next)).toContain("Research queries: React 19 documentation");
		expect(formatAutonomousRunLedger(next)).toContain("Preferred sources: https://react.dev/");
		expect(formatAutonomousRunLedger(next)).toContain("Research evidence: sufficient");
		expect(formatAutonomousRunLedger(next)).toContain("Planner:");
		expect(formatAutonomousRunLedger(next)).toContain("Resume mode: resume_research");
		expect(formatAutonomousRunLedger(next)).toContain("Resume:");
	});

	test("keeps a concrete src or test repair target pinned when later helper-script reads occur", () => {
		const current = createAutonomousRunLedger("fix the search URL builder and add a regression test");
		current.discoveryTargetFile = "tests/search-url.test.mjs";
		current.discoveredFiles = ["tests/search-url.test.mjs", "src/search-url.mjs"];

		const next = updateAutonomousRunLedger({
			current,
			lastAssistantText: "I read the verifier helper to understand the failing regression requirement.",
			toolHistory: [
				{
					tool: "read",
					success: true,
					file: "scripts/check-regression-test.mjs",
					detail: "read verifier script",
				},
			],
			fileAccessHistory: [
				{
					tool: "read",
					success: true,
					file: "scripts/check-regression-test.mjs",
					detail: "read verifier script",
				},
			],
			verificationSatisfied: false,
			lastVerificationDetail: undefined,
		});

		expect(next.discoveryTargetFile).toBe("tests/search-url.test.mjs");
		expect(next.discoveredFiles).toContain("scripts/check-regression-test.mjs");
	});

	test("formats a compact prompt ledger for continuation turns", () => {
		const ledger = createAutonomousRunLedger("research the latest React 19 docs");
		ledger.planner = {
			phase: "summarizing",
			lane: "research",
			planRevision: 2,
			executionAttempts: 1,
			handoffSummary: "Stop browsing and synthesize the answer from the saved sources.",
		};
		ledger.resume = {
			mode: "resume_summarize",
			resumeInstruction: "Summarize the source-backed answer and cite the supporting URLs.",
			resumeReason: "The run already has enough authoritative evidence.",
			lastStableCheckpoint: "Fetched React — https://react.dev/",
		};
		ledger.taskJournal.plannedNextStep = "Summarize the source-backed answer and cite the supporting URLs.";
		ledger.taskJournal.expectedVerification = "Cite supporting source URLs such as https://react.dev/";
		ledger.research = {
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
		};
		ledger.touchedFiles = ["src/auth.ts", "docs/notes.md"];
		ledger.readFiles = ["src/auth.test.ts"];
		ledger.taskJournal.planItems = [
			{ key: "inspect", title: "Inspect relevant files", status: "completed" },
			{ key: "implement", title: "Apply workspace changes", status: "completed" },
			{ key: "verify", title: "Verify latest changes", status: "completed" },
			{ key: "summarize", title: "Summarize verified result", status: "active" },
		];

		const promptLedger = formatAutonomousPromptLedger(ledger);
		expect(promptLedger).toContain("Run ledger:");
		expect(promptLedger).toContain("Planner: summarizing via research");
		expect(promptLedger).toContain("Resume mode: resume_summarize");
		expect(promptLedger).toContain("Preferred sources: https://react.dev/");
		expect(promptLedger).not.toContain("Plan:");
		expect(promptLedger).not.toContain("Changed:");
		expect(promptLedger).not.toContain("Read:");
	});

	test("formats a slimmer continuation ledger for repeated prompts", () => {
		const ledger = createAutonomousRunLedger("research the latest React 19 docs");
		ledger.planner = {
			phase: "summarizing",
			lane: "research",
			planRevision: 2,
			executionAttempts: 1,
			handoffSummary: "Summarize the source-backed answer and cite the supporting URLs.",
		};
		ledger.resume = {
			mode: "resume_summarize",
			resumeInstruction: "Summarize the saved evidence and stop.",
			resumeReason: "Enough authoritative evidence is already available.",
			lastStableCheckpoint: "Fetched React — https://react.dev/",
		};
		ledger.taskJournal.activeSubtask = "Summarize the source-backed answer";
		ledger.taskJournal.plannedNextStep = "Summarize the source-backed answer and cite the supporting URLs.";
		ledger.taskJournal.expectedVerification = "Cite supporting source URLs such as https://react.dev/";
		ledger.research = {
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
		};
		ledger.lastActionType = "verification";
		ledger.lastActionDetail = "webFetch https://react.dev/";
		ledger.verificationSatisfied = true;
		ledger.lastVerificationDetail = "Source URLs captured";

		const continuationLedger = formatAutonomousContinuationLedger(ledger);

		expect(continuationLedger).toContain("Run ledger:");
		expect(continuationLedger).toContain("Goal: research the latest React 19 docs");
		expect(continuationLedger).toContain("Active subtask: Summarize the source-backed answer");
		expect(continuationLedger).toContain("Planned next step: Summarize the source-backed answer and cite the supporting URLs.");
		expect(continuationLedger).toContain("Research: sufficient | source https://react.dev/");
		expect(continuationLedger).toContain("Verification: satisfied via Source URLs captured");
		expect(continuationLedger).not.toContain("Planner handoff:");
		expect(continuationLedger).not.toContain("Resume mode:");
	});
});
