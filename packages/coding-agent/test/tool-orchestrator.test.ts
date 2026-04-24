import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { TaskPolicy } from "../src/core/task-policy.js";
import { parseEmbeddedTaskPolicy, ToolOrchestrator } from "../src/core/tool-orchestrator.js";

describe("tool-orchestrator", () => {
	let rootDir: string;
	let policy: TaskPolicy;

	beforeEach(() => {
		rootDir = mkdtempSync(join(tmpdir(), "ag1-tool-orchestrator-"));
		mkdirSync(join(rootDir, "src"), { recursive: true });
		mkdirSync(join(rootDir, "tests"), { recursive: true });
		writeFileSync(join(rootDir, "src", "config-parser.mjs"), "export function parseConfig() {}\n");
		writeFileSync(join(rootDir, "src", "defaults.mjs"), "export const defaults = {};\n");
		writeFileSync(join(rootDir, "tests", "config-parser.test.mjs"), "import '../src/config-parser.mjs';\n");
		policy = {
			mode: "strict_benchmark",
			intent: "debug_fix",
			mutationExpected: true,
			webRelevant: false,
			allowedPaths: ["src/config-parser.mjs", "src/defaults.mjs", "tests/config-parser.test.mjs"],
			expectedChangedPaths: ["src/config-parser.mjs"],
			likelyTests: ["tests/config-parser.test.mjs"],
			verification: "node --test",
			maxReadsBeforePatch: 4,
			maxSearchesBeforePatch: 1,
			maxPatchAttempts: 2,
			stopAfterVerifierPass: true,
		};
	});

	afterEach(() => {
		rmSync(rootDir, { recursive: true, force: true });
	});

	test("blocks broad discovery when strict policy already lists relevant files", () => {
		const orchestrator = new ToolOrchestrator({ cwd: rootDir, policy });

		expect(orchestrator.evaluate("ls", { path: "tests" })).toMatchObject({
			allow: false,
			nextAction: "read tests/config-parser.test.mjs",
		});
		expect(orchestrator.evaluate("find", { pattern: "**/*", path: "." })).toMatchObject({
			allow: false,
			nextAction: "read tests/config-parser.test.mjs",
		});
	});

	test("allows repeated reads but blocks wrong-target edits in strict mode", () => {
		const orchestrator = new ToolOrchestrator({ cwd: rootDir, policy });
		orchestrator.noteToolResult({
			toolName: "read",
			args: { path: "src/config-parser.mjs" },
			isError: false,
			result: { content: [{ type: "text", text: "ok" }] },
		});

		expect(orchestrator.evaluate("read", { path: "src/config-parser.mjs" })).toMatchObject({
			allow: true,
		});
		expect(orchestrator.evaluate("edit", { path: "src/defaults.mjs", edits: [] })).toMatchObject({
			allow: false,
			nextAction: "edit src/config-parser.mjs",
		});
	});

	test("allows required test evidence before pushing optional reads to edit", () => {
		const orchestrator = new ToolOrchestrator({ cwd: rootDir, policy });
		expect(orchestrator.getNextActionHint()).toBe("read tests/config-parser.test.mjs");
		orchestrator.noteToolResult({
			toolName: "read",
			args: { path: "src/config-parser.mjs" },
			isError: false,
			result: { content: [{ type: "text", text: "ok" }] },
		});
		expect(orchestrator.getNextActionHint()).toBe("read tests/config-parser.test.mjs");
		orchestrator.noteToolResult({
			toolName: "read",
			args: { path: "src/defaults.mjs" },
			isError: false,
			result: { content: [{ type: "text", text: "ok" }] },
		});

		expect(orchestrator.evaluate("read", { path: "tests/config-parser.test.mjs" })).toMatchObject({
			allow: true,
		});
		orchestrator.noteToolResult({
			toolName: "read",
			args: { path: "tests/config-parser.test.mjs" },
			isError: false,
			result: { content: [{ type: "text", text: "ok" }] },
		});
		expect(orchestrator.getNextActionHint()).toBe("edit src/config-parser.mjs");
		expect(orchestrator.evaluate("read", { path: "src/config-parser.mjs" })).toMatchObject({
			allow: true,
		});
		expect(orchestrator.evaluate("read", { path: "src/defaults.mjs" })).toMatchObject({
			allow: false,
			nextAction: "edit src/config-parser.mjs",
		});
	});

	test("does not apply pre-patch read gate to multi-path expected changes", () => {
		const orchestrator = new ToolOrchestrator({
			cwd: rootDir,
			policy: {
				...policy,
				expectedChangedPaths: ["src/config-parser.mjs", "tests/config-parser.test.mjs"],
			},
		});
		orchestrator.noteToolResult({
			toolName: "read",
			args: { path: "src/config-parser.mjs" },
			isError: false,
			result: { content: [{ type: "text", text: "ok" }] },
		});
		orchestrator.noteToolResult({
			toolName: "read",
			args: { path: "src/defaults.mjs" },
			isError: false,
			result: { content: [{ type: "text", text: "ok" }] },
		});

		expect(orchestrator.evaluate("read", { path: "tests/config-parser.test.mjs" })).toMatchObject({
			allow: true,
		});
	});

	test("blocks further tools after verifier passes following mutation", () => {
		const orchestrator = new ToolOrchestrator({ cwd: rootDir, policy });
		orchestrator.noteToolResult({
			toolName: "edit",
			args: { path: "src/config-parser.mjs", edits: [] },
			isError: false,
			result: { content: [{ type: "text", text: "edited" }] },
		});
		orchestrator.noteToolResult({
			toolName: "bash",
			args: { command: "node --test" },
			isError: false,
			result: { content: [{ type: "text", text: "ok 1 - config parser" }] },
		});

		expect(orchestrator.evaluate("read", { path: "src/defaults.mjs" })).toMatchObject({
			allow: false,
			nextAction: "final_answer",
		});
	});

	test("defers repeated same-file edits until verifier runs but allows cross-file edits", () => {
		const orchestrator = new ToolOrchestrator({
			cwd: rootDir,
			policy: {
				...policy,
				expectedChangedPaths: ["src/config-parser.mjs", "src/defaults.mjs"],
			},
		});
		orchestrator.noteToolResult({
			toolName: "edit",
			args: { path: "src/config-parser.mjs", edits: [] },
			isError: false,
			result: { content: [{ type: "text", text: "edited" }] },
		});

		expect(orchestrator.evaluate("edit", { path: "src/config-parser.mjs", edits: [] })).toMatchObject({
			allow: false,
			nextAction: "bash node --test",
		});
		expect(orchestrator.evaluate("edit", { path: "src/defaults.mjs", edits: [] })).toMatchObject({
			allow: true,
		});
	});

	test("allows expected-target repair after verifier failure", () => {
		const orchestrator = new ToolOrchestrator({ cwd: rootDir, policy });
		orchestrator.noteToolResult({
			toolName: "read",
			args: { path: "src/config-parser.mjs" },
			isError: false,
			result: { content: [{ type: "text", text: "ok" }] },
		});
		orchestrator.noteToolResult({
			toolName: "edit",
			args: { path: "src/config-parser.mjs", edits: [] },
			isError: false,
			result: { content: [{ type: "text", text: "edited" }] },
		});
		orchestrator.noteToolResult({
			toolName: "bash",
			args: { command: "node --test" },
			isError: true,
			result: { content: [{ type: "text", text: "Command exited with code 1" }] },
		});

		expect(orchestrator.evaluate("read", { path: "src/config-parser.mjs" })).toMatchObject({
			allow: true,
		});
		expect(orchestrator.evaluate("edit", { path: "src/config-parser.mjs", edits: [] })).toMatchObject({
			allow: true,
		});
	});

	test("blocks verifier reruns after failure until another mutation", () => {
		const orchestrator = new ToolOrchestrator({ cwd: rootDir, policy });
		orchestrator.noteToolResult({
			toolName: "edit",
			args: { path: "src/config-parser.mjs", edits: [] },
			isError: false,
			result: { content: [{ type: "text", text: "edited" }] },
		});
		orchestrator.noteToolResult({
			toolName: "bash",
			args: { command: "node --test" },
			isError: true,
			result: { content: [{ type: "text", text: "AssertionError: expected false to be true tests/config-parser.test.mjs:4" }] },
		});

		expect(orchestrator.getNextActionHint()).toContain("edit src/config-parser.mjs");
		expect(orchestrator.evaluate("bash", { command: "node --test" })).toMatchObject({
			allow: false,
			nextAction: "edit src/config-parser.mjs",
		});

		orchestrator.noteToolResult({
			toolName: "edit",
			args: { path: "src/config-parser.mjs", edits: [] },
			isError: false,
			result: { content: [{ type: "text", text: "edited again" }] },
		});
		expect(orchestrator.evaluate("bash", { command: "node --test" })).toMatchObject({
			allow: true,
		});
	});

	test("stops after repeated same verifier failure", () => {
		const orchestrator = new ToolOrchestrator({ cwd: rootDir, policy });
		for (const line of ["first", "second"]) {
			orchestrator.noteToolResult({
				toolName: "edit",
				args: { path: "src/config-parser.mjs", edits: [] },
				isError: false,
				result: { content: [{ type: "text", text: `edited ${line}` }] },
			});
			orchestrator.noteToolResult({
				toolName: "bash",
				args: { command: "node --test" },
				isError: true,
				result: {
					content: [{ type: "text", text: `AssertionError: expected false to be true tests/config-parser.test.mjs:${line === "first" ? 4 : 8}` }],
				},
			});
		}

		expect(orchestrator.evaluate("read", { path: "src/config-parser.mjs" })).toMatchObject({
			allow: false,
			nextAction: "final_answer",
		});
	});

	test("blocks empty bash calls with a concrete verifier hint", () => {
		const orchestrator = new ToolOrchestrator({ cwd: rootDir, policy });

		expect(orchestrator.evaluate("bash", {})).toMatchObject({
			allow: false,
			nextAction: "bash node --test",
		});
	});

	test("blocks verifier before expected mutation paths are edited", () => {
		const orchestrator = new ToolOrchestrator({ cwd: rootDir, policy });

		expect(orchestrator.evaluate("bash", { command: "node --test" })).toMatchObject({
			allow: false,
			nextAction: "edit src/config-parser.mjs",
		});

		orchestrator.noteToolResult({
			toolName: "edit",
			args: { path: "src/config-parser.mjs", edits: [] },
			isError: false,
			result: { content: [{ type: "text", text: "edited" }] },
		});
		expect(orchestrator.evaluate("bash", { command: "node --test" })).toMatchObject({
			allow: true,
		});
	});

	test("rewrites non-exact verifier variants in strict benchmark mode", () => {
		const orchestrator = new ToolOrchestrator({ cwd: rootDir, policy });
		orchestrator.noteToolResult({
			toolName: "edit",
			args: { path: "src/config-parser.mjs", edits: [] },
			isError: false,
			result: { content: [{ type: "text", text: "edited" }] },
		});
		const targetedVerifierArgs = { command: "node --test tests/config-parser.test.mjs" };
		const pipedVerifierArgs = { command: "cd /tmp/workspace && node --test 2>&1 | head -30" };

		expect(orchestrator.evaluate("bash", targetedVerifierArgs)).toMatchObject({
			allow: true,
			reason: "Controlled runtime: verifier command rewritten to: node --test",
		});
		expect(targetedVerifierArgs.command).toBe("node --test");
		expect(orchestrator.evaluate("bash", pipedVerifierArgs)).toMatchObject({
			allow: true,
		});
		expect(pipedVerifierArgs.command).toBe("node --test");
	});

	test("points shell discovery to verifier after mutation", () => {
		const orchestrator = new ToolOrchestrator({ cwd: rootDir, policy });
		orchestrator.noteToolResult({
			toolName: "edit",
			args: { path: "src/config-parser.mjs", edits: [] },
			isError: false,
			result: { content: [{ type: "text", text: "edited" }] },
		});

		expect(orchestrator.evaluate("bash", { command: "find . -type f" })).toMatchObject({
			allow: false,
			nextAction: "bash node --test",
		});
	});

	test("parses embedded benchmark policy guidance", () => {
		const parsed = parseEmbeddedTaskPolicy(`
Controlled workspace manifest:
Relevant files:
- src/key-normalizer.mjs
- tests/session-store.test.mjs
Relevant tests:
- tests/session-store.test.mjs
Controlled execution policy:
- mode: strict_benchmark
- intent: debug_fix
- expected changed paths: src/key-normalizer.mjs
- allowed changed paths: src/key-normalizer.mjs, src/session-index.mjs
- verifier: node --test
`);

		expect(parsed.mode).toBe("strict_benchmark");
		expect(parsed.intent).toBe("debug_fix");
		expect(parsed.allowedPaths).toEqual(["src/key-normalizer.mjs", "tests/session-store.test.mjs"]);
		expect(parsed.expectedChangedPaths).toEqual(["src/key-normalizer.mjs"]);
		expect(parsed.verification).toBe("node --test");
	});
});
