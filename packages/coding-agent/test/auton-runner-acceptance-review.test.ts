import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { runAcceptanceReviewMock } = vi.hoisted(() => ({
	runAcceptanceReviewMock: vi.fn(),
}));

vi.mock("../src/core/session-debug-logger.js", () => ({
	SessionDebugLogger: class {
		start(): void {}
		dispose(): void {}
	},
}));

vi.mock("../src/core/auton/acceptance-review.js", async (importOriginal) => {
	// Keep the real ground-truth collectors; only the LLM review call is stubbed.
	const actual = await importOriginal<typeof import("../src/core/auton/acceptance-review.js")>();
	return { ...actual, runAcceptanceReview: runAcceptanceReviewMock };
});

import { runAutonomousSession } from "../src/core/auton/runner.js";

type MockAssistantResponse = {
	text: string;
	stopReason: string;
	toolOutcomes?: Array<{ tool: string; success: boolean; detail?: string; file?: string }>;
	/** Side effect applied when this response is prompted — e.g. actually writing the file the turn claims to change. */
	effect?: () => void;
};

const createdWorkspaces: string[] = [];

function createWorkspace(files?: Record<string, string>): string {
	const workspace = mkdtempSync(join(tmpdir(), "ag1-runner-review-"));
	createdWorkspaces.push(workspace);
	for (const [relativePath, contents] of Object.entries(files ?? {})) {
		const filePath = join(workspace, relativePath);
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, contents);
	}
	return workspace;
}

afterEach(() => {
	while (createdWorkspaces.length > 0) {
		const workspace = createdWorkspaces.pop();
		if (workspace) rmSync(workspace, { recursive: true, force: true });
	}
});

const BROKEN_PARSER = [
	"export function parseConfig(input) {",
	"\tconst result = {};",
	"\tfor (const [key, value] of Object.entries(input)) {",
	'\t\tresult[key] = value || "default";',
	"\t}",
	"\treturn result;",
	"}",
	"",
].join("\n");

const FIXED_PARSER = BROKEN_PARSER.replace('value || "default"', 'value ?? "default"');

const PARSER_TEST = [
	'import assert from "node:assert/strict";',
	'import { test } from "node:test";',
	'import { parseConfig } from "../src/config-parser.mjs";',
	"",
	'test("explicit falsey values are preserved", () => {',
	"\tassert.equal(parseConfig({ flag: false }).flag, false);",
	"\tassert.equal(parseConfig({ count: 0 }).count, 0);",
	"});",
	"",
].join("\n");

const TASK = `You are in a self-contained benchmark workspace.

Task:

1. Fix the configuration parser so explicit falsey values from user input are preserved.
2. Do not rewrite the tests.
3. Run the targeted verification command before you finish.

Constraints:

- Stay inside this workspace.
- The intended verification command is: \`node --test\``;

function discoveryResponse(): MockAssistantResponse {
	return {
		text: "I inspected the workspace and identified the implementation file.",
		stopReason: "stop",
		toolOutcomes: [{ tool: "read", success: true, file: "src/config-parser.mjs", detail: "read parser" }],
	};
}

function mutationResponse(text = "Fixed src/config-parser.mjs and node --test passed."): MockAssistantResponse {
	return {
		text,
		stopReason: "stop",
		toolOutcomes: [
			{ tool: "read", success: true, file: "src/config-parser.mjs", detail: "read parser" },
			{ tool: "edit", success: true, file: "src/config-parser.mjs", detail: "preserved explicit falsey values" },
			{ tool: "bash", success: true, detail: "node --test" },
		],
	};
}

function createRuntime(
	responses: MockAssistantResponse[],
	options?: { withVerifierModel?: boolean; workspace?: string },
): {
	runtimeHost: never;
	session: any;
	workspace: string;
	toolHistory: Array<{ tool: string; success: boolean; detail?: string; file?: string }>;
	fileHistory: Array<{ tool: string; success: boolean; detail?: string; file?: string }>;
} {
	const workspace = options?.workspace ?? createWorkspace();
	const subscribers: Array<(event: any) => void> = [];
	const toolHistory: Array<{ tool: string; success: boolean; detail?: string; file?: string }> = [];
	const fileHistory: Array<{ tool: string; success: boolean; detail?: string; file?: string }> = [];
	const sessionManager = {
		appendCustomEntry: vi.fn(),
		getEntries: vi.fn(() => []),
		getCwd: vi.fn(() => workspace),
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
			next.effect?.();
			if (next.toolOutcomes) {
				toolHistory.push(...next.toolOutcomes);
				for (const outcome of next.toolOutcomes) {
					if (outcome.file) fileHistory.push(outcome);
				}
			}
			const assistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: next.text }],
				stopReason: next.stopReason,
				usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0 } },
			};
			session.agent.state.messages.push(assistantMessage);
			for (const subscriber of subscribers) {
				subscriber({ type: "message_end", message: assistantMessage });
			}
			for (const subscriber of subscribers) {
				subscriber({ type: "agent_end" });
			}
		}),
		getContextUsage: vi.fn(() => null),
		compact: vi.fn(async () => undefined),
		getToolDefinition: vi.fn(() => undefined),
	};
	if (options?.withVerifierModel) {
		session.resolveVerifierModel = () => ({ id: "verifier-1", provider: "verifier-provider" });
	}

	return {
		runtimeHost: { session } as never,
		session,
		workspace,
		toolHistory,
		fileHistory,
	};
}

describe("runAutonomousSession acceptance review", () => {
	beforeEach(() => {
		runAcceptanceReviewMock.mockReset();
	});

	test("accept verdict lets a mutation run complete", async () => {
		runAcceptanceReviewMock.mockResolvedValue({ verdict: "accept", reason: "evidence holds" });
		const { runtimeHost, session, workspace, toolHistory, fileHistory } = createRuntime(
			[discoveryResponse(), mutationResponse()],
			{ withVerifierModel: true },
		);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: TASK,
			projectRoot: workspace,
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(result.stopReason).toBe("complete");
		expect(runAcceptanceReviewMock).toHaveBeenCalledTimes(1);
		expect(runAcceptanceReviewMock.mock.calls[0]?.[1]?.goal).toBe(TASK);
		expect(session.prompt).toHaveBeenCalledTimes(2);
	});

	test("reject verdict continues the run with the review reason as blocker", async () => {
		runAcceptanceReviewMock
			.mockResolvedValueOnce({ verdict: "reject", reason: "verification does not exercise the change" })
			.mockResolvedValueOnce({ verdict: "accept", reason: "evidence now holds" });
		const { runtimeHost, session, workspace, toolHistory, fileHistory } = createRuntime(
			[discoveryResponse(), mutationResponse(), mutationResponse("Added a targeted test; node --test passed.")],
			{ withVerifierModel: true },
		);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: TASK,
			projectRoot: workspace,
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(result.stopReason).toBe("complete");
		expect(runAcceptanceReviewMock).toHaveBeenCalledTimes(2);
		expect(session.prompt).toHaveBeenCalledTimes(3);
		const blockerPrompt = session.prompt.mock.calls[2]?.[0] as string;
		expect(blockerPrompt).toContain("acceptance review REJECTED");
		expect(blockerPrompt).toContain("verification does not exercise the change");
	});

	test("missing verifier model skips the review and still completes", async () => {
		const { runtimeHost, workspace, toolHistory, fileHistory } = createRuntime(
			[discoveryResponse(), mutationResponse()],
			{
				withVerifierModel: false,
			},
		);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: TASK,
			projectRoot: workspace,
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(result.stopReason).toBe("complete");
		expect(runAcceptanceReviewMock).not.toHaveBeenCalled();
	});

	test("unavailable reviewer (undefined) skips the review and still completes", async () => {
		runAcceptanceReviewMock.mockResolvedValue(undefined);
		const { runtimeHost, workspace, toolHistory, fileHistory } = createRuntime(
			[discoveryResponse(), mutationResponse()],
			{
				withVerifierModel: true,
			},
		);

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: TASK,
			projectRoot: workspace,
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(result.stopReason).toBe("complete");
		expect(runAcceptanceReviewMock).toHaveBeenCalledTimes(1);
	});
});

describe("runAutonomousSession acceptance review ground truth", () => {
	beforeEach(() => {
		runAcceptanceReviewMock.mockReset();
	});

	test("fresh failing verification rejects completion without an LLM review call", async () => {
		runAcceptanceReviewMock.mockResolvedValue({ verdict: "accept", reason: "evidence holds" });
		const workspace = createWorkspace({
			"src/config-parser.mjs": BROKEN_PARSER,
			"test/config-parser.test.mjs": PARSER_TEST,
		});
		const responses: MockAssistantResponse[] = [
			discoveryResponse(),
			// The agent claims a fix but nothing on disk changes: the fresh
			// re-run of `node --test` fails for real.
			mutationResponse(),
			// Second attempt actually writes the fixed parser.
			{
				...mutationResponse("Actually fixed src/config-parser.mjs; node --test passed."),
				effect: () => writeFileSync(join(workspace, "src/config-parser.mjs"), FIXED_PARSER),
			},
		];
		const { runtimeHost, session, toolHistory, fileHistory } = createRuntime(responses, {
			withVerifierModel: true,
			workspace,
		});

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: TASK,
			projectRoot: workspace,
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(result.stopReason).toBe("complete");
		// The first review never reached the LLM: ground truth rejected it directly.
		expect(runAcceptanceReviewMock).toHaveBeenCalledTimes(1);
		const blockerPrompt = session.prompt.mock.calls[2]?.[0] as string;
		expect(blockerPrompt).toContain("acceptance review REJECTED");
		expect(blockerPrompt).toContain("fresh verification re-run of `node --test` exited 1");
	});

	test("extension-style delegation with no structured evidence completes when real tests pass", async () => {
		runAcceptanceReviewMock.mockResolvedValue({ verdict: "accept", reason: "evidence holds" });
		const workspace = createWorkspace({
			"src/config-parser.mjs": BROKEN_PARSER,
			"test/config-parser.test.mjs": PARSER_TEST,
		});
		// Mirrors the dogfood failure: the delegation extension recorded only
		// ledger paperwork (plain strings, no structured result evidence), so the
		// old LLM-only review had nothing checkable. The delegated edit lands on
		// disk for real during the turn.
		const delegatedMutation: MockAssistantResponse = {
			text: "Delegated the fix; the subagent edited src/config-parser.mjs and ran node --test.",
			stopReason: "stop",
			toolOutcomes: [
				{ tool: "read", success: true, file: "src/config-parser.mjs", detail: "read parser" },
				{ tool: "edit", success: true, file: "src/config-parser.mjs", detail: "preserved explicit falsey values" },
				{ tool: "bash", success: true, detail: "node --test" },
			],
			effect: () => writeFileSync(join(workspace, "src/config-parser.mjs"), FIXED_PARSER),
		};
		const { runtimeHost, toolHistory, fileHistory } = createRuntime([discoveryResponse(), delegatedMutation], {
			withVerifierModel: true,
			workspace,
		});

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: TASK,
			projectRoot: workspace,
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(result.stopReason).toBe("complete");
		expect(runAcceptanceReviewMock).toHaveBeenCalledTimes(1);
		const reviewInput = runAcceptanceReviewMock.mock.calls[0]?.[1];
		// The reviewer saw reality: the file really changed on disk, and a fresh
		// re-run of the recorded verification command really passed.
		expect(reviewInput?.workspaceEvidence?.changedFiles.map((file: { path: string }) => file.path)).toContain(
			"src/config-parser.mjs",
		);
		expect(reviewInput?.verificationRerun?.command).toBe("node --test");
		expect(reviewInput?.verificationRerun?.exitCode).toBe(0);
		expect(reviewInput?.verificationRerun?.outputTail).toContain("pass 1");
	});

	test("non-command verification detail falls back to the LLM review with file evidence", async () => {
		runAcceptanceReviewMock.mockResolvedValue({ verdict: "accept", reason: "evidence holds" });
		const workspace = createWorkspace({
			"src/config-parser.mjs": BROKEN_PARSER,
		});
		const proseVerification: MockAssistantResponse = {
			text: "Fixed src/config-parser.mjs and verified the behavior manually.",
			stopReason: "stop",
			toolOutcomes: [
				{ tool: "read", success: true, file: "src/config-parser.mjs", detail: "read parser" },
				{ tool: "edit", success: true, file: "src/config-parser.mjs", detail: "preserved explicit falsey values" },
				{ tool: "verify", success: true, detail: "manual review: the falsey values now round-trip correctly" },
			],
			effect: () => writeFileSync(join(workspace, "src/config-parser.mjs"), FIXED_PARSER),
		};
		const { runtimeHost, toolHistory, fileHistory } = createRuntime([discoveryResponse(), proseVerification], {
			withVerifierModel: true,
			workspace,
		});

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: TASK,
			projectRoot: workspace,
			config: { enableNudges: false },
			getToolCallHistory: () => toolHistory,
			getFileAccessHistory: () => fileHistory,
		});

		expect(result.stopReason).toBe("complete");
		expect(runAcceptanceReviewMock).toHaveBeenCalledTimes(1);
		const reviewInput = runAcceptanceReviewMock.mock.calls[0]?.[1];
		// No command to re-run, but the LLM still gets the on-disk file evidence.
		expect(reviewInput?.verificationRerun).toBeUndefined();
		expect(reviewInput?.workspaceEvidence?.changedFiles.map((file: { path: string }) => file.path)).toContain(
			"src/config-parser.mjs",
		);
	});
});
