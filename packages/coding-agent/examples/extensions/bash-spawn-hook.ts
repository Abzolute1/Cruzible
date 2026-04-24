/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   ag1 -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "@ag1/coding-agent";
import { createBashTool } from "@ag1/coding-agent";

export default function (ag1: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashTool(cwd, {
		spawnHook: ({ command, cwd, env }) => ({
			command: `source ~/.profile\n${command}`,
			cwd,
			env: { ...env, AG1_SPAWN_HOOK: "1" },
		}),
	});

	ag1.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
