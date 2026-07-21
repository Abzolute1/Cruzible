import { describe, expect, test } from "vitest";
import type { ToolOutcome } from "../src/core/auton/nudges/types.js";
import {
	getVerificationCheckpointState,
	getVerificationFailurePreview,
	getVisualVerificationBlockingIssues,
	isIntendedVerificationOutcome,
	isMutatingOutcome,
	isReliableVerificationBashCommand,
	isVerificationOutcome,
	isVisualVerificationOutcome,
	summarizeVisualBlockingIssues,
} from "../src/core/auton/verification-control.js";

function outcome(overrides: Partial<ToolOutcome>): ToolOutcome {
	return {
		tool: "bash",
		success: true,
		detail: "npm test",
		...overrides,
	};
}

describe("autonomous verification control", () => {
	test("requires verification after the latest mutation", () => {
		expect(
			getVerificationCheckpointState([
				outcome({ tool: "bash", detail: "npm test" }),
				outcome({ tool: "edit", file: "src/app.ts", detail: "patched app" }),
			]),
		).toMatchObject({
			hasVerificationCheckpoint: false,
			lastVerificationDetail: "npm test",
		});

		expect(
			getVerificationCheckpointState([
				outcome({ tool: "edit", file: "src/app.ts", detail: "patched app" }),
				outcome({ tool: "bash", detail: "npm test" }),
			]),
		).toMatchObject({
			hasVerificationCheckpoint: true,
			lastVerificationDetail: "npm test",
		});
	});

	test("recognizes reliable verification commands and rejects unsafe head/tail pipes", () => {
		expect(isReliableVerificationBashCommand("npm test")).toBe(true);
		expect(isReliableVerificationBashCommand("pnpm run build")).toBe(true);
		expect(isReliableVerificationBashCommand("go test ./...")).toBe(true);
		expect(isReliableVerificationBashCommand("npm test | tail -20")).toBe(false);
		expect(isReliableVerificationBashCommand("set -o pipefail; npm test | tail -20")).toBe(true);
	});

	test("recognizes the declared intended verification command with honesty guards intact", () => {
		const command = "node src/export.mjs";
		// Verbatim and cd-prefixed runs count — the harness itself demands verbatim.
		expect(isIntendedVerificationOutcome(outcome({ detail: "node src/export.mjs" }), command)).toBe(true);
		expect(isIntendedVerificationOutcome(outcome({ detail: "cd /workspace && node src/export.mjs" }), command)).toBe(
			true,
		);
		expect(isIntendedVerificationOutcome(outcome({ detail: "node src/export.mjs && echo done" }), command)).toBe(
			true,
		);
		// Laundered exit codes and truncated output still prove nothing.
		expect(isIntendedVerificationOutcome(outcome({ detail: "node src/export.mjs || true" }), command)).toBe(false);
		expect(isIntendedVerificationOutcome(outcome({ detail: "node src/export.mjs; true" }), command)).toBe(false);
		expect(isIntendedVerificationOutcome(outcome({ detail: "node src/export.mjs | head -5" }), command)).toBe(false);
		// Appended args, different scripts, and near-miss names do not count.
		expect(isIntendedVerificationOutcome(outcome({ detail: "node src/export.mjs --verbose" }), command)).toBe(false);
		expect(isIntendedVerificationOutcome(outcome({ detail: "node src/export.mjs.bak" }), command)).toBe(false);
		expect(isIntendedVerificationOutcome(outcome({ detail: "node src/other.mjs" }), command)).toBe(false);
		// Non-bash tools and missing declarations never match.
		expect(isIntendedVerificationOutcome(outcome({ tool: "edit", detail: command }), command)).toBe(false);
		expect(isIntendedVerificationOutcome(outcome({ detail: command }), undefined)).toBe(false);
		// Multi-step declared commands match verbatim as a whole.
		const chained = "node a.mjs && node b.mjs";
		expect(isIntendedVerificationOutcome(outcome({ detail: chained }), chained)).toBe(true);
	});

	test("split segments of a chained intended command each count as verification", () => {
		const command = "bash build.sh && grep -q OK dist/output.txt";
		// The v4 shell_script_fix failure mode: chain split across two bash calls.
		expect(isIntendedVerificationOutcome(outcome({ detail: "bash build.sh" }), command)).toBe(true);
		expect(isIntendedVerificationOutcome(outcome({ detail: "grep -q OK dist/output.txt" }), command)).toBe(true);
		// Near-misses and laundered segments still do not count.
		expect(isIntendedVerificationOutcome(outcome({ detail: "bash other.sh" }), command)).toBe(false);
		expect(isIntendedVerificationOutcome(outcome({ detail: "grep -q OK dist/other.txt" }), command)).toBe(false);
		expect(isIntendedVerificationOutcome(outcome({ detail: "bash build.sh || true" }), command)).toBe(false);
		// Single-segment commands keep exact-match semantics (no segment loosening).
		expect(
			isIntendedVerificationOutcome(outcome({ detail: "node src/export.mjs --flag" }), "node src/export.mjs"),
		).toBe(false);
	});

	test("intended verification command satisfies the checkpoint after a mutation", () => {
		const history = [
			outcome({ tool: "edit", file: "src/export.mjs", detail: "patched export" }),
			outcome({ tool: "bash", detail: "node src/export.mjs" }),
		];
		// Without the declaration the run-the-program command is invisible...
		expect(getVerificationCheckpointState(history).hasVerificationCheckpoint).toBe(false);
		// ...and with it the checkpoint holds.
		expect(getVerificationCheckpointState(history, false, "node src/export.mjs")).toMatchObject({
			hasVerificationCheckpoint: true,
			lastVerificationDetail: "node src/export.mjs",
		});
	});

	test("classifies mutation, verification, and visual verification outcomes", () => {
		expect(isMutatingOutcome(outcome({ tool: "write" }))).toBe(true);
		expect(isVerificationOutcome(outcome({ tool: "verify" }))).toBe(true);
		expect(isVerificationOutcome(outcome({ tool: "bash", detail: "npm run lint" }))).toBe(true);
		expect(isVisualVerificationOutcome(outcome({ tool: "interact_then_screenshot" }))).toBe(true);
		expect(isVisualVerificationOutcome(outcome({ tool: "bash", detail: "npm test" }))).toBe(false);
	});

	test("requires clean visual verification when visual verification is relevant", () => {
		expect(
			getVerificationCheckpointState(
				[
					outcome({ tool: "edit", file: "src/app.tsx", detail: "patched UI" }),
					outcome({ tool: "bash", detail: "npm test" }),
				],
				true,
			),
		).toMatchObject({
			hasVerificationCheckpoint: false,
			lastVerificationDetail: "npm test",
			visualBlockingIssues: [],
		});

		expect(
			getVerificationCheckpointState(
				[
					outcome({ tool: "edit", file: "src/app.tsx", detail: "patched UI" }),
					outcome({
						tool: "screenshot_url",
						detail: "captured app",
						metadata: { consoleErrors: ["ReferenceError: app is not defined"] },
					}),
				],
				true,
			),
		).toMatchObject({
			hasVerificationCheckpoint: false,
			lastVerificationDetail: "captured app",
			visualFailureDetail: "console errors: ReferenceError: app is not defined",
			visualBlockingIssues: ["console errors: ReferenceError: app is not defined"],
		});

		expect(
			getVerificationCheckpointState(
				[
					outcome({ tool: "edit", file: "src/app.tsx", detail: "patched UI" }),
					outcome({ tool: "screenshot_url", detail: "captured app", metadata: {} }),
				],
				true,
			),
		).toMatchObject({
			hasVerificationCheckpoint: true,
			lastVerificationDetail: "captured app",
			visualBlockingIssues: [],
		});
	});

	test("summarizes visual blocking issues from metadata", () => {
		const issues = getVisualVerificationBlockingIssues(
			outcome({
				tool: "interact_then_screenshot",
				metadata: {
					error: "timeout",
					consoleErrors: ["TypeError: failed"],
					failedRequests: ["/api/data 500"],
				},
			}),
		);

		expect(issues).toEqual([
			"capture error: timeout",
			"console errors: TypeError: failed",
			"failed requests: /api/data 500",
		]);
		expect(summarizeVisualBlockingIssues(issues)).toBe(
			"capture error: timeout; console errors: TypeError: failed; failed requests: /api/data 500",
		);
	});

	test("uses metadata preview for failed verification when it adds detail", () => {
		expect(
			getVerificationFailurePreview(
				outcome({
					success: false,
					detail: "npm test failed",
					metadata: { outputPreview: "Expected true to equal false" },
				}),
			),
		).toBe("Expected true to equal false");

		expect(
			getVerificationFailurePreview(
				outcome({
					success: false,
					detail: "same detail",
					metadata: { outputPreview: "same detail" },
				}),
			),
		).toBeUndefined();
	});
});
