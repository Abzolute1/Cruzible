import type { AgentTool } from "@ag1/agent-core";
import type { Executor } from "../sandbox.js";
import { type AttachState, createAttachTool } from "./attach.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export { type AttachState, createAttachState, type UploadFn } from "./attach.js";

export function createMomTools(executor: Executor, attachState: AttachState): AgentTool<any>[] {
	return [
		createReadTool(executor),
		createBashTool(executor),
		createEditTool(executor),
		createWriteTool(executor),
		createAttachTool(attachState),
	];
}
