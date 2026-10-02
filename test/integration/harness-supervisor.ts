import { spawn, type SpawnOptions } from "node:child_process";
import { afterAll } from "vitest";
import { createChildEvidenceContext, finalizeFocusedNamespace, requireHarnessAuth, supervisePtyProcess,
	HARNESS_SIGNATURE, HARNESS_SIGNATURE_ENV_KEY, HARNESS_RUN_ID_ENV_KEY, HARNESS_SIGNING_KEY_ENV_KEY } from "./harness-supervisor-core.mjs";
export * from "./harness-supervisor-core.mjs";
afterAll(finalizeFocusedNamespace);

/** Only for trusted IPC children that wait for a parent release before work.
 * execve admission cannot preserve Node's IPC channel; register synchronously
 * before the spawn event can release the retained anchor instead.
 */
export function spawnSupervisedGatedIpcProcess(command: string, args: readonly string[], options: SpawnOptions) {
	const env = { ...options.env, [HARNESS_SIGNATURE_ENV_KEY]: HARNESS_SIGNATURE };
	const auth = requireHarnessAuth(env);
	const evidence = createChildEvidenceContext([command, ...args], env);
	delete env[HARNESS_SIGNING_KEY_ENV_KEY];
	delete env[HARNESS_RUN_ID_ENV_KEY];
	const child = spawn(command, args, { ...options, detached: true, env });
	if (child.pid === undefined) throw new Error("gated IPC child did not publish a pid");
	return { child, ...supervisePtyProcess(child.pid, evidence, env, auth) };
}
