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
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

const BUN_PIN = readFileSync(resolve(root, ".bun-version"), "utf8").trim();
const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

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
	const result = spawnSync(command, args, { stdio: "inherit" });
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
 * Builds the child extension bundle with Pi's virtual modules as the ONLY
 * externals and guards against any other surviving bare import. Pi's extension
 * loader resolves @earendil-works/* and typebox itself; everything else must be
 * inlined or the compiled child cannot load it.
 */
async function buildExtensionBundle(outPath) {
	const result = await build({
		absWorkingDir: root,
		entryPoints: ["src/rpc-child-extension.ts"],
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

async function main() {
	await import("./instrument-pi-startup.mjs");
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

	// 1. Child extension bundle (deps inlined; Pi virtual modules external).
	await buildExtensionBundle(join(extensionDir, "sumocode-extension.bundle.mjs"));

	// 2. Bun-compiled Pi child + its sidecar assets (copy-binary-assets set).
	// Pi's exports map does not expose ./package.json, so resolve its dist main
	// entry directly and derive the package root from it. A require rooted at
	// that entry resolves Pi's own (hoisted) dependencies like photon-node.
	const piMainEntry = realpathSync(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"));
	const piPkg = resolve(dirname(piMainEntry), "..");
	if (!existsSync(join(piPkg, "package.json"))) fail(`cannot locate installed Pi package root at ${piPkg}`);
	const piRequire = createRequire(pathToFileURL(piMainEntry));
	run(bunBin, [
		"build",
		"--compile",
		"--no-compile-autoload-bunfig",
		"--no-compile-autoload-dotenv",
		"--outfile", join(binDir, "sumocode-pi"),
		join(piPkg, "dist/bun/cli.js"),
		join(piPkg, "dist/utils/image-resize-worker.js"),
	]);
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
	run(bunBin, [
		"build",
		"--compile",
		"--no-compile-autoload-bunfig",
		"--no-compile-autoload-dotenv",
		"--define", `__SUMOCODE_VERSION__=${JSON.stringify(version)}`,
		"--outfile", join(binDir, "sumocode"),
		join(root, "src/native/main.ts"),
		join(root, "src/sumo-tui/rpc/chrome-cache-worker.ts"),
	]);

	// 4. Host sidecar assets and installer.
	copyFileSync(require.resolve("yoga-wasm-web/dist/yoga.wasm"), join(shareDir, "yoga.wasm"));
	copyFileSync(resolve(root, "src/assets/sumo-face.ans"), join(shareDir, "sumo-face.ans"));
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

if (!existsSync(resolve(root, "node_modules"))) {
	fail("node_modules is missing — run pnpm install first.");
}
await main();
