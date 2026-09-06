import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { systemProcessTree } from "../background-tasks/process-tree.js";
import { assertPrivateDir, nodeArtifactFs } from "../private-artifact.js";
import { createPiChildSpawner } from "./backend-pi.js";
import { readRetainedBootstrap } from "./retained-bootstrap.js";
import { SubagentRegistry } from "./registry.js";
import { RetainedHeadlessSupervisor } from "./retained-supervisor.js";

/** Trusted source caller only: bootstrap data grants neither writer nor control authority. */
export async function runRetainedSupervisorEntry(
	argv: readonly string[],
	dependencies: ConstructorParameters<typeof RetainedHeadlessSupervisor>[1] = {},
): Promise<void> {
	try {
		const { taskDir, registryDir, id, ownerSessionId, nonce } = parseArgs(argv);
		const { descriptor, prompt } = readRetainedBootstrap({ taskDir, id, ownerSessionId }, nonce);
		// The registry constructor can create directories; this entry may only attach.
		assertPrivateDir(nodeArtifactFs, registryDir, "retained registry");
		if (realpathSync(registryDir) !== registryDir || (lstatSync(registryDir).mode & 0o7777) !== 0o700) throw new Error();
		const registry = new SubagentRegistry(registryDir, ownerSessionId);
		const initial = registry.get(id);
		const config = descriptor.config;
		if (!initial || initial.taskDir !== taskDir || initial.ownerSessionId !== ownerSessionId
			|| initial.backend !== "headless" || descriptor.backend !== "headless" || initial.status !== "starting"
			|| initial.writerLease !== null || initial.controlLease !== null || initial.controlHead !== 0
			|| initial.supervisor !== null || initial.child !== null || initial.pane !== null
			|| initial.result !== null || initial.manifest !== null
			|| initial.roleId !== (config.role?.id ?? null)
			|| (initial.modelLabel !== null && initial.modelLabel !== config.model.label)
			|| !isDeepStrictEqual(initial.worktree, descriptor.worktree)) throw new Error();
		const operations = dependencies.operations ?? systemProcessTree;
		const processStartTime = operations.captureStartTime(process.pid);
		if (!processStartTime) throw new Error();
		const identity = { pid: process.pid, processGroupId: process.pid, processStartTime };
		const verification = operations.captureTreeVerification?.(identity);
		if (!verification) throw new Error();
		const controller = new RetainedHeadlessSupervisor({
			registry, initial, supervisor: { identity, verification }, attach: { cwd: config.cwd }, keepAlive: true,
			baseRef: config.baseRef,
			launch: { cwd: config.cwd, prompt, retainedBootstrap: descriptor, model: config.model.label,
				thinking: config.thinking, builtInTools: config.builtInTools, inherited: {} },
		}, { ...dependencies, spawn: dependencies.spawn ?? createPiChildSpawner(undefined, undefined, () => config.pi) });
		if (await controller.settlement !== "settled") throw new Error();
	} catch { throw new Error("retained_entry_failed"); }
}

function parseArgs(argv: readonly string[]) {
	const flags = ["--task-dir", "--registry-dir", "--id", "--owner-session", "--nonce"];
	if (argv.length !== flags.length * 2 || flags.some((flag, i) => argv[i * 2] !== flag)
		|| argv.some((value) => !value.trim() || Buffer.byteLength(value) > 4096
			// oxlint-disable-next-line no-control-regex -- public metadata must stay single-line and valid UTF-8.
			|| /[\x00-\x1f\x7f]/u.test(value) || Buffer.from(value).toString("utf8") !== value)) throw new Error();
	const [, taskDir, , registryDir, , id, , ownerSessionId, , nonce] = argv;
	if (![taskDir, registryDir].every((path) => isAbsolute(path) && resolve(path) === path)) throw new Error();
	return { taskDir, registryDir, id, ownerSessionId, nonce };
}
