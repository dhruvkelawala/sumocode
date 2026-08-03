import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const LOVELY_WEB_CONFIG_FILE = "xl0-pi-lovely-web.json";
export type LovelyWebConfigScope = "user" | "workspace";
export type LovelyWebSearchProvider = "disabled" | "firecrawl" | "exa" | "tavily" | "brave";
export type LovelyWebFetchProvider = "disabled" | "firecrawl" | "exa" | "tavily";
export type LovelyWebConfigKey =
	| "webSearchProvider"
	| "webFetchProvider"
	| "webImageEnabled"
	| "webImageResize"
	| "webImageMaxSize"
	| "smartSearchEnabled"
	| "smartSearchModel"
	| "smartSearchMaxTokens"
	| "smartSearchSystemPrompt"
	| "firecrawlApiKey"
	| "exaApiKey"
	| "tavilyApiKey"
	| "braveApiKey";

export type LovelyWebConfigPatch = Record<string, unknown>;

export interface LovelyWebResolvedConfig {
	readonly webSearchProvider: LovelyWebSearchProvider;
	readonly webFetchProvider: LovelyWebFetchProvider;
	readonly webImageEnabled: boolean;
	readonly webImageResize: boolean;
	readonly webImageMaxSize: number;
	readonly smartSearchEnabled: boolean;
	readonly smartSearchModel: string;
	readonly smartSearchMaxTokens: number;
	readonly smartSearchSystemPrompt: string;
	readonly firecrawlApiKey: string;
	readonly exaApiKey: string;
	readonly tavilyApiKey: string;
	readonly braveApiKey: string;
}

export interface LovelyWebConfigState {
	readonly userPath: string;
	readonly workspacePath: string;
	readonly userPatch: LovelyWebConfigPatch;
	readonly workspacePatch: LovelyWebConfigPatch;
	readonly value: LovelyWebResolvedConfig;
}

export const LOVELY_WEB_SEARCH_PROVIDERS: readonly LovelyWebSearchProvider[] = ["disabled", "firecrawl", "exa", "tavily", "brave"];
export const LOVELY_WEB_FETCH_PROVIDERS: readonly LovelyWebFetchProvider[] = ["disabled", "firecrawl", "exa", "tavily"];
export const LOVELY_WEB_API_KEY_FIELDS = {
	firecrawl: "firecrawlApiKey",
	exa: "exaApiKey",
	tavily: "tavilyApiKey",
	brave: "braveApiKey",
} as const;

const DEFAULTS: LovelyWebResolvedConfig = {
	webSearchProvider: "firecrawl",
	webFetchProvider: "disabled",
	webImageEnabled: true,
	webImageResize: true,
	webImageMaxSize: 2000,
	smartSearchEnabled: false,
	smartSearchModel: "",
	smartSearchMaxTokens: 2000,
	smartSearchSystemPrompt: "",
	firecrawlApiKey: "",
	exaApiKey: "",
	tavilyApiKey: "",
	braveApiKey: "",
};

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function readJsonObject(path: string): LovelyWebConfigPatch {
	if (!existsSync(path)) return {};
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	if (!isObject(parsed)) throw new Error(`Invalid Lovely Web config at ${path}: expected a JSON object`);
	return { ...parsed };
}

function writeJsonObject(path: string, value: LovelyWebConfigPatch): void {
	const keys = Object.keys(value);
	if (keys.length === 0) {
		rmSync(path, { force: true });
		return;
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 1 ? value : undefined;
}

function validSearchProvider(value: unknown): LovelyWebSearchProvider | undefined {
	return typeof value === "string" && LOVELY_WEB_SEARCH_PROVIDERS.includes(value as LovelyWebSearchProvider)
		? value as LovelyWebSearchProvider
		: undefined;
}

function validFetchProvider(value: unknown): LovelyWebFetchProvider | undefined {
	return typeof value === "string" && LOVELY_WEB_FETCH_PROVIDERS.includes(value as LovelyWebFetchProvider)
		? value as LovelyWebFetchProvider
		: undefined;
}

function legacyProvider(value: unknown, allowed: readonly string[]): string | undefined {
	if (value === null) return "disabled";
	return typeof value === "string" && allowed.includes(value) ? value : undefined;
}

/**
 * Lovely Web 0.2.x switched from the original nested shape to a flat
 * pi-lovely-config schema. Some SumoCode installs still have the old keys in
 * the new filename; normalize them here so the retained host can repair the
 * config without depending on Lovely Web's private TypeScript modules.
 */
export function normalizeLovelyWebPatch(input: LovelyWebConfigPatch): LovelyWebConfigPatch {
	const patch: LovelyWebConfigPatch = { ...input };
	const webSearch = isObject(input.webSearch) ? input.webSearch : undefined;
	const searchProvider = legacyProvider(webSearch?.provider, LOVELY_WEB_SEARCH_PROVIDERS);
	if (patch.webSearchProvider === undefined && searchProvider !== undefined) patch.webSearchProvider = searchProvider;

	const webFetch = isObject(input.webFetch) ? input.webFetch : undefined;
	const fetchProvider = legacyProvider(webFetch?.provider, LOVELY_WEB_FETCH_PROVIDERS);
	if (patch.webFetchProvider === undefined && fetchProvider !== undefined) patch.webFetchProvider = fetchProvider;

	const webImage = isObject(input.webImage) ? input.webImage : undefined;
	const imageEnabled = asBoolean(webImage?.enabled);
	if (patch.webImageEnabled === undefined && imageEnabled !== undefined) patch.webImageEnabled = imageEnabled;
	const imageResize = asBoolean(webImage?.resize);
	if (patch.webImageResize === undefined && imageResize !== undefined) patch.webImageResize = imageResize;
	const imageMaxSize = asPositiveNumber(webImage?.maxSize);
	if (patch.webImageMaxSize === undefined && imageMaxSize !== undefined) patch.webImageMaxSize = imageMaxSize;

	const webApiKeys = isObject(input.webApiKeys) ? input.webApiKeys : undefined;
	for (const [provider, keyField] of Object.entries(LOVELY_WEB_API_KEY_FIELDS)) {
		const key = asString(webApiKeys?.[provider]);
		if (patch[keyField] === undefined && key) patch[keyField] = key;
	}

	delete patch.webSearch;
	delete patch.webFetch;
	delete patch.webImage;
	delete patch.webApiKeys;
	return patch;
}

export function resolveLovelyWebConfigPath(scope: LovelyWebConfigScope, cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	if (scope === "workspace") return resolve(cwd, ".pi", LOVELY_WEB_CONFIG_FILE);
	return join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), LOVELY_WEB_CONFIG_FILE);
}

export function loadLovelyWebConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): LovelyWebConfigState {
	const userPath = resolveLovelyWebConfigPath("user", cwd, env);
	const workspacePath = resolveLovelyWebConfigPath("workspace", cwd, env);
	const userPatch = normalizeLovelyWebPatch(readJsonObject(userPath));
	const workspacePatch = normalizeLovelyWebPatch(readJsonObject(workspacePath));
	return {
		userPath,
		workspacePath,
		userPatch,
		workspacePatch,
		value: resolveLovelyWebConfig(userPatch, workspacePatch),
	};
}

export function readLovelyWebPatch(scope: LovelyWebConfigScope, cwd: string, env: NodeJS.ProcessEnv = process.env): LovelyWebConfigPatch {
	return normalizeLovelyWebPatch(readJsonObject(resolveLovelyWebConfigPath(scope, cwd, env)));
}

export function writeLovelyWebPatch(scope: LovelyWebConfigScope, cwd: string, patch: LovelyWebConfigPatch, env: NodeJS.ProcessEnv = process.env): string {
	const path = resolveLovelyWebConfigPath(scope, cwd, env);
	writeJsonObject(path, normalizeLovelyWebPatch(patch));
	return path;
}

export function updateLovelyWebConfigValue(
	scope: LovelyWebConfigScope,
	cwd: string,
	key: LovelyWebConfigKey,
	value: unknown,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const patch = readLovelyWebPatch(scope, cwd, env);
	if (value === undefined || value === "") delete patch[key];
	else patch[key] = value;
	return writeLovelyWebPatch(scope, cwd, patch, env);
}

export function resolveLovelyWebConfig(userPatch: LovelyWebConfigPatch, workspacePatch: LovelyWebConfigPatch = {}): LovelyWebResolvedConfig {
	const merged = { ...DEFAULTS, ...userPatch, ...workspacePatch };
	return {
		webSearchProvider: validSearchProvider(merged.webSearchProvider) ?? DEFAULTS.webSearchProvider,
		webFetchProvider: validFetchProvider(merged.webFetchProvider) ?? DEFAULTS.webFetchProvider,
		webImageEnabled: asBoolean(merged.webImageEnabled) ?? DEFAULTS.webImageEnabled,
		webImageResize: asBoolean(merged.webImageResize) ?? DEFAULTS.webImageResize,
		webImageMaxSize: asPositiveNumber(merged.webImageMaxSize) ?? DEFAULTS.webImageMaxSize,
		smartSearchEnabled: asBoolean(merged.smartSearchEnabled) ?? DEFAULTS.smartSearchEnabled,
		smartSearchModel: asString(merged.smartSearchModel) ?? DEFAULTS.smartSearchModel,
		smartSearchMaxTokens: asPositiveNumber(merged.smartSearchMaxTokens) ?? DEFAULTS.smartSearchMaxTokens,
		smartSearchSystemPrompt: asString(merged.smartSearchSystemPrompt) ?? DEFAULTS.smartSearchSystemPrompt,
		firecrawlApiKey: asString(merged.firecrawlApiKey) ?? DEFAULTS.firecrawlApiKey,
		exaApiKey: asString(merged.exaApiKey) ?? DEFAULTS.exaApiKey,
		tavilyApiKey: asString(merged.tavilyApiKey) ?? DEFAULTS.tavilyApiKey,
		braveApiKey: asString(merged.braveApiKey) ?? DEFAULTS.braveApiKey,
	};
}

export function lovelyWebConfigPathForDisplay(path: string): string {
	const home = homedir();
	return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}
