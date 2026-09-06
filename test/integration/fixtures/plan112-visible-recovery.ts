import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recoveryEnvironment } from "../../../scripts/plan112-recovery-preflight.mjs";
import { shellEscape } from "../../../src/background-tasks/visible-spawn.js";
import { systemProcessTree, type ProcessTreeOperations } from "../../../src/background-tasks/process-tree.js";
import { createPaneChildSpawner } from "../../../src/subagents/backend-pane.js";
import type { RegistryProcess } from "../../../src/subagents/registry.js";
import { herdrTerminalHost } from "../../../src/terminal-host/herdr.js";
import type { PiExecLike, TerminalHost } from "../../../src/terminal-host/types.js";

/** Real pane backend; only executable selection and external birth admission are injected. */
export function visibleRecoveryLaunch(root: string, pi: string, provider: string,
	dependencies: { executor?: PiExecLike; operations?: ProcessTreeOperations } = {}) {
	const operations = dependencies.operations ?? systemProcessTree;
	const taskDir = join(root, "task");
	const launcher = join(root, "visible-launcher.sh");
	const extension = fileURLToPath(new URL("./plan112-visible-task.ts", import.meta.url));
	const env = { ...recoveryEnvironment(root), TERM: "xterm-256color", SUMOCODE_TASK_MODE: "1",
		SUMOCODE_TASK_RESPONSE_FILE: join(taskDir, "response.md"), SUMOCODE_TASK_EXIT_FILE: join(taskDir, "exit.code"),
		SUMOCODE_TASK_STARTED_FILE: join(taskDir, "started.marker"), SUMOCODE_TASK_CONTROL_DIR: join(taskDir, "control") };
	const environment = Object.entries(env).map(([key, value]) => shellEscape(`${key}=${value}`)).join(" ");
	writeFileSync(launcher, `#!/bin/bash\nexec ${[process.execPath, pi, "--offline", "--no-extensions", "--no-session", "-e", provider, "-e", extension,
		"--model", "source-proof/fixed", "--thinking", "off", "--no-tools"].map(shellEscape).join(" ")} "$(< ${shellEscape(join(taskDir, "prompt.txt"))})"\n`, { mode: 0o700, flag: "wx" });
	const executor: PiExecLike = dependencies.executor ?? { exec: async (_command, args) => {
		try { return { code: 0, stdout: execFileSync(process.env.PLAN112_HERDR_BIN!, args, { encoding: "utf8", timeout: 5000 }), stderr: "", killed: false }; }
		catch { return { code: 1, stdout: "", stderr: "", killed: false }; }
	} };
	let shell: RegistryProcess | undefined;
	const admit = async (name: string, birth: RegistryProcess): Promise<void> => {
		writeFileSync(join(root, `${name}.pending`), JSON.stringify(birth), { mode: 0o600, flag: "wx" });
		renameSync(join(root, `${name}.pending`), join(root, `${name}.json`));
		const deadline = Date.now() + 10_000;
		while (!existsSync(join(root, `${name}-admitted`))) {
			assert(Date.now() < deadline, "pane birth admission timeout");
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	};
	const host: TerminalHost = { ...herdrTerminalHost, startAgentPane: async (hostPi, options) => {
		assert(options.shellCommand.startsWith("exec "), "pane wrapper must replace the shell");
		const commandFile = join(root, "pane-command.sh");
		writeFileSync(commandFile, `#!/bin/bash\nexec /usr/bin/env -i ${environment} ${options.shellCommand.slice("exec ".length)}\n`, { mode: 0o700, flag: "wx" });
		writeFileSync(join(root, "pane-launch-intent"), "", { mode: 0o600, flag: "wx" });
		return herdrTerminalHost.startAgentPane(hostPi, {
			...options,
			// Keep terminal input short and strip BASH_ENV before starting bash.
			shellCommand: `exec /usr/bin/env -i /bin/bash ${shellEscape(commandFile)}`,
			beforeRun: async (pane) => {
				writeFileSync(join(root, "pane-created.json"), JSON.stringify(pane), { mode: 0o600, flag: "wx" });
				const info = await herdrTerminalHost.inspectPane(hostPi, pane);
				assert(info.ok && info.shellPid && info.foregroundProcessGroupId === info.shellPid, "pane shell association refused");
				const processStartTime = operations.captureStartTime(info.shellPid);
				assert(processStartTime, "pane shell identity unknown");
				const identity = { pid: info.shellPid, processGroupId: info.shellPid, processStartTime };
				const verification = operations.captureTreeVerification!(identity);
				assert(verification, "pane shell birth unknown");
				shell = { identity, verification };
				await admit("pane-shell-birth", shell);
				assert.equal(operations.identityMatches(identity), "same");
				assert.equal(operations.verificationMatches!(identity, verification), "same");
				await options.beforeRun?.(pane);
			},
		});
	} };
	const spawn = createPaneChildSpawner({ resolveLauncher: () => launcher, processTree: operations });
	return { host, pi: executor, spawn: ((options) => {
		const gate = options.launchGate!;
		return spawn({ ...options, launchGate: { ...gate, wrapperBorn: async (evidence) => {
			assert(shell, "pane shell not admitted");
			assert.equal(evidence.process.identity.pid, shell.identity.pid);
			const original = shell.verification.members.find((member) => member.pid === shell!.identity.pid)!;
			assert(evidence.process.verification.members.some((member) => member.pid === original.pid && member.processStartTime === original.processStartTime), "pane shell birth changed across exec");
			await gate.wrapperBorn(evidence);
			await admit("anchor-birth", evidence.process);
			assert(!existsSync(join(taskDir, "launch.release")), "pane released before external admission");
			assert.equal(readFileSync(join(taskDir, "launch.born"), "utf8").split("\n")[0], evidence.nonce);
		} } });
	}) satisfies typeof spawn };
}
