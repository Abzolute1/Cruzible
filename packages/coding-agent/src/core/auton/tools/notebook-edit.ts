// Auton — NotebookEdit Tool
// Edits Jupyter .ipynb notebook files.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../../extensions/types.js";

interface NotebookCell {
	id?: string;
	cell_type: string;
	execution_count?: number | null;
	source: string[];
	metadata?: Record<string, unknown>;
	outputs?: unknown[];
}

interface Notebook {
	cells: NotebookCell[];
	metadata: Record<string, unknown>;
	nbformat: number;
	nbformat_minor: number;
}

function loadNotebook(path: string): Notebook {
	const content = readFileSync(path, "utf-8");
	return JSON.parse(content);
}

function saveNotebook(path: string, notebook: Notebook): void {
	writeFileSync(path, JSON.stringify(notebook, null, 1), "utf-8");
}

function normalizeSource(source: string | string[]): string[] {
	if (typeof source === "string") {
		// If the string has embedded newlines, split them
		if (source.includes("\n")) {
			const lines = source.split("\n");
			// Add newline to all lines except the last
			return lines.map((line, i) => (i < lines.length - 1 ? `${line}\n` : line));
		}
		return [source];
	}
	return source;
}

function _sourceToString(source: string[]): string {
	return source.join("");
}

const notebookEditParamsSchema = Type.Object({
	path: Type.String({ description: "Path to the .ipynb notebook file" }),
	action: Type.Enum(
		{
			insert: "insert",
			replace: "replace",
			delete: "delete",
		},
		{ description: "Action to perform" },
	),
	cellIndex: Type.Optional(Type.Number({ description: "Cell index (0-based). Required for replace and delete." })),
	cellType: Type.Optional(
		Type.Enum(
			{
				code: "code",
				markdown: "markdown",
			},
			{ description: "Type of cell to create (for insert action)" },
		),
	),
	source: Type.Optional(Type.String({ description: "Cell source content (required for insert and replace)" })),
});
type NotebookEditParams = Static<typeof notebookEditParamsSchema>;

export const notebookEditToolDefinition: ToolDefinition<typeof notebookEditParamsSchema, undefined, undefined> = {
	name: "NotebookEdit",
	label: "NotebookEdit",
	description: "Edit Jupyter .ipynb notebook files. Supports insert, replace, and delete actions on cells.",
	parameters: notebookEditParamsSchema,
	execute: async (
		_toolCallId: string,
		params: NotebookEditParams,
		_signal: AbortSignal | undefined,
		_onUpdate: (update: unknown) => Promise<void>,
		ctx: { cwd?: string } | undefined,
	) => {
		const filePath = params.path;
		const action = params.action;
		const cellIndex = params.cellIndex;
		const cellType = params.cellType || "code";
		const source = params.source;

		const cwd = ctx?.cwd || process.cwd();
		const absolutePath = filePath.startsWith("/") ? filePath : join(cwd, filePath);

		// Validate path
		if (!absolutePath.endsWith(".ipynb")) {
			return {
				content: [{ type: "text", text: "Error: Path must be a .ipynb notebook file." }],
				details: undefined,
			};
		}

		if (!existsSync(absolutePath)) {
			return {
				content: [{ type: "text", text: `Error: Notebook not found: ${absolutePath}` }],
				details: undefined,
			};
		}

		let notebook: Notebook;
		try {
			notebook = loadNotebook(absolutePath);
		} catch (err: any) {
			return {
				content: [{ type: "text", text: `Error: Failed to parse notebook: ${err.message || String(err)}` }],
				details: undefined,
			};
		}

		try {
			switch (action) {
				case "insert": {
					if (!source && source !== "") {
						return {
							content: [{ type: "text", text: "Error: 'source' is required for insert action." }],
							details: undefined,
						};
					}

					const newCell: NotebookCell = {
						cell_type: cellType,
						source: normalizeSource(source!),
						metadata: {},
					};

					if (cellType === "code") {
						newCell.execution_count = null;
						newCell.outputs = [];
					}

					const insertAt =
						cellIndex !== undefined ? Math.min(cellIndex, notebook.cells.length) : notebook.cells.length;
					notebook.cells.splice(insertAt, 0, newCell);

					saveNotebook(absolutePath, notebook);

					return {
						content: [
							{
								type: "text",
								text: `Inserted ${cellType} cell at index ${insertAt} in ${absolutePath}.\nTotal cells: ${notebook.cells.length}`,
							},
						],
						details: undefined,
					};
				}

				case "replace": {
					if (cellIndex === undefined) {
						return {
							content: [{ type: "text", text: "Error: 'cellIndex' is required for replace action." }],
							details: undefined,
						};
					}
					if (!source && source !== "") {
						return {
							content: [{ type: "text", text: "Error: 'source' is required for replace action." }],
							details: undefined,
						};
					}

					if (cellIndex < 0 || cellIndex >= notebook.cells.length) {
						return {
							content: [
								{
									type: "text",
									text: `Error: Cell index ${cellIndex} out of range (0-${notebook.cells.length - 1}).`,
								},
							],
							details: undefined,
						};
					}

					const oldCell = notebook.cells[cellIndex];
					const newCellType = cellType || oldCell.cell_type;

					notebook.cells[cellIndex] = {
						cell_type: newCellType,
						source: normalizeSource(source!),
						metadata: oldCell.metadata || {},
						execution_count: newCellType === "code" ? (oldCell.execution_count ?? null) : undefined,
						outputs: newCellType === "code" ? (oldCell.outputs ?? []) : undefined,
					};

					saveNotebook(absolutePath, notebook);

					return {
						content: [
							{
								type: "text",
								text: `Replaced cell at index ${cellIndex} in ${absolutePath}.\nPrevious type: ${oldCell.cell_type} -> New type: ${newCellType}`,
							},
						],
						details: undefined,
					};
				}

				case "delete": {
					if (cellIndex === undefined) {
						return {
							content: [{ type: "text", text: "Error: 'cellIndex' is required for delete action." }],
							details: undefined,
						};
					}

					if (cellIndex < 0 || cellIndex >= notebook.cells.length) {
						return {
							content: [
								{
									type: "text",
									text: `Error: Cell index ${cellIndex} out of range (0-${notebook.cells.length - 1}).`,
								},
							],
							details: undefined,
						};
					}

					const deletedCell = notebook.cells[cellIndex];
					notebook.cells.splice(cellIndex, 1);

					saveNotebook(absolutePath, notebook);

					return {
						content: [
							{
								type: "text",
								text: `Deleted ${deletedCell.cell_type} cell at index ${cellIndex} from ${absolutePath}.\nRemaining cells: ${notebook.cells.length}`,
							},
						],
						details: undefined,
					};
				}

				default:
					return {
						content: [
							{ type: "text", text: `Error: Unknown action "${action}". Supported: insert, replace, delete.` },
						],
						details: undefined,
					};
			}
		} catch (err: any) {
			return {
				content: [{ type: "text", text: `NotebookEdit Error: ${err.message || String(err)}` }],
				details: undefined,
			};
		}
	},
};
