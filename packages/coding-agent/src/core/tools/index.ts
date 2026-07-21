export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	bashTool,
	bashToolDefinition,
	createBashTool,
	createBashToolDefinition,
	createDefaultBashOperations,
	createLocalBashOperations,
} from "./bash.js";
export {
	type BashSandboxBackendConfig,
	type BashSandboxBackendKind,
	createSandboxedBashOperations,
	describeBashSandboxBackend,
	renderBashSandboxCommand,
	resolveBashSandboxBackendFromEnv,
	shellQuote,
} from "./bash-sandbox.js";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
	editTool,
	editToolDefinition,
} from "./edit.js";
export { withFileMutationQueue } from "./file-mutation-queue.js";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
	findTool,
	findToolDefinition,
} from "./find.js";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
	grepTool,
	grepToolDefinition,
} from "./grep.js";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
	lsTool,
	lsToolDefinition,
} from "./ls.js";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
	readTool,
	readToolDefinition,
} from "./read.js";
export {
	createSubmitPlanToolDefinition,
	type SubmitPlanToolDetails,
	type SubmitPlanToolInput,
	type SubmittedPlan,
	type SubmittedPlanQuestion,
	submitPlanToolDefinition,
} from "./submit-plan.js";
export { createTaskToolDefinition, TASK_SESSION_ENTRY_TYPE, type TaskToolDeps, type TaskToolDetails } from "./task.js";
export {
	createTodoToolDefinition,
	type TodoToolDetails,
	type TodoToolInput,
	todoTool,
	todoToolDefinition,
} from "./todo.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";
// Visual verification tools (conditionally loaded at runtime based on model vision capability)
export {
	closeBrowser,
	createInteractThenScreenshotToolDefinition,
	createScreenshotUrlToolDefinition,
	getBrowser,
	interactThenScreenshotTool,
	interactThenScreenshotToolDefinition,
	type PageAction,
	runScreenshot,
	type ScreenshotOptions,
	type ScreenshotResult,
	screenshotUrlTool,
	screenshotUrlToolDefinition,
} from "./visual/index.js";
export {
	createWebFetchTool,
	type WebFetchToolOptions,
	webFetchToolDefinition,
} from "./webfetch.js";
export {
	createWebSearchTool,
	type WebSearchToolOptions,
	webSearchToolDefinition,
} from "./websearch.js";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
	writeTool,
	writeToolDefinition,
} from "./write.js";

import type { AgentTool } from "@ag1/agent-core";
import type { ToolDefinition } from "../extensions/types.js";
import {
	type BashToolOptions,
	bashTool,
	bashToolDefinition,
	createBashTool,
	createBashToolDefinition,
} from "./bash.js";
import { createEditTool, createEditToolDefinition, editTool, editToolDefinition } from "./edit.js";
import { createFindTool, createFindToolDefinition, findTool, findToolDefinition } from "./find.js";
import { createGrepTool, createGrepToolDefinition, grepTool, grepToolDefinition } from "./grep.js";
import { createLsTool, createLsToolDefinition, lsTool, lsToolDefinition } from "./ls.js";
import {
	createReadTool,
	createReadToolDefinition,
	type ReadToolOptions,
	readTool,
	readToolDefinition,
} from "./read.js";
import { createSubmitPlanToolDefinition } from "./submit-plan.js";
import { createTaskToolDefinition, type TaskToolDeps } from "./task.js";
import { createTodoToolDefinition, todoTool, todoToolDefinition } from "./todo.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { createWebFetchTool, webFetchToolDefinition } from "./webfetch.js";
import { createWebSearchTool, webSearchToolDefinition } from "./websearch.js";
import { createWriteTool, createWriteToolDefinition, writeTool, writeToolDefinition } from "./write.js";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;

export const codingTools: Tool[] = [
	readTool,
	bashTool,
	editTool,
	writeTool,
	createWebSearchTool({ cwd: "." }),
	createWebFetchTool({ cwd: "." }),
];
export const readOnlyTools: Tool[] = [
	readTool,
	grepTool,
	findTool,
	lsTool,
	createWebSearchTool({ cwd: "." }),
	createWebFetchTool({ cwd: "." }),
];

export const allTools = {
	read: readTool,
	bash: bashTool,
	edit: editTool,
	write: writeTool,
	grep: grepTool,
	find: findTool,
	ls: lsTool,
	webSearch: createWebSearchTool({ cwd: "." }),
	webFetch: createWebFetchTool({ cwd: "." }),
	submitPlan: createSubmitPlanToolDefinition(),
	todo: createTodoToolDefinition(),
};

export const allToolDefinitions = {
	read: readToolDefinition,
	bash: bashToolDefinition,
	edit: editToolDefinition,
	write: writeToolDefinition,
	grep: grepToolDefinition,
	find: findToolDefinition,
	ls: lsToolDefinition,
	webSearch: webSearchToolDefinition,
	webFetch: webFetchToolDefinition,
	submitPlan: createSubmitPlanToolDefinition(),
	todo: todoToolDefinition,
};

export type ToolName = keyof typeof allTools;

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	/** Subagent delegation deps. When provided (and not env-disabled), a `task` tool definition is included. */
	task?: TaskToolDeps;
}

/** Kill switch for the task tool (default: on). */
export function isTaskToolDisabled(): boolean {
	const value = process.env.AG1_DISABLE_TASK_TOOL;
	return value === "1" || value?.toLowerCase() === "true";
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd),
		createWriteToolDefinition(cwd),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd),
		createFindToolDefinition(cwd),
		createLsToolDefinition(cwd),
		webSearchToolDefinition,
		webFetchToolDefinition,
	];
}

export function createAllToolDefinitions(
	cwd: string,
	options?: ToolsOptions,
): Record<ToolName, ToolDef> & { task?: ToolDef } {
	const definitions: Record<ToolName, ToolDef> & { task?: ToolDef } = {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		edit: createEditToolDefinition(cwd),
		write: createWriteToolDefinition(cwd),
		grep: createGrepToolDefinition(cwd),
		find: createFindToolDefinition(cwd),
		ls: createLsToolDefinition(cwd),
		webSearch: webSearchToolDefinition,
		webFetch: webFetchToolDefinition,
		submitPlan: createSubmitPlanToolDefinition(),
		todo: createTodoToolDefinition(),
	};
	if (options?.task && !isTaskToolDisabled()) {
		definitions.task = createTaskToolDefinition(options.task);
	}
	return definitions;
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd),
		createWriteTool(cwd),
		createWebSearchTool({ cwd }),
		createWebFetchTool({ cwd }),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createGrepTool(cwd),
		createFindTool(cwd),
		createLsTool(cwd),
		createWebSearchTool({ cwd }),
		createWebFetchTool({ cwd }),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
		webSearch: createWebSearchTool({ cwd }),
		webFetch: createWebFetchTool({ cwd }),
		submitPlan: wrapToolDefinition(createSubmitPlanToolDefinition()),
		todo: todoTool,
	};
}
