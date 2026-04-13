import { describe, expect, test } from "vitest";
import { AgentSessionToolFailureCoordinator } from "../src/core/agent-session-tool-failure-coordinator.js";

describe("AgentSessionToolFailureCoordinator", () => {
	test("emits guidance only after the threshold is reached", () => {
		const coordinator = new AgentSessionToolFailureCoordinator();

		coordinator.recordFailure("readx");
		coordinator.recordFailure("readx");
		expect(coordinator.preparePromptInjection(["read", "bash"]).message).toBeUndefined();

		coordinator.recordFailure("readx");
		const result = coordinator.preparePromptInjection(["read", "bash"]);
		expect(result.message?.customType).toBe("tool_failure_warning");
		expect(result.message?.content).toContain("`readx` failed 3 times");
		expect(result.message?.content).toContain("Consider using: read");
		expect(result.warnings).toEqual([
			expect.objectContaining({
				toolName: "readx",
				failureCount: 3,
			}),
		]);
	});

	test("does not repeat the same warning until the tool succeeds or resets", () => {
		const coordinator = new AgentSessionToolFailureCoordinator();

		coordinator.recordFailure("wrte");
		coordinator.recordFailure("wrte");
		coordinator.recordFailure("wrte");
		expect(coordinator.preparePromptInjection(["write"]).warnings).toHaveLength(1);
		expect(coordinator.preparePromptInjection(["write"]).message).toBeUndefined();

		coordinator.recordSuccess("wrte");
		coordinator.recordFailure("wrte");
		coordinator.recordFailure("wrte");
		coordinator.recordFailure("wrte");
		expect(coordinator.preparePromptInjection(["write"]).warnings).toHaveLength(1);

		coordinator.reset();
		coordinator.recordFailure("wrte");
		coordinator.recordFailure("wrte");
		coordinator.recordFailure("wrte");
		expect(coordinator.preparePromptInjection(["write"]).warnings).toHaveLength(1);
	});
});
