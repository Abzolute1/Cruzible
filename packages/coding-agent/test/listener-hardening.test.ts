import { describe, expect, test, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";

describe("listener hardening", () => {
	test("AgentSession event listeners fail open", () => {
		const first = vi.fn(() => {
			throw new Error("listener blew up");
		});
		const second = vi.fn();
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		(AgentSession.prototype as any)._emit.call(
			{
				_eventDispatcher: {
					emit: (event: any) => {
						for (const listener of [first, second]) {
							try {
								listener(event);
							} catch (err) {
								const error = err instanceof Error ? err : new Error(String(err));
								console.error("[AgentSession] Event listener error:", error);
							}
						}
					},
				},
			},
			{ type: "queue_update", steering: [], followUp: [] },
		);

		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(1);
		expect(consoleError).toHaveBeenCalledWith(
			"[AgentSession] Event listener error:",
			expect.objectContaining({ message: "listener blew up" }),
		);
		consoleError.mockRestore();
	});

	test("ExtensionRunner error listeners fail open", () => {
		const first = vi.fn(() => {
			throw new Error("error listener blew up");
		});
		const second = vi.fn();
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const runner = new ExtensionRunner([] as any, {} as any, "/tmp", {} as any, {} as any);

		runner.onError(first);
		runner.onError(second);
		runner.emitError({
			extensionPath: "/tmp/ext.ts",
			event: "input",
			error: "boom",
		});

		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(1);
		expect(consoleError).toHaveBeenCalledWith(
			"[ExtensionRunner] Error listener failed:",
			expect.objectContaining({ message: "error listener blew up" }),
		);
		consoleError.mockRestore();
	});
});
