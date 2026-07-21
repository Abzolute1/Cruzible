import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProjectConfigDir } from "../src/config.js";
import { discoverAndLoadExtensions, loadExtensions, trustProject } from "../src/core/extensions/loader.js";

const extensionCode = `
	export default function(ag1) {
		ag1.registerCommand("test", { handler: async () => {} });
	}
`;

describe("project extension workspace trust", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let projectExtDir: string;
	let previousTrustEnv: string | undefined;

	beforeEach(() => {
		previousTrustEnv = process.env.AG1_TRUST_PROJECT;
		delete process.env.AG1_TRUST_PROJECT;
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag1-ext-trust-test-"));
		cwd = path.join(tempDir, "project");
		agentDir = path.join(tempDir, "agent");
		projectExtDir = path.join(getProjectConfigDir(cwd), "extensions");
		fs.mkdirSync(projectExtDir, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (previousTrustEnv === undefined) {
			delete process.env.AG1_TRUST_PROJECT;
		} else {
			process.env.AG1_TRUST_PROJECT = previousTrustEnv;
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function writeProjectExtension(name = "evil.ts"): string {
		const extPath = path.join(projectExtDir, name);
		fs.writeFileSync(extPath, extensionCode);
		return extPath;
	}

	it("skips untrusted project-local extensions and exposes a pending trust prompt", async () => {
		const extPath = writeProjectExtension();

		const result = await discoverAndLoadExtensions([], cwd, agentDir);

		expect(result.extensions).toHaveLength(0);
		expect(result.pendingTrustPrompt).toBeDefined();
		expect(result.pendingTrustPrompt?.projectConfigDir).toBe(getProjectConfigDir(cwd));
		expect(result.pendingTrustPrompt?.extensionPaths).toEqual([extPath]);
		expect(result.errors.some((e) => e.error.includes("not trusted"))).toBe(true);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("not trusted"));
	});

	it("loads project-local extensions once the project is trusted in USER settings", async () => {
		writeProjectExtension();
		await trustProject(getProjectConfigDir(cwd), cwd, agentDir);

		const result = await discoverAndLoadExtensions([], cwd, agentDir);

		expect(result.pendingTrustPrompt).toBeUndefined();
		expect(result.extensions).toHaveLength(1);
		expect(result.errors).toHaveLength(0);
		// Trust must have been persisted to the user settings file
		const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8"));
		expect(settings.trustedProjects).toEqual([getProjectConfigDir(cwd)]);
	});

	it("does not let PROJECT settings trust themselves", async () => {
		writeProjectExtension();
		fs.writeFileSync(
			path.join(getProjectConfigDir(cwd), "settings.json"),
			JSON.stringify({ trustedProjects: [getProjectConfigDir(cwd)] }),
		);

		const result = await discoverAndLoadExtensions([], cwd, agentDir);

		expect(result.extensions).toHaveLength(0);
		expect(result.pendingTrustPrompt).toBeDefined();
	});

	it("force-trusts via AG1_TRUST_PROJECT=1", async () => {
		writeProjectExtension();
		process.env.AG1_TRUST_PROJECT = "1";

		const result = await discoverAndLoadExtensions([], cwd, agentDir);

		expect(result.extensions).toHaveLength(1);
		expect(result.pendingTrustPrompt).toBeUndefined();
	});

	it("force-disables via AG1_TRUST_PROJECT=0 even when trusted in settings", async () => {
		writeProjectExtension();
		await trustProject(getProjectConfigDir(cwd), cwd, agentDir);
		process.env.AG1_TRUST_PROJECT = "0";

		const result = await discoverAndLoadExtensions([], cwd, agentDir);

		expect(result.extensions).toHaveLength(0);
		expect(result.pendingTrustPrompt).toBeDefined();
	});

	it("honors the explicit trustProject option over env and settings", async () => {
		const extPath = writeProjectExtension();

		const trusted = await loadExtensions([extPath], cwd, undefined, { trustProject: true, agentDir });
		expect(trusted.extensions).toHaveLength(1);

		process.env.AG1_TRUST_PROJECT = "1";
		const distrusted = await loadExtensions([extPath], cwd, undefined, { trustProject: false, agentDir });
		expect(distrusted.extensions).toHaveLength(0);
		expect(distrusted.pendingTrustPrompt?.extensionPaths).toEqual([extPath]);
	});

	it("still loads global extensions when the project is untrusted", async () => {
		writeProjectExtension();
		const globalExtDir = path.join(agentDir, "extensions");
		fs.mkdirSync(globalExtDir, { recursive: true });
		fs.writeFileSync(path.join(globalExtDir, "global.ts"), extensionCode);

		const result = await discoverAndLoadExtensions([], cwd, agentDir);

		expect(result.extensions).toHaveLength(1);
		expect(path.basename(result.extensions[0].path)).toBe("global.ts");
		expect(result.pendingTrustPrompt).toBeDefined();
	});

	it("does not expose a trust prompt when there are no project-local extensions", async () => {
		fs.rmSync(projectExtDir, { recursive: true, force: true });

		const result = await discoverAndLoadExtensions([], cwd, agentDir);

		expect(result.pendingTrustPrompt).toBeUndefined();
		expect(result.errors).toHaveLength(0);
	});
});
