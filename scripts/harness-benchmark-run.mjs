#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUPPORTED_ADAPTERS = new Set(["ag1", "opencode", "aider", "codex", "claude", "continue", "command"]);
const EXTERNAL_ADAPTERS = new Set(["opencode", "aider", "codex", "claude", "continue", "command"]);

function parseArgs(argv) {
	const args = {
		adapter: "ag1",
		scenarios: join(repoRoot, "scripts", "benchmark-scenarios-v3_5.json"),
		model: "",
		provider: "local",
		steering: "on",
		timeout: 120,
		outDir: "",
		skipHistory: false,
		scenarioIds: [],
		maxTurns: 30,
		maxOutput: 0,
		commandTemplate: "",
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--adapter") args.adapter = argv[++i] ?? args.adapter;
		else if (arg === "--scenarios") args.scenarios = resolve(argv[++i] ?? args.scenarios);
		else if (arg === "--model") args.model = argv[++i] ?? "";
		else if (arg === "--provider") args.provider = argv[++i] ?? args.provider;
		else if (arg === "--steering") args.steering = argv[++i] ?? args.steering;
		else if (arg === "--timeout") args.timeout = Number(argv[++i] ?? args.timeout);
		else if (arg === "--out-dir") args.outDir = resolve(argv[++i] ?? "");
		else if (arg === "--skip-history") args.skipHistory = true;
		else if (arg === "--scenario") args.scenarioIds.push(argv[++i] ?? "");
		else if (arg === "--max-turns") args.maxTurns = Number(argv[++i] ?? args.maxTurns);
		else if (arg === "--max-output") args.maxOutput = Number(argv[++i] ?? args.maxOutput);
		else if (arg === "--command-template") args.commandTemplate = argv[++i] ?? "";
		else if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (!SUPPORTED_ADAPTERS.has(args.adapter)) {
		throw new Error(`Unsupported adapter: ${args.adapter}. Supported: ${Array.from(SUPPORTED_ADAPTERS).join(", ")}`);
	}
	if (!args.model) throw new Error("--model is required");
	if (!args.outDir) throw new Error("--out-dir is required");
	if (!Number.isFinite(args.timeout) || args.timeout <= 0) throw new Error("--timeout must be a positive number");
	if (EXTERNAL_ADAPTERS.has(args.adapter) && !resolveAdapterCommandTemplate(args)) {
		throw new Error(
			`--command-template or ${adapterCommandEnvName(args.adapter)} is required for adapter ${args.adapter}`,
		);
	}
	return args;
}

function printHelp() {
	console.log(`Usage:
  node scripts/harness-benchmark-run.mjs \\
    --adapter ag1|opencode|aider|codex|claude|continue|command \\
    --scenarios scripts/benchmark-scenarios-v3_5.json \\
    --model qwen/qwen3.5-9b \\
    --timeout 120 \\
    --out-dir /tmp/ag1-v3_5-qwen9b-once \\
    --skip-history

Options:
  --scenario <id>       Run one scenario. Can be repeated.
  --max-turns <n>       Autonomous turn budget per scenario. Default: 30.
  --max-output <n>      AG1 max output per turn. Default: 0.
  --command-template    External adapter command template. Overrides AG1_BENCH_<ADAPTER>_COMMAND.

External command placeholders:
  {workspace} {task} {taskFile} {scenario} {model} {maxTurns} {maxOutput} {agentDir} {metricsFile}

Examples:
  AG1_BENCH_OPENCODE_COMMAND='opencode run --dir {workspace} --model {model} {task}'
  AG1_BENCH_AIDER_COMMAND='aider --yes --model {model} --message-file {taskFile}'
  AG1_BENCH_CODEX_COMMAND='codex exec --cwd {workspace} --model {model} {task}'
`);
}

function adapterCommandEnvName(adapter) {
	return adapter === "command" ? "AG1_BENCH_COMMAND" : `AG1_BENCH_${adapter.toUpperCase()}_COMMAND`;
}

function resolveAdapterCommandTemplate(args) {
	return args.commandTemplate || process.env[adapterCommandEnvName(args.adapter)] || "";
}

function loadSuite(path) {
	const suite = JSON.parse(readFileSync(path, "utf8"));
	if (!suite || !Array.isArray(suite.scenarios)) {
		throw new Error(`Invalid scenarios file: ${path}`);
	}
	return suite;
}

function fileContent(file) {
	if (typeof file.content === "string") return file.content;
	if (Array.isArray(file.lines)) return `${file.lines.join("\n")}${file.finalNewline === false ? "" : "\n"}`;
	throw new Error(`Scenario file ${file.path} must have content or lines`);
}

function writeFixture(scenario, fixtureDir) {
	const workspace = join(fixtureDir, "workspace");
	mkdirSync(workspace, { recursive: true });
	writeFileSync(join(fixtureDir, "TASK.md"), scenario.task, "utf8");
	for (const file of scenario.files ?? []) {
		const target = join(workspace, file.path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, fileContent(file), "utf8");
	}
	return workspace;
}

function runCommand(command, args, options = {}) {
	return new Promise((resolveResult) => {
		const child = spawn(command, args, {
			cwd: options.cwd ?? repoRoot,
			env: options.env ?? process.env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout = [];
		const stderr = [];
		let timedOut = false;
		const timeout = options.timeoutMs
			? setTimeout(() => {
					timedOut = true;
					child.kill("SIGTERM");
					setTimeout(() => child.kill("SIGKILL"), 2000).unref();
				}, options.timeoutMs)
			: undefined;
		child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
		child.on("close", (code, signal) => {
			if (timeout) clearTimeout(timeout);
			resolveResult({
				code: code ?? (timedOut ? 124 : 1),
				signal,
				timedOut,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			});
		});
		child.on("error", (error) => {
			if (timeout) clearTimeout(timeout);
			resolveResult({ code: 1, signal: null, timedOut, stdout: "", stderr: String(error) });
		});
	});
}

function runShellCommand(command, options = {}) {
	return new Promise((resolveResult) => {
		const child = spawn(command, {
			cwd: options.cwd ?? repoRoot,
			env: options.env ?? process.env,
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout = [];
		const stderr = [];
		let timedOut = false;
		const timeout = options.timeoutMs
			? setTimeout(() => {
					timedOut = true;
					child.kill("SIGTERM");
					setTimeout(() => child.kill("SIGKILL"), 2000).unref();
				}, options.timeoutMs)
			: undefined;
		child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
		child.on("close", (code, signal) => {
			if (timeout) clearTimeout(timeout);
			resolveResult({
				code: code ?? (timedOut ? 124 : 1),
				signal,
				timedOut,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			});
		});
		child.on("error", (error) => {
			if (timeout) clearTimeout(timeout);
			resolveResult({ code: 1, signal: null, timedOut, stdout: "", stderr: String(error) });
		});
	});
}

function shellQuote(value) {
	return `'${String(value ?? "").replaceAll("'", "'\\''")}'`;
}

function renderCommandTemplate(template, values) {
	const replacements = new Map(Object.entries(values).map(([key, value]) => [`{${key}}`, shellQuote(value)]));
	let command = template;
	for (const [placeholder, value] of replacements) {
		command = command.replaceAll(placeholder, value);
	}
	if (!template.includes("{task}") && !template.includes("{taskFile}")) {
		command = `${command} ${shellQuote(values.task)}`;
	}
	return command;
}

async function initGit(workspace) {
	await runCommand("git", ["init", "-q"], { cwd: workspace });
	await runCommand("git", ["config", "user.email", "benchmark@example.invalid"], { cwd: workspace });
	await runCommand("git", ["config", "user.name", "Benchmark"], { cwd: workspace });
	await runCommand("git", ["add", "-A"], { cwd: workspace });
	await runCommand("git", ["commit", "-q", "-m", "fixture"], { cwd: workspace });
}

async function getChangedFiles(workspace) {
	const status = await runCommand("git", ["status", "--porcelain"], { cwd: workspace });
	const changed = [];
	const added = [];
	const deleted = [];
	for (const line of status.stdout.split("\n")) {
		if (!line.trim()) continue;
		const code = line.slice(0, 2);
		const file = line.slice(3).trim();
		if (!file) continue;
		if (code.includes("D")) deleted.push(file);
		else if (code.includes("A") || code.includes("?")) added.push(file);
		else changed.push(file);
	}
	return { changed, added, deleted };
}

function latestSessionFile(agentDir) {
	const sessionRoot = join(agentDir, "sessions");
	if (!existsSync(sessionRoot)) return "";
	const files = [];
	function walk(dir) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".jsonl")) files.push(full);
		}
	}
	walk(sessionRoot);
	files.sort();
	return files.at(-1) ?? "";
}

function parseSession(sessionPath) {
	if (!sessionPath || !existsSync(sessionPath)) {
		return {
			toolSequence: [],
			toolCallCount: 0,
			finalAnswerDetected: false,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
			usageTurns: [],
		};
	}
	const toolSequence = [];
	let finalAnswerDetected = false;
	const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
	const usageTurns = [];
	for (const line of readFileSync(sessionPath, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const message = entry.message ?? entry;
		// Subagent usage roll-ups: task-tool subagents run ephemeral in-memory
		// sessions, so their token usage is recorded as a custom entry on the
		// parent session. Count them — otherwise delegation looks free.
		const usage = message.usage ?? entry.usage ?? (entry.customType === "ag1.subagent_task" ? entry.data?.usage : undefined);
		if (usage) {
			const turn = {
				input: Number(usage.input ?? usage.inputTokens ?? 0),
				output: Number(usage.output ?? usage.outputTokens ?? 0),
				cacheRead: Number(usage.cacheRead ?? usage.cacheReadTokens ?? 0),
				cacheWrite: Number(usage.cacheWrite ?? usage.cacheWriteTokens ?? 0),
				total: Number(usage.totalTokens ?? usage.total ?? 0),
				cost: Number(usage.cost?.total ?? usage.totalCost ?? 0),
			};
			tokens.input += turn.input;
			tokens.output += turn.output;
			tokens.cacheRead += turn.cacheRead;
			tokens.cacheWrite += turn.cacheWrite;
			tokens.total += turn.total;
			tokens.cost += turn.cost;
			usageTurns.push(turn);
		}
		const content = message.content;
		if (Array.isArray(content)) {
			for (const block of content) {
				if (block?.type === "toolCall" && typeof block.name === "string") {
					toolSequence.push(block.name);
				}
				if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
					finalAnswerDetected = true;
				}
			}
		} else if (typeof content === "string" && content.trim() && message.role === "assistant") {
			finalAnswerDetected = true;
		}
	}
	return { toolSequence, toolCallCount: toolSequence.length, finalAnswerDetected, tokens, usageTurns };
}

function readAdapterMetrics(metricsPath) {
	if (!metricsPath || !existsSync(metricsPath)) {
		return null;
	}
	try {
		return JSON.parse(readFileSync(metricsPath, "utf8"));
	} catch {
		return null;
	}
}

function normalizeMetricNumber(value) {
	const number = Number(value ?? 0);
	return Number.isFinite(number) ? number : 0;
}

function sessionLikeFromAdapterMetrics(metrics) {
	if (!metrics) {
		return null;
	}
	const toolSequence = Array.isArray(metrics.toolSequence)
		? metrics.toolSequence.map(String)
		: typeof metrics.tool_sequence === "string"
			? metrics.tool_sequence.split(/\s*->\s*/).filter(Boolean)
			: [];
	const usageTurns = Array.isArray(metrics.usageTurns) ? metrics.usageTurns : Array.isArray(metrics.usage_turns) ? metrics.usage_turns : [];
	return {
		toolSequence,
		toolCallCount: normalizeMetricNumber(metrics.toolCallCount ?? metrics.tool_call_count ?? toolSequence.length),
		finalAnswerDetected: Boolean(metrics.finalAnswerDetected ?? metrics.final_answer_detected ?? true),
		tokens: {
			input: normalizeMetricNumber(metrics.inputTokens ?? metrics.input_tokens),
			output: normalizeMetricNumber(metrics.outputTokens ?? metrics.output_tokens),
			cacheRead: normalizeMetricNumber(metrics.cacheReadTokens ?? metrics.cache_read_tokens),
			cacheWrite: normalizeMetricNumber(metrics.cacheWriteTokens ?? metrics.cache_write_tokens),
			total: normalizeMetricNumber(metrics.totalTokens ?? metrics.total_tokens),
			cost: normalizeMetricNumber(metrics.totalCost ?? metrics.total_cost),
		},
		usageTurns: usageTurns.map((turn) => ({
			input: normalizeMetricNumber(turn.input ?? turn.inputTokens),
			output: normalizeMetricNumber(turn.output ?? turn.outputTokens),
			cacheRead: normalizeMetricNumber(turn.cacheRead ?? turn.cacheReadTokens),
			cacheWrite: normalizeMetricNumber(turn.cacheWrite ?? turn.cacheWriteTokens),
			total: normalizeMetricNumber(turn.total ?? turn.totalTokens),
			cost: normalizeMetricNumber(turn.cost?.total ?? turn.totalCost),
		})),
	};
}

function estimateContextTelemetry(auditDir) {
	if (!existsSync(auditDir)) {
		return {
			context_audit_turns: 0,
			max_context_chars: 0,
			avg_context_chars: 0,
			max_context_tokens_est: 0,
			avg_context_tokens_est: 0,
			max_context_message_count: 0,
			max_system_prompt_chars: 0,
			model_capability_profile: "",
			context_hygiene_options: "",
		};
	}
	const files = readdirSync(auditDir).filter((name) => name.endsWith(".json")).sort();
	const samples = [];
	let modelProfile = "";
	let hygieneOptions = "";
	for (const file of files) {
		let payload;
		try {
			payload = JSON.parse(readFileSync(join(auditDir, file), "utf8"));
		} catch {
			continue;
		}
		const messagesChars = JSON.stringify(payload.messages ?? []).length;
		const systemPromptChars = Number(payload.systemPromptChars ?? 0);
		const contextChars = messagesChars + systemPromptChars;
		samples.push({
			contextChars,
			messageCount: Number(payload.messageCount ?? 0),
			systemPromptChars,
		});
		if (!modelProfile && payload.modelCapabilityProfile) {
			modelProfile = JSON.stringify(payload.modelCapabilityProfile);
		}
		if (!hygieneOptions && payload.contextHygieneOptions) {
			hygieneOptions = JSON.stringify(payload.contextHygieneOptions);
		}
	}
	const avg = (values) => Math.round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length));
	const max = (values) => values.reduce((best, value) => Math.max(best, value), 0);
	const contextChars = samples.map((sample) => sample.contextChars);
	return {
		context_audit_turns: samples.length,
		max_context_chars: max(contextChars),
		avg_context_chars: avg(contextChars),
		max_context_tokens_est: Math.round(max(contextChars) / 4),
		avg_context_tokens_est: Math.round(avg(contextChars) / 4),
		max_context_message_count: max(samples.map((sample) => sample.messageCount)),
		max_system_prompt_chars: max(samples.map((sample) => sample.systemPromptChars)),
		model_capability_profile: modelProfile,
		context_hygiene_options: hygieneOptions,
	};
}

function scoreRow(row) {
	const verifyPassed = row.verify_status === "passed";
	const changedCount = Number(row.changed_files_count || 0) + Number(row.added_files_count || 0) + Number(row.deleted_files_count || 0);
	const taskCorrectness = verifyPassed ? 35 : 0;
	const verificationQuality = verifyPassed && row.tool_sequence.split(" -> ").includes("bash") ? 15 : verifyPassed ? 8 : 0;
	const executionQuality = verifyPassed && changedCount <= Math.max(1, Number(row.expected_changed_files_max ?? 2)) ? 15 : verifyPassed ? 9 : 0;
	const repeatedExtra = countRepeatedExtra(row.tool_sequence ? row.tool_sequence.split(" -> ") : []);
	const recoveryDiscipline = Math.max(0, 10 - repeatedExtra * 1.5);
	const toolCalls = Number(row.tool_call_count || 0);
	const totalTokens = Number(row.total_tokens || 0);
	const efficiency = Math.max(0, 20 - Math.max(0, toolCalls - 4) * 2 - Math.max(0, totalTokens - 20_000) / 5000);
	const stopping = row.final_answer_detected === "true" ? 5 : 0;
	const total = taskCorrectness + verificationQuality + executionQuality + recoveryDiscipline + efficiency + stopping;
	return {
		score: Math.round(total * 10) / 10,
		task_correctness_score: taskCorrectness,
		verification_quality_score: verificationQuality,
		execution_quality_score: executionQuality,
		recovery_discipline_score: Math.round(recoveryDiscipline * 10) / 10,
		efficiency_score: Math.round(efficiency * 10) / 10,
		stopping_score: stopping,
	};
}

function countRepeatedExtra(sequence) {
	let repeats = 0;
	for (let i = 1; i < sequence.length; i++) {
		if (sequence[i] === sequence[i - 1]) repeats++;
	}
	return repeats;
}

function csvEscape(value) {
	const text = String(value ?? "");
	return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeReports(outDir, adapter, run) {
	const rows = run.rows;
	const jsonPath = join(outDir, `${adapter}.results.json`);
	const runPath = join(outDir, `${adapter}.run.json`);
	const csvPath = join(outDir, `${adapter}.results.csv`);
	const mdPath = join(outDir, `${adapter}.results.md`);
	writeFileSync(jsonPath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
	writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
	const columns = Object.keys(rows[0] ?? { adapter: "", scenario: "", status: "", score: "" });
	writeFileSync(
		csvPath,
		`${columns.join(",")}\n${rows.map((row) => columns.map((column) => csvEscape(row[column])).join(",")).join("\n")}\n`,
		"utf8",
	);
	writeFileSync(
		mdPath,
		[
			`# ${run.meta.suite_name} Results`,
			"",
			`- Adapter: ${adapter}`,
			`- Model: ${run.meta.model}`,
			`- Solved (external verify): ${run.aggregate.verified_count}/${run.aggregate.scenario_count} (${run.aggregate.pass_rate}%)`,
			`- Cost: total $${run.aggregate.total_cost} · per solved $${run.aggregate.cost_per_solved}`,
			`- Tokens: total ${run.aggregate.total_tokens} · per solved ${run.aggregate.tokens_per_solved}`,
			`- Duration: total ${Math.round(run.aggregate.total_duration_ms / 1000)}s · avg ${Math.round(run.aggregate.average_duration_ms / 1000)}s`,
			`- Deprecated heuristic score (do not tune to this): ${run.aggregate.weighted_score}`,
			"",
			"| Scenario | Status | Verify | Tokens | Cost | Duration | Tools |",
			"|---|---:|---:|---:|---:|---:|---:|",
			...rows.map(
				(row) =>
					`| ${row.scenario} | ${row.status} | ${row.verify_status} | ${row.total_tokens} | $${row.total_cost} | ${Math.round(Number(row.duration_ms || 0) / 1000)}s | ${row.tool_call_count} |`,
			),
			"",
		].join("\n"),
		"utf8",
	);
	return { jsonPath, runPath, csvPath, mdPath };
}

function aggregateRows(rows) {
	const totalWeight = rows.reduce((sum, row) => sum + Number(row.weight || 1), 0) || 1;
	const weighted = (field) =>
		rows.reduce((sum, row) => sum + Number(row[field] || 0) * Number(row.weight || 1), 0) / totalWeight;
	const avg = (field) => rows.reduce((sum, row) => sum + Number(row[field] || 0), 0) / Math.max(1, rows.length);
	return {
		scenario_count: rows.length,
		ok_count: rows.filter((row) => row.status === "ok").length,
		error_count: rows.filter((row) => row.status !== "ok").length,
		verified_count: rows.filter((row) => row.verify_status === "passed").length,
		pass_rate:
			Math.round((rows.filter((row) => row.verify_status === "passed").length / Math.max(1, rows.length)) * 1000) /
			10,
		average_score: Math.round(avg("score") * 100) / 100,
		weighted_score: Math.round(weighted("score") * 100) / 100,
		total_duration_ms: rows.reduce((sum, row) => sum + Number(row.duration_ms || 0), 0),
		average_duration_ms: Math.round(avg("duration_ms") * 100) / 100,
		total_tokens: rows.reduce((sum, row) => sum + Number(row.total_tokens || 0), 0),
		total_cost: Math.round(rows.reduce((sum, row) => sum + Number(row.total_cost || 0), 0) * 1e6) / 1e6,
		tokens_per_solved: Math.round(
			rows.reduce((sum, row) => sum + Number(row.total_tokens || 0), 0) /
				Math.max(1, rows.filter((row) => row.verify_status === "passed").length),
		),
		cost_per_solved:
			Math.round(
				(rows.reduce((sum, row) => sum + Number(row.total_cost || 0), 0) /
					Math.max(1, rows.filter((row) => row.verify_status === "passed").length)) *
					1e6,
			) / 1e6,
	};
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const suite = loadSuite(args.scenarios);
	const selected = args.scenarioIds.length
		? suite.scenarios.filter((scenario) => args.scenarioIds.includes(scenario.id))
		: suite.scenarios;
	if (selected.length === 0) throw new Error("No scenarios selected");

	const runId = `${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${args.adapter}`;
	mkdirSync(args.outDir, { recursive: true });
	const rows = [];
	const cliPath = join(repoRoot, "packages", "coding-agent", "dist", "cli.js");
	if (args.adapter === "ag1" && !existsSync(cliPath)) {
		throw new Error("packages/coding-agent/dist/cli.js not found. Run `npm run build --workspace packages/coding-agent` first.");
	}

	console.log(`benchmark_adapter=${args.adapter}`);
	console.log(`benchmark_run_id=${runId}`);
	console.log(`benchmark_out_dir=${args.outDir}`);
	console.log(`benchmark_json=${join(args.outDir, `${args.adapter}.results.json`)}`);
	console.log(`benchmark_run_json=${join(args.outDir, `${args.adapter}.run.json`)}`);
	console.log(`benchmark_csv=${join(args.outDir, `${args.adapter}.results.csv`)}`);
	console.log(`benchmark_markdown=${join(args.outDir, `${args.adapter}.results.md`)}`);

	for (const scenario of selected) {
		const scenarioRoot = join(args.outDir, args.adapter, scenario.id);
		const fixtureDir = join(scenarioRoot, "fixture");
		const agentDir = join(scenarioRoot, "agent");
		const contextAuditDir = join(scenarioRoot, "context-audit");
		const metricsPath = join(scenarioRoot, `${args.adapter}.metrics.json`);
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(contextAuditDir, { recursive: true });
		const workspace = writeFixture(scenario, fixtureDir);
		await initGit(workspace);
		const prompt = readFileSync(join(fixtureDir, "TASK.md"), "utf8");
		const started = Date.now();
		const result =
			args.adapter === "ag1"
				? await runCommand(
						process.execPath,
						[
							cliPath,
							"--autonomous",
							"--cwd",
							workspace,
							"--agent-dir",
							agentDir,
							"--provider",
							args.provider,
							"--model",
							args.model,
							"--max-turns",
							String(scenario.maxTurns ?? args.maxTurns),
							"--max-output",
							String(args.maxOutput),
							"--no-extensions",
							"--no-skills",
							"--no-prompt-templates",
							"--no-themes",
							prompt,
						],
						{
							timeoutMs: args.timeout * 1000,
							env: {
								...process.env,
								AG1_NON_INTERACTIVE: "1",
								AG1_CONTEXT_AUDIT_DIR: contextAuditDir,
								AG1_PROMPT_STEERING: args.steering === "off" ? "0" : "1",
							},
						},
					)
				: await runShellCommand(
						renderCommandTemplate(resolveAdapterCommandTemplate(args), {
							workspace,
							task: prompt,
							taskFile: join(fixtureDir, "TASK.md"),
							scenario: scenario.id,
							model: args.model,
							maxTurns: scenario.maxTurns ?? args.maxTurns,
							maxOutput: args.maxOutput,
							agentDir,
							metricsFile: metricsPath,
						}),
						{
							cwd: workspace,
							timeoutMs: args.timeout * 1000,
							env: {
								...process.env,
								AG1_BENCH_WORKSPACE: workspace,
								AG1_BENCH_TASK_FILE: join(fixtureDir, "TASK.md"),
								AG1_BENCH_SCENARIO: scenario.id,
								AG1_BENCH_MODEL: args.model,
								AG1_BENCH_AGENT_DIR: agentDir,
								AG1_BENCH_METRICS_FILE: metricsPath,
							},
						},
					);
		const durationMs = Date.now() - started;
		writeFileSync(join(scenarioRoot, `${args.adapter}.stdout.log`), result.stdout, "utf8");
		writeFileSync(join(scenarioRoot, `${args.adapter}.stderr.log`), result.stderr, "utf8");

		// AG1 autonomous runs use an isolated workspace (git-worktree or copy) for safety.
		// After the run, sync changes from the preserved autonomous workspace back into the
		// fixture so that verification and change detection operate on the actual edits.
		if (args.adapter === "ag1") {
			const preservedMatch = (result.stderr || "").match(/Autonomous workspace preserved at (.+)/);
			if (preservedMatch) {
				const preservedWs = preservedMatch[1].trim();
				try {
					await runCommand("rsync", ["-a", "--delete", preservedWs + "/", workspace + "/"], { cwd: workspace });
				} catch (e) {
					// non-fatal; continue with verification on whatever state is present
				}
			}
		}

		const verify = await runCommand("bash", ["-lc", scenario.verifyCommand], { cwd: workspace, timeoutMs: 30_000 });
		writeFileSync(join(scenarioRoot, "verify.stdout.log"), verify.stdout, "utf8");
		writeFileSync(join(scenarioRoot, "verify.stderr.log"), verify.stderr, "utf8");
		const sessionPath = latestSessionFile(agentDir);
		const adapterMetrics = readAdapterMetrics(metricsPath);
		const parsedSession = parseSession(sessionPath);
		const session =
			sessionLikeFromAdapterMetrics(adapterMetrics) ??
			(args.adapter === "ag1"
				? parsedSession
				: { ...parsedSession, finalAnswerDetected: Boolean(result.stdout.trim() || result.stderr.trim()) });
		const contextTelemetry = estimateContextTelemetry(contextAuditDir);
		const changed = await getChangedFiles(workspace);
		const row = {
			adapter: args.adapter,
			scenario: scenario.id,
			category: scenario.category ?? "",
			description: scenario.description ?? "",
			weight: scenario.weight ?? 1,
			status: result.code === 0 ? "ok" : result.timedOut ? "timeout" : "error",
			error_kind: result.timedOut ? "timeout" : result.code === 0 ? "" : "agent_exit",
			duration_ms: durationMs,
			exit_code: result.code,
			stdout_chars: result.stdout.length,
			stderr_chars: result.stderr.length,
			output_chars: result.stdout.length + result.stderr.length,
			first_tool: session.toolSequence[0] ?? "",
			tool_sequence: session.toolSequence.join(" -> "),
			tool_call_count: session.toolCallCount,
			tool_calls_before_final_answer: session.toolCallCount,
			final_answer_detected: String(session.finalAnswerDetected),
			session_path: sessionPath,
			workspace_path: workspace,
			verify_command: scenario.verifyCommand,
			verify_status: verify.code === 0 ? "passed" : "failed",
			verify_exit_code: verify.code,
			verify_stdout_chars: verify.stdout.length,
			verify_stderr_chars: verify.stderr.length,
			changed_files_count: changed.changed.length,
			added_files_count: changed.added.length,
			deleted_files_count: changed.deleted.length,
			changed_files: changed.changed.join(","),
			added_files: changed.added.join(","),
			deleted_files: changed.deleted.join(","),
			expected_changed_files_max: scenario.expectedChangedFilesMax ?? "",
			input_tokens: session.tokens.input,
			output_tokens: session.tokens.output,
			cache_read_tokens: session.tokens.cacheRead,
			cache_write_tokens: session.tokens.cacheWrite,
			total_tokens: session.tokens.total,
			total_cost: session.tokens.cost.toFixed(6),
			usage_turn_count: session.usageTurns.length,
			max_input_tokens: Math.max(0, ...session.usageTurns.map((turn) => turn.input)),
			avg_input_tokens: Math.round(
				session.usageTurns.reduce((sum, turn) => sum + turn.input, 0) / Math.max(1, session.usageTurns.length),
			),
			max_output_tokens: Math.max(0, ...session.usageTurns.map((turn) => turn.output)),
			avg_output_tokens: Math.round(
				session.usageTurns.reduce((sum, turn) => sum + turn.output, 0) / Math.max(1, session.usageTurns.length),
			),
			...contextTelemetry,
		};
		Object.assign(row, scoreRow(row));
		writeFileSync(join(scenarioRoot, `${args.adapter}.result.json`), `${JSON.stringify(row, null, 2)}\n`, "utf8");
		rows.push(row);
	}

	const run = {
		meta: {
			run_id: runId,
			timestamp: new Date().toISOString(),
			adapter: args.adapter,
			runtime_profile: "ag1_internal_benchmark",
			cwd: repoRoot,
			model: args.model,
			suite_id: suite.id,
			suite_name: suite.name,
			suite_description: suite.description,
			suite_version: suite.version,
			scenarios_path: args.scenarios,
			scenario_ids: selected.map((scenario) => scenario.id),
			timeout_sec: args.timeout,
			steering: args.adapter === "ag1" ? args.steering : "n/a",
			history_enabled: !args.skipHistory,
		},
		aggregate: aggregateRows(rows),
		rows,
	};
	const reports = writeReports(args.outDir, args.adapter, run);
	if (!args.skipHistory) {
		const historyDir = join(repoRoot, "benchmarks", "history");
		mkdirSync(historyDir, { recursive: true });
		writeFileSync(join(historyDir, `${runId}.json`), `${JSON.stringify(run, null, 2)}\n`, "utf8");
	}
	console.log(`benchmark_solved=${run.aggregate.verified_count}/${run.aggregate.scenario_count}`);
	console.log(`benchmark_cost_per_solved=${run.aggregate.cost_per_solved}`);
	console.log(`benchmark_tokens_per_solved=${run.aggregate.tokens_per_solved}`);
	console.log(`benchmark_deprecated_score=${run.aggregate.weighted_score}`);
	console.log(`benchmark_results=${reports.runPath}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack || error.message : String(error));
	process.exit(1);
});
