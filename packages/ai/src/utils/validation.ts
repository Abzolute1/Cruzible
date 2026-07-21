import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";

// Handle both default and named exports
const Ajv = (AjvModule as any).default || AjvModule;
const addFormats = (addFormatsModule as any).default || addFormatsModule;

import type { Tool, ToolCall } from "../types.js";

// Detect if we're in a browser extension environment with strict CSP
// Chrome extensions with Manifest V3 don't allow eval/Function constructor
const isBrowserExtension = typeof globalThis !== "undefined" && (globalThis as any).chrome?.runtime?.id !== undefined;

// Cache the result: CSP policy cannot change during process lifetime, and
// `new Function` is too expensive to re-run on every tool-call validation.
let runtimeCodegenAvailable: boolean | null = null;

function probeRuntimeCodegen(): boolean {
	if (isBrowserExtension) {
		return false;
	}

	try {
		new Function("return true;");
		return true;
	} catch {
		return false;
	}
}

function canUseRuntimeCodegen(): boolean {
	if (runtimeCodegenAvailable === null) {
		runtimeCodegenAvailable = probeRuntimeCodegen();
	}
	return runtimeCodegenAvailable;
}

// Create a singleton AJV instance with formats only when runtime code generation is available.
let ajv: any = null;
if (canUseRuntimeCodegen()) {
	try {
		ajv = new Ajv({
			allErrors: true,
			strict: false,
			coerceTypes: true,
			// AJV's default logger dumps generated code to console.error when compilation
			// fails (e.g. CSP-blocked codegen); the caller handles that via fallback instead.
			logger: false,
		});
		addFormats(ajv);
	} catch (_e) {
		console.warn("AJV validation disabled due to CSP restrictions");
	}
}

// Compiled AJV validators are expensive to create; cache them per schema object.
// Tool definitions are long-lived and stable across calls, so a WeakMap keyed on
// the parameters object is safe (entries vanish if the tool is garbage collected).
const validatorCache = new WeakMap<object, any>();

/**
 * Finds a tool by name and validates the tool call arguments against its TypeBox schema
 * @param tools Array of tool definitions
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error if tool is not found or validation fails
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): any {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		throw new Error(`Tool "${toolCall.name}" not found`);
	}
	return validateToolArguments(tool, toolCall);
}

/**
 * Validates tool call arguments against the tool's TypeBox schema
 * @param tool The tool definition with TypeBox schema
 * @param toolCall The tool call from the LLM
 * @returns The validated (and potentially coerced) arguments
 * @throws Error with formatted message if validation fails
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): any {
	// Skip validation in environments where runtime code generation is unavailable.
	if (!ajv || !canUseRuntimeCodegen()) {
		return toolCall.arguments;
	}

	// Compile the schema (cached per schema object).
	let validate = validatorCache.get(tool.parameters);
	if (!validate) {
		try {
			validate = ajv.compile(tool.parameters);
		} catch (e) {
			// AJV compiles via `new Function`; if code generation turned out to be blocked
			// after all (strict CSP), fall back to raw arguments like the probe path above.
			if (!probeRuntimeCodegen()) {
				return toolCall.arguments;
			}
			throw e;
		}
		validatorCache.set(tool.parameters, validate);
	}

	// Clone arguments so AJV can safely mutate for type coercion
	const args = structuredClone(toolCall.arguments);

	// Validate the arguments (AJV mutates args in-place for type coercion)
	if (validate(args)) {
		return args;
	}

	// Format validation errors nicely
	const errors =
		validate.errors
			?.map((err: any) => {
				const path = err.instancePath ? err.instancePath.substring(1) : err.params.missingProperty || "root";
				return `  - ${path}: ${err.message}`;
			})
			.join("\n") || "Unknown validation error";

	// Truncate embedded arguments: they can contain secrets (e.g. Write tool on .env)
	// and this message propagates into logs and session files.
	const argsJson = JSON.stringify(toolCall.arguments, null, 2);
	const truncatedArgs = argsJson.length > 500 ? `${argsJson.slice(0, 500)}… (truncated)` : argsJson;

	const errorMessage = `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${truncatedArgs}`;

	throw new Error(errorMessage);
}
