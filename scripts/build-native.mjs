// Plan 117: produce the native release archive under dist/native/ (git-ignored).
//
// Layout (per plans/117-ship-native-executable.md, Target design):
//   sumocode-<version>-<platform-tag>/
//     bin/sumocode              Bun-compiled host executable
//     bin/sumocode-pi           Bun-compiled Pi child
//     theme/ assets/ export-html/ photon_rs_bg.wasm package.json   (Pi sidecars)
//     share/yoga.wasm  share/sumo-face.ans                         (host sidecars)
//     extension/sumocode-extension.bundle.mjs                      (child extension)
//     SHA256SUMS
//
// Nothing produced here is ever committed: dist/** is git-ignored (#439).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { instrumentPiStartup } from "./instrument-pi-startup.mjs";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

const BUN_PIN = readFileSync(resolve(root, ".bun-version"), "utf8").trim();
const PI_PIN = "0.85.1";
const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
// Pi 0.85.1 registers Bedrock inside bun/runtime-setup.js (0.84.4 used a
// dynamic register-bedrock.js import in bun/cli.js). The child strips only these
// three Bedrock lines: runtime-setup also owns process.title and the Bun OAuth
// flows, which the compiled child must keep.
const BEDROCK_RUNTIME_SETUP_STRIPS = [
	'import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";\n',
	'import { setBedrockProviderModule } from "@earendil-works/pi-ai/compat";\n',
	'setBedrockProviderModule(bedrockProviderModule);\n',
];

function fail(message) {
	console.error(`[sumocode] build:native: ${message}`);
	process.exit(1);
}

function platformTag(platform = process.platform, arch = process.arch) {
	const os = platform === "darwin" ? "macos" : platform;
	return `${os}-${arch}`;
}

function resolveBun() {
	const candidate = process.env.BUN_BIN ?? "bun";
	const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
	if (probe.error || probe.status !== 0) {
		fail(`bun is required (tried "${candidate}"). Set BUN_BIN or install Bun on PATH.`);
	}
	const observed = probe.stdout.trim();
	if (observed !== BUN_PIN) {
		fail(`bun ${BUN_PIN} is pinned (.bun-version) but found ${observed}. Change .bun-version deliberately or align your Bun install.`);
	}
	return candidate;
}

function run(command, args) {
	const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
	if (result.error || result.status !== 0) {
		fail(`${command} ${args.join(" ")} failed${result.status !== null ? ` with exit ${result.status}` : ""}`);
	}
}

function copyMatchingFiles(source, destination, includePattern) {
	mkdirSync(destination, { recursive: true });
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		if (!entry.isFile() || !includePattern.test(entry.name)) continue;
		copyFileSync(join(source, entry.name), join(destination, entry.name));
	}
}

/**
 * Builds an extension bundle with Pi's virtual modules as the ONLY externals
 * and guards against any other surviving bare import. Pi's extension
 * loader resolves @earendil-works/* and typebox itself; everything else must be
 * inlined or the compiled child cannot load it.
 */
async function buildExtensionBundle(entryPoint, outPath) {
	const result = await build({
		absWorkingDir: root,
		entryPoints: [entryPoint],
		outfile: outPath,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		external: ["@earendil-works/*", "typebox"],
		metafile: true,
		write: false,
		logLevel: "warning",
	});
	assertMetafileContainment(result.metafile);
	const output = result.outputFiles[0];
	// Regression guard (plan step 2.3): every bare import in the bundle must be
	// a Pi virtual module. Relative imports (./, ../, /) are inlined paths.
	const bareImports = new Set();
	const specifierPatterns = [
		/\bfrom\s*["']([^"'\n]+)["']/g,
		/\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
		/\bimport\s*["']([^"'\n]+)["']/g,
		/\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
	];
	for (const pattern of specifierPatterns) {
		for (const match of output.text.matchAll(pattern)) {
			const specifier = match[1];
			if (specifier === undefined) continue;
			if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
			bareImports.add(specifier);
		}
	}
	const offenders = [...bareImports].filter((specifier) =>
		!specifier.startsWith("@earendil-works/")
		&& specifier !== "typebox"
		// Node builtins are available inside the Bun-compiled Pi child.
		&& !specifier.startsWith("node:"),
	);
	if (offenders.length > 0) {
		fail(`extension bundle keeps non-virtual-module external imports: ${offenders.join(", ")}. ` +
			"Pi's Jiti loader only resolves @earendil-works/* and typebox inside the compiled child; add the dependency to the bundle instead.");
	}
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, output.text);
	console.log(`[sumocode] extension bundle: ${outPath} (${output.text.length} bytes, externals: ${[...bareImports].join(", ") || "none"})`);
}

export function makeNativePiBuildCopy(piPkg, buildDir, packageRoot = root, resolvePackage = resolvePackageWithNode) {
	const dependencies = validatePiBuildGraph(piPkg, packageRoot, undefined, resolvePackage);
	const manifest = JSON.parse(readFileSync(join(piPkg, "package.json"), "utf8"));
	const piVersion = manifest.version;
	if (piVersion !== PI_PIN) fail(`Bedrock-free child patch expects Pi ${PI_PIN}, found ${piVersion}`);

	rmSync(buildDir, { recursive: true, force: true });
	mkdirSync(buildDir, { recursive: true });
	cpSync(realpathSync(join(piPkg, "dist")), join(buildDir, "dist"), { recursive: true });
	copyFileSync(join(piPkg, "package.json"), join(buildDir, "package.json"));
	instrumentPiStartup(join(buildDir, "dist"));

	// Link roots rather than entries to preserve private exports and resolution.
	for (const [name, realDependency] of dependencies) {
		const target = join(buildDir, "node_modules", name);
		mkdirSync(dirname(target), { recursive: true });
		symlinkSync(realDependency, target, "dir");
	}

	// The instrumented cli.js keeps its bedrock_import marks around the (now
	// Bedrock-free) runtime-setup import; only the registration itself is removed.
	const runtimeSetupPath = join(buildDir, "dist/bun/runtime-setup.js");
	const runtimeSetupSource = readFileSync(runtimeSetupPath, "utf8");
	const bedrockFreeRuntimeSetup = BEDROCK_RUNTIME_SETUP_STRIPS.reduce((source, needle) => {
		const count = source.split(needle).length - 1;
		if (count !== 1) fail(`Pi ${PI_PIN} Bedrock patch expected one "${needle.trim()}" in bun/runtime-setup.js, found ${count}`);
		return source.replace(needle, "");
	}, runtimeSetupSource);
	unlinkSync(runtimeSetupPath);
	writeFileSync(runtimeSetupPath, bedrockFreeRuntimeSetup);
	return buildDir;
}

function resolvePackageWithNode(directory) {
	try {
		return require.resolve(directory);
	} catch (error) {
		if (error?.code === "MODULE_NOT_FOUND") return undefined;
		throw error;
	}
}

export function createBunResolver(bunBin) {
	return (specifier, from = root) => {
		const result = spawnSync(bunBin, ["--no-install", "--no-env-file", "-e",
			'try { process.stdout.write(Bun.resolveSync(process.argv[1], process.argv[2])) } catch (error) { if (["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"].includes(error?.code)) process.exit(42); throw error }',
			specifier, from,
		], { cwd: root, encoding: "utf8" });
		if (result.error) throw result.error;
		if (result.signal) throw new Error(`Bun resolver exited on signal ${result.signal}`);
		if (result.status === 42) return undefined;
		if (result.status !== 0) throw new Error(`Bun resolver failed with exit ${result.status}: ${result.stderr.trim()}`);
		return result.stdout;
	};
}

function loadablePackageDirectory(directory, resolvePackage) {
	const manifestPath = join(directory, "package.json");
	if (existsSync(manifestPath)) {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		// A package may expose only private subpaths, so its bare name is not
		// necessarily resolvable. Exports still make the nearest package decisive.
		if (manifest.exports != null) return true;
	}
	return resolvePackage(directory) !== undefined;
}

/**
 * Check package contents and installed dependency edges, not JS import expressions.
 * Pre-check: fast-fail on definite escapes and select roots to link.
 * Node and Bun can resolve differently; post-build metafile containment is the
 * authoritative escape invariant, while the injected resolver selects versions.
 */
export function validatePiBuildGraph(piPkg, packageRoot, counts = { checked: 0, linked: 0, skipped: 0 }, resolvePackage = resolvePackageWithNode) {
	const realRoot = realpathSync(packageRoot);
	const directories = new Set();
	const packages = new Map();

	function checkedPath(path, name = path) {
		const real = realpathSync(path);
		if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) {
			throw new Error(`Pi build dependency ${name} resolves outside ${packageRoot}: ${real}`);
		}
		return real;
	}

	function walk(path) {
		const real = checkedPath(path);
		if (!statSync(real).isDirectory() || directories.has(real)) return;
		directories.add(real);
		for (const entry of readdirSync(real)) {
			const child = join(real, entry);
			if (entry === "node_modules") {
				const modules = checkedPath(child);
				for (const name of readdirSync(modules)) {
					const installed = join(modules, name);
					if (name.startsWith("@")) {
						for (const scoped of readdirSync(checkedPath(installed))) visitPackage(join(installed, scoped));
					} else if (!name.startsWith(".")) visitPackage(installed);
				}
			}
			walk(child);
		}
	}

	function visitPackage(path) {
		const real = checkedPath(path);
		if (packages.has(real)) return packages.get(real);
		const dependencies = new Map();
		packages.set(real, dependencies);
		const manifestPath = join(real, "package.json");
		// Manifestless installed modules are valid; example manifests are only content.
		if (!existsSync(manifestPath)) {
			walk(real);
			return dependencies;
		}
		const manifest = JSON.parse(readFileSync(checkedPath(manifestPath), "utf8"));
		const require = createRequire(manifestPath);
		for (const name of Object.keys({ ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies })) {
			// Builtin specifiers (bare like string_decoder, or node:-prefixed) always
			// resolve to core modules: require.resolve.paths returns null for them, and
			// Node loads the builtin even when a same-named directory is installed. Skip
			// before resolving — nothing to contain, no directory to link into the copy.
			counts.checked++;
			if (isBuiltin(name)) {
				counts.skipped++;
				continue;
			}
			// Walk pnpm siblings and ancestors in search order. The first loadable
			// candidate decides; never fall back past an escape to a contained copy.
			let candidateFound = false;
			const dependency = require.resolve.paths(name)
				.map((directory) => join(directory, name))
				.find((directory) => {
					if (!existsSync(directory) || !statSync(directory).isDirectory()) return false;
					candidateFound = true;
					return loadablePackageDirectory(directory, resolvePackage);
				});
			if (!dependency) {
				if (!candidateFound && !name.startsWith("@types/")
					&& !Object.hasOwn(manifest.optionalDependencies ?? {}, name)
					&& !(manifest.peerDependenciesMeta?.[name]?.optional && !Object.hasOwn(manifest.dependencies ?? {}, name))) {
					throw new Error(`Cannot resolve Pi build dependency ${name} within ${packageRoot}`);
				}
				counts.skipped++;
				continue;
			}
			const target = checkedPath(dependency, name);
			visitPackage(target);
			dependencies.set(name, target);
			counts.linked++;
		}
		walk(real);
		return dependencies;
	}

	return visitPackage(piPkg);
}

export function assertMetafileContainment(metafile, packageRoot = root, buildDir) {
	const roots = [packageRoot, ...(buildDir ? [buildDir] : [])].map((path) => realpathSync(path));
	for (const input of Object.keys(metafile.inputs)) {
		const real = realpathSync(resolve(packageRoot, input));
		if (!roots.some((directory) => real.startsWith(`${directory}${sep}`))) {
			throw new Error(`Build input ${input} resolves outside ${packageRoot}: ${real}`);
		}
	}
}

function bedrockInputs(metafile) {
	return Object.keys(metafile.inputs).filter((path) =>
		path.includes("register-bedrock")
		|| path.includes("bedrock-provider")
		|| path.includes("@aws-sdk/client-bedrock-runtime"),
	);
}

async function main() {
	const bunBin = resolveBun();
	const tag = platformTag();
	const outDir = resolve(root, "dist/native", `sumocode-${version}-${tag}`);
	const binDir = join(outDir, "bin");
	const shareDir = join(outDir, "share");
	const extensionDir = join(outDir, "extension");
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(binDir, { recursive: true });
	mkdirSync(shareDir, { recursive: true });
	mkdirSync(extensionDir, { recursive: true });

	// 1. Canonical direct-Pi + lean RPC-child extension bundles.
	await buildExtensionBundle("src/extension.ts", join(extensionDir, "sumocode-extension.bundle.mjs"));
	await buildExtensionBundle("src/rpc-child-extension.ts", join(extensionDir, "sumocode-rpc-extension.bundle.mjs"));

	// 2. Bun-compiled Pi child + its sidecar assets (copy-binary-assets set).
	// Pi's exports map does not expose ./package.json, so resolve its dist main
	// entry directly and derive the package root from it. A require rooted at
	// that entry resolves Pi's own dependencies like photon-node.
	const piMainEntry = realpathSync(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"));
	const piPkg = resolve(dirname(piMainEntry), "..");
	if (!existsSync(join(piPkg, "package.json"))) fail(`cannot locate installed Pi package root at ${piPkg}`);
	const piRequire = createRequire(pathToFileURL(piMainEntry));
	const piBuildDir = makeNativePiBuildCopy(piPkg, resolve(root, "dist/native/.pi-build"), root, createBunResolver(bunBin));
	const piMetafile = resolve(root, "dist/native/sumocode-pi.metafile.json");
	run(bunBin, [
		"build",
		"--compile",
		"--no-compile-autoload-bunfig",
		"--no-compile-autoload-dotenv",
		`--metafile=${piMetafile}`,
		"--outfile", join(binDir, "sumocode-pi"),
		join(piBuildDir, "dist/bun/cli.js"),
		join(piBuildDir, "dist/utils/image-resize-worker.js"),
	]);
	const piBuildMetafile = JSON.parse(readFileSync(piMetafile, "utf8"));
	assertMetafileContainment(piBuildMetafile, root, piBuildDir);
	rmSync(piBuildDir, { recursive: true, force: true });
	const includedBedrockInputs = bedrockInputs(piBuildMetafile);
	if (includedBedrockInputs.length > 0) fail(`compiled Pi child still includes Bedrock: ${includedBedrockInputs.join(", ")}`);
	console.log(`[sumocode] compiled Pi child excludes Bedrock registration (${piMetafile})`);
	const piDist = join(piPkg, "dist");
	// Pi sidecars must sit BESIDE bin/sumocode-pi: a compiled Pi resolves its
	// package dir as dirname(process.execPath) (getPackageDir/getThemesDir in
	// dist/config.js). Verified: without theme/ + package.json there, the
	// child crashes in getBuiltinThemes() and --version falls back to 0.0.0.
	// File sets mirror Pi's copy-binary-assets exactly (json/png/templates
	// + vendor js only, no build sources).
	copyMatchingFiles(join(piDist, "modes/interactive/theme"), join(binDir, "theme"), /\.json$/);
	copyMatchingFiles(join(piDist, "modes/interactive/assets"), join(binDir, "assets"), /\.png$/);
	const exportHtmlSource = join(piDist, "core/export-html");
	copyMatchingFiles(exportHtmlSource, join(binDir, "export-html"), /^template\.(html|css|js)$/);
	copyMatchingFiles(join(exportHtmlSource, "vendor"), join(binDir, "export-html/vendor"), /\.js$/);
	const photonPkgDir = dirname(piRequire.resolve("@silvia-odwyer/photon-node"));
	const photonWasm = join(photonPkgDir, "photon_rs_bg.wasm");
	if (!existsSync(photonWasm)) fail(`photon wasm missing at ${photonWasm}`);
	copyFileSync(photonWasm, join(binDir, "photon_rs_bg.wasm"));
	copyFileSync(join(piPkg, "package.json"), join(binDir, "package.json"));

	// 3. Bun-compiled host executable from the native entry, with the
	// chrome-cache worker embedded as its own entrypoint (started by the worker
	// client via new Worker(new URL(...)) inside the binary).
	const hostMetafile = resolve(root, "dist/native/sumocode.metafile.json");
	run(bunBin, [
		"build",
		"--compile",
		"--no-compile-autoload-bunfig",
		"--no-compile-autoload-dotenv",
		`--metafile=${hostMetafile}`,
		"--define", `__SUMOCODE_VERSION__=${JSON.stringify(version)}`,
		"--outfile", join(binDir, "sumocode"),
		join(root, "src/native/main.ts"),
		join(root, "src/sumo-tui/rpc/chrome-cache-worker.ts"),
	]);
	assertMetafileContainment(JSON.parse(readFileSync(hostMetafile, "utf8")));

	// 4. Host sidecar assets and installer.
	copyFileSync(require.resolve("yoga-wasm-web/dist/yoga.wasm"), join(shareDir, "yoga.wasm"));
	copyFileSync(resolve(root, "src/assets/sumo-face.ans"), join(shareDir, "sumo-face.ans"));
	// /changelog reads CHANGELOG.md from the archive root in native launches.
	copyFileSync(resolve(root, "CHANGELOG.md"), join(outDir, "CHANGELOG.md"));
	copyFileSync(resolve(root, "install.sh"), join(outDir, "install.sh"));

	// 5. SHA256SUMS over the archive contents.
	const checksumLines = [];
	function walk(dir) {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile() && entry.name !== "SHA256SUMS") {
				const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
				checksumLines.push(`${hash}  ${relative(outDir, path)}`);
			}
		}
	}
	walk(outDir);
	writeFileSync(join(outDir, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);

	console.log(`[sumocode] native archive: ${outDir}`);
}

let entryUrl;
try {
	if (process.argv[1]) entryUrl = pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
	// Import callers need not have a filesystem entry point.
}

if (import.meta.url === entryUrl) {
	if (!existsSync(resolve(root, "node_modules"))) {
		fail("node_modules is missing — run pnpm install first.");
	}
	await main();
}
