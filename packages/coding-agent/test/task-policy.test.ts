import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { classifyControlledTaskIntent, formatTaskPolicy, inferTaskPolicy } from "../src/core/task-policy.js";
import { buildWorkspaceIndex } from "../src/core/workspace-index.js";

describe("task-policy", () => {
	let rootDir: string;

	beforeEach(() => {
		rootDir = mkdtempSync(join(tmpdir(), "ag1-task-policy-"));
		mkdirSync(join(rootDir, "src"), { recursive: true });
		mkdirSync(join(rootDir, "tests"), { recursive: true });
		writeFileSync(join(rootDir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }, null, 2));
		writeFileSync(join(rootDir, "src", "config-parser.mjs"), "export function parseConfig(input) { return input; }\n");
		writeFileSync(
			join(rootDir, "tests", "config-parser.test.mjs"),
			'import { parseConfig } from "../src/config-parser.mjs";\n',
		);
		writeFileSync(join(rootDir, "README.md"), "# Fixture\n");
	});

	afterEach(() => {
		rmSync(rootDir, { recursive: true, force: true });
	});

	test("classifies common task intents", () => {
		expect(classifyControlledTaskIntent("Fix the parser bug")).toBe("debug_fix");
		expect(classifyControlledTaskIntent("Refactor this across modules")).toBe("multi_file_change");
		expect(classifyControlledTaskIntent("Explain how the parser works")).toBe("code_explanation");
		expect(classifyControlledTaskIntent("Research the latest API release")).toBe("research");
		expect(classifyControlledTaskIntent("Improve the responsive UI component")).toBe("frontend_visual");
	});

	test("infers strict benchmark policy for a deterministic fixture", () => {
		const index = buildWorkspaceIndex({ rootDir });
		const policy = inferTaskPolicy({
			index,
			mode: "strict_benchmark",
			prompt: [
				"Fix the configuration parser so explicit falsey values from user input are preserved.",
				"The intended verification command is: `node --test`",
			].join("\n"),
		});

		expect(policy.intent).toBe("debug_fix");
		expect(policy.mutationExpected).toBe(true);
		expect(policy.webRelevant).toBe(false);
		expect(policy.allowedPaths).toContain("src/config-parser.mjs");
		expect(policy.allowedPaths).toContain("tests/config-parser.test.mjs");
		expect(policy.expectedChangedPaths).toContain("src/config-parser.mjs");
		expect(policy.expectedChangedPaths).not.toContain("tests/config-parser.test.mjs");
		expect(policy.verification).toBe("node --test");
		expect(policy.stopAfterVerifierPass).toBe(true);
		expect(policy.maxSearchesBeforePatch).toBe(1);
		expect(formatTaskPolicy(policy)).toContain("Controlled execution policy:");
	});

	test("does not assign mutation policy to direct answers", () => {
		const index = buildWorkspaceIndex({ rootDir });
		const policy = inferTaskPolicy({
			index,
			prompt: "Which file defines the config parser? Give the exact path.",
		});

		expect(policy.intent).toBe("direct_answer");
		expect(policy.mutationExpected).toBe(false);
		expect(policy.expectedChangedPaths).toEqual([]);
		expect(policy.verification).toBeUndefined();
		expect(policy.maxPatchAttempts).toBe(0);
	});
});
