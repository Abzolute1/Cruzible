import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, test, vi } from "vitest";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

function createFakeChild(): ChildProcess {
	const child = new EventEmitter() as ChildProcess & {
		stdout: EventEmitter;
		stderr: EventEmitter;
		killed: boolean;
	};
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.killed = false;
	child.kill = vi.fn(() => {
		child.killed = true;
		return true;
	});
	return child;
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
				{ cwd: "/tmp" },
			);

			await vi.waitFor(() => {
				expect(spawnMock).toHaveBeenCalledWith(
					"/usr/local/bin/ag1",
					expect.arrayContaining(["--print", "--non-interactive", "inspect the repo"]),
					expect.objectContaining({ cwd: "/tmp" }),
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

		const failedExecution = agentToolDefinition.execute("call-failed", { task: "first task" }, undefined, onUpdate, { cwd: "/tmp" });
		await vi.waitFor(() => {
			expect(spawnMock).toHaveBeenCalledTimes(1);
		});
		failedChild.emit("error", new Error("spawn failed"));
		failedChild.emit("close", 1);

		const failedResult = await failedExecution;
		expect(failedResult.content[0]?.type).toBe("text");
		expect(failedResult.content[0]?.text).toContain("Child Agent Error: Failed to spawn process. spawn failed");

		const executionA = agentToolDefinition.execute("call-a", { task: "task a" }, undefined, onUpdate, { cwd: "/tmp" });
		const executionB = agentToolDefinition.execute("call-b", { task: "task b" }, undefined, onUpdate, { cwd: "/tmp" });
		const executionC = agentToolDefinition.execute("call-c", { task: "task c" }, undefined, onUpdate, { cwd: "/tmp" });
		const blockedExecution = agentToolDefinition.execute("call-d", { task: "task d" }, undefined, onUpdate, { cwd: "/tmp" });

		await vi.waitFor(() => {
			expect(spawnMock).toHaveBeenCalledTimes(4);
		});

		const blockedResult = await blockedExecution;
		expect(blockedResult.content[0]?.type).toBe("text");
		expect(blockedResult.content[0]?.text).toContain("Maximum concurrent child agents (3)");

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
			{ cwd: "/tmp" },
		);

		expect(spawnMock).not.toHaveBeenCalled();
		expect(result.content[0]?.type).toBe("text");
		expect(result.content[0]?.text).toContain("Child Agent Cancelled before launch.");
	});
});
