import { lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Source-only entry. Caller supplies a verified absolute Node, detached, and a controlled env.
 * This entry rejects executable-resolution overrides; it does not sanitize the whole env.
 * Code comes from this package, never argv, task cwd, or SUMOCODE_ROOT_DIR.
 * Args, in order: --task-dir PATH --registry-dir PATH --id ID --owner-session ID --nonce UUID.
 * Physical Node source supports headless and visible owners; native artifacts use their disposable backend.
 */
export async function runSourceEntry(argv, load = (url) => import(url)) {
	try {
		if (process.versions.bun || process.execArgv.length || process.env.NODE_PATH || process.env.NODE_OPTIONS
			|| !isAbsolute(process.execPath) || basename(process.execPath) !== "node") throw new Error();
		assertFile(process.execPath, true);
		const entry = fileURLToPath(import.meta.url);
		assertFile(entry);
		const source = fileURLToPath(new URL("./retained-supervisor-entry.ts", import.meta.url));
		assertFile(source);
		const packageFile = fileURLToPath(new URL("../../package.json", import.meta.url));
		assertFile(packageFile);
		const pi = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		assertFile(pi);
		const jitiPath = realpathSync(createRequire(pi).resolve("jiti"));
		assertFile(jitiPath);
		const { createJiti } = await load(pathToFileURL(jitiPath).href);
		const jiti = createJiti(import.meta.url, { moduleCache: true, tryNative: false, fsCache: false });
		const { runRetainedSupervisorEntry } = await jiti.import(source);
		await runRetainedSupervisorEntry(argv);
	} catch { throw new Error("retained_entry_failed"); }
}

function assertFile(path, executable = false) {
	const stat = lstatSync(path);
	if (realpathSync(path) !== path || !stat.isFile() || (stat.mode & 0o022) !== 0
		|| (executable && (stat.mode & 0o111) === 0)) throw new Error();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	void runSourceEntry(process.argv.slice(2)).catch(() => {
		process.stderr.write("retained_entry_failed\n");
		// Exit only this CLI, without reclaiming authority or signaling the child.
		// Closing our pipes may cause child EPIPE; work remains ambiguous/lost.
		process.exit(1);
	});
}
