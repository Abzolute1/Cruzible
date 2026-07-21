import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

function createFakeChild(): ChildProcess {
	const child = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
		killed: boolean;
		kill: ChildProcess["kill"];
	};
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.killed = false;
	child.kill = vi.fn(() => {
		child.killed = true;
		return true;
	});
	return child as unknown as ChildProcess;
}

describe("agentToolDefinition", () => {
	beforeEach(() => {
		vi.resetModules();
		spawnMock.mockReset();
	});

	test("uses the current ag1 launcher path for child agents", async () => {
		const originalArgv1 = process.argv[1];
		process.argv[1] = "/usr/local/bin/ag1";

		try {
			const child = createFakeChild();
			spawnMock.mockReturnValue(child);

			const { agentToolDefinition } = await import("../src/core/auton/tools/agent.js");
			const executionPromise = agentToolDefinition.execute(
				"call-1",
				{ task: "inspect the repo" },
				undefined,
				vi.fn().mockResolvedValue(undefined),
				{ cwd: "/tmp" } as ExtensionContext,
			);

			await vi.waitFor(() => {
				expect(spawnMock).toHaveBeenCalledWith(
					"/usr/local/bin/ag1",
					expect.arrayContaining(["--print", "--non-interactive", "inspect the repo"]),
					expect.objectContaining({ cwd: "/tmp" } as ExtensionContext),
				);
			});

			child.emit("close", 0);
			await executionPromise;
		} finally {
			process.argv[1] = originalArgv1;
		}
	});

	test("keeps child-agent concurrency accounting stable after spawn errors", async () => {
		const { agentToolDefinition } = await import("../src/core/auton/tools/agent.js");
		const onUpdate = vi.fn().mockResolvedValue(undefined);

		const failedChild = createFakeChild();
		const childA = createFakeChild();
		const childB = createFakeChild();
		const childC = createFakeChild();
		spawnMock
			.mockReturnValueOnce(failedChild)
			.mockReturnValueOnce(childA)
			.mockReturnValueOnce(childB)
			.mockReturnValueOnce(childC);

		const failedExecution = agentToolDefinition.execute("call-failed", { task: "first task" }, undefined, onUpdate, {
			cwd: "/tmp",
		} as ExtensionContext);
		await vi.waitFor(() => {
			expect(spawnMock).toHaveBeenCalledTimes(1);
		});
		failedChild.emit("error", new Error("spawn failed"));
		failedChild.emit("close", 1);

		const failedResult = await failedExecution;
		const failedText = failedResult.content[0] as { type: "text"; text: string } | undefined;
		expect(failedText?.type).toBe("text");
		expect(failedText?.text).toContain("Child Agent Error: Failed to spawn process. spawn failed");

		const executionA = agentToolDefinition.execute("call-a", { task: "task a" }, undefined, onUpdate, {
			cwd: "/tmp",
		} as ExtensionContext);
		const executionB = agentToolDefinition.execute("call-b", { task: "task b" }, undefined, onUpdate, {
			cwd: "/tmp",
		} as ExtensionContext);
		const executionC = agentToolDefinition.execute("call-c", { task: "task c" }, undefined, onUpdate, {
			cwd: "/tmp",
		} as ExtensionContext);
		const blockedExecution = agentToolDefinition.execute("call-d", { task: "task d" }, undefined, onUpdate, {
			cwd: "/tmp",
		} as ExtensionContext);

		await vi.waitFor(() => {
			expect(spawnMock).toHaveBeenCalledTimes(4);
		});

		const blockedResult = await blockedExecution;
		const blockedText = blockedResult.content[0] as { type: "text"; text: string } | undefined;
		expect(blockedText?.type).toBe("text");
		expect(blockedText?.text).toContain("Maximum concurrent child agents (3)");

		childA.emit("close", 0);
		childB.emit("close", 0);
		childC.emit("close", 0);
		await Promise.all([executionA, executionB, executionC]);
	});

	test("does not spawn a child process when aborted before launch", async () => {
		const { agentToolDefinition } = await import("../src/core/auton/tools/agent.js");
		const controller = new AbortController();
		controller.abort();

		const result = await agentToolDefinition.execute(
			"call-abort",
			{ task: "cancelled task" },
			controller.signal,
			vi.fn().mockResolvedValue(undefined),
			{ cwd: "/tmp" } as ExtensionContext,
		);

		expect(spawnMock).not.toHaveBeenCalled();
		const resultText = result.content[0] as { type: "text"; text: string } | undefined;
		expect(resultText?.type).toBe("text");
		expect(resultText?.text).toContain("Child Agent Cancelled before launch.");
	});
});
