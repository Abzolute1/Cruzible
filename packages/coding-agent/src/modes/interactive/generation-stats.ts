/**
 * Live generation stats for the interactive loader: phase, estimated tokens, rolling
 * rate, elapsed time, and — the actual point — a silence counter that answers
 * "did it hang?" before the stream stall watchdog (AG1_STREAM_STALL_TIMEOUT_MS) fires.
 *
 * Token counts mid-stream are estimates (chars/4); the official usage number
 * replaces the estimate when message_end arrives with real usage.
 */

export type GenerationPhase = "thinking" | "writing" | "tool_args" | "tool_run" | "waiting";

export interface GenerationStatsLine {
	text: string;
	tone: "normal" | "warn" | "alert";
}

/** Minimal structural event shape — the interactive-mode event union is cast to this. */
export type GenerationStatsEvent =
	| { type: "agent_start" }
	| { type: "agent_end" }
	| {
			type: "message_start" | "message_update" | "message_end";
			message: { role?: string; content?: unknown; usage?: { totalTokens?: number } };
	  }
	| { type: "tool_execution_start"; toolName?: string }
	| { type: "tool_execution_end" };

const SILENCE_NOTICE_S = 15;
const SILENCE_WARN_S = 60;
const SILENCE_ALERT_S = 300;
const RATE_WINDOW_MS = 10_000;

function formatCount(n: number): string {
	return n.toLocaleString("en-US");
}

function formatElapsed(totalSeconds: number): string {
	const s = Math.max(0, Math.floor(totalSeconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
	return `${m}:${String(sec).padStart(2, "0")}`;
}

function contentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const b = block as Record<string, unknown>;
		if (typeof b.text === "string") total += b.text.length;
		else if (typeof b.thinking === "string") total += b.thinking.length;
		else if (b.type === "toolCall" && b.arguments !== undefined) {
			try {
				total += JSON.stringify(b.arguments)?.length ?? 0;
			} catch {
				// ignore unserializable partial arguments
			}
		}
	}
	return total;
}

export class GenerationStatsTracker {
	private turnStartedAt = 0;
	private lastEventAt = 0;
	private phase: GenerationPhase = "waiting";
	private toolName = "";
	private totalChars = 0;
	private samples: Array<{ t: number; chars: number }> = [];
	private officialTokens: number | undefined;

	reset(): void {
		this.turnStartedAt = 0;
		this.lastEventAt = 0;
		this.phase = "waiting";
		this.toolName = "";
		this.totalChars = 0;
		this.samples = [];
		this.officialTokens = undefined;
	}

	handleEvent(event: GenerationStatsEvent, now = Date.now()): void {
		switch (event.type) {
			case "agent_start":
				this.reset();
				break;
			case "agent_end":
				break;
			case "message_start":
				if (event.message.role !== "assistant") break;
				if (!this.turnStartedAt) this.turnStartedAt = now;
				this.lastEventAt = now;
				break;
			case "message_update": {
				if (event.message.role !== "assistant") break;
				if (!this.turnStartedAt) this.turnStartedAt = now;
				const chars = contentChars(event.message.content);
				if (chars > this.totalChars) {
					this.samples.push({ t: now, chars });
					if (this.samples.length > 200) this.samples.splice(0, this.samples.length - 200);
					this.totalChars = chars;
				}
				const content = event.message.content;
				const lastBlock = Array.isArray(content) ? content[content.length - 1] : undefined;
				const blockType =
					typeof lastBlock === "object" && lastBlock !== null ? (lastBlock as { type?: string }).type : undefined;
				if (blockType === "thinking") this.phase = "thinking";
				else if (blockType === "toolCall") this.phase = "tool_args";
				else this.phase = "writing";
				this.lastEventAt = now;
				break;
			}
			case "message_end":
				if (event.message.role !== "assistant") break;
				if (event.message.usage?.totalTokens) this.officialTokens = event.message.usage.totalTokens;
				this.phase = "waiting";
				this.lastEventAt = now;
				break;
			case "tool_execution_start":
				this.phase = "tool_run";
				this.toolName = event.toolName ?? "tool";
				this.lastEventAt = now;
				break;
			case "tool_execution_end":
				this.phase = "waiting";
				this.lastEventAt = now;
				break;
		}
	}

	/** Record the official usage once message_end carries it, replacing the estimate. */
	private currentTokens(): number {
		return this.officialTokens ?? Math.round(this.totalChars / 4);
	}

	private ratePerSecond(now: number): number {
		const cutoff = now - RATE_WINDOW_MS;
		let oldest: { t: number; chars: number } | undefined;
		for (const sample of this.samples) {
			if (sample.t >= cutoff) {
				oldest = sample;
				break;
			}
		}
		if (!oldest || this.samples.length < 2) return 0;
		const dt = (now - oldest.t) / 1000;
		if (dt < 1) return 0;
		return (this.totalChars - oldest.chars) / 4 / dt;
	}

	private phaseLabel(): string {
		switch (this.phase) {
			case "thinking":
				return "Thinking";
			case "writing":
				return "Writing";
			case "tool_args":
				return "Tool args";
			case "tool_run":
				return `Running ${this.toolName}`;
			case "waiting":
				return "Waiting";
		}
	}

	statsLine(now = Date.now()): GenerationStatsLine | undefined {
		if (!this.turnStartedAt) return undefined;
		const tokens = this.currentTokens();
		const elapsedS = Math.floor((now - this.turnStartedAt) / 1000);
		const silenceS = this.lastEventAt ? Math.floor((now - this.lastEventAt) / 1000) : 0;
		const label = this.phaseLabel();

		if (silenceS >= SILENCE_NOTICE_S && this.phase !== "tool_run") {
			const tone = silenceS >= SILENCE_ALERT_S ? "alert" : silenceS >= SILENCE_WARN_S ? "warn" : "normal";
			return {
				text: `${label}… ~${formatCount(tokens)} tok · silent ${silenceS}s · ${formatElapsed(elapsedS)}`,
				tone,
			};
		}
		const rate = this.phase === "tool_run" ? 0 : this.ratePerSecond(now);
		const rateText = this.phase === "tool_run" ? "" : ` · ${Math.max(0, rate).toFixed(0)} tok/s`;
		return { text: `${label}… ~${formatCount(tokens)} tok${rateText} · ${formatElapsed(elapsedS)}`, tone: "normal" };
	}
}
