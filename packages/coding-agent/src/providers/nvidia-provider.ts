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

const FREE_PRICING = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

const NVIDIA_MODELS: NvidiaModelEntry[] = [
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
		id: "nvidia/llama-3.1-nemotron-70b-instruct",
		name: "Llama 3.1 Nemotron 70B Instruct",
		provider: NVIDIA_PROVIDER_ID,
		contextWindow: 131_072,
		supportsVision: false,
		supportsThinking: false,
		cost: {
			input: 1.2,
			output: 1.2,
			cacheRead: 0,
			cacheWrite: 0,
		},
	},
	{
		id: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
		name: "Llama 3.3 Nemotron Super 49B v1.5",
		provider: NVIDIA_PROVIDER_ID,
		contextWindow: 131_072,
		supportsVision: false,
		supportsThinking: true,
		preserveThinking: true,
		cost: {
			input: 0.1,
			output: 0.4,
			cacheRead: 0,
			cacheWrite: 0,
		},
	},
	{
		id: "nvidia/nemotron-3-nano-30b-a3b",
		name: "Nemotron 3 Nano 30B A3B",
		provider: NVIDIA_PROVIDER_ID,
		contextWindow: 262_144,
		supportsVision: false,
		supportsThinking: true,
		preserveThinking: true,
		cost: {
			input: 0.05,
			output: 0.2,
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
	{
		id: "nvidia/nemotron-nano-12b-v2-vl",
		name: "Nemotron Nano 12B v2 VL",
		provider: NVIDIA_PROVIDER_ID,
		contextWindow: 131_072,
		supportsVision: true,
		supportsThinking: true,
		preserveThinking: true,
		cost: {
			input: 0.2,
			output: 0.6,
			cacheRead: 0,
			cacheWrite: 0,
		},
	},
	{
		id: "nvidia/nemotron-nano-9b-v2",
		name: "Nemotron Nano 9B v2",
		provider: NVIDIA_PROVIDER_ID,
		contextWindow: 131_072,
		supportsVision: false,
		supportsThinking: true,
		preserveThinking: true,
		cost: {
			input: 0.04,
			output: 0.16,
			cacheRead: 0,
			cacheWrite: 0,
		},
	},
];

export function getNvidiaModels(): NvidiaModelEntry[] {
	return NVIDIA_MODELS.map((model) => ({ ...model, cost: { ...model.cost } }));
}

export function createNvidiaModelEntry(id: string): NvidiaModelEntry {
	const known = NVIDIA_MODELS.find((model) => model.id === id);
	if (known) return { ...known, cost: { ...known.cost } };
	const normalized = id.replace(/^nvidia\//, "").replace(/[-_:]+/g, " ");
	return {
		id,
		name: normalized.replace(/\b\w/g, (char) => char.toUpperCase()),
		provider: NVIDIA_PROVIDER_ID,
		contextWindow: 128_000,
		supportsVision: /\bvl\b|vision/i.test(id),
		supportsThinking: /nemotron|reason/i.test(id),
		preserveThinking: /nemotron|reason/i.test(id),
		cost: FREE_PRICING,
	};
}
