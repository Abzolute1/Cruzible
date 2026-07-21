import { keyText } from "./components/keybinding-hints.js";
import {
	classifyWorkingPhase,
	describeWorkingActivity,
	describeWorkingPhaseActivity,
	type WorkingVerbAnimator,
	type WorkingVerbState,
} from "./interactive-working-verbs.js";
import { theme } from "./theme/theme.js";

export interface WorkingActivityTrackerDeps {
	isAutonomous(): boolean;
	/** Visible verb state lives on the session class — handleEvent clears it directly on turn boundaries. */
	getActiveWorkingVerb(): WorkingVerbState | undefined;
	setActiveWorkingVerb(state: WorkingVerbState | undefined): void;
	/** Extracted shimmer/interrupt animator. */
	animator: WorkingVerbAnimator;
	/** Deliver to the visible loader, or queue the message until one exists (agent_start drains the queue). */
	deliverMessage(message: string): void;
}

export class WorkingActivityTracker {
	private lastSubmittedPromptText: string | undefined = undefined;

	constructor(private readonly deps: WorkingActivityTrackerDeps) {}

	rememberSubmittedPrompt(text: string): void {
		const normalized = text.trim();
		if (normalized) {
			this.lastSubmittedPromptText = normalized;
		}
	}

	setManagedWorkingActivity(
		options?: { toolName?: string; args?: Record<string, unknown>; promptText?: string },
		config: { interruptible?: boolean; resetPhase?: boolean } = {},
	): string {
		const interruptible = config.interruptible ?? true;
		const hasExplicitActivity =
			options?.toolName !== undefined || options?.args !== undefined || options?.promptText !== undefined;
		const activeWorkingVerb = this.deps.getActiveWorkingVerb();
		if (!hasExplicitActivity && activeWorkingVerb && !config.resetPhase) {
			const nextActiveWorkingVerb = {
				...activeWorkingVerb,
				interruptible,
			};
			this.deps.setActiveWorkingVerb(nextActiveWorkingVerb);
			this.deps.animator.setState(nextActiveWorkingVerb, true);
			if (!this.deps.isAutonomous()) {
				this.deps.animator.startAnimation();
			}
			const message = this.buildManagedWorkingMessage();
			this.deps.deliverMessage(message);
			return message;
		}
		const nextPhase = classifyWorkingPhase({
			toolName: options?.toolName,
			args: options?.args,
			command: typeof options?.args?.command === "string" ? options.args.command : undefined,
			promptText: options?.promptText ?? this.lastSubmittedPromptText,
		});
		const shouldSwitchPhase = config.resetPhase || !activeWorkingVerb || activeWorkingVerb.phase !== nextPhase;
		const phase = shouldSwitchPhase ? nextPhase : (activeWorkingVerb?.phase ?? nextPhase);
		const activity = describeWorkingPhaseActivity(
			phase,
			{
				toolName: options?.toolName,
				args: options?.args,
				command: typeof options?.args?.command === "string" ? options.args.command : undefined,
				promptText: options?.promptText ?? this.lastSubmittedPromptText,
			},
			this.lastSubmittedPromptText,
		);

		const nextActiveWorkingVerb = {
			phase,
			verb: shouldSwitchPhase ? activity.verb : (activeWorkingVerb?.verb ?? activity.verb),
			tone: shouldSwitchPhase ? activity.tone : (activeWorkingVerb?.tone ?? activity.tone),
			target: activity.target,
			interruptible,
		};
		this.deps.setActiveWorkingVerb(nextActiveWorkingVerb);
		this.deps.animator.setState(nextActiveWorkingVerb, true);
		if (!this.deps.isAutonomous()) {
			this.deps.animator.startAnimation();
		}
		const message = this.buildManagedWorkingMessage();
		this.deps.deliverMessage(message);
		return message;
	}

	buildManagedWorkingMessage(): string {
		// Delegate to extracted animator (keeps shimmer + interrupt hint logic in one place)
		return this.deps.animator.buildMessage(this.lastSubmittedPromptText);
	}

	formatWorkingMessage(options?: { toolName?: string; args?: Record<string, unknown>; promptText?: string }): string {
		const activity = describeWorkingActivity({
			toolName: options?.toolName,
			args: options?.args,
			command: typeof options?.args?.command === "string" ? options.args.command : undefined,
			promptText: options?.promptText ?? this.lastSubmittedPromptText,
		});
		const verb = theme.bold(theme.fg(activity.tone, activity.verb));
		const detail = activity.target ? theme.fg("muted", ` ${activity.target}`) : "";
		return `${verb}${detail}`;
	}

	getDefaultWorkingMessage(): string {
		return this.setManagedWorkingActivity(
			{
				promptText: this.lastSubmittedPromptText,
			},
			{ interruptible: false, resetPhase: true },
		);
	}

	getInterruptibleWorkingMessage(options?: {
		toolName?: string;
		args?: Record<string, unknown>;
		promptText?: string;
	}): string {
		return `${this.formatWorkingMessage(options)} (${keyText("app.interrupt")} to interrupt)`;
	}

	resetLoadingAnimationMessage(): void {
		this.setManagedWorkingActivity(undefined, { interruptible: true });
	}

	setToolAwareLoadingMessage(toolName: string, args?: Record<string, unknown>): void {
		if (this.deps.isAutonomous()) return;
		this.setManagedWorkingActivity({ toolName, args }, { interruptible: true });
	}
}
