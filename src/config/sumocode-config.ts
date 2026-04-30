import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface SumoCodeConfig {
	readonly primaryAgentName: string;
}

export type SumoCodeConfigSourceKind = "project" | "project-pi" | "global" | "defaults";

export interface SumoCodeConfigCandidate {
	readonly kind: Exclude<SumoCodeConfigSourceKind, "defaults">;
	readonly path: string;
}

export interface SumoCodeConfigLoadResult {
	readonly config: SumoCodeConfig;
	readonly source: SumoCodeConfigSourceKind;
	readonly path?: string;
}

export interface LoadSumoCodeConfigOptions {
	readonly cwd?: string;
	readonly homeDir?: string;
	readonly readFile?: (path: string) => string | undefined;
}

export const DEFAULT_SUMOCODE_CONFIG: SumoCodeConfig = {
	primaryAgentName: "SUMO",
};

export function resolveSumoCodeConfigCandidates(options: Pick<LoadSumoCodeConfigOptions, "cwd" | "homeDir"> = {}): SumoCodeConfigCandidate[] {
	const cwd = resolve(options.cwd ?? process.cwd());
	const homeDir = resolve(options.homeDir ?? homedir());
	return [
		{ kind: "project", path: join(cwd, ".sumocode.json") },
		{ kind: "project-pi", path: join(cwd, ".pi", "sumocode.json") },
		{ kind: "global", path: join(homeDir, ".pi", "agent", "sumocode.json") },
	];
}

export function loadSumoCodeConfig(options: LoadSumoCodeConfigOptions = {}): SumoCodeConfigLoadResult {
	const readFile = options.readFile ?? readConfigFile;
	for (const candidate of resolveSumoCodeConfigCandidates(options)) {
		const raw = readFile(candidate.path);
		if (raw === undefined) continue;
		const config = parseSumoCodeConfig(raw);
		if (config) return { config, source: candidate.kind, path: candidate.path };
	}
	return { config: DEFAULT_SUMOCODE_CONFIG, source: "defaults" };
}

function readConfigFile(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	return readFileSync(path, "utf8");
}

function parseSumoCodeConfig(raw: string): SumoCodeConfig | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const primaryAgentName = (parsed as { primaryAgentName?: unknown }).primaryAgentName;
	if (typeof primaryAgentName !== "string") return undefined;
	const trimmed = primaryAgentName.trim();
	if (trimmed.length === 0) return undefined;
	return { primaryAgentName: trimmed };
}
