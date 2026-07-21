export type AutonomousFinalizationStatus = "complete" | "continue";

const FINALIZATION_STATUS_PATTERN = /^\s*AG1_FINAL_STATUS:\s*(complete|continue)\s*$/im;
const FINALIZATION_CONTRACT_INSTRUCTION =
	"When the autonomous task is truly finished, end the visible response with a final line exactly `AG1_FINAL_STATUS: complete`. Do not emit that line while work, verification, or reporting is still pending.";

export function appendFinalizationContractInstruction(prompt: string): string {
	if (prompt.includes("AG1_FINAL_STATUS:")) {
		return prompt;
	}
	return `${prompt}\n\n${FINALIZATION_CONTRACT_INSTRUCTION}`;
}

export function parseFinalizationContract(text: string): AutonomousFinalizationStatus | undefined {
	const recentText = text.split("\n").slice(-8).join("\n");
	const match = recentText.match(FINALIZATION_STATUS_PATTERN);
	if (!match?.[1]) return undefined;
	return match[1] as AutonomousFinalizationStatus;
}
