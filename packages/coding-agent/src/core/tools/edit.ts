import type { AgentTool } from "@ag1/agent-core";
import { Container, Text } from "@ag1/tui";
import { type Static, Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { renderDiff } from "../../modes/interactive/components/diff.js";
import type { ToolDefinition } from "../extensions/types.js";
import { normalizePatchIntent } from "../patch-intent.js";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	type Edit,
	generateDiffString,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { writeFileAtomically } from "./file-mutation-transaction.js";
import { resolveContainedPath } from "./path-utils.js";
import { invalidArgText, shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

type EditRenderState = Record<string, never>;

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description: "Exact text for one targeted replacement.",
		}),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{ additionalProperties: false },
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(replaceEditSchema, {
			description: "One or more targeted replacements, matched against the original file (not incrementally).",
		}),
		allowFuzzyMatch: Type.Optional(
			Type.Boolean({
				description: "Allow matching after quote/space normalization when exact matching fails (default false).",
			}),
		),
	},
	{ additionalProperties: false },
);

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & {
	oldText?: unknown;
	newText?: unknown;
	edits?: unknown;
};

export interface EditToolDetails {
	/** Unified diff of the changes made */
	diff: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
	/** True when opt-in fuzzy matching was needed because exact text did not match. */
	fuzzyMatchUsed?: boolean;
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string, signal?: AbortSignal) => Promise<void>;
	/** Check if file is readable and writable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content, signal) => writeFileAtomically(path, content, signal),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	/** Custom operations for file editing. Default: local filesystem */
	operations?: EditOperations;
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	const args = input as LegacyEditToolInput;
	const normalizedPatch = normalizePatchIntent(args);
	if (
		normalizedPatch &&
		!Array.isArray(args.edits) &&
		typeof args.oldText !== "string" &&
		typeof args.newText !== "string"
	) {
		return {
			path: normalizedPatch.path,
			edits: normalizedPatch.replacements,
		};
	}

	const parsedEdits = parseEditsArgument(args.edits);
	if (typeof args.oldText !== "string" || typeof args.newText !== "string") {
		return parsedEdits === args.edits ? (input as EditToolInput) : ({ ...args, edits: parsedEdits } as EditToolInput);
	}

	const edits = Array.isArray(parsedEdits) ? [...parsedEdits] : [];
	edits.push({ oldText: args.oldText, newText: args.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = args;
	return { ...rest, edits } as EditToolInput;
}

function isReplacementEdit(value: unknown): value is Edit {
	return Boolean(
		value &&
			typeof value === "object" &&
			typeof (value as { oldText?: unknown }).oldText === "string" &&
			typeof (value as { newText?: unknown }).newText === "string",
	);
}

function parseEditsArgument(value: unknown): unknown {
	if (Array.isArray(value)) return value;
	if (typeof value !== "string") return value;

	const trimmed = value.trim();
	if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return value;
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (Array.isArray(parsed) && parsed.every(isReplacementEdit)) return parsed;
		if (isReplacementEdit(parsed)) return [parsed];
	} catch {
		// Keep the original value so normal validation reports the bad shape.
	}
	return value;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[]; allowFuzzyMatch: boolean } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits, allowFuzzyMatch: input.allowFuzzyMatch === true };
}

type RenderableEditArgs = {
	path?: string;
	file_path?: string;
	edits?: Edit[];
	oldText?: string;
	newText?: string;
};

function formatEditCall(
	args: RenderableEditArgs | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const invalidArg = invalidArgText(theme);
	const rawPath = str(args?.file_path ?? args?.path);
	const path = rawPath !== null ? shortenPath(rawPath) : null;
	const pathDisplay = path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
	return `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;
}

function formatEditResult(
	args: RenderableEditArgs | undefined,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: EditToolDetails;
	},
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	isError: boolean,
): string | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	if (isError) {
		const errorText = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n");
		if (!errorText) {
			return undefined;
		}
		return `\n${theme.fg("error", errorText)}`;
	}

	const resultDiff = result.details?.diff;
	if (!resultDiff) {
		return undefined;
	}
	return `\n${renderDiff(resultDiff, { filePath: rawPath ?? undefined })}`;
}

function formatEditSuccess(path: string, editCount: number, fuzzyMatchUsed: boolean): string {
	const fuzzyNote = fuzzyMatchUsed ? " Fuzzy match used; review the diff carefully." : "";
	return `Patched ${editCount} block(s) in ${path}.${fuzzyNote}`;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Each edits[].oldText must match a unique, non-overlapping region of the original file; merge nearby changes into one edit and keep oldText minimal.",
		promptSnippet:
			"Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
		promptGuidelines: [
			"Use edit for precise changes (edits[].oldText must match exactly)",
			"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
		],
		parameters: editSchema,
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			const { path, edits, allowFuzzyMatch } = validateEditInput(input);
			const absolutePath = resolveContainedPath(path, cwd);

			return withFileMutationQueue(absolutePath, async () => {
				throwIfAborted(signal);
				try {
					await ops.access(absolutePath);
				} catch {
					throw new Error(`File not found: ${path}`);
				}

				throwIfAborted(signal);
				const buffer = await ops.readFile(absolutePath);
				const rawContent = buffer.toString("utf-8");

				throwIfAborted(signal);
				// Strip BOM before matching. The model will not include an invisible BOM in oldText.
				const { bom, text: content } = stripBom(rawContent);
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);
				const { baseContent, newContent, fuzzyMatchUsed } = applyEditsToNormalizedContent(
					normalizedContent,
					edits,
					path,
					{ allowFuzzyMatch },
				);

				throwIfAborted(signal);
				const finalContent = bom + restoreLineEndings(newContent, originalEnding);
				await ops.writeFile(absolutePath, finalContent, signal);
				throwIfAborted(signal);

				const diffResult = generateDiffString(baseContent, newContent);
				return {
					content: [
						{
							type: "text" as const,
							text: formatEditSuccess(path, edits.length, fuzzyMatchUsed),
						},
					],
					details: {
						diff: diffResult.diff,
						firstChangedLine: diffResult.firstChangedLine,
						...(fuzzyMatchUsed ? { fuzzyMatchUsed: true } : {}),
					},
				};
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatEditCall(args, theme));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const output = formatEditResult(context.args, result as any, theme, context.isError);
			if (!output) {
				const component = (context.lastComponent as Container | undefined) ?? new Container();
				component.clear();
				return component;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(output);
			return text;
		},
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}

/** Default edit tool using process.cwd() for backwards compatibility. */
export const editToolDefinition = createEditToolDefinition(process.cwd());
export const editTool = createEditTool(process.cwd());
