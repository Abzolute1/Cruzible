import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertContainedInstallPath, DefaultPackageManager } from "../src/core/package-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { parseGitUrl } from "../src/utils/git.js";

describe("package source path traversal", () => {
	describe("parseGitUrl rejects traversing repo paths", () => {
		it("rejects scp-like URLs with .. segments", () => {
			expect(parseGitUrl("git:git@evil.com:../../x")).toBeNull();
			expect(parseGitUrl("git:git@evil.com:user/../../../root")).toBeNull();
		});

		it("rejects shorthand URLs with .. segments", () => {
			expect(parseGitUrl("git:evil.com/../../x")).toBeNull();
			expect(parseGitUrl("git:evil.com/user/../..")).toBeNull();
		});

		it("rejects empty path segments, drive letters and backslashes", () => {
			expect(parseGitUrl("git:evil.com/user//repo")).toBeNull();
			expect(parseGitUrl("git:evil.com/C:/x/y")).toBeNull();
			expect(parseGitUrl("git:git@evil.com:user\\..\\..\\x")).toBeNull();
		});

		it("still accepts legitimate repo paths", () => {
			expect(parseGitUrl("git:git@github.com:user/repo")).toMatchObject({ host: "github.com", path: "user/repo" });
			expect(parseGitUrl("git:evil.com/user/repo")).toMatchObject({ host: "evil.com", path: "user/repo" });
			expect(parseGitUrl("git:evil.com/user/repo/")).toMatchObject({ path: "user/repo" });
			expect(parseGitUrl("git:git@evil.com:user/repo.git")).toMatchObject({ path: "user/repo" });
		});
	});

	describe("assertContainedInstallPath", () => {
		it("accepts paths inside the install root", () => {
			const root = join(tmpdir(), "ag1-contain-root");
			expect(assertContainedInstallPath(root, join(root, "host", "user", "repo"))).toBe(
				join(root, "host", "user", "repo"),
			);
			expect(assertContainedInstallPath(root, root)).toBe(root);
		});

		it("rejects paths escaping the install root", () => {
			const root = join(tmpdir(), "ag1-contain-root");
			expect(() => assertContainedInstallPath(root, join(root, "..", "victim"))).toThrow(/outside its install root/);
			expect(() => assertContainedInstallPath(root, resolve(root, "..", "x"))).toThrow(/outside its install root/);
			expect(() => assertContainedInstallPath(root, `${root}-sibling${sep}x`)).toThrow(/outside its install root/);
		});
	});

	describe("DefaultPackageManager npm source validation", () => {
		let tempDir: string;
		let packageManager: DefaultPackageManager;

		beforeEach(() => {
			tempDir = join(tmpdir(), `pm-traversal-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			mkdirSync(join(tempDir, "agent"), { recursive: true });
			packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir: join(tempDir, "agent"),
				settingsManager: SettingsManager.inMemory(),
			});
		});

		afterEach(() => {
			rmSync(tempDir, { recursive: true, force: true });
		});

		it("rejects npm sources with path traversal at parse time", async () => {
			await expect(packageManager.install("npm:../../x")).rejects.toThrow(/unsafe npm package name/);
			await expect(packageManager.remove("npm:../../x")).rejects.toThrow(/unsafe npm package name/);
			expect(() => packageManager.getInstalledPath("npm:../x", "project")).toThrow(/unsafe npm package name/);
			expect(() => packageManager.getInstalledPath("npm:@scope/../../x", "project")).toThrow(
				/unsafe npm package name/,
			);
			expect(() => packageManager.getInstalledPath("npm:/abs", "project")).toThrow(/unsafe npm package name/);
		});

		it("still accepts legitimate npm package names", () => {
			expect(() => packageManager.getInstalledPath("npm:lodash", "project")).not.toThrow();
			expect(() => packageManager.getInstalledPath("npm:@scope/pkg@1.2.3", "project")).not.toThrow();
		});
	});
});
