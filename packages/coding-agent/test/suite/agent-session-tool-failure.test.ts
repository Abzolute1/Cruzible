import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

describe("AgentSession tool failure guidance", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("emits one corrective warning after repeated not-found tool failures", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses(["done"]);

		harness.session.recordToolFailure("reed");
		harness.session.recordToolFailure("reed");
		harness.session.recordToolFailure("reed");

		await harness.session.prompt("hi");

		const warnings = harness.eventsOfType("tool_failure_warning");
		expect(warnings).toEqual([
			expect.objectContaining({
				toolName: "reed",
				failureCount: 3,
			}),
		]);
		expect(warnings[0]?.correctiveMessage).toContain("Available tools:");
	});

	it("does not repeat the same corrective warning on the next prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses(["first", "second"]);

		harness.session.recordToolFailure("reed");
		harness.session.recordToolFailure("reed");
		harness.session.recordToolFailure("reed");

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		expect(harness.eventsOfType("tool_failure_warning")).toHaveLength(1);
	});
});
