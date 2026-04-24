#!/usr/bin/env node
process.title = "ag1";
process.emitWarning = (() => {}) as typeof process.emitWarning;

await import("./register-bedrock.js");
await import("../cli.js");
