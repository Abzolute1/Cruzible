import type { AgentTool } from "@ag1/agent-core";
import { Type } from "@sinclair/typebox";
import { basename, resolve as resolvePath } from "path";

export type UploadFn = (filePath: string, title?: string) => Promise<void>;

// Per-runner state for the attach tool. Each channel runner gets its own state so
// concurrent runs never upload through another channel's context (S32).
export interface AttachState {
	uploadFn: UploadFn | null;
}

export function createAttachState(): AttachState {
	return { uploadFn: null };
}

const attachSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're sharing (shown to user)" }),
	path: Type.String({ description: "Path to the file to attach" }),
	title: Type.Optional(Type.String({ description: "Title for the file (defaults to filename)" })),
});

export function createAttachTool(state: AttachState): AgentTool<typeof attachSchema> {
	return {
		name: "attach",
		label: "attach",
		description:
			"Attach a file to your response. Use this to share files, images, or documents with the user. Only files from /workspace/ can be attached.",
		parameters: attachSchema,
		execute: async (
			_toolCallId: string,
			{ path, title }: { label: string; path: string; title?: string },
			signal?: AbortSignal,
		) => {
			if (!state.uploadFn) {
				throw new Error("Upload function not configured");
			}

			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			// Reject traversal attempts up front; translateToHostPath enforces containment authoritatively
			if (path.split("/").includes("..")) {
				throw new Error(`Path must not contain '..' segments: ${path}`);
			}

			const absolutePath = resolvePath(path);
			const fileName = title || basename(absolutePath);

			await state.uploadFn(absolutePath, fileName);

			return {
				content: [{ type: "text" as const, text: `Attached file: ${fileName}` }],
				details: undefined,
			};
		},
	};
}
