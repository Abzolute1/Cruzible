import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

export interface NotebookEditToolOptions {
	cwd: string;
}

interface NotebookCell {
	id?: string;
	cell_type: "code" | "markdown";
	execution_count?: number | null;
	metadata: Record<string, unknown>;
	outputs?: Record<string, unknown>[];
	source: string[] | string;
}

interface Notebook {
	cells: NotebookCell[];
	metadata: Record<string, unknown>;
	nbformat: number;
	nbformat_minor: number;
}

function loadNotebook(path: string): Notebook | null {
	try {
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

function saveNotebook(path: string, notebook: Notebook): boolean {
	try {
		writeFileSync(path, JSON.stringify(notebook, null, 1), "utf-8");
		return true;
	} catch {
		return false;
	}
}

export const notebookEditToolDefinition = {
	name: "NotebookEdit",
	label: "NotebookEdit",
	description:
		"Edit Jupyter notebook (.ipynb) cells. Supports insert, replace, delete operations. Preserves cell metadata and execution counts. Use for programmatic notebook editing.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to .ipynb file" }),
		action: Type.String({ description: "Action: insert, replace, or delete", enum: ["insert", "replace", "delete"] }),
		cellIndex: Type.Optional(
			Type.Number({
				description: "Cell index (0-based). For insert: position to insert. For replace/delete: target cell.",
			}),
		),
		source: Type.Optional(Type.String({ description: "Cell source content (for insert/replace)" })),
		cellType: Type.Optional(
			Type.String({ description: "Cell type: code or markdown (default: code)", enum: ["code", "markdown"] }),
		),
	}),
	guidelines: [
		"Always read the notebook first to understand structure.",
		"Cell indices are 0-based.",
		"Preserves metadata and execution counts on replace.",
	],
};

export function createNotebookEditTool(options: NotebookEditToolOptions) {
	return {
		name: "NotebookEdit",
		label: "NotebookEdit",
		description: notebookEditToolDefinition.description,
		parameters: notebookEditToolDefinition.parameters,
		execute: async (_toolCallId: string, params: unknown): Promise<AgentToolResult<unknown>> => {
			const { path, action, cellIndex, source, cellType = "code" } = params as Record<string, any>;

			if (!path || typeof path !== "string") {
				return { details: {}, content: [{ type: "text" as const, text: "Error: 'path' parameter is required." }] };
			}

			const fullPath = path.startsWith("/") ? path : `${options.cwd}/${path}`;
			const notebook = loadNotebook(fullPath);

			if (!notebook) {
				return {
					details: {},
					content: [
						{
							type: "text" as const,
							text: `Error: Could not load notebook at '${fullPath}'. File may not exist or be invalid JSON.`,
						},
					],
				};
			}

			switch (action) {
				case "insert": {
					if (source === undefined) {
						return {
							details: {},
							content: [
								{ type: "text" as const, text: "Error: 'source' parameter is required for insert action." },
							],
						};
					}
					const newCell: NotebookCell = {
						cell_type: cellType as "code" | "markdown",
						source: source.split("\n"),
						metadata: {},
						...(cellType === "code" ? { execution_count: null, outputs: [] } : {}),
					};
					const idx = cellIndex !== undefined ? Math.min(cellIndex, notebook.cells.length) : notebook.cells.length;
					notebook.cells.splice(idx, 0, newCell);
					break;
				}
				case "replace": {
					if (cellIndex === undefined || source === undefined) {
						return {
							details: {},
							content: [
								{
									type: "text" as const,
									text: "Error: 'cellIndex' and 'source' parameters are required for replace action.",
								},
							],
						};
					}
					if (cellIndex < 0 || cellIndex >= notebook.cells.length) {
						return {
							details: {},
							content: [
								{
									type: "text" as const,
									text: `Error: Cell index ${cellIndex} out of range (0-${notebook.cells.length - 1}).`,
								},
							],
						};
					}
					const oldCell = notebook.cells[cellIndex];
					notebook.cells[cellIndex] = {
						...oldCell,
						cell_type: cellType as "code" | "markdown",
						source: source.split("\n"),
					};
					break;
				}
				case "delete": {
					if (cellIndex === undefined) {
						return {
							details: {},
							content: [
								{ type: "text" as const, text: "Error: 'cellIndex' parameter is required for delete action." },
							],
						};
					}
					if (cellIndex < 0 || cellIndex >= notebook.cells.length) {
						return {
							details: {},
							content: [{ type: "text" as const, text: `Error: Cell index ${cellIndex} out of range.` }],
						};
					}
					notebook.cells.splice(cellIndex, 1);
					break;
				}
				default:
					return {
						details: {},
						content: [
							{
								type: "text" as const,
								text: `Error: Invalid action '${action}'. Must be insert, replace, or delete.`,
							},
						],
					};
			}

			const saved = saveNotebook(fullPath, notebook);
			if (!saved) {
				return {
					details: {},
					content: [{ type: "text" as const, text: `Error: Failed to save notebook to '${fullPath}'.` }],
				};
			}

			return {
				details: {},
				content: [
					{
						type: "text" as const,
						text: `Notebook ${action}d successfully. ${notebook.cells.length} cells total.`,
					},
				],
			};
		},
	};
}
