/**
 * Subagent (`task` tool) tests.
 *
 * Covers the locked contract from docs/subagent-proposal.md:
 * - Profile tool sets are STRUCTURAL: read-only profiles never see writer
 *   tools, and no profile ever sees `task` (hard no-recursion).
 * - Read-only bash is enforced in the tool wrapper, not the prompt.
 * - Model routing: implement/plan run the parent driver; explore/research/
 *   verify may route cheaper; explicit overrides are honored and validated.
 * - Bounds stop loops (turn cap, repeated-call loop detection, timeout) and
 *   produce clean partial results — never hangs.
 * - Results are result-only: state + summary + capped evidence + usage.
 * - Verification-gate honesty: a completed verify task with a real recorded
 *   bash execution counts as a checkpoint; mutations below the boundary count
 *   as mutations.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@ag1/agent-core";
import type { Model } from "@ag1/ai";
import { afterEach, describe, expect, it } from "vitest";
import { isMutatingOutcome, isVerificationOutcome } from "../src/core/auton/verification-control.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import {
	buildSubagentSystemPrompt,
	buildSubagentTools,
	resolveSubagentModel,
	runSubagent,
	SUBAGENT_TYPES,
	type SubagentRunnerDeps,
	type SubagentType,
	validateReadOnlyBashCommand,
} from "../src/core/subagent-runner.js";
import { acquireSubagentSlot, configureSubagentScheduler } from "../src/core/subagent-scheduler.js";
import { formatTaskResultContent, synthesizeEvidenceOutcomes } from "../src/core/tools/task.js";
import { createFauxStreamFn, createHarness, fauxModel } from "./test-harness.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ag1-subagent-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
	configureSubagentScheduler({});
});

function toolNames(type: SubagentType, cwd: string): string[] {
	return buildSubagentTools(type, cwd).map((tool) => tool.name);
}

// ============================================================================
// Profile tool sets (structural restriction)
// ============================================================================

describe("subagent profile tool sets", () => {
	it("gives every profile read tools and never the task tool (no recursion)", () => {
		const cwd = makeTempDir();
		for (const type of SUBAGENT_TYPES) {
			const names = toolNames(type, cwd);
			expect(names, type).toContain("read");
			expect(names, type).not.toContain("task");
		}
	});

	it("explore and plan are read-only (no write/edit, read-only bash only)", () => {
		const cwd = makeTempDir();
		for (const type of ["explore", "plan"] as const) {
			const names = toolNames(type, cwd);
			expect(names).toEqual(["read", "grep", "find", "ls", "bash"]);
			expect(names).not.toContain("write");
			expect(names).not.toContain("edit");
			expect(names).not.toContain("webSearch");
		}
	});

	it("research adds web tools but no writers", () => {
		const names = toolNames("research", makeTempDir());
		expect(names).toContain("webSearch");
		expect(names).toContain("webFetch");
		expect(names).not.toContain("write");
		expect(names).not.toContain("edit");
	});

	it("verify gets full bash but no writers", () => {
		const names = toolNames("verify", makeTempDir());
		expect(names).toEqual(["read", "grep", "find", "ls", "bash"]);
	});

	it("implement gets the full set", () => {
		const names = toolNames("implement", makeTempDir());
		for (const expected of ["read", "grep", "find", "ls", "bash", "edit", "write", "webSearch", "webFetch"]) {
			expect(names).toContain(expected);
		}
		expect(names).not.toContain("task");
	});
});

// ============================================================================
// Read-only bash enforcement
// ============================================================================

describe("validateReadOnlyBashCommand", () => {
	it("allows inspection commands", () => {
		for (const command of [
			"cat src/index.ts",
			"rg foo | head -5",
			"ls -la 2>/dev/null",
			"git log --oneline -5",
			"git diff HEAD~1",
			"find . -name '*.ts' | sort | uniq",
			"wc -l package.json && file package.json",
		]) {
			expect(validateReadOnlyBashCommand(command), command).toEqual({ ok: true });
		}
	});

	it("rejects mutations, redirection, substitution, and unknown binaries", () => {
		const rejected = [
			"echo hi > file.txt",
			"rm -f file.txt",
			"sed -i 's/a/b/' file.txt",
			"git checkout .",
			"git commit -m x",
			"npm install",
			"cat $(rm -f x)",
			"cat `rm -f x`",
			"FOO=bar ls",
			"node -e 'console.log(1)'",
		];
		for (const command of rejected) {
			const verdict = validateReadOnlyBashCommand(command);
			expect(verdict.ok, command).toBe(false);
		}
	});

	it("the wrapped explore bash tool refuses to execute a mutating command", async () => {
		const cwd = makeTempDir();
		const tools = buildSubagentTools("explore", cwd);
		const bash = tools.find((tool) => tool.name === "bash");
		expect(bash).toBeDefined();
		const result = await bash!.execute("tc1", { command: "echo pwned > pwned.txt" });
		const text = result.content.map((block: { type: string; text?: string }) => block.text ?? "").join("\n");
		expect(text).toContain("Read-only bash");
	});
});

// ============================================================================
// Model routing
// ============================================================================

const expensiveApiModel: Model<any> = {
	...fauxModel,
	provider: "api-exp",
	id: "flagship",
	cost: { input: 5, output: 15, cacheRead: 1, cacheWrite: 5 },
};

const cheapLocalModel: Model<any> = {
	...fauxModel,
	provider: "local",
	id: "local-9b",
};

function stubModelRegistry(models: Model<any>[]): ModelRegistry {
	return {
		find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
		getAvailable: () => models,
		hasConfiguredAuth: () => true,
	} as unknown as ModelRegistry;
}

describe("resolveSubagentModel", () => {
	const registry = stubModelRegistry([expensiveApiModel, cheapLocalModel]);
	const deps = { modelRegistry: registry, getParentModel: () => expensiveApiModel };

	it("routes implement and plan to the parent driver model", () => {
		for (const type of ["implement", "plan"] as const) {
			const resolved = resolveSubagentModel(deps, { type });
			expect("model" in resolved && resolved.model.id, type).toBe("flagship");
		}
	});

	it("routes mechanical profiles to the cheapest eligible model", () => {
		for (const type of ["explore", "research", "verify"] as const) {
			const resolved = resolveSubagentModel(deps, { type });
			expect("model" in resolved && resolved.model.id, type).toBe("local-9b");
		}
	});

	it("honors an explicit provider/id override and rejects unknown models", () => {
		const explicit = resolveSubagentModel(deps, { type: "implement", model: "local/local-9b" });
		expect("model" in explicit && explicit.model.id).toBe("local-9b");

		const unknown = resolveSubagentModel(deps, { type: "explore", model: "local/nope" });
		expect("error" in unknown).toBe(true);

		const malformed = resolveSubagentModel(deps, { type: "explore", model: "no-slash" });
		expect("error" in malformed).toBe(true);
	});
});

// ============================================================================
// Runner behavior (faux provider)
// ============================================================================

function makeDeps(streamFn: StreamFn, cwd: string, parent: Model<any> = fauxModel): SubagentRunnerDeps {
	return {
		cwd,
		modelRegistry: stubModelRegistry([parent]),
		getParentModel: () => parent,
		streamFnFactory: () => streamFn,
	};
}

describe("runSubagent", () => {
	it("completes a simple task and rolls up usage", async () => {
		const { streamFn } = createFauxStreamFn([{ text: "The answer is 42." }]);
		const result = await runSubagent(makeDeps(streamFn, makeTempDir()), {
			description: "answer a question",
			type: "explore",
			prompt: "What is the answer?",
		});
		expect(result.state).toBe("completed");
		expect(result.summary).toContain("42");
		expect(result.partial).toBe(false);
		expect(result.turns).toBe(1);
		expect(result.usage.totalTokens).toBeGreaterThan(0);
		expect(result.model).toBe("faux/faux-1");
	});

	it("collects real bash evidence with exit codes", async () => {
		const { streamFn } = createFauxStreamFn([
			{ toolCalls: [{ name: "bash", args: { command: "echo hello" } }] },
			{ text: "verified" },
		]);
		const result = await runSubagent(makeDeps(streamFn, makeTempDir()), {
			description: "run a check",
			type: "verify",
			prompt: "Run echo hello and report.",
		});
		expect(result.state).toBe("completed");
		expect(result.summary).toBe("verified");
		expect(result.evidence).toEqual([{ kind: "bash", command: "echo hello", exitCode: 0 }]);
		expect(result.usage.totalTokens).toBeGreaterThanOrEqual(300);
	});

	it("collects file evidence for mutations", async () => {
		const cwd = makeTempDir();
		const { streamFn } = createFauxStreamFn([
			{ toolCalls: [{ name: "write", args: { path: "out.txt", content: "hello\n" } }] },
			{ text: "wrote the file" },
		]);
		const result = await runSubagent(makeDeps(streamFn, cwd), {
			description: "write a file",
			type: "implement",
			prompt: "Write hello to out.txt.",
		});
		expect(result.state).toBe("completed");
		expect(result.evidence).toContainEqual({ kind: "file", action: "write", path: "out.txt" });
	});

	it("turn cap produces a clean budget result", async () => {
		const { streamFn } = createFauxStreamFn([{ toolCalls: [{ name: "bash", args: { command: "echo again" } }] }]);
		const result = await runSubagent(makeDeps(streamFn, makeTempDir()), {
			description: "loop forever",
			type: "verify",
			prompt: "Keep checking.",
			maxTurns: 2,
		});
		expect(result.state).toBe("budget");
		expect(result.error).toContain("turn limit");
	});

	it("maxTurns is capped at the hard cap", async () => {
		const { streamFn } = createFauxStreamFn([{ text: "done" }]);
		const result = await runSubagent(makeDeps(streamFn, makeTempDir()), {
			description: "cap check",
			type: "explore",
			prompt: "Hi.",
			maxTurns: 10_000,
		});
		expect(result.state).toBe("completed");
	});

	it("repeated identical tool calls trip loop detection", async () => {
		// Vary commands per call would defeat the fingerprint; keep them identical.
		const { streamFn } = createFauxStreamFn([{ toolCalls: [{ name: "bash", args: { command: "cat same.txt" } }] }]);
		const result = await runSubagent(makeDeps(streamFn, makeTempDir()), {
			description: "stuck loop",
			type: "verify",
			prompt: "Inspect the file.",
			maxTurns: 25,
		});
		expect(result.state).toBe("budget");
		expect(result.error).toContain("Loop detected");
	});

	it("wall timeout aborts a hung run", async () => {
		const { streamFn } = createFauxStreamFn([{ text: "slow answer", delayMs: 2_000 }]);
		const result = await runSubagent(makeDeps(streamFn, makeTempDir()), {
			description: "slow task",
			type: "explore",
			prompt: "Think slowly.",
			timeout: 1,
		});
		expect(result.state).toBe("timeout");
		expect(result.durationMs).toBeGreaterThanOrEqual(1_000);
	}, 15_000);

	it("token budget aborts runaway usage with a partial result", async () => {
		const { streamFn } = createFauxStreamFn([
			{ toolCalls: [{ name: "bash", args: { command: "echo one" } }], usage: { input: 5_000, output: 500 } },
			{ text: "partial findings so far" },
		]);
		const result = await runSubagent(makeDeps(streamFn, makeTempDir()), {
			description: "expensive task",
			type: "verify",
			prompt: "Check things.",
			tokenBudget: 1_000,
		});
		expect(result.state).toBe("budget");
		expect(result.error).toContain("Token budget");
	});

	it("model resolution failures return a failed result (never throw)", async () => {
		const { streamFn } = createFauxStreamFn([{ text: "unused" }]);
		const result = await runSubagent(makeDeps(streamFn, makeTempDir()), {
			description: "bad model",
			type: "explore",
			prompt: "Hi.",
			model: "local/does-not-exist",
		});
		expect(result.state).toBe("failed");
		expect(result.error).toContain("Unknown model");
	});

	it("subagent system prompts carry the result-only contract", () => {
		for (const type of SUBAGENT_TYPES) {
			const prompt = buildSubagentSystemPrompt(type, "/tmp/work");
			expect(prompt, type).toContain("final message");
			expect(prompt, type).toContain("/tmp/work");
		}
	});
});

// ============================================================================
// Scheduler
// ============================================================================

describe("subagent scheduler", () => {
	it("serializes local models on a single slot", async () => {
		configureSubagentScheduler({ localDepth: 1, apiDepth: 3 });
		const release1 = await acquireSubagentSlot(cheapLocalModel);
		let secondAcquired = false;
		const pending = acquireSubagentSlot(cheapLocalModel).then((release) => {
			secondAcquired = true;
			return release;
		});
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(secondAcquired).toBe(false);
		release1();
		const release2 = await pending;
		expect(secondAcquired).toBe(true);
		release2();
	});

	it("allows concurrent API subagents up to the pool depth", async () => {
		configureSubagentScheduler({ localDepth: 1, apiDepth: 2 });
		const releases = await Promise.all([
			acquireSubagentSlot(expensiveApiModel),
			acquireSubagentSlot(expensiveApiModel),
		]);
		let thirdAcquired = false;
		const pending = acquireSubagentSlot(expensiveApiModel).then((release) => {
			thirdAcquired = true;
			return release;
		});
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(thirdAcquired).toBe(false);
		for (const release of releases) release();
		const release3 = await pending;
		release3();
	});
});

// ============================================================================
// Result formatting + evidence synthesis + gate integration
// ============================================================================

describe("task result formatting and gate honesty", () => {
	const baseResult = {
		state: "completed" as const,
		type: "verify" as const,
		description: "verify auth flow",
		model: "local/local-9b",
		summary: "All tests pass.",
		partial: false,
		evidence: [
			{ kind: "bash" as const, command: "npm test", exitCode: 0 },
			{ kind: "bash" as const, command: "false", exitCode: 1 },
			{ kind: "file" as const, action: "edit" as const, path: "src/auth.ts" },
		],
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: 0 },
		turns: 2,
		durationMs: 1_500,
	};

	it("formats compact result content with state, summary, and evidence", () => {
		const content = formatTaskResultContent(baseResult);
		expect(content).toContain("Task completed: verify auth flow");
		expect(content).toContain("All tests pass.");
		expect(content).toContain("`npm test` → exit 0");
		expect(content).toContain("edit: src/auth.ts");
	});

	it("synthesizes only successful outcomes (bash exit 0 + file mutations)", () => {
		const outcomes: Array<{ tool: string; success: boolean; detail?: string }> = [];
		synthesizeEvidenceOutcomes(baseResult, (outcome) => outcomes.push(outcome));
		expect(outcomes).toEqual([
			{ tool: "bash", success: true, detail: "npm test" },
			{ tool: "edit", success: true, detail: "src/auth.ts" },
		]);
	});

	it("a completed verify task with a real recorded bash run counts as a checkpoint", () => {
		const outcome = {
			tool: "task",
			success: true,
			metadata: {
				type: "verify",
				state: "completed",
				evidence: [{ kind: "bash", command: "npm test", exitCode: 0 }],
			},
		};
		expect(isVerificationOutcome(outcome)).toBe(true);
	});

	it("prose does not count: non-verify types, failures, and non-zero exits are rejected", () => {
		const implementOutcome = {
			tool: "task",
			success: true,
			metadata: {
				type: "implement",
				state: "completed",
				evidence: [{ kind: "bash", command: "npm test", exitCode: 0 }],
			},
		};
		expect(isVerificationOutcome(implementOutcome)).toBe(false);

		const failedBash = {
			tool: "task",
			success: true,
			metadata: {
				type: "verify",
				state: "completed",
				evidence: [{ kind: "bash", command: "npm test", exitCode: 1 }],
			},
		};
		expect(isVerificationOutcome(failedBash)).toBe(false);

		const noEvidence = {
			tool: "task",
			success: true,
			metadata: { type: "verify", state: "completed", evidence: [] },
		};
		expect(isVerificationOutcome(noEvidence)).toBe(false);

		const timedOut = {
			tool: "task",
			success: true,
			metadata: { type: "verify", state: "timeout", evidence: [{ kind: "bash", command: "npm test", exitCode: 0 }] },
		};
		expect(isVerificationOutcome(timedOut)).toBe(false);
	});

	it("file evidence below the boundary counts as mutation", () => {
		const outcome = {
			tool: "task",
			success: true,
			metadata: {
				type: "implement",
				state: "completed",
				evidence: [{ kind: "file", action: "write", path: "a.ts" }],
			},
		};
		expect(isMutatingOutcome(outcome)).toBe(true);

		const readOnly = {
			tool: "task",
			success: true,
			metadata: { type: "explore", state: "completed", evidence: [] },
		};
		expect(isMutatingOutcome(readOnly)).toBe(false);
	});
});

// ============================================================================
// Task-tool surface (on by default for every model; env kill switches remain)
// ============================================================================

describe("task tool surface gate", () => {
	const smallLocalModel: Model<any> = {
		...fauxModel,
		provider: "local",
		id: "qwen/qwen3.5-9b",
		baseUrl: "http://localhost:1234/v1",
		contextWindow: 8192,
	};

	function gateHarness(model: Model<any>) {
		const harness = createHarness({ model });
		return {
			hasTask: harness.session.getAllTools().some((tool) => tool.name === "task"),
			cleanup: harness.cleanup,
		};
	}

	it("includes the task tool even for low-reliability cramped local models", () => {
		const { hasTask, cleanup } = gateHarness(smallLocalModel);
		try {
			expect(hasTask).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("includes the task tool for capable models", () => {
		const { hasTask, cleanup } = gateHarness(fauxModel);
		try {
			expect(hasTask).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("AG1_TASK_TOOL=1 forces the tool on", () => {
		process.env.AG1_TASK_TOOL = "1";
		try {
			const { hasTask, cleanup } = gateHarness(smallLocalModel);
			try {
				expect(hasTask).toBe(true);
			} finally {
				cleanup();
			}
		} finally {
			delete process.env.AG1_TASK_TOOL;
		}
	});

	it("AG1_TASK_TOOL=0 forces the tool off for capable models", () => {
		process.env.AG1_TASK_TOOL = "0";
		try {
			const { hasTask, cleanup } = gateHarness(fauxModel);
			try {
				expect(hasTask).toBe(false);
			} finally {
				cleanup();
			}
		} finally {
			delete process.env.AG1_TASK_TOOL;
		}
	});
});
