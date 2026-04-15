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
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

export function getNvidiaModels(): NvidiaModelEntry[] {
	return [
		{
			id: "nvidia/llama-3.1-nemotron-ultra-253b-v1",
			name: "Llama 3.1 Nemotron Ultra (253B)",
			provider: NVIDIA_PROVIDER_ID,
			contextWindow: 131_072,
			supportsVision: false,
			supportsThinking: true,
			preserveThinking: true,
			cost: {
				input: 0.6,
				output: 1.8,
				cacheRead: 0,
				cacheWrite: 0,
			},
		},
		{
			id: "nvidia/nemotron-3-super-120b-a12b",
			name: "Nemotron 3 Super (120B)",
			provider: NVIDIA_PROVIDER_ID,
			contextWindow: 1_000_000,
			supportsVision: false,
			supportsThinking: true,
			preserveThinking: true,
			cost: {
				input: 0.2,
				output: 0.8,
				cacheRead: 0,
				cacheWrite: 0,
			},
		},
	];
}
