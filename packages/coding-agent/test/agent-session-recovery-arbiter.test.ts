import { describe, expect, it } from "vitest";
import { AgentSessionRecoveryArbiter } from "../src/core/agent-session-recovery-arbiter.js";

describe("AgentSessionRecoveryArbiter", () => {
	it("allows the same owner to re-arm recovery", () => {
		const arbiter = new AgentSessionRecoveryArbiter();

		expect(arbiter.tryArm("retry")).toBe(true);
		expect(arbiter.tryArm("retry")).toBe(true);
		expect(arbiter.owner).toBe("retry");
	});

	it("blocks a different owner until the current one clears", () => {
		const arbiter = new AgentSessionRecoveryArbiter();

		expect(arbiter.tryArm("retry")).toBe(true);
		expect(arbiter.tryArm("compaction")).toBe(false);
		expect(arbiter.owner).toBe("retry");

		arbiter.clear("retry");

		expect(arbiter.tryArm("compaction")).toBe(true);
		expect(arbiter.owner).toBe("compaction");
	});
});
