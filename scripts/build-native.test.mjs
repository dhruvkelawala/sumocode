import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { makeNativePiBuildCopy } from "./build-native.mjs";

const temporaryDirectories = [];

afterEach(({ task }) => {
	for (const directory of temporaryDirectories.splice(0)) {
		if (task.result?.state === "pass") rmSync(directory, { recursive: true, force: true });
		else console.error(`fixture retained: ${directory}`);
	}
});

function write(path, contents) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
}

function fixture(layout) {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "sumocode-native-build-resolution-")));
	temporaryDirectories.push(directory);
	const root = join(directory, "package");
	const piPkg = layout === "pnpm"
		? join(root, "node_modules/.pnpm/pi@0.84.4/node_modules/@earendil-works/pi-coding-agent")
		: join(root, "node_modules/@earendil-works/pi-coding-agent");
	const neighborhood = layout === "pnpm" ? join(piPkg, "../..") : join(piPkg, "node_modules");
	write(join(piPkg, "package.json"), JSON.stringify({
		name: "@earendil-works/pi-coding-agent", version: "0.84.4", type: "module",
		dependencies: { "proper-lockfile": "1.0.0", "@earendil-works/pi-agent-core": "1.0.0" },
		optionalDependencies: { "absent-optional-dependency": "1.0.0" },
	}));
	const source = 'globalThis.__sumocodeStartupMark("bedrock_import_start");\nawait import("./register-bedrock.js");\nglobalThis.__sumocodeStartupMark("after_bedrock_import");\n'
		+ 'import lock from "proper-lockfile";\nimport { agent } from "@earendil-works/pi-agent-core/private-entry";\nconsole.log(JSON.stringify([lock, agent]));\n';
	write(join(piPkg, "dist/bun/cli.js"), source);
	const lockPkg = join(root, "node_modules/.pnpm/lock@1/node_modules/proper-lockfile");
	write(join(lockPkg, "package.json"), JSON.stringify({ name: "proper-lockfile", main: "index.cjs" }));
	write(join(lockPkg, "index.cjs"), 'module.exports = require("private-transitive");\n');
	write(join(lockPkg, "node_modules/private-transitive/index.js"), 'module.exports = "pi-private-transitive";\n');
	mkdirSync(neighborhood, { recursive: true });
	symlinkSync(lockPkg, join(neighborhood, "proper-lockfile"), "dir");
	write(join(neighborhood, "@earendil-works/pi-agent-core/package.json"), JSON.stringify({
		name: "@earendil-works/pi-agent-core", type: "module",
		exports: { "./private-entry": { import: "./nested/entry.js" } },
	}));
	write(join(neighborhood, "@earendil-works/pi-agent-core/nested/entry.js"), 'export const agent = "pi-private-esm";\n');
	for (const base of [directory, root, join(directory, "operator")]) {
		write(join(base, "node_modules/proper-lockfile/package.json"), JSON.stringify({ name: "proper-lockfile", main: "index.js" }));
		write(join(base, "node_modules/proper-lockfile/index.js"), 'module.exports = "wrong-root-or-operator-version";\n');
	}
	return { directory, root, piPkg, source, buildDir: join(root, "dist/native/.pi-build") };
}

describe("native build entry", () => {
	for (const mode of ["direct", "symlink", "directory alias", "import", "missing argv", "directory argv", "unrelated file argv"]) {
		it(`${mode} runs instrumentation only for CLI invocation`, () => {
			const directory = realpathSync(mkdtempSync(join(tmpdir(), "sumocode-native-entry-")));
			temporaryDirectories.push(directory);
			const root = join(directory, "package");
			const script = join(root, "scripts/build-native.mjs");
			write(join(root, "package.json"), '{"type":"module","version":"0.0.0"}');
			write(join(root, ".bun-version"), "fixture-only");
			mkdirSync(dirname(script), { recursive: true });
			copyFileSync(new URL("./build-native.mjs", import.meta.url), script);
			write(join(root, "node_modules/esbuild/package.json"), '{"type":"module","exports":"./index.js"}');
			write(join(root, "node_modules/esbuild/index.js"), 'export function build() { throw new Error("unexpected-build"); }');
			write(join(root, "scripts/instrument-pi-startup.mjs"),
				'import { appendFileSync } from "node:fs";\n'
				+ 'appendFileSync(new URL("../marker", import.meta.url), "entry\\n");\n'
				+ 'throw new Error("native-entry-sentinel");\n');
			const env = {};
			for (const key of ["HOME", "TMPDIR", "XDG_CACHE_HOME"]) {
				env[key] = join(directory, key);
				mkdirSync(env[key]);
			}
			const cli = ["direct", "symlink", "directory alias"].includes(mode);
			let args = [script];
			if (mode === "symlink") {
				const alias = join(directory, "build-alias.mjs");
				symlinkSync(script, alias);
				args = [alias];
			} else if (mode === "directory alias") {
				const alias = join(directory, "package-alias");
				symlinkSync(root, alias, "dir");
				args = [join(alias, "scripts/build-native.mjs")];
			} else if (!cli) {
				const caller = join(directory, "caller.mjs");
				write(caller, "export {};\n");
				const argv = mode === "import" ? undefined
					: mode === "missing argv" ? join(directory, "absent.mjs")
						: mode === "directory argv" ? directory : caller;
				args = ["--input-type=module", "-e",
					`process.argv[1] = ${JSON.stringify(argv)}; await import(${JSON.stringify(pathToFileURL(script).href)});`];
			}
			const result = spawnSync(process.execPath, args, { cwd: directory, env, encoding: "utf8", timeout: 10_000 });
			expect(result.error?.code).toBeUndefined();
			expect(result.signal).toBeNull();
			expect(result.status).toBe(cli ? 1 : 0);
			expect(result.stdout).toBe("");
			if (cli) {
				expect(result.stderr).toContain("Error: native-entry-sentinel");
				expect(readFileSync(join(root, "marker"), "utf8")).toBe("entry\n");
			} else {
				expect(result.stderr).toBe("");
				expect(existsSync(join(root, "marker"))).toBe(false);
			}
		});
	}
});

describe("native Pi build-source preparation", () => {
	for (const escape of ["nested transitive", "pnpm neighbor transitive", "pnpm peer transitive", "pnpm optional transitive", "package file", "package directory", "Pi dist file"]) {
		it(`rejects an escaped ${escape} before linking the source graph`, () => {
			const { directory, root, piPkg, buildDir } = fixture("pnpm");
			const lockPkg = join(root, "node_modules/.pnpm/lock@1/node_modules/proper-lockfile");
			const outside = join(directory, "outside-fake");
			write(join(outside, "package.json"), '{"name":"escaped-transitive","main":"index.cjs"}');
			write(join(outside, "index.cjs"), 'throw new Error("fake source must never execute");\n');
			let input;
			if (escape.endsWith("transitive")) {
				write(join(lockPkg, "package.json"), JSON.stringify({
					name: "proper-lockfile", main: "index.cjs",
					[escape === "pnpm peer transitive" ? "peerDependencies"
						: escape === "pnpm optional transitive" ? "optionalDependencies" : "dependencies"]: { "escaped-transitive": "1" },
				}));
				const neighborhood = escape === "nested transitive" ? join(lockPkg, "node_modules") : dirname(lockPkg);
				input = join(neighborhood, "escaped-transitive");
				symlinkSync(outside, input, "dir");
				// Resolve only: this observes the source graph without evaluating its code.
				expect(createRequire(join(lockPkg, "index.cjs")).resolve("escaped-transitive"))
					.toBe(join(outside, "index.cjs"));
			} else if (escape === "package directory") {
				input = join(lockPkg, "escaped");
				symlinkSync(outside, input, "dir");
				expect(createRequire(join(lockPkg, "index.cjs")).resolve("./escaped/index.cjs"))
					.toBe(join(outside, "index.cjs"));
			} else {
				input = join(escape === "package file" ? lockPkg : join(piPkg, "dist"), "escaped.cjs");
				symlinkSync(join(outside, "index.cjs"), input);
				expect(createRequire(join(piPkg, "package.json")).resolve(input)).toBe(join(outside, "index.cjs"));
			}
			expect(realpathSync(lockPkg).startsWith(`${root}/`)).toBe(true);
			expect(() => makeNativePiBuildCopy(piPkg, buildDir, root)).toThrow(/resolves outside/);
			expect(existsSync(join(buildDir, "node_modules/proper-lockfile"))).toBe(false);
		});
	}

	for (const scenario of ["optional without fallback", "required with contained fallback"]) {
		it(`rejects an escaped manifestless pnpm neighbor: ${scenario}`, () => {
			const { directory, root, piPkg, buildDir } = fixture("pnpm");
			const lockPkg = join(root, "node_modules/.pnpm/lock@1/node_modules/proper-lockfile");
			const name = "manifestless-neighbor";
			write(join(lockPkg, "package.json"), JSON.stringify({
				name: "proper-lockfile", main: "index.cjs",
				[scenario.startsWith("optional") ? "optionalDependencies" : "dependencies"]: { [name]: "1" },
			}));
			const outside = join(directory, "outside-manifestless");
			write(join(outside, "index.js"), 'throw new Error("fake source must never execute");\n');
			symlinkSync(outside, join(dirname(lockPkg), name), "dir");
			if (scenario.startsWith("required")) {
				write(join(root, "node_modules", name, "package.json"), JSON.stringify({ name, main: "index.js" }));
				write(join(root, "node_modules", name, "index.js"), 'module.exports = "later-contained";\n');
			}
			// Resolve the owned fixture without evaluating either candidate.
			expect(createRequire(join(lockPkg, "index.cjs")).resolve(name)).toBe(join(outside, "index.js"));
			expect(() => makeNativePiBuildCopy(piPkg, buildDir, root))
				.toThrow(`Pi build dependency ${name} resolves outside ${root}: ${outside}`);
			expect(existsSync(buildDir)).toBe(false);
		});
	}

	// A nearest dependency-named directory that exists but is not loadable must be
	// skipped exactly like Node falls through to ancestor candidates; the validator
	// must then apply containment to the candidate Node actually resolves.
	for (const scenario of ["contained ancestor", "escaped ancestor"]) {
		it(`skips a present-but-unloadable nearest candidate and ${scenario === "contained ancestor" ? "links the contained Node fallback" : "rejects the escaped Node fallback"}`, () => {
			const { directory, root, piPkg, buildDir } = fixture("pnpm");
			const name = "unloadable-nearest";
			const manifestPath = join(piPkg, "package.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			manifest.dependencies[name] = "1.0.0";
			write(manifestPath, JSON.stringify(manifest));
			// Nearest candidate in resolution order: present, but no manifest or index.
			mkdirSync(join(piPkg, "../..", name), { recursive: true });
			if (scenario === "contained ancestor") {
				const ancestor = join(root, "node_modules", name);
				write(join(ancestor, "package.json"), JSON.stringify({ name, main: "index.js" }));
				write(join(ancestor, "index.js"), 'module.exports = "contained-ancestor";\n');
				// Node skips the unloadable nearest candidate for the contained ancestor.
				expect(createRequire(manifestPath).resolve(name)).toBe(join(ancestor, "index.js"));
				makeNativePiBuildCopy(piPkg, buildDir, root);
				expect(realpathSync(join(buildDir, "node_modules", name))).toBe(ancestor);
				expect(createRequire(join(buildDir, "package.json")).resolve(name)).toBe(join(ancestor, "index.js"));
			} else {
				const outside = join(directory, "node_modules", name);
				write(join(outside, "package.json"), JSON.stringify({ name, main: "index.js" }));
				write(join(outside, "index.js"), 'throw new Error("external source must never bundle");\n');
				// Node skips the unloadable nearest candidate for the escaped ancestor.
				expect(createRequire(manifestPath).resolve(name)).toBe(join(outside, "index.js"));
				expect(() => makeNativePiBuildCopy(piPkg, buildDir, root))
					.toThrow(`Pi build dependency ${name} resolves outside ${root}: ${outside}`);
				expect(existsSync(buildDir)).toBe(false);
			}
		});
	}

	// Builtin-shadowing dependency names are routine in real closures (readable-stream
	// -> string_decoder, uri-js -> punycode). For such specifiers Node and Bun load the
	// core module — require.resolve.paths returns null, and even an installed
	// same-named directory is never loaded — so the validator must skip the name before
	// resolving: there is nothing to contain and no directory to link.
	for (const name of ["string_decoder", "node:string_decoder"]) {
		it(`validates the graph when an uninstalled dependency is named ${name}`, () => {
			const { root, piPkg, buildDir } = fixture("pnpm");
			const lockPkg = join(root, "node_modules/.pnpm/lock@1/node_modules/proper-lockfile");
			write(join(lockPkg, "package.json"), JSON.stringify({
				name: "proper-lockfile", main: "index.cjs", dependencies: { [name]: "1.0.0" },
			}));
			// Node resolves the builtin itself; no installed copy exists anywhere.
			expect(createRequire(join(lockPkg, "index.cjs")).resolve(name)).toBe(name);
			makeNativePiBuildCopy(piPkg, buildDir, root);
			// Remaining dependency edges are still validated and still linked.
			expect(realpathSync(join(buildDir, "node_modules/proper-lockfile"))).toBe(realpathSync(lockPkg));
			expect(createRequire(join(buildDir, "package.json")).resolve("proper-lockfile"))
				.toBe(join(realpathSync(lockPkg), "index.cjs"));
		});
	}

	it("does not link a contained install of a builtin-named dependency: string_decoder", () => {
		const { root, piPkg, buildDir } = fixture("pnpm");
		const lockPkg = join(root, "node_modules/.pnpm/lock@1/node_modules/proper-lockfile");
		write(join(lockPkg, "package.json"), JSON.stringify({
			name: "proper-lockfile", main: "index.cjs", dependencies: { string_decoder: "1.0.0" },
		}));
		// A real, contained userland package carrying a builtin's name exists on disk,
		// but Node still loads the core module for the bare specifier, so the validator
		// skips the name entirely and the directory is deliberately not linked.
		const userland = join(root, "node_modules/string_decoder");
		write(join(userland, "package.json"), JSON.stringify({ name: "string_decoder", main: "index.js" }));
		write(join(userland, "index.js"), 'module.exports = "userland-shadow";\n');
		expect(createRequire(join(lockPkg, "index.cjs")).resolve("string_decoder")).toBe("string_decoder");
		makeNativePiBuildCopy(piPkg, buildDir, root);
		expect(existsSync(join(buildDir, "node_modules/string_decoder"))).toBe(false);
		expect(realpathSync(join(buildDir, "node_modules/proper-lockfile"))).toBe(realpathSync(lockPkg));
	});

	it("links a contained manifestless pnpm neighbor", () => {
		const { root, piPkg, buildDir } = fixture("pnpm");
		const manifestPath = join(piPkg, "package.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		manifest.optionalDependencies["manifestless-neighbor"] = "1";
		write(manifestPath, JSON.stringify(manifest));
		const neighbor = join(root, "manifestless-neighbor");
		write(join(neighbor, "index.js"), 'module.exports = "contained-manifestless";\n');
		symlinkSync(neighbor, join(piPkg, "../../manifestless-neighbor"), "dir");
		expect(createRequire(manifestPath).resolve("manifestless-neighbor")).toBe(join(neighbor, "index.js"));
		makeNativePiBuildCopy(piPkg, buildDir, root);
		expect(realpathSync(join(buildDir, "node_modules/manifestless-neighbor"))).toBe(neighbor);
		expect(createRequire(join(buildDir, "package.json")).resolve("manifestless-neighbor"))
			.toBe(join(neighbor, "index.js"));
	});

	it("keeps contained pnpm neighbors, cycles and absent optionals without treating example manifests as dependencies", () => {
		const { root, piPkg, buildDir } = fixture("pnpm");
		const lockPkg = join(root, "node_modules/.pnpm/lock@1/node_modules/proper-lockfile");
		const neighbor = join(root, "node_modules/.pnpm/neighbor@1/node_modules/neighbor");
		write(join(lockPkg, "package.json"), JSON.stringify({
			name: "proper-lockfile", main: "index.cjs", dependencies: { neighbor: "1" },
			optionalDependencies: { "absent-transitive": "1" },
			peerDependencies: { "absent-peer": "1" },
			peerDependenciesMeta: { "absent-peer": { optional: true } },
		}));
		write(join(neighbor, "package.json"), JSON.stringify({
			name: "neighbor", main: "index.cjs", dependencies: { "proper-lockfile": "1" },
		}));
		write(join(neighbor, "index.cjs"), 'module.exports = "contained-neighbor";\n');
		symlinkSync(neighbor, join(dirname(lockPkg), "neighbor"), "dir");
		symlinkSync(lockPkg, join(dirname(neighbor), "proper-lockfile"), "dir");
		symlinkSync(lockPkg, join(lockPkg, "content-cycle"), "dir");
		write(join(neighbor, "examples/package.json"), '{"dependencies":{"not-installed-example":"1"}}');
		makeNativePiBuildCopy(piPkg, buildDir, root);
		const stagedLock = createRequire(join(buildDir, "package.json")).resolve("proper-lockfile");
		expect(createRequire(stagedLock).resolve("neighbor")).toBe(join(neighbor, "index.cjs"));
		expect(createRequire(join(neighbor, "index.cjs")).resolve("proper-lockfile")).toBe(join(lockPkg, "index.cjs"));
	});

	for (const linkedPath of ["dist", "dist/bun", "dist/bun/cli.js"]) {
		it(`detaches the ${linkedPath} patch path without changing source bytes or other dist links`, () => {
			const { root, piPkg, source, buildDir } = fixture("pnpm");
			const shared = join(root, "shared");
			renameSync(join(piPkg, linkedPath), shared);
			symlinkSync(shared, join(piPkg, linkedPath));
			const cliPath = join(piPkg, "dist/bun/cli.js");
			const sourceDist = realpathSync(join(piPkg, "dist"));
			symlinkSync(sourceDist, join(piPkg, "dist/contained-cycle"), "dir");
			makeNativePiBuildCopy(piPkg, buildDir, root);
			expect(readFileSync(cliPath, "utf8")).toBe(source);
			expect(readFileSync(join(buildDir, "dist/bun/cli.js"), "utf8")).not.toContain("bedrock_import_start");
			expect(realpathSync(join(buildDir, "dist/bun/cli.js"))).toBe(join(buildDir, "dist/bun/cli.js"));
			expect(realpathSync(join(buildDir, "dist/contained-cycle"))).toBe(sourceDist);
		});
	}

	it("rejects optional dependencies available only above the package root", () => {
		const { directory, root, piPkg, buildDir } = fixture("pnpm");
		const manifestPath = join(piPkg, "package.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		manifest.optionalDependencies["parent-only-optional"] = "1.0.0";
		write(manifestPath, JSON.stringify(manifest));
		const parentPackage = join(directory, "node_modules/parent-only-optional");
		write(join(parentPackage, "package.json"), JSON.stringify({ name: "parent-only-optional", main: "index.js" }));
		write(join(parentPackage, "index.js"), 'throw new Error("parent dependency must not load");\n');
		expect(() => makeNativePiBuildCopy(piPkg, buildDir, root))
			.toThrow(`Pi build dependency parent-only-optional resolves outside ${root}: ${parentPackage}`);
		expect(existsSync(join(buildDir, "node_modules/parent-only-optional"))).toBe(false);
	});

	it("rejects required dependencies available only above the package root", () => {
		const { directory, root, piPkg, buildDir } = fixture("pnpm");
		const manifestPath = join(piPkg, "package.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		manifest.dependencies["parent-only"] = "1.0.0";
		write(manifestPath, JSON.stringify(manifest));
		write(join(directory, "node_modules/parent-only/package.json"), JSON.stringify({ name: "parent-only", main: "index.js" }));
		write(join(directory, "node_modules/parent-only/index.js"), 'throw new Error("parent dependency must not load");\n');
		expect(() => makeNativePiBuildCopy(piPkg, buildDir, root))
			.toThrow(`Pi build dependency parent-only resolves outside ${root}: ${join(directory, "node_modules/parent-only")}`);
	});

	for (const dependencyKind of ["dependencies", "optionalDependencies"]) {
		it(`rejects escaped ${dependencyKind} without staging or executing external code`, () => {
			const { root, piPkg, buildDir } = fixture("pnpm");
			const manifestPath = join(piPkg, "package.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			manifest[dependencyKind]["external-private"] = "1.0.0";
			write(manifestPath, JSON.stringify(manifest));
			// A sibling with the same prefix must not count as inside the checkout.
			const externalRoot = mkdtempSync(`${root}-external-`);
			const marker = join(externalRoot, "executed");
			write(join(externalRoot, "package.json"), JSON.stringify({ name: "external-private", main: "index.cjs" }));
			write(join(externalRoot, "index.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`);
			symlinkSync(externalRoot, join(piPkg, "../../external-private"), "dir");
			// Do not fall back to another in-checkout version after an escape.
			write(join(root, "node_modules/external-private/package.json"), JSON.stringify({ name: "external-private" }));
			expect(() => makeNativePiBuildCopy(piPkg, buildDir, root))
				.toThrow(`Pi build dependency external-private resolves outside ${root}: ${externalRoot}`);
			expect(existsSync(join(buildDir, "node_modules/external-private"))).toBe(false);
			expect(existsSync(marker)).toBe(false);
		});
	}

	for (const layout of ["pnpm", "nested"]) {
		it(`preserves the ${layout} package's private dependency graph in a fresh build copy`, () => {
			const { directory, root, piPkg, source, buildDir } = fixture(layout);
			makeNativePiBuildCopy(piPkg, buildDir, root);
			const env = { HOME: directory, TMPDIR: directory };
			const result = spawnSync(process.execPath, [join(buildDir, "dist/bun/cli.js")], {
				cwd: join(directory, "operator"), env, encoding: "utf8", timeout: 10_000,
			});
			expect(result.status, `${result.stderr}\nfixture retained: ${directory}`).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual(["pi-private-transitive", "pi-private-esm"]);
			expect(readFileSync(join(piPkg, "dist/bun/cli.js"), "utf8")).toBe(source);
		});
	}
});
