import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
