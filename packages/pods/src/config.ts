import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Config, Pod } from "./types.js";

// Get config directory from env or use default
const getConfigDir = (): string => {
	const configDir = process.env.AG1_CONFIG_DIR || join(homedir(), ".ag1");
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true });
	}
	return configDir;
};

const getConfigPath = (): string => {
	return join(getConfigDir(), "pods.json");
};

export const loadConfig = (): Config => {
	const configPath = getConfigPath();
	if (!existsSync(configPath)) {
		// Return empty config if file doesn't exist
		return { pods: {} };
	}
	try {
		const data = readFileSync(configPath, "utf-8");
		return JSON.parse(data);
	} catch (e) {
		// Back up the corrupt file instead of silently overwriting it on next save
		const backupPath = `${configPath}.corrupt-${Date.now()}`;
		try {
			copyFileSync(configPath, backupPath);
		} catch {}
		throw new Error(`Error reading config: ${e}. Corrupt file backed up to ${backupPath}`);
	}
};

export const saveConfig = (config: Config): void => {
	const configPath = getConfigPath();
	const tmpPath = `${configPath}.tmp`;
	try {
		// Write temp + rename so a crash mid-write can't corrupt pods.json
		writeFileSync(tmpPath, JSON.stringify(config, null, 2));
		renameSync(tmpPath, configPath);
	} catch (e) {
		console.error(`Error saving config: ${e}`);
		process.exit(1);
	}
};

export const getActivePod = (): { name: string; pod: Pod } | null => {
	const config = loadConfig();
	if (!config.active || !config.pods[config.active]) {
		return null;
	}
	return { name: config.active, pod: config.pods[config.active] };
};

export const addPod = (name: string, pod: Pod): void => {
	const config = loadConfig();
	config.pods[name] = pod;
	// If no active pod, make this one active
	if (!config.active) {
		config.active = name;
	}
	saveConfig(config);
};

export const removePod = (name: string): void => {
	const config = loadConfig();
	delete config.pods[name];
	// If this was the active pod, clear active
	if (config.active === name) {
		config.active = undefined;
	}
	saveConfig(config);
};

export const setActivePod = (name: string): void => {
	const config = loadConfig();
	if (!config.pods[name]) {
		console.error(`Pod '${name}' not found`);
		process.exit(1);
	}
	config.active = name;
	saveConfig(config);
};
