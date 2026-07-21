#!/usr/bin/env node
/**
 * eval-compare.mjs — run the same benchmark suite across multiple agent adapters
 * (ag1, opencode, codex, claude, ...) and emit one side-by-side report.
 *
 * Headline metrics are honest ones only: solved (external verifyCommand),
 * cost per solved task, tokens per solved task, wall time. The runner's old
 * heuristic "score" is deliberately not compared.
 *
 * Usage:
 *   node scripts/eval-compare.mjs --model qwen/qwen3.6-35b-a3b \
 *     [--provider local] [--adapters ag1,opencode] [--scenario <id> ...] \
 *     [--timeout 300] [--max-turns 30] [--out-dir /tmp/ag1-eval]
 *
 * Notes:
 * - External adapters are driven through command templates (see harness-benchmark-run.mjs
 *   --help). Override with AG1_BENCH_<ADAPTER>_COMMAND. Default opencode template:
 *     opencode run --dir {workspace} --model {model} {task}
 *   The opencode-side model id may differ from ag1's (e.g. provider prefix); pass
 *   --opencode-model <id> if needed. The endpoint opencode talks to must serve the
 *   same model as ag1's --provider for a fair comparison.
 * - Token/cost metrics are only available for adapters that expose them (ag1 via
 *   session files; external adapters only if they write a metrics JSON). Adapters
 *   without usage data report "n/a" — the comparison never fabricates numbers.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = join(repoRoot, "scripts", "harness-benchmark-run.mjs");

function parseArgs(argv) {
	const args = {
		model: "",
		provider: "local",
		steering: "on",
		adapters: ["ag1", "opencode"],
		scenarios: join(repoRoot, "scripts", "benchmark-scenarios-v3_5.json"),
		scenarioIds: [],
		timeout: 300,
		maxTurns: 30,
		outDir: join("/tmp", `ag1-eval-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}`),
		opencodeModel: "",
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--model") args.model = argv[++i] ?? "";
		else if (arg === "--provider") args.provider = argv[++i] ?? args.provider;
		else if (arg === "--steering") args.steering = argv[++i] ?? args.steering;
		else if (arg === "--adapters") args.adapters = (argv[++i] ?? "").split(",").filter(Boolean);
		else if (arg === "--scenarios") args.scenarios = resolve(argv[++i] ?? args.scenarios);
		else if (arg === "--scenario") args.scenarioIds.push(argv[++i] ?? "");
		else if (arg === "--timeout") args.timeout = Number(argv[++i] ?? args.timeout);
		else if (arg === "--max-turns") args.maxTurns = Number(argv[++i] ?? args.maxTurns);
		else if (arg === "--out-dir") args.outDir = resolve(argv[++i] ?? args.outDir);
		else if (arg === "--opencode-model") args.opencodeModel = argv[++i] ?? "";
		else if (arg === "--help" || arg === "-h") {
			console.log("See header comment of this script.");
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (!args.model) throw new Error("--model is required");
	return args;
}

function runRunner(argv, env, script = RUNNER) {
	return new Promise((resolvePromise) => {
		const child = spawn(process.execPath, [script, ...argv], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", (error) => resolvePromise({ code: -1, stdout, stderr: `${stderr}\n${error.message}` }));
		child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
	});
}

function loadRun(path) {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function fmtMoney(value) {
	return value == null ? "n/a" : `$${Number(value).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	mkdirSync(args.outDir, { recursive: true });
	const summaries = [];

	for (const adapter of args.adapters) {
		const adapterOut = join(args.outDir, adapter);
		mkdirSync(adapterOut, { recursive: true });
		const runnerArgs = [
			"--adapter",
			adapter,
			"--scenarios",
			args.scenarios,
			"--model",
			adapter === "opencode" && args.opencodeModel ? args.opencodeModel : args.model,
			"--timeout",
			String(args.timeout),
			"--max-turns",
			String(args.maxTurns),
			"--out-dir",
			adapterOut,
		];
		if (adapter === "ag1") runnerArgs.push("--provider", args.provider, "--steering", args.steering);
		for (const id of args.scenarioIds) runnerArgs.push("--scenario", id);

		console.log(`\n=== adapter ${adapter} (out: ${adapterOut}) ===`);
		const started = Date.now();
		const result = await runRunner(runnerArgs, process.env);
		process.stdout.write(result.stdout.split("\n").filter((l) => l.startsWith("benchmark_")).join("\n") + "\n");
		if (result.code !== 0) {
			console.error(`adapter ${adapter}: runner exited ${result.code}`);
			if (result.stderr.trim()) console.error(result.stderr.trim().split("\n").slice(-5).join("\n"));
		}

		const run = loadRun(join(adapterOut, `${adapter}.run.json`));
		const agg = run?.aggregate;
		const hasUsage = agg ? Number(agg.total_tokens || 0) > 0 || Number(agg.total_cost || 0) > 0 : false;
		const summary = {
			adapter,
			runner_exit: result.code,
			wall_ms: Date.now() - started,
			solved: agg ? `${agg.verified_count}/${agg.scenario_count}` : "n/a",
			pass_rate: agg?.pass_rate ?? null,
			total_cost: agg ? agg.total_cost : null,
			cost_per_solved: agg && hasUsage ? agg.cost_per_solved : null,
			total_tokens: agg ? agg.total_tokens : null,
			tokens_per_solved: agg && hasUsage ? agg.tokens_per_solved : null,
			avg_duration_ms: agg?.average_duration_ms ?? null,
			run_path: join(adapterOut, `${adapter}.run.json`),
		};
		// opencode doesn't emit usage through the runner; scrape its session DB instead.
		if (adapter === "opencode") {
			const usagePath = join(adapterOut, "opencode-usage.json");
			await runRunner(["--eval-dir", join(adapterOut, "opencode"), "--out", usagePath], process.env, join(repoRoot, "scripts", "opencode-usage.mjs"));
			const usage = loadRun(usagePath)?.aggregate;
			if (usage && Number(usage.total_tokens || 0) > 0) {
				summary.total_tokens = usage.total_tokens;
				summary.tokens_per_solved = usage.tokens_per_solved;
				summary.usage_source = "opencode.db";
			}
		}
		summaries.push(summary);
	}

	const md = [
		`# Eval comparison — ${new Date().toISOString()}`,
		"",
		`- Model (ag1 side): ${args.model} (provider: ${args.provider})`,
		`- Suite: ${args.scenarios}`,
		"",
		"| Adapter | Solved | Pass rate | Cost/solved | Tokens/solved | Avg duration |",
		"|---|---:|---:|---:|---:|---:|",
		...summaries.map(
			(s) =>
				`| ${s.adapter} | ${s.solved} | ${s.pass_rate == null ? "n/a" : `${s.pass_rate}%`} | ${fmtMoney(s.cost_per_solved)} | ${s.tokens_per_solved ?? "n/a"} | ${s.avg_duration_ms == null ? "n/a" : `${Math.round(s.avg_duration_ms / 1000)}s`} |`,
		),
		"",
		"Notes: solved = external verifyCommand passed. cost/tokens are n/a for adapters that don't expose usage data.",
	].join("\n");
	writeFileSync(join(args.outDir, "comparison.md"), `${md}\n`, "utf8");
	writeFileSync(join(args.outDir, "comparison.json"), `${JSON.stringify({ args: { ...args }, summaries }, null, 2)}\n`, "utf8");
	console.log(`\ncomparison_report=${join(args.outDir, "comparison.md")}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack || error.message : String(error));
	process.exit(1);
});
