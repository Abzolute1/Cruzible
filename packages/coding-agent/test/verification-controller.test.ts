import { describe, expect, test } from "vitest";
import {
	classifyVerificationFailure,
	commandMatchesVerifier,
	selectVerificationCommand,
} from "../src/core/verification-controller.js";

describe("verification-controller", () => {
	test("narrows simple node test commands to a single relevant test file", () => {
		expect(
			selectVerificationCommand({
				command: "node --test",
				manifest: {
					testFiles: ["tests/config-parser.test.mjs"],
					likelyVerifier: "node --test",
				},
			}),
		).toBe("node --test tests/config-parser.test.mjs");
	});

	test("keeps composite verifier commands intact", () => {
		expect(
			selectVerificationCommand({
				command: "node --test && node scripts/check-regression-test.mjs",
				manifest: {
					testFiles: ["tests/search-url.test.mjs"],
					likelyVerifier: "node --test",
				},
			}),
		).toBe("node --test && node scripts/check-regression-test.mjs");
	});

	test("does not narrow when multiple test files are relevant", () => {
		expect(
			selectVerificationCommand({
				command: "node --test",
				manifest: {
					testFiles: ["tests/a.test.mjs", "tests/b.test.mjs"],
					likelyVerifier: "node --test",
				},
			}),
		).toBe("node --test");
	});

	test("matches broader verifier commands against targeted verifier policy", () => {
		expect(commandMatchesVerifier("node --test", "node --test tests/config-parser.test.mjs")).toBe(true);
		expect(commandMatchesVerifier("node --test tests/config-parser.test.mjs", "node --test")).toBe(true);
		expect(commandMatchesVerifier("npm test", "node --test tests/config-parser.test.mjs")).toBe(false);
	});

	test("classifies assertion failures with compact signatures", () => {
		const first = classifyVerificationFailure(`
TAP version 13
not ok 1 - saves normalized scope
  ---
  error: |-
    AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal
    actual: []
    expected: [ 'admin' ]
  stack: tests/session-store.test.mjs:14:10
`);
		const second = classifyVerificationFailure(`
not ok 1 - saves normalized scope
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal
actual: []
expected: [ 'admin' ]
stack: tests/session-store.test.mjs:22:10
`);

		expect(first.kind).toBe("assertion");
		expect(first.summary).toContain("AssertionError");
		expect(first.paths).toContain("tests/session-store.test.mjs");
		expect(first.signature).toBe(second.signature);
	});

	test("classifies syntax, import, timeout, and unrelated failures", () => {
		expect(classifyVerificationFailure("SyntaxError: Unexpected token ':' at src/config-parser.mjs:4").kind).toBe("syntax");
		expect(classifyVerificationFailure("Error [ERR_MODULE_NOT_FOUND]: Cannot find module './missing.js'").kind).toBe("import");
		expect(classifyVerificationFailure("Command timed out after 30000ms").kind).toBe("timeout");
		expect(
			classifyVerificationFailure("not ok 1 tests/unrelated.test.mjs AssertionError", {
				relevantPaths: ["src/config-parser.mjs"],
			}).kind,
		).toBe("unrelated");
	});
});
