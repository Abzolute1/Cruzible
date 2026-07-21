import { keyText } from "./components/keybinding-hints.js";
import { theme } from "./theme/theme.js";

export type WorkingVerbContext =
	| "read_file"
	| "write_file"
	| "edit_file"
	| "bash"
	| "search"
	| "thinking"
	| "list_dir"
	| "grep_search"
	| "web_fetch"
	| "git"
	| "install"
	| "compile"
	| "test"
	| "default";

export type WorkingVerbPhase = "thinking" | "research" | "explore" | "editing" | "building" | "testing" | "executing";

export const verbsByContext: Record<WorkingVerbContext, string[]> = {
	read_file: [
		"Perusing",
		"Skimming",
		"Rifling",
		"Leafing",
		"Squinting at",
		"Sifting through",
		"Rummaging through",
		"Peering into",
		"Dissecting",
		"Pawing through",
		"Combing over",
		"Unpacking",
		"Excavating",
		"Spelunking through",
		"Untangling",
		"Deciphering",
		"Absorbing",
		"Ingesting",
		"Devouring",
		"Sniffing through",
		"Auditing",
		"Cataloguing",
		"Cross-referencing",
		"Trawling through",
		"Chewing on",
	],
	write_file: [
		"Scrawling",
		"Drafting",
		"Etching",
		"Chiseling",
		"Hammering out",
		"Scratching down",
		"Inscribing",
		"Forging",
		"Minting",
		"Weaving",
		"Knitting together",
		"Assembling",
		"Constructing",
		"Laying down",
		"Spinning up",
		"Manifesting",
		"Baking in",
		"Pouring out",
		"Rendering",
		"Casting",
		"Pressing",
		"Stamping out",
		"Sculpting",
		"Composing",
		"Authoring",
		"Conjuring",
		"Whittling",
	],
	edit_file: [
		"Patching",
		"Stitching",
		"Tweaking",
		"Fiddling",
		"Reshaping",
		"Kneading",
		"Sanding down",
		"Buffing",
		"Nipping and tucking",
		"Wrangling",
		"Massaging",
		"Prodding",
		"Poking at",
		"Finessing",
		"Doctoring",
		"Mending",
		"Reworking",
		"Tinkering",
		"Overhauling",
		"Retrofitting",
		"Splicing",
		"Grafting",
		"Pruning",
		"Tidying",
		"Reshuffling",
		"Coaxing",
		"Nudging into shape",
		"Rejigging",
	],
	bash: [
		"Yanking the lever",
		"Pulling the trigger",
		"Firing off",
		"Detonating",
		"Unleashing",
		"Cranking",
		"Launching",
		"Flooring it",
		"Pulling the pin",
		"Letting rip",
		"Kicking off",
		"Triggering",
		"Igniting",
		"Greenlighting",
		"Sending it",
		"Dropping the hammer",
		"Punching it",
		"Flipping the switch",
		"Booting up",
		"Blasting off",
		"Engaging",
		"Winding up",
		"Pulling the cord",
		"Dropping it",
		"Throwing the switch",
		"Punching in",
		"Deploying",
		"Riding it out",
	],
	search: [
		"Fossicking",
		"Trawling",
		"Sieving",
		"Hunting",
		"Sniffing around",
		"Dredging",
		"Combing through",
		"Ferreting out",
		"Rooting around",
		"Prospecting",
		"Casting about",
		"Casting a wide net",
		"Nosing around",
		"Digging up",
		"Unearthing",
		"Sweeping for",
		"Casing",
		"Tracking down",
		"Running down",
		"Chasing",
		"Triangulating",
		"Zeroing in",
		"Homing in on",
		"Closing in on",
		"Beating the bushes",
		"Poking around",
		"Scoping out",
		"Staking out",
		"Tracing",
	],
	thinking: [
		"Noodling",
		"Mulling",
		"Cogitating",
		"Scheming",
		"Reckoning",
		"Triangulating",
		"Stewing on",
		"Deliberating",
		"Strategising",
		"Marinating on",
		"Chewing the cud",
		"Sitting with",
		"Wrestling with",
		"Turning over",
		"Spinning the wheels on",
		"Untangling",
		"Connecting dots",
		"Wading through",
		"Mapping out",
		"Charting",
		"Brainstorming",
		"Hypothesising",
		"Extrapolating",
		"Reverse-engineering",
		"Debugging mentally",
		"Working backwards from",
		"Simulating",
		"Modelling",
		"Pressure-testing",
		"Gut-checking",
	],
	list_dir: [
		"Surveying",
		"Taking stock of",
		"Inventorying",
		"Casing the joint",
		"Mapping out",
		"Cataloguing",
		"Scoping",
		"Scouting",
		"Poking around in",
		"Canvassing",
		"Reconnoitering",
		"Getting the lay of",
		"Sweeping",
		"Taking the census of",
		"Walking the floor of",
		"Casing",
	],
	grep_search: [
		"Needling through the haystack",
		"Pattern-matching",
		"Fishing for",
		"Sieving for",
		"Filtering down",
		"Hunting for traces of",
		"Sniffing for",
		"Listening for",
		"Tuning into",
		"Homing in on",
		"Netting",
		"Trapping",
		"Casting for",
		"Baiting for",
		"Luring out",
	],
	web_fetch: [
		"Pulling from the ether",
		"Reaching out to",
		"Poking",
		"Knocking on",
		"Interrogating",
		"Querying",
		"Dialing up",
		"Fetching from the void",
		"Summoning",
		"Coaxing out of",
		"Extracting from",
		"Harvesting from",
		"Leeching from",
		"Siphoning",
		"Tapping into",
		"Piping in from",
	],
	git: [
		"Spelunking the history",
		"Digging through commits",
		"Blame-gaming",
		"Bisecting",
		"Rewinding",
		"Cherry-picking",
		"Rebasing reality",
		"Untangling the graph",
		"Diffing",
		"Stashing",
		"Resurrecting",
		"Archaeology-ing",
		"Dusting off",
		"Exhuming",
	],
	install: [
		"Bootstrapping",
		"Wiring up",
		"Plumbing in",
		"Bolting on",
		"Slotting in",
		"Plugging in",
		"Grafting on",
		"Stitching in",
		"Snapping in",
		"Latching on",
		"Hauling in",
		"Materializing",
		"Conjuring",
		"Summoning",
		"Provisioning",
		"Dropping in",
	],
	compile: [
		"Baking",
		"Forging",
		"Smelting",
		"Casting",
		"Tempering",
		"Quenching",
		"Vulcanizing",
		"Fusing",
		"Crystallizing",
		"Hardening",
		"Solidifying",
		"Setting",
		"Rendering",
		"Distilling",
		"Pressing",
	],
	test: [
		"Prodding",
		"Poking",
		"Stress-testing",
		"Kicking the tyres on",
		"Putting through its paces",
		"Running the gauntlet",
		"Squeezing",
		"Interrogating",
		"Hazing",
		"Sparring with",
		"Probing",
		"Benchmarking",
		"Challenging",
		"Baiting",
		"Hammering on",
	],
	default: [
		"Vibing",
		"Doing the thing",
		"Crunching",
		"Winging it",
		"Improvising",
		"Figuring it out",
		"Making it up as I go",
		"Vibes-based development",
		"Going with my gut",
		"Cooking",
		"Letting it marinate",
		"Trusting the process",
		"Manifesting",
		"Sending it",
		"Yoloing",
		"Going for it",
	],
};

export interface WorkingActivityDescriptor {
	context: WorkingVerbContext;
	phase: WorkingVerbPhase;
	verb: string;
	target?: string;
	tone: WorkingVerbTone;
}

export type WorkingVerbTone = "accent" | "success" | "bashMode";

export interface WorkingActivityOptions {
	toolName?: string;
	args?: Record<string, unknown>;
	command?: string;
	promptText?: string;
}

export function pickVerb(context: string | undefined, seed = context ?? "default"): string {
	const normalizedContext = isWorkingVerbContext(context) ? context : "default";
	const pool = verbsByContext[normalizedContext] ?? verbsByContext.default;
	return pool[stableHash(seed) % pool.length];
}

export function describeWorkingActivity(options: WorkingActivityOptions): WorkingActivityDescriptor {
	const context: WorkingVerbContext = classifyWorkingContext(options);
	const phase = mapContextToPhase(context);
	const seed = buildPhaseSeed(phase, options);
	return {
		context,
		phase,
		verb: pickVerb(getPhasePoolContext(phase), seed),
		target: buildTarget(context, options),
		tone: getWorkingVerbTone(phase),
	};
}

export function classifyWorkingPhase(options: WorkingActivityOptions): WorkingVerbPhase {
	return mapContextToPhase(classifyWorkingContext(options));
}

export function describeWorkingPhaseActivity(
	phase: WorkingVerbPhase,
	options: WorkingActivityOptions,
	seedHint?: string,
): WorkingActivityDescriptor {
	const context: WorkingVerbContext = classifyWorkingContext(options);
	return {
		context,
		phase,
		verb: pickVerb(getPhasePoolContext(phase), buildPhaseSeed(phase, options, seedHint)),
		target: buildTarget(context, options),
		tone: getWorkingVerbTone(phase),
	};
}

export function formatWorkingActivityText(options: WorkingActivityOptions): string {
	const activity = describeWorkingActivity(options);
	return activity.target ? `${activity.verb} ${activity.target}` : activity.verb;
}

function buildPhaseSeed(phase: WorkingVerbPhase, options: WorkingActivityOptions, seedHint?: string): string {
	return [phase, seedHint ?? options.promptText ?? ""].join("|");
}

function stableHash(input: string): number {
	let hash = 0;
	for (let i = 0; i < input.length; i++) {
		hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
	}
	return hash;
}

function isWorkingVerbContext(value: string | undefined): value is WorkingVerbContext {
	return value !== undefined && value in verbsByContext;
}

function classifyWorkingContext(options: WorkingActivityOptions): WorkingVerbContext {
	const toolName = options.toolName;
	switch (toolName) {
		case "read":
			return "read_file";
		case "write":
			return "write_file";
		case "edit":
		case "str_replace_editor":
		case "apply_patch":
			return "edit_file";
		case "webFetch":
			return "web_fetch";
		case "webSearch":
			return "search";
		case "bash":
			return classifyBashContext(options.command ?? getStringArg(options.args, "command"));
		case undefined:
			return options.promptText ? "thinking" : "default";
		default:
			return "default";
	}
}

function buildTarget(context: WorkingVerbContext, options: WorkingActivityOptions): string | undefined {
	switch (context) {
		case "read_file":
		case "write_file":
		case "edit_file":
			return truncateText(getStringArg(options.args, "path", "file_path") ?? "that file", 72);
		case "web_fetch":
			return truncateText(formatUrlTarget(getStringArg(options.args, "url")), 72);
		case "search":
			return truncateText(getStringArg(options.args, "query") ?? "that query", 72);
		case "thinking":
			return undefined;
		case "list_dir":
			return truncateText(extractBashTarget(options.command, options.args) ?? "the workspace", 72);
		case "grep_search":
			return truncateText(
				extractSearchNeedle(options.command ?? getStringArg(options.args, "command")) ??
					extractBashTarget(options.command, options.args) ??
					"the codebase",
				72,
			);
		case "git":
		case "install":
		case "compile":
		case "test":
		case "bash":
			return truncateText(
				extractBashTarget(options.command, options.args) ?? normalizeCommand(options.command) ?? "the command",
				72,
			);
		default:
			return undefined;
	}
}

function getWorkingVerbTone(phase: WorkingVerbPhase): WorkingVerbTone {
	switch (phase) {
		case "editing":
		case "building":
		case "testing":
			return "success";
		case "executing":
			return "bashMode";
		default:
			return "accent";
	}
}

function mapContextToPhase(context: WorkingVerbContext): WorkingVerbPhase {
	switch (context) {
		case "thinking":
			return "thinking";
		case "search":
		case "web_fetch":
			return "research";
		case "read_file":
		case "list_dir":
		case "grep_search":
		case "git":
			return "explore";
		case "write_file":
		case "edit_file":
			return "editing";
		case "install":
		case "compile":
			return "building";
		case "test":
			return "testing";
		default:
			return "executing";
	}
}

function getPhasePoolContext(phase: WorkingVerbPhase): WorkingVerbContext {
	switch (phase) {
		case "thinking":
			return "thinking";
		case "research":
			return "search";
		case "explore":
			return "read_file";
		case "editing":
			return "edit_file";
		case "building":
			return "compile";
		case "testing":
			return "test";
		default:
			return "bash";
	}
}

function classifyBashContext(command: string | undefined): WorkingVerbContext {
	const normalized = normalizeCommand(command);
	if (!normalized) return "bash";
	const primary = getPrimaryShellCommand(normalized);
	const lower = normalized.toLowerCase();

	if (["ls", "dir", "tree", "find", "fd", "exa", "eza"].includes(primary)) return "list_dir";
	if (["rg", "grep", "ag", "ack"].includes(primary)) return "grep_search";
	if (primary === "git") return "git";
	if (looksLikeTestCommand(lower, primary)) return "test";
	if (looksLikeCompileCommand(lower, primary)) return "compile";
	if (looksLikeInstallCommand(lower, primary)) return "install";
	return "bash";
}

function looksLikeTestCommand(lower: string, primary: string): boolean {
	return (
		["pytest", "vitest", "jest", "phpunit", "rspec", "ctest"].includes(primary) ||
		lower.startsWith("go test") ||
		lower.startsWith("cargo test") ||
		lower.startsWith("npm test") ||
		lower.startsWith("pnpm test") ||
		lower.startsWith("yarn test") ||
		lower.startsWith("bun test") ||
		lower.includes(" npm run test") ||
		lower.includes(" pnpm run test") ||
		lower.includes(" yarn run test") ||
		lower.includes(" bun run test")
	);
}

function looksLikeCompileCommand(lower: string, primary: string): boolean {
	return (
		["tsc", "make", "cmake", "webpack", "vite", "rollup"].includes(primary) ||
		lower.startsWith("cargo build") ||
		lower.startsWith("go build") ||
		lower.startsWith("npm run build") ||
		lower.startsWith("pnpm build") ||
		lower.startsWith("pnpm run build") ||
		lower.startsWith("yarn build") ||
		lower.startsWith("yarn run build") ||
		lower.startsWith("bun build") ||
		lower.startsWith("bun run build")
	);
}

function looksLikeInstallCommand(lower: string, primary: string): boolean {
	return (
		primary === "pip" ||
		primary === "uv" ||
		lower.startsWith("npm install") ||
		lower.startsWith("npm add") ||
		lower.startsWith("pnpm install") ||
		lower.startsWith("pnpm add") ||
		lower.startsWith("yarn add") ||
		lower.startsWith("yarn install") ||
		lower.startsWith("bun add") ||
		lower.startsWith("bun install") ||
		lower.startsWith("cargo add") ||
		lower.startsWith("cargo install")
	);
}

function getPrimaryShellCommand(command: string): string {
	const segments = command.split(/\s*(?:&&|\|\||;|\|)\s*/);
	for (const segment of segments) {
		const tokens = segment.trim().split(/\s+/).filter(Boolean);
		if (tokens.length === 0) continue;
		let index = 0;
		while (index < tokens.length && /^(?:sudo|env)$/.test(tokens[index].toLowerCase())) {
			index++;
		}
		while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index])) {
			index++;
		}
		if (tokens[index]?.toLowerCase() === "cd") {
			continue;
		}
		return tokens[index]?.toLowerCase() ?? "bash";
	}
	return "bash";
}

function extractBashTarget(command: string | undefined, args?: Record<string, unknown>): string | undefined {
	const normalized = normalizeCommand(command ?? getStringArg(args, "command"));
	if (!normalized) return undefined;
	const primary = getPrimaryShellCommand(normalized);
	const tokens = normalized.split(/\s+/).filter(Boolean);

	if (["ls", "dir", "tree", "find", "fd", "exa", "eza"].includes(primary)) {
		const pathToken = [...tokens]
			.reverse()
			.find((token) => !token.startsWith("-") && !isOperatorToken(token) && token !== primary);
		return pathToken ?? "the workspace";
	}

	if (primary === "git") {
		return normalized;
	}

	return normalized;
}

function extractSearchNeedle(command: string | undefined): string | undefined {
	const normalized = normalizeCommand(command);
	if (!normalized) return undefined;
	const quoted = normalized.match(/["']([^"']{2,80})["']/);
	if (quoted) return quoted[1];
	const parts = normalized.split(/\s+/).filter(Boolean);
	const primary = getPrimaryShellCommand(normalized);
	const firstNonFlag = parts.find((part) => part !== primary && !part.startsWith("-") && !isOperatorToken(part));
	return firstNonFlag;
}

function formatUrlTarget(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		const parsed = new URL(url);
		return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
	} catch {
		return url;
	}
}

function getStringArg(args: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
	if (!args) return undefined;
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

function normalizeCommand(command: string | undefined): string | undefined {
	if (!command) return undefined;
	const normalized = command.replace(/\s+/g, " ").trim();
	return normalized || undefined;
}

function truncateText(text: string | undefined, maxLength: number): string | undefined {
	if (!text) return undefined;
	if (text.length <= maxLength) return text;
	return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function isOperatorToken(token: string): boolean {
	return ["&&", "||", "|", ";"].includes(token);
}

// ============================================================================
// Working Verb Animation Controller (extracted from InteractiveMode)
// ============================================================================

export interface WorkingVerbState {
	phase: WorkingVerbPhase;
	verb: string;
	tone: WorkingVerbTone;
	target?: string;
	interruptible: boolean;
}

export interface WorkingVerbAnimatorDeps {
	isAutonomous(): boolean;
	setMessage(message: string): void;
	requestRender(): void;
}

export class WorkingVerbAnimator {
	private frame = 0;
	private timer: NodeJS.Timeout | undefined = undefined;
	private state: WorkingVerbState | undefined = undefined;
	private managedEnabled = false;

	constructor(private readonly deps: WorkingVerbAnimatorDeps) {}

	setState(next: WorkingVerbState | undefined, managedEnabled: boolean): void {
		this.state = next;
		this.managedEnabled = managedEnabled;
	}

	getState(): WorkingVerbState | undefined {
		return this.state;
	}

	isManagedEnabled(): boolean {
		return this.managedEnabled;
	}

	buildMessage(_lastSubmittedPromptText?: string): string {
		if (!this.state) {
			// Fallback simple activity (caller can enhance)
			const verb = "Working";
			return theme.bold(theme.fg("accent", verb));
		}

		const verb = this.renderShimmeringVerb(this.state.verb, this.state.tone);
		const detail = this.state.target ? theme.fg("muted", ` ${this.state.target}`) : "";
		const helper = this.state.interruptible ? theme.fg("dim", ` (${keyText("app.interrupt")} to interrupt)`) : "";
		return `${verb}${detail}${helper}`;
	}

	startAnimation(): void {
		if (this.timer || this.deps.isAutonomous()) return;
		this.timer = setInterval(() => {
			if (!this.state || !this.managedEnabled) {
				return;
			}
			this.frame = (this.frame + 1) % 64;
			this.deps.setMessage(this.buildMessage());
			this.deps.requestRender();
		}, 140);
	}

	stopAnimation(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.frame = 0;
	}

	private renderShimmeringVerb(verb: string, tone: WorkingVerbTone): string {
		if (this.deps.isAutonomous()) {
			return theme.bold(theme.fg(tone, verb));
		}
		const chars = [...verb];
		if (chars.length === 0) return theme.bold(theme.fg(tone, verb));
		const pulseWidth = Math.max(2, Math.min(4, Math.ceil(chars.length / 4)));
		const cycle = chars.length + pulseWidth;
		const head = this.frame % cycle;
		const tailStart = head - pulseWidth;
		return chars
			.map((char, index) => {
				const inPulse = index >= tailStart && index < head;
				if (inPulse && char.trim().length > 0) {
					return theme.bold(theme.fg(this.getShimmerTone(tone), char));
				}
				return theme.bold(theme.fg(tone, char));
			})
			.join("");
	}

	private getShimmerTone(tone: WorkingVerbTone): "accentShimmer" | "successShimmer" | "bashModeShimmer" {
		switch (tone) {
			case "accent":
				return "accentShimmer";
			case "success":
				return "successShimmer";
			default:
				return "bashModeShimmer";
		}
	}
}
