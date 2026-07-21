import { describe, expect, test } from "vitest";
import { buildInteractiveDebugReport } from "../src/modes/interactive/interactive-debug-report.js";

describe("interactive-debug-report", () => {
	test("builds a runtime-oriented debug report", () => {
		const output = buildInteractiveDebugReport({
			timestamp: "2026-04-13T17:00:00.000Z",
			width: 120,
			height: 40,
			renderedLines: ["hello", "world"],
			messages: [{ role: "user", content: [{ type: "text", text: "test" }], timestamp: 1 }],
			modelId: "provider/model",
			mode: "autonomous",
			stabilization: {
				level: "guarded",
				reasons: ["recent degradation"],
				recommendedMaxOutputPerTurn: 4000,
				forceBehavioralPrompt: true,
				forceNudges: true,
			},
			xmlFallbackCount: 2,
			degradedTurnCount: 1,
			lastXmlFallbackEvent: {
				type: "xml_tool_call",
				toolName: "bash",
				arguments: { command: "npm test" },
				severity: "critical",
				reasons: ["truncated_turn"],
			},
			lastDegradedTurnEvent: {
				type: "degraded_turn",
				severity: "elevated",
				stopReason: "stop",
				outputTokens: 9000,
				textLength: 22000,
				reasons: ["high_output_tokens"],
			},
			formatRuntimeHealthIssue: (event) => `${event.type}:${event.severity}`,
			workspace: {
				workspaceRoot: "/tmp/workspace",
				activeCwd: "/tmp/workspace/app",
				sourceCwd: "/repo/app",
				strategy: "copy",
				description: "copy",
			},
			artifacts: {
				sessionDir: "/tmp/session",
				sessionMd: "/tmp/session.md",
				sessionCompactMd: "/tmp/session-compact.md",
				timelineJson: "/tmp/timeline.json",
			},
		});

		expect(output).toContain("Debug output at 2026-04-13T17:00:00.000Z");
		expect(output).toContain("Terminal: 120x40");
		expect(output).toContain("Mode: autonomous");
		expect(output).toContain("Stabilization: guarded (recent degradation)");
		expect(output).toContain("Latest XML Fallback: xml_tool_call:critical");
		expect(output).toContain("State: preserved");
		expect(output).toContain('{"role":"user"');
	});
});
