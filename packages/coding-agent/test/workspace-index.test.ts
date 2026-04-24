import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	buildWorkspaceIndex,
	buildWorkspaceManifest,
	formatWorkspaceManifest,
} from "../src/core/workspace-index.js";

describe("workspace-index", () => {
	let rootDir: string;

	beforeEach(() => {
		rootDir = mkdtempSync(join(tmpdir(), "ag1-workspace-index-"));
		mkdirSync(join(rootDir, "src"), { recursive: true });
		mkdirSync(join(rootDir, "tests"), { recursive: true });
		mkdirSync(join(rootDir, "node_modules", "ignored"), { recursive: true });
		writeFileSync(join(rootDir, ".gitignore"), "ignored.txt\n.cache/\n");
		writeFileSync(
			join(rootDir, "package.json"),
			JSON.stringify({ scripts: { test: "node --test", check: "tsc --noEmit" } }, null, 2),
		);
		writeFileSync(join(rootDir, "src", "defaults.mjs"), "export const defaults = { preserveFalse: true };\n");
		writeFileSync(
			join(rootDir, "src", "config-parser.mjs"),
			'import { defaults } from "./defaults.mjs";\nexport function parseConfig(input) { return { ...defaults, ...input }; }\n',
		);
		writeFileSync(
			join(rootDir, "tests", "config-parser.test.mjs"),
			'import { parseConfig } from "../src/config-parser.mjs";\n',
		);
		writeFileSync(join(rootDir, "ignored.txt"), "ignore me");
		writeFileSync(join(rootDir, "node_modules", "ignored", "index.js"), "ignore me");
	});

	afterEach(() => {
		rmSync(rootDir, { recursive: true, force: true });
	});

	test("collects filtered files, package scripts, tests, and import edges", () => {
		const index = buildWorkspaceIndex({ rootDir });

		expect(index.files.map((file) => file.path)).toContain("src/config-parser.mjs");
		expect(index.files.map((file) => file.path)).not.toContain("ignored.txt");
		expect(index.files.some((file) => file.path.includes("node_modules"))).toBe(false);
		expect(index.packageScripts.test).toBe("node --test");
		expect(index.testFiles).toEqual(["tests/config-parser.test.mjs"]);
		expect(index.importEdges).toContainEqual({
			from: "tests/config-parser.test.mjs",
			to: "src/config-parser.mjs",
			specifier: "../src/config-parser.mjs",
		});
		expect(index.importEdges).toContainEqual({
			from: "src/config-parser.mjs",
			to: "src/defaults.mjs",
			specifier: "./defaults.mjs",
		});
	});

	test("builds a compact task-specific manifest", () => {
		const index = buildWorkspaceIndex({ rootDir });
		const manifest = buildWorkspaceManifest(index, {
			prompt: "Fix the config parser so explicit falsey values are preserved.",
			maxFiles: 8,
		});

		expect(manifest.files).toContain("src/config-parser.mjs");
		expect(manifest.files).toContain("src/defaults.mjs");
		expect(manifest.files).toContain("tests/config-parser.test.mjs");
		expect(manifest.likelyVerifier).toBe("npm test");
		expect(formatWorkspaceManifest(manifest)).toContain("Controlled workspace manifest:");
	});
});
