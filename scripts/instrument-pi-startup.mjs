#!/usr/bin/env node
// Diagnostic-only Plan 117 instrumentation. Pi is installed as generated JS, so
// the smallest way to compare its bundled Node entry with its Bun entry is to
// add identical no-op-unless-diagnostics marks to the installed artifacts.
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const piDist = dirname(realpathSync(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")));

function replaceOnce(relativePath, needle, replacement) {
	const path = join(piDist, relativePath);
	const source = readFileSync(path, "utf8");
	if (source.includes(replacement)) return;
	const count = source.split(needle).length - 1;
	if (count !== 1) throw new Error(`Pi 0.84.4 instrumentation expected one match in ${relativePath}, found ${count}`);
	writeFileSync(path, source.replace(needle, replacement));
}

replaceOnce("bun/cli.js",
	'import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";',
	`import { appendFileSync } from "node:fs";\nimport { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";\nconst startupDiagnosticsFile = process.env.SUMO_TUI_DIAG_FILE;\nglobalThis.__sumocodeStartupMark = (event, fields = {}) => {\n    if (!startupDiagnosticsFile) return;\n    try {\n        appendFileSync(startupDiagnosticsFile, JSON.stringify({ ts: Date.now(), event, pid: process.pid, ...fields }) + "\\n", { encoding: "utf8", mode: 0o600 });\n    } catch {}\n};\nglobalThis.__sumocodeStartupMark("child_entry");`);
replaceOnce("bun/cli.js",
	'await import("./register-bedrock.js");\nawait import("../cli.js");',
	'globalThis.__sumocodeStartupMark("bedrock_import_start");\nawait import("./register-bedrock.js");\nglobalThis.__sumocodeStartupMark("after_bedrock_import");\nglobalThis.__sumocodeStartupMark("cli_import_start");\nawait import("../cli.js");\nglobalThis.__sumocodeStartupMark("after_cli_import");');

replaceOnce("main.js",
	"export async function main(args, options) {\n    resetTimings();",
	'export async function main(args, options) {\n    resetTimings();\n    globalThis.__sumocodeStartupMark?.("main_enter");');
replaceOnce("core/model-runtime.js",
	"static async create(options = {}) {\n        const credentials",
	'static async create(options = {}) {\n        globalThis.__sumocodeStartupMark?.("model_runtime_create_start");\n        const credentials');
replaceOnce("core/model-runtime.js",
	"if (options.refreshOnCreate !== false) {\n                await runtime.refresh({ allowNetwork: refreshFromNetwork, signal });\n            }",
	'if (options.refreshOnCreate !== false) {\n                globalThis.__sumocodeStartupMark?.("model_refresh_1_start");\n                await runtime.refresh({ allowNetwork: refreshFromNetwork, signal });\n                globalThis.__sumocodeStartupMark?.("model_refresh_1_end");\n            }');
replaceOnce("core/model-runtime.js",
	"return runtime;\n    }\n    configureRadiusProviders()",
	'globalThis.__sumocodeStartupMark?.("model_runtime_create_end");\n        return runtime;\n    }\n    configureRadiusProviders()');

replaceOnce("core/agent-session-services.js",
	"await modelRuntime.refresh({ allowNetwork: false });\n    diagnostics.push",
	'globalThis.__sumocodeStartupMark?.("model_refresh_2_start");\n    await modelRuntime.refresh({ allowNetwork: false });\n    globalThis.__sumocodeStartupMark?.("model_refresh_2_end");\n    diagnostics.push');

replaceOnce("core/extensions/loader.js",
	"try {\n        await factory(load.api);\n        load.commit();",
	'try {\n        globalThis.__sumocodeStartupMark?.("extension_factory_start", { extensionPath });\n        await factory(load.api);\n        globalThis.__sumocodeStartupMark?.("extension_factory_end", { extensionPath });\n        load.commit();');
replaceOnce("core/extensions/loader.js",
	"try {\n        const factory = await loadExtensionModule(resolvedPath, cacheToken);\n        time(`${extensionPath} module import`, \"extensions\");",
	'try {\n        globalThis.__sumocodeStartupMark?.("extension_import_start", { extensionPath });\n        const factory = await loadExtensionModule(resolvedPath, cacheToken);\n        globalThis.__sumocodeStartupMark?.("extension_import_end", { extensionPath });\n        time(`${extensionPath} module import`, "extensions");');

replaceOnce("modes/rpc/rpc-mode.js",
	"export async function runRpcMode(runtimeHost) {\n    takeOverStdout();",
	'export async function runRpcMode(runtimeHost) {\n    globalThis.__sumocodeStartupMark?.("run_rpc_mode_enter");\n    takeOverStdout();');
replaceOnce("modes/rpc/rpc-mode.js",
	"case \"get_state\": {\n                const state =",
	'case "get_state": {\n                globalThis.__sumocodeStartupMark?.("first_get_state_received");\n                const state =');

const bundleChunkNeedle = "async function main(args,options){resetTimings();";
const bundleChunkReplacement = 'async function main(args,options){resetTimings();globalThis.__sumocodeStartupMark?.("main_enter");';
const chunkMatches = readdirSync(join(piDist, "bundle/chunks"))
	.filter((name) => name.endsWith(".js"))
	.filter((name) => {
		const source = readFileSync(join(piDist, "bundle/chunks", name), "utf8");
		return source.includes(bundleChunkNeedle) || source.includes(bundleChunkReplacement);
	});
if (chunkMatches.length !== 1) throw new Error(`Pi 0.84.4 instrumentation expected one main bundle chunk, found ${chunkMatches.length}`);
const chunk = join("bundle/chunks", chunkMatches[0]);
replaceOnce(chunk, bundleChunkNeedle, bundleChunkReplacement);
replaceOnce(chunk,
	"static async create(options={}){let credentials=",
	'static async create(options={}){globalThis.__sumocodeStartupMark?.("model_runtime_create_start");let credentials=');
replaceOnce(chunk,
	"try{options.refreshOnCreate!==!1&&await runtime.refresh({allowNetwork:refreshFromNetwork,signal})}finally{timeout&&clearTimeout(timeout)}return runtime}",
	'try{if(options.refreshOnCreate!==!1){globalThis.__sumocodeStartupMark?.("model_refresh_1_start");await runtime.refresh({allowNetwork:refreshFromNetwork,signal});globalThis.__sumocodeStartupMark?.("model_refresh_1_end")}}finally{timeout&&clearTimeout(timeout)}return globalThis.__sumocodeStartupMark?.("model_runtime_create_end"),runtime}');
replaceOnce(chunk,
	"await modelRuntime.refresh({allowNetwork:!1}),diagnostics.push",
	'globalThis.__sumocodeStartupMark?.("model_refresh_2_start"),await modelRuntime.refresh({allowNetwork:!1}),globalThis.__sumocodeStartupMark?.("model_refresh_2_end"),diagnostics.push');
replaceOnce(chunk,
	"async function initializeExtension(factory,extensionPath,resolvedPath,cwd,eventBus,runtime){let extension=createExtension(extensionPath,resolvedPath),load=createExtensionAPI(extension,runtime,cwd,eventBus);try{await factory(load.api),load.commit()}",
	'async function initializeExtension(factory,extensionPath,resolvedPath,cwd,eventBus,runtime){let extension=createExtension(extensionPath,resolvedPath),load=createExtensionAPI(extension,runtime,cwd,eventBus);try{globalThis.__sumocodeStartupMark?.("extension_factory_start",{extensionPath}),await factory(load.api),globalThis.__sumocodeStartupMark?.("extension_factory_end",{extensionPath}),load.commit()}');
replaceOnce(chunk,
	"async function loadExtension(extensionPath,cwd,eventBus,runtime,cacheToken){let resolvedPath=resolvePath(extensionPath,cwd,{normalizeUnicodeSpaces:!0});try{let factory=await loadExtensionModule(resolvedPath,cacheToken);",
	'async function loadExtension(extensionPath,cwd,eventBus,runtime,cacheToken){let resolvedPath=resolvePath(extensionPath,cwd,{normalizeUnicodeSpaces:!0});try{globalThis.__sumocodeStartupMark?.("extension_import_start",{extensionPath});let factory=await loadExtensionModule(resolvedPath,cacheToken);globalThis.__sumocodeStartupMark?.("extension_import_end",{extensionPath});');
replaceOnce(chunk,
	"async function runRpcMode(runtimeHost){takeOverStdout();",
	'async function runRpcMode(runtimeHost){globalThis.__sumocodeStartupMark?.("run_rpc_mode_enter");takeOverStdout();');
replaceOnce(chunk,
	'case"get_state":{let state2=',
	'case"get_state":{globalThis.__sumocodeStartupMark?.("first_get_state_received");let state2=');

replaceOnce("bundle/cli.js",
	"process.title=APP_NAME;",
	'globalThis.__sumocodeStartupMark?.("after_cli_import");process.title=APP_NAME;');

console.log(`[sumocode] diagnostic Pi startup marks applied under ${piDist}`);
