import { Text } from "@ag1/tui";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../extensions/types.js";
import { getTextOutput, invalidArgText } from "./render-utils.js";

const MAX_STEPS = 30;
const MAX_OPEN_QUESTIONS = 10;
const MAX_OPTIONS_PER_QUESTION = 8;
const MAX_STRING_CHARS = 500;

const submitPlanSchema = Type.Object({
	summary: Type.String({ description: "One short paragraph summarizing the plan" }),
	steps: Type.Optional(Type.Array(Type.String(), { description: "Implementation steps in execution order" })),
	openQuestions: Type.Optional(
		Type.Array(
			Type.Object({
				question: Type.String({ description: "A full question or decision label" }),
				options: Type.Optional(Type.Array(Type.String(), { description: "Candidate choices for this decision" })),
			}),
			{ description: "Open decisions or clarifying questions for the user" },
		),
	),
	assumptions: Type.Optional(Type.Array(Type.String(), { description: "Assumptions the plan relies on" })),
	constraints: Type.Optional(Type.Array(Type.String(), { description: "Constraints that bound the plan" })),
	risks: Type.Optional(Type.Array(Type.String(), { description: "Risks and how to mitigate them" })),
	verification: Type.Optional(Type.Array(Type.String(), { description: "How to verify the finished work" })),
});

export type SubmitPlanToolInput = Static<typeof submitPlanSchema>;

export interface SubmittedPlanQuestion {
	question: string;
	options?: string[];
}

export interface SubmittedPlan {
	summary: string;
	steps: string[];
	openQuestions: SubmittedPlanQuestion[];
	assumptions: string[];
	constraints: string[];
	risks: string[];
	verification: string[];
}

export interface SubmitPlanToolDetails {
	plan: SubmittedPlan;
}

function clampString(value: unknown): string {
	const trimmed = String(value ?? "").trim();
	return trimmed.length > MAX_STRING_CHARS ? trimmed.slice(0, MAX_STRING_CHARS) : trimmed;
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map(clampString).filter((entry) => entry.length > 0);
}

function normalizeOpenQuestions(value: unknown): SubmittedPlanQuestion[] {
	if (!Array.isArray(value)) return [];
	const questions: SubmittedPlanQuestion[] = [];
	for (const entry of value) {
		if (entry === null || typeof entry !== "object") continue;
		const question = clampString((entry as { question?: unknown }).question);
		if (!question) continue;
		const options = normalizeStringArray((entry as { options?: unknown }).options);
		questions.push(options.length > 0 ? { question, options } : { question });
	}
	return questions;
}

function errorResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

export function createSubmitPlanToolDefinition(): ToolDefinition<
	typeof submitPlanSchema,
	SubmitPlanToolDetails | undefined
> {
	return {
		name: "submit_plan",
		label: "submit_plan",
		description:
			"Submit a structured plan (or clarifying questions) in planning mode. Delivers the plan to the user for review instead of printing markdown. No side effects.",
		promptSnippet: "Submit a structured plan for user review in planning mode",
		promptGuidelines: [
			"In planning mode, call submit_plan exactly once to deliver the plan; do not print the plan as markdown text.",
			"Put implementation steps in steps, open decisions in openQuestions with inline options when choices are obvious.",
			"If foundational choices are still open, submit only summary and openQuestions without steps.",
		],
		parameters: submitPlanSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const summary = clampString(params.summary);
			const steps = normalizeStringArray(params.steps);
			const openQuestions = normalizeOpenQuestions(params.openQuestions);
			const assumptions = normalizeStringArray(params.assumptions);
			const constraints = normalizeStringArray(params.constraints);
			const risks = normalizeStringArray(params.risks);
			const verification = normalizeStringArray(params.verification);

			if (steps.length === 0 && openQuestions.length === 0) {
				return errorResult(
					"Error: plan has no steps and no open questions. Provide implementation steps, or clarifying questions if foundational choices are open.",
				);
			}
			if (steps.length > MAX_STEPS) {
				return errorResult(
					`Error: plan has ${steps.length} steps; the limit is ${MAX_STEPS}. Merge related work into fewer, coarser steps and resubmit.`,
				);
			}
			if (openQuestions.length > MAX_OPEN_QUESTIONS) {
				return errorResult(
					`Error: plan has ${openQuestions.length} open questions; the limit is ${MAX_OPEN_QUESTIONS}. Batch related decisions together and resubmit.`,
				);
			}
			const overloadedQuestion = openQuestions.find(
				(entry) => (entry.options?.length ?? 0) > MAX_OPTIONS_PER_QUESTION,
			);
			if (overloadedQuestion) {
				return errorResult(
					`Error: question "${overloadedQuestion.question}" has more than ${MAX_OPTIONS_PER_QUESTION} options. Keep only the realistic choices and resubmit.`,
				);
			}

			const plan: SubmittedPlan = {
				summary,
				steps,
				openQuestions,
				assumptions,
				constraints,
				risks,
				verification,
			};
			return {
				content: [
					{
						type: "text" as const,
						text: `Plan submitted: ${steps.length} steps, ${openQuestions.length} open questions.`,
					},
				],
				details: { plan },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			let label = theme.fg("toolTitle", theme.bold("submit_plan"));
			if (!args || typeof args.summary !== "string") {
				label += ` ${invalidArgText(theme)}`;
			} else {
				const steps = Array.isArray(args.steps) ? args.steps.length : 0;
				const questions = Array.isArray(args.openQuestions) ? args.openQuestions.length : 0;
				label += theme.fg("toolOutput", ` (${steps} steps, ${questions} open questions)`);
			}
			text.setText(label);
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = getTextOutput(result as any, context.showImages).trim();
			text.setText(theme.fg("success", output));
			return text;
		},
	};
}

/** Default submit_plan tool definition (no cwd or option dependencies). */
export const submitPlanToolDefinition = createSubmitPlanToolDefinition();
