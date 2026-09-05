import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeNativePiBuildCopy } from "./build-native.mjs";

function write(path, contents) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
}

function fixture(layout) {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "sumocode-native-build-resolution-")));
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

describe("native Pi build-source preparation", () => {
	it("rejects required dependencies available only above the package root", () => {
		const { directory, root, piPkg, buildDir } = fixture("pnpm");
		const manifestPath = join(piPkg, "package.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		manifest.dependencies["parent-only"] = "1.0.0";
		write(manifestPath, JSON.stringify(manifest));
		write(join(directory, "node_modules/parent-only/package.json"), JSON.stringify({ name: "parent-only", main: "index.js" }));
		write(join(directory, "node_modules/parent-only/index.js"), 'throw new Error("parent dependency must not load");\n');
		expect(() => makeNativePiBuildCopy(piPkg, buildDir, root))
			.toThrow(`Cannot resolve Pi build dependency parent-only within ${root}`);
	});

	for (const layout of ["pnpm", "nested"]) {
		it(`preserves the ${layout} package's private dependency graph in a fresh build copy`, () => {
			const { directory, root, piPkg, source, buildDir } = fixture(layout);
			makeNativePiBuildCopy(piPkg, buildDir, root);
			const env = { ...process.env };
			for (const key of ["NODE_PATH", "NODE_OPTIONS", "NODE_COMPILE_CACHE"]) delete env[key];
			const result = spawnSync(process.execPath, [join(buildDir, "dist/bun/cli.js")], {
				cwd: join(directory, "operator"), env, encoding: "utf8", timeout: 10_000,
			});
			expect(result.status, `${result.stderr}\nfixture retained: ${directory}`).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual(["pi-private-transitive", "pi-private-esm"]);
			expect(readFileSync(join(piPkg, "dist/bun/cli.js"), "utf8")).toBe(source);
		});
	}
});
