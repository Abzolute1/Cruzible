// Auton — NVIDIA NIM Provider Configuration
// Registers NVIDIA Nemotron models via integrate.api.nvidia.com

export const NVIDIA_PROVIDER_ID = "nvidia";
export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

export interface NvidiaModelEntry {
	id: string;
	name: string;
	provider: string;
	contextWindow: number;
	supportsVision: boolean;
	supportsThinking: boolean;
	preserveThinking?: boolean;
}

export function getNvidiaModels(): NvidiaModelEntry[] {
	return [
		{
			id: "nvidia/nemotron-3-super-120b-a12b",
			name: "Nemotron 3 Super (120B)",
			provider: NVIDIA_PROVIDER_ID,
			contextWindow: 1_000_000,
			supportsVision: false,
			supportsThinking: true,
			preserveThinking: true,
		},
	];
}
