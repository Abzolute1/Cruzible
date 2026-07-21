import { describe, expect, test } from "vitest";
import { normalizePatchIntent } from "../src/core/patch-intent.js";

describe("patch-intent", () => {
	test("normalizes common replacement key variants", () => {
		expect(
			normalizePatchIntent({
				file_path: "src/app.ts",
				changes: [{ search: "before", replace: "after" }],
			}),
		).toEqual({
			path: "src/app.ts",
			replacements: [{ oldText: "before", newText: "after" }],
		});
	});

	test("normalizes JSON-string replacement arrays", () => {
		expect(
			normalizePatchIntent({
				path: "src/app.ts",
				replacements: '[{"old_text":"before","new_text":"after"}]',
			}),
		).toEqual({
			path: "src/app.ts",
			replacements: [{ oldText: "before", newText: "after" }],
		});
	});

	test("normalizes Aider-style search replace blocks", () => {
		expect(
			normalizePatchIntent({
				path: "src/app.ts",
				patch: ["<<<<<<< SEARCH", "const value = 1;", "=======", "const value = 2;", ">>>>>>> REPLACE"].join("\n"),
			}),
		).toEqual({
			path: "src/app.ts",
			replacements: [{ oldText: "const value = 1;", newText: "const value = 2;" }],
		});
	});

	test("normalizes simple unified diffs", () => {
		expect(
			normalizePatchIntent({
				diff: [
					"--- a/src/app.ts",
					"+++ b/src/app.ts",
					"@@ -1,3 +1,3 @@",
					" export function answer() {",
					"-\treturn 1;",
					"+\treturn 2;",
					" }",
				].join("\n"),
			}),
		).toEqual({
			path: "src/app.ts",
			replacements: [
				{
					oldText: ["export function answer() {", "\treturn 1;", "}"].join("\n"),
					newText: ["export function answer() {", "\treturn 2;", "}"].join("\n"),
				},
			],
		});
	});
});
