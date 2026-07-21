import { describe, expect, it } from "vitest";
import { AGENT_SESSION_COORDINATOR_OWNERSHIP } from "../src/core/agent-session-coordinator-map.js";

describe("AgentSession coordinator ownership map", () => {
	it("assigns every coordinator area exactly one primary owner", () => {
		const areas = AGENT_SESSION_COORDINATOR_OWNERSHIP.map((entry) => entry.area);
		expect(new Set(areas).size).toBe(areas.length);

		for (const entry of AGENT_SESSION_COORDINATOR_OWNERSHIP) {
			expect(entry.className).toMatch(/^AgentSession|^AgentSessionRecoveryReplayScheduler$/);
			expect(entry.primaryResponsibility.trim().length).toBeGreaterThan(20);
			expect(entry.ownedState.length).toBeGreaterThan(0);
		}
	});

	it("only references known coordinator areas in mayCall edges", () => {
		const areas = new Set(AGENT_SESSION_COORDINATOR_OWNERSHIP.map((entry) => entry.area));

		for (const entry of AGENT_SESSION_COORDINATOR_OWNERSHIP) {
			for (const target of entry.mayCall) {
				expect(areas.has(target)).toBe(true);
			}
		}
	});
});
