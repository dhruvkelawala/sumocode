import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface SumoCodeConfig {
	readonly primaryAgentName: string;
	readonly themeName?: string;
}

interface ParsedSumoCodeConfig {
	readonly primaryAgentName?: string;
	readonly themeName?: string;
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
	readonly env?: NodeJS.ProcessEnv;
	readonly readFile?: (path: string) => string | undefined;
}

export interface SaveSumoCodeConfigOptions {
	readonly homeDir?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly readFile?: (path: string) => string | undefined;
	readonly writeFile?: (path: string, content: string) => void;
}

export const DEFAULT_SUMOCODE_CONFIG: SumoCodeConfig = {
	primaryAgentName: "SUMO",
};

/**
 * Resolve the global SumoCode config path. When `PI_CODING_AGENT_DIR` is set
 * (the visual harness and other tooling use it to redirect Pi's whole agent
 * dir to an isolated temp directory), the config lives directly under that
 * directory instead of under `<homeDir>/.pi/agent` — mirroring how
 * `resolvePiAgentDir` in sidebar.ts / shell-adapter.ts treats the env var as
 * a full replacement for `.pi/agent`, not just `.pi`. Without this, harness
 * captures that isolate `PI_CODING_AGENT_DIR` still read the developer's real
 * `~/.pi/agent/sumocode.json` (and its `themeName`), defeating the isolation.
 */
export function resolveGlobalSumoCodeConfigPath(homeDir = homedir(), env: NodeJS.ProcessEnv = process.env): string {
	const piAgentDir = env.PI_CODING_AGENT_DIR;
	if (piAgentDir) return join(resolve(piAgentDir), "sumocode.json");
	return join(resolve(homeDir), ".pi", "agent", "sumocode.json");
}

export function resolveSumoCodeConfigCandidates(options: Pick<LoadSumoCodeConfigOptions, "cwd" | "homeDir" | "env"> = {}): SumoCodeConfigCandidate[] {
	const cwd = resolve(options.cwd ?? process.cwd());
	const homeDir = resolve(options.homeDir ?? homedir());
	const env = options.env ?? process.env;
	return [
		{ kind: "project", path: join(cwd, ".sumocode.json") },
		{ kind: "project-pi", path: join(cwd, ".pi", "sumocode.json") },
		{ kind: "global", path: resolveGlobalSumoCodeConfigPath(homeDir, env) },
	];
}

export function loadSumoCodeConfig(options: LoadSumoCodeConfigOptions = {}): SumoCodeConfigLoadResult {
	const readFile = options.readFile ?? readConfigFile;
	let merged: ParsedSumoCodeConfig | undefined;
	let source: SumoCodeConfigSourceKind = "defaults";
	let path: string | undefined;
	for (const candidate of resolveSumoCodeConfigCandidates(options)) {
		let raw: string | undefined;
		try {
			raw = readFile(candidate.path);
		} catch {
			continue;
		}
		if (raw === undefined) continue;
		const config = parseSumoCodeConfig(raw);
		if (!config) continue;
		merged = mergeMissingSumoCodeConfig(merged, config);
		if (source === "defaults") {
			source = candidate.kind;
			path = candidate.path;
		}
	}
	if (!merged) return { config: DEFAULT_SUMOCODE_CONFIG, source: "defaults" };
	const config = finalizeSumoCodeConfig(merged);
	return path === undefined ? { config, source } : { config, source, path };
}

export function saveSumoCodeConfigPatch(patch: Partial<SumoCodeConfig>, options: SaveSumoCodeConfigOptions = {}): { success: true; path: string } | { success: false; error: string; path: string } {
	const path = resolveGlobalSumoCodeConfigPath(options.homeDir, options.env);
	const readFile = options.readFile ?? readConfigFile;
	const writeFile = options.writeFile ?? writeConfigFileAtomic;
	let existing: Record<string, unknown> = {};
	let raw: string | undefined;
	try {
		raw = readFile(path);
	} catch (error) {
		return { success: false, path, error: error instanceof Error ? error.message : String(error) };
	}
	if (raw !== undefined) {
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { success: false, path, error: "Existing SumoCode config is not a JSON object" };
			existing = parsed as Record<string, unknown>;
		} catch (error) {
			return { success: false, path, error: error instanceof Error ? error.message : String(error) };
		}
	}

	const next = { ...existing };
	if (patch.primaryAgentName !== undefined) next.primaryAgentName = patch.primaryAgentName;
	if (patch.themeName !== undefined) next.themeName = patch.themeName;

	try {
		writeFile(path, `${JSON.stringify(next, null, "\t")}\n`);
		return { success: true, path };
	} catch (error) {
		return { success: false, path, error: error instanceof Error ? error.message : String(error) };
	}
}

function mergeMissingSumoCodeConfig(primary: ParsedSumoCodeConfig | undefined, fallback: ParsedSumoCodeConfig): ParsedSumoCodeConfig {
	if (!primary) return fallback;
	return {
		primaryAgentName: primary.primaryAgentName ?? fallback.primaryAgentName,
		themeName: primary.themeName ?? fallback.themeName,
	};
}

function finalizeSumoCodeConfig(config: ParsedSumoCodeConfig): SumoCodeConfig {
	return {
		primaryAgentName: config.primaryAgentName ?? DEFAULT_SUMOCODE_CONFIG.primaryAgentName,
		...(config.themeName === undefined ? {} : { themeName: config.themeName }),
	};
}

function readConfigFile(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	return readFileSync(path, "utf8");
}

function writeConfigFileAtomic(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmpPath, content);
	renameSync(tmpPath, path);
}

function parseSumoCodeConfig(raw: string): ParsedSumoCodeConfig | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const record = parsed as { primaryAgentName?: unknown; themeName?: unknown };
	if (record.primaryAgentName === undefined && record.themeName === undefined) return undefined;
	if (record.primaryAgentName !== undefined && (typeof record.primaryAgentName !== "string" || record.primaryAgentName.trim().length === 0)) return undefined;
	const primaryAgentName = typeof record.primaryAgentName === "string" ? record.primaryAgentName.trim() : undefined;
	const themeName = typeof record.themeName === "string" && record.themeName.trim().length > 0 ? record.themeName.trim().toLowerCase() : undefined;
	return { ...(primaryAgentName === undefined ? {} : { primaryAgentName }), ...(themeName === undefined ? {} : { themeName }) };
}
