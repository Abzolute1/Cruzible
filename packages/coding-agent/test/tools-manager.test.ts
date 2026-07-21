import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

describe("managed tool availability", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	test("does not auto-download fd or rg unless explicitly enabled", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "ag1-tools-manager-"));
		try {
			vi.stubEnv("AG1_CODING_AGENT_DIR", tempRoot);
			vi.stubEnv("PATH", tempRoot);
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					throw new Error("network should not be used when auto-download is disabled");
				}),
			);
			vi.resetModules();

			const { ensureTool } = await import("../src/utils/tools-manager.js");
			await expect(ensureTool("rg", true)).resolves.toBeUndefined();
			expect(globalThis.fetch).not.toHaveBeenCalled();
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});
