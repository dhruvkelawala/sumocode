import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { systemProcessTree } from "../background-tasks/process-tree.js";
import { assertPrivateDir, nodeArtifactFs } from "../private-artifact.js";
import { createPiChildSpawner } from "./backend-pi.js";
import { createPaneChildSpawner, type spawnPaneChild } from "./backend-pane.js";
import { getTerminalHost } from "../terminal-host/index.js";
import type { PiExecLike, TerminalHost } from "../terminal-host/types.js";
import { readRetainedBootstrap } from "./retained-bootstrap.js";
import { SubagentRegistry } from "./registry.js";
import { RetainedHeadlessSupervisor, RetainedVisibleSupervisor } from "./retained-supervisor.js";

type EntryDependencies = ConstructorParameters<typeof RetainedHeadlessSupervisor>[1] & {
	readonly host?: TerminalHost;
	readonly executor?: PiExecLike;
	readonly spawnPane?: typeof spawnPaneChild;
};

/** Trusted source caller only: bootstrap data grants neither writer nor control authority. */
export async function runRetainedSupervisorEntry(
	argv: readonly string[],
	dependencies: EntryDependencies = {},
): Promise<void> {
	try {
		const { taskDir, registryDir, id, ownerSessionId, nonce } = parseArgs(argv);
		const { descriptor, prompt, systemPrompt } = readRetainedBootstrap({ taskDir, id, ownerSessionId }, nonce);
		// The registry constructor can create directories; this entry may only attach.
		assertPrivateDir(nodeArtifactFs, registryDir, "retained registry");
		if (realpathSync(registryDir) !== registryDir || (lstatSync(registryDir).mode & 0o7777) !== 0o700) throw new Error();
		const registry = new SubagentRegistry(registryDir, ownerSessionId);
		const initial = registry.get(id);
		const config = descriptor.config;
		if (!initial || initial.taskDir !== taskDir || initial.ownerSessionId !== ownerSessionId
			|| initial.backend !== descriptor.backend || initial.status !== "starting"
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
		const owner = { registry, initial, supervisor: { identity, verification }, attach: { cwd: config.cwd }, keepAlive: true,
			baseRef: config.baseRef, controller: config.controller };
		const controller = config.visible ? new RetainedVisibleSupervisor({ ...owner,
			launch: { cwd: config.cwd, prompt, appendSystemPrompt: systemPrompt ?? undefined, name: config.visible.name,
				id, model: config.model.label, thinking: config.thinking, tools: config.builtInTools,
				placement: config.visible.placement, host: dependencies.host ?? getTerminalHost(),
				pi: dependencies.executor ?? terminalExecutor },
		}, { ...dependencies, spawn: dependencies.spawnPane ?? createPaneChildSpawner({ resolveLauncher: () => config.visible!.launcher }) })
			: new RetainedHeadlessSupervisor({ ...owner,
			launch: { cwd: config.cwd, prompt, retainedBootstrap: descriptor, model: config.model.label,
				thinking: config.thinking, builtInTools: config.builtInTools, inherited: {} },
		}, { ...dependencies, spawn: dependencies.spawn ?? createPiChildSpawner(undefined, undefined, () => config.pi) });
		if (await controller.settlement !== "settled") throw new Error();
		// Production controllers may still need to transfer an undelivered completion.
		// Standalone proof entries have no external delivery owner to wait for.
		if (!config.controller) controller.dispose();
	} catch { throw new Error("retained_entry_failed"); }
}

const terminalExecutor: PiExecLike = {
	exec: (command, args, options) => new Promise((resolve) => {
		execFile(command, args, { cwd: options?.cwd, timeout: Math.min(options?.timeout ?? 5000, 30_000),
			signal: options?.signal, encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node exposes numeric exit codes and string spawn error codes at this process boundary.
			resolve({ stdout, stderr, code: typeof error?.code === "number" ? error.code : error ? 1 : 0, killed: error?.killed ?? false });
		});
	}),
};

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
