import { describe, expect, it, vi } from "vitest";
import type { BashOperations } from "../src/core/tools/bash.js";
import {
	createSandboxedBashOperations,
	renderBashSandboxCommand,
	resolveBashSandboxBackendFromEnv,
	shellQuote,
} from "../src/core/tools/bash-sandbox.js";

describe("bash sandbox backend", () => {
	it("uses the local backend when no sandbox command is configured", () => {
		expect(resolveBashSandboxBackendFromEnv({})).toEqual({ kind: "local" });
		expect(resolveBashSandboxBackendFromEnv({ AG1_BASH_SANDBOX_COMMAND: "   " })).toEqual({ kind: "local" });
	});

	it("uses a command template when AG1_BASH_SANDBOX_COMMAND is configured", () => {
		expect(
			resolveBashSandboxBackendFromEnv({
				AG1_BASH_SANDBOX_COMMAND: "bwrap --chdir {cwd} bash -lc {command}",
			}),
		).toEqual({
			kind: "command-template",
			template: "bwrap --chdir {cwd} bash -lc {command}",
		});
	});

	it("shell-quotes commands and cwd placeholders", () => {
		expect(shellQuote("printf 'hello'")).toBe("'printf '\\''hello'\\'''");
		expect(
			renderBashSandboxCommand("sandbox --cwd {cwd} -- bash -lc {command}", "printf 'hello'", "/tmp/with space"),
		).toBe("sandbox --cwd '/tmp/with space' -- bash -lc 'printf '\\''hello'\\'''");
	});

	it("appends the quoted command when the template has no command placeholder", () => {
		expect(renderBashSandboxCommand("sandbox --cwd {cwd}", "npm test", "/repo")).toBe(
			"sandbox --cwd '/repo' 'npm test'",
		);
	});

	it("wraps bash operations without changing cwd or execution options", async () => {
		const exec = vi.fn(async () => ({ exitCode: 0 }));
		const operations: BashOperations = { exec };
		const wrapped = createSandboxedBashOperations(operations, {
			kind: "command-template",
			template: "sandbox --cwd {cwd} -- bash -lc {command}",
		});
		const options = { onData: vi.fn(), timeout: 3 };

		await wrapped.exec("echo ok", "/repo", options);

		expect(exec).toHaveBeenCalledWith("sandbox --cwd '/repo' -- bash -lc 'echo ok'", "/repo", options);
	});
});
