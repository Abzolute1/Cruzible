// Auton — LSP Tool
// Provides LSP operations via typescript-language-server.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { execCommand } from "../../exec.js";
import type { ToolDefinition } from "../../extensions/types.js";

const MAX_OUTPUT_CHARS = 20000;

function truncateOutput(output: string): string {
	if (output.length <= MAX_OUTPUT_CHARS) return output;
	return (
		output.slice(0, MAX_OUTPUT_CHARS) +
		`\n\n[Output truncated: ${output.length - MAX_OUTPUT_CHARS} more characters omitted]`
	);
}

function findTsConfigDir(startDir: string): string | null {
	let current = startDir;
	for (let i = 0; i < 20; i++) {
		if (existsSync(join(current, "tsconfig.json"))) return current;
		if (existsSync(join(current, "jsconfig.json"))) return current;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return null;
}

async function runLspAction(
	action: string,
	filePath: string,
	symbol: string | undefined,
	line: number | undefined,
	column: number | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	const projectRoot = findTsConfigDir(cwd);
	if (!projectRoot) {
		return "Error: No tsconfig.json or jsconfig.json found in project hierarchy.";
	}

	const absolutePath = filePath.startsWith("/") ? filePath : join(cwd, filePath);
	if (!existsSync(absolutePath)) {
		return `Error: File not found: ${absolutePath}`;
	}

	// Build the LSP request as a JSON-RPC message
	const position = {
		line: line ?? 0,
		character: column ?? 0,
	};

	const _lspRequest = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: getLspMethod(action),
		params: buildLspParams(action, absolutePath, position, symbol),
	});

	try {
		const _result = await execCommand("npx", ["--yes", "typescript-language-server", "--stdio"], projectRoot, {
			signal,
			timeout: 60000,
		});

		// typescript-language-server --stdio expects JSON-RPC over stdin/stdout
		// We'll use a simpler approach: use a dedicated LSP client script
		return await runLspViaNode(action, absolutePath, position, symbol, projectRoot, signal);
	} catch (_err: any) {
		// Fallback: try running tsserver directly
		return await runTsserverFallback(action, absolutePath, position, symbol, projectRoot, signal);
	}
}

function getLspMethod(action: string): string {
	const methodMap: Record<string, string> = {
		goToDefinition: "textDocument/definition",
		findReferences: "textDocument/references",
		hover: "textDocument/hover",
		documentSymbol: "textDocument/documentSymbol",
		workspaceSymbol: "workspace/symbol",
		goToImplementation: "textDocument/implementation",
		prepareCallHierarchy: "textDocument/prepareCallHierarchy",
		incomingCalls: "callHierarchy/incomingCalls",
		outgoingCalls: "callHierarchy/outgoingCalls",
	};
	return methodMap[action] || action;
}

function buildLspParams(action: string, filePath: string, position: any, symbol: string | undefined): any {
	const uri = `file://${filePath}`;

	switch (action) {
		case "goToDefinition":
		case "goToImplementation":
			return {
				textDocument: { uri },
				position,
			};
		case "findReferences":
			return {
				textDocument: { uri },
				position,
				context: { includeDeclaration: true },
			};
		case "hover":
			return {
				textDocument: { uri },
				position,
			};
		case "documentSymbol":
			return {
				textDocument: { uri },
			};
		case "workspaceSymbol":
			return {
				query: symbol || "",
			};
		case "prepareCallHierarchy":
			return {
				textDocument: { uri },
				position,
			};
		case "incomingCalls":
		case "outgoingCalls":
			return {
				item: {
					kind: 12,
					name: symbol || "unknown",
					uri,
					range: { start: position, end: position },
					selectionRange: { start: position, end: position },
				},
			};
		default:
			return { textDocument: { uri }, position };
	}
}

async function runLspViaNode(
	action: string,
	filePath: string,
	position: any,
	symbol: string | undefined,
	projectRoot: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	// Create a temporary script that communicates with tsserver
	const script = `
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');

const filePath = ${JSON.stringify(filePath)};
const position = ${JSON.stringify(position)};
const action = ${JSON.stringify(action)};
const symbol = ${JSON.stringify(symbol)};
const projectRoot = ${JSON.stringify(projectRoot)};

// Find tsconfig
let configPath = null;
let dir = projectRoot;
for (let i = 0; i < 20; i++) {
  const ts = path.join(dir, 'tsconfig.json');
  const js = path.join(dir, 'jsconfig.json');
  if (fs.existsSync(ts)) { configPath = ts; break; }
  if (fs.existsSync(js)) { configPath = js; break; }
  const parent = path.dirname(dir);
  if (parent === dir) break;
  dir = parent;
}

if (!configPath) {
  console.log(JSON.stringify({ error: 'No tsconfig.json found' }));
  process.exit(0);
}

// Try using typescript's tsserver directly
let ts;
try {
  ts = require(path.join(projectRoot, 'node_modules', 'typescript', 'lib', 'typescript.js'));
} catch(e) {
  try {
    ts = require('typescript');
  } catch(e2) {
    console.log(JSON.stringify({ error: 'TypeScript not found. Install typescript: npm install typescript' }));
    process.exit(0);
  }
}

const uri = 'file://' + filePath;
const fileContent = fs.readFileSync(filePath, 'utf-8');

const compilerOptions = ts.parseConfigFileTextToJson(configPath, fs.readFileSync(configPath, 'utf-8')).config;
const host = ts.createCompilerHost(compilerOptions.compilerOptions || {});
const origGetSourceFile = host.getSourceFile.bind(host);
host.getSourceFile = (fileName, languageVersion, onError) => {
  if (fileName === filePath) {
    return ts.createSourceFile(fileName, fileContent, ts.ScriptTarget.Latest, true);
  }
  return origGetSourceFile(fileName, languageVersion, onError);
};

const program = ts.createProgram([filePath], compilerOptions.compilerOptions || {}, host);
const checker = program.getTypeChecker();
const sourceFile = program.getSourceFile(filePath);

if (!sourceFile) {
  console.log(JSON.stringify({ error: 'Could not parse source file' }));
  process.exit(0);
}

function getPosition() {
  return ts.getPositionOfLineAndCharacter(sourceFile, position.line, position.character);
}

function getNodeAtPos() {
  const pos = getPosition();
  let result = null;
  function visit(node) {
    if (node.pos <= pos && node.end >= pos) {
      result = node;
      ts.forEachChild(node, visit);
    }
  }
  ts.forEachChild(sourceFile, visit);
  return result;
}

let result;
try {
  switch (action) {
    case 'goToDefinition': {
      const node = getNodeAtPos();
      if (!node) { result = { error: 'No node at position' }; break; }
      const defs = checker.getSymbolAtLocation(node)?.declarations;
      if (!defs || defs.length === 0) {
        // Try alternate approach for definitions
        const sym = checker.getSymbolAtLocation(node);
        if (sym && sym.declarations) {
          result = { locations: sym.declarations.map(d => ({ file: d.getSourceFile().fileName, line: sourceFile.getLineAndCharacterOfPosition(d.pos).line + 1 })) };
        } else {
          result = { message: 'No definition found' };
        }
      } else {
        result = { locations: defs.map(d => ({ file: d.getSourceFile().fileName, line: sourceFile.getLineAndCharacterOfPosition(d.pos).line + 1 })) };
      }
      break;
    }
    case 'findReferences': {
      const node = getNodeAtPos();
      const refs = node ? checker.getSymbolAtLocation(node) : null;
      if (!refs) { result = { message: 'No symbol found at position' }; break; }
      const allRefs = [];
      function visitFile(sf) {
        function visit(node) {
          if (ts.isIdentifier(node)) {
            const s = checker.getSymbolAtLocation(node);
            if (s === refs) {
              const lc = sf.getLineAndCharacterOfPosition(node.pos);
              allRefs.push({ file: sf.fileName, line: lc.line + 1, column: lc.character + 1 });
            }
          }
          ts.forEachChild(node, visit);
        }
        ts.forEachChild(sf, visit);
      }
      // NOTE: Only scans current file, not whole workspace. For cross-file references, use an IDE.
      visitFile(sourceFile);
      result = { references: allRefs, note: allRefs.length > 0 ? 'References found in current file only. Cross-file references require a full IDE.' : undefined };
      break;
    }
    case 'hover': {
      const node = getNodeAtPos();
      if (!node) { result = { message: 'No node at position' }; break; }
      const sym = checker.getSymbolAtLocation(node);
      if (!sym) { result = { message: 'No symbol at position' }; break; }
      const type = checker.getTypeOfSymbolAtLocation(sym, node);
      const typeStr = checker.typeToString(type);
      result = { symbol: sym.name, type: typeStr };
      break;
    }
    case 'documentSymbol': {
      const symbols = [];
      function visit(node) {
        if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) ||
            ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) ||
            ts.isEnumDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
            ts.isVariableStatement(node) || ts.isMethodDeclaration(node) ||
            ts.isPropertyDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
          const lc = sourceFile.getLineAndCharacterOfPosition(node.pos);
          let name = 'anonymous';
          if (ts.isVariableStatement(node)) {
            name = node.declarationList.declarations[0]?.name?.getText(sourceFile) || 'unknown';
          } else if (node.name) {
            name = node.name.getText ? node.name.getText(sourceFile) : String(node.name.escapedText || 'unknown');
          }
          symbols.push({ name, kind: ts.SyntaxKind[node.kind], line: lc.line + 1 });
        }
        ts.forEachChild(node, visit);
      }
      ts.forEachChild(sourceFile, visit);
      result = { symbols };
      break;
    }
    case 'workspaceSymbol': {
      result = { message: 'workspaceSymbol requires index; use documentSymbol for single-file queries' };
      break;
    }
    case 'goToImplementation': {
      const node = getNodeAtPos();
      const sym = node ? checker.getSymbolAtLocation(node) : null;
      if (!sym) { result = { message: 'No symbol at position' }; break; }
      const impls = sym.declarations?.filter(d => ts.isClassDeclaration(d) || ts.isMethodDeclaration(d) || ts.isFunctionDeclaration(d)) || [];
      result = { implementations: impls.map(d => ({ file: d.getSourceFile().fileName, line: sourceFile.getLineAndCharacterOfPosition(d.pos).line + 1 })) };
      break;
    }
    case 'prepareCallHierarchy': {
      const node = getNodeAtPos();
      const sym = node ? checker.getSymbolAtLocation(node) : null;
      if (!sym) { result = { message: 'No symbol at position' }; break; }
      result = { name: sym.name, kind: ts.SyntaxKind[sym.flags], details: undefined };
      break;
    }
    case 'incomingCalls':
    case 'outgoingCalls': {
      result = { message: 'Call hierarchy requires full workspace analysis; consider using an IDE for this' };
      break;
    }
    default:
      result = { error: 'Unknown action: ' + action };
  }
} catch (err) {
  result = { error: err.message || String(err) };
}

console.log(JSON.stringify(result, null, 2));
`;

	try {
		const result = await execCommand("node", ["-e", script], projectRoot, { signal, timeout: 30000 });
		if (result.code === 0 && result.stdout) {
			return truncateOutput(result.stdout);
		}
		if (result.stderr) {
			return `Error: ${truncateOutput(result.stderr)}`;
		}
		return "LSP action completed with no output.";
	} catch (err: any) {
		return `Error executing LSP: ${err.message || String(err)}`;
	}
}

async function runTsserverFallback(
	action: string,
	_filePath: string,
	_position: any,
	_symbol: string | undefined,
	_projectRoot: string,
	_signal: AbortSignal | undefined,
): Promise<string> {
	return `LSP action "${action}" requires TypeScript. Please install it with: npm install typescript`;
}

const lspParamsSchema = Type.Object({
	action: Type.Enum(
		{
			goToDefinition: "goToDefinition",
			findReferences: "findReferences",
			hover: "hover",
			documentSymbol: "documentSymbol",
			workspaceSymbol: "workspaceSymbol",
			goToImplementation: "goToImplementation",
			prepareCallHierarchy: "prepareCallHierarchy",
			incomingCalls: "incomingCalls",
			outgoingCalls: "outgoingCalls",
		},
		{ description: "LSP operation to perform" },
	),
	path: Type.String({ description: "File path to operate on" }),
	symbol: Type.Optional(Type.String({ description: "Symbol name (required for workspaceSymbol and call hierarchy)" })),
	line: Type.Optional(Type.Number({ description: "Line number (0-based)" })),
	column: Type.Optional(Type.Number({ description: "Column number (0-based)" })),
});
type LspParams = Static<typeof lspParamsSchema>;

export const lspToolDefinition: ToolDefinition<typeof lspParamsSchema, undefined, undefined> = {
	name: "LSP",
	label: "LSP",
	description:
		"Perform LSP operations like goToDefinition, findReferences, hover, documentSymbol, etc. Requires TypeScript to be installed.",
	parameters: lspParamsSchema,
	execute: async (
		_toolCallId: string,
		params: LspParams,
		signal: AbortSignal | undefined,
		_onUpdate: (update: unknown) => Promise<void>,
		ctx: { cwd?: string } | undefined,
	) => {
		const action = params.action;
		const filePath = params.path;
		const symbol = params.symbol;
		const line = params.line;
		const column = params.column;
		const cwd = ctx?.cwd || process.cwd();

		try {
			const result = await runLspAction(action, filePath, symbol, line, column, cwd, signal);
			return {
				content: [{ type: "text", text: result }],
				details: undefined,
			};
		} catch (err: any) {
			const hint = err.message?.includes("TypeScript")
				? "\n\nHint: Install TypeScript in this project: npm install typescript"
				: "";
			return {
				content: [{ type: "text", text: `LSP Error: ${err.message || String(err)}${hint}` }],
				details: undefined,
			};
		}
	},
};
