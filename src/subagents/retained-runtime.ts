import { spawn } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ensurePrivateSumocodeDirectory } from "../activity/persistence.js";
import { systemProcessTree, type ProcessTreeOperations } from "../background-tasks/process-tree.js";
import { resolveExecutableProvenance, type ExecutableProvenance } from "../executable-provenance.js";
import { BUILT_IN_TOOLS, getBuiltInToolsFromActiveTools } from "../native-task-config.js";
import { resolveModel, VALID_THINKING_LEVELS } from "../native-task-params.js";
import { resolveClaudeOauthAdapterEntry, resolvePiChildModelBootstrapEntry, type SpawnedChild } from "./backend-pi.js";
import type { SubagentLaunch } from "./manager.js";
import { prepareRetainedBootstrap } from "./retained-bootstrap.js";
import { observeRemoteRetained, verifyRetained } from "./retained-adoption.js";
import { controlAuthority, retainedControlClient } from "./retained-control.js";
import { SubagentRegistry, type RegistryWriter, type SubagentRecord, type SubagentRegistryOptions } from "./registry.js";
import type { PiExecLike, TerminalHost } from "../terminal-host/types.js";
import type { SubagentLaunchFailure } from "./domain.js";

/** Owner refused a launch before admission and persisted structured evidence for it. */
export class RetainedLaunchRefusal extends Error {
	constructor(readonly failure: SubagentLaunchFailure) {
		super(failure.errorText ?? failure.errorReason ?? failure.errorCode ?? "retained launch refused before admission");
		this.name = "RetainedLaunchRefusal";
	}
}

interface OwnerProcess {
	readonly pid?: number;
	once(event: "error", listener: (error: Error) => void): void;
	unref(): void;
}

interface RetainedRuntimeOptions {
	readonly operations?: ProcessTreeOperations;
	readonly registryOptions?: SubagentRegistryOptions;
	readonly provenance?: () => ExecutableProvenance;
	readonly spawnOwner?: (command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; detached: true; stdio: "ignore" }) => OwnerProcess;
}

/** Owner-bootstrap wait for launches without a caller-supplied provisioning budget. */
const RETAINED_OWNER_BOOTSTRAP_WAIT_MS = 30_000;

/** Owns the installation namespace shared by production launches and replacement sessions. */
export class RetainedRuntime {
	public constructor(private readonly options: RetainedRuntimeOptions = {}) {}

	public registry(sessionId: string): SubagentRegistry {
		const root = ensurePrivateSumocodeDirectory(["subagents", "v2"]);
		return new SubagentRegistry(join(root, "registry"), sessionId, this.options.registryOptions);
	}

	/** Unsupported distributions keep the caller's disposable backend; a refused admitted launch never falls back. */
	public async spawn(task: SubagentLaunch & { readonly provisioningTimeoutMs?: number }, sessionId: string, controller: RegistryWriter, host: TerminalHost, pi: PiExecLike): Promise<SpawnedChild | undefined> {
		const source = sourceOwner(this.options.provenance?.() ?? resolveExecutableProvenance(), task.visible === true);
		if (!source) return undefined;
		if (task.signal.aborted) throw new Error("retained launch interrupted before admission");
		const model = resolveModel(task.model, task.inherited?.model);
		if (!model.ok || !model.model) throw new Error("retained launch requires a resolved provider/model");
		const thinking = VALID_THINKING_LEVELS.find((level) => level === (task.thinking ?? task.inherited?.thinking ?? "off"));
		if (!thinking) throw new Error("retained launch requires a resolved thinking level");
		if (task.visible && !task.placement) throw new Error("retained visible placement is unavailable");
		const registry = this.registry(sessionId);
		const tasks = ensurePrivateSumocodeDirectory(["subagents", "v2", "tasks"]);
		const taskDir = join(tasks, task.id);
		mkdirSync(taskDir, { mode: 0o700 });
		const now = Date.now();
		const initial: SubagentRecord = {
			schemaVersion: 2, revision: 1, id: task.id, ownerSessionId: sessionId, backend: task.visible ? "visible" : "headless",
			status: "starting", taskDir, child: null, supervisor: null, pane: null, worktree: task.worktreeRef ?? null,
			sessionFilePath: null, modelLabel: model.model.label, roleId: task.roleId ?? null, budget: task.budget,
			createdAt: now, updatedAt: now, settledAt: null, completionId: null, outcome: null,
			delivery: { state: "none", claim: null }, result: null, manifest: null, writerLease: null, controlLease: null, controlHead: 0,
		};
		registry.create(initial);
		const adapter = resolveClaudeOauthAdapterEntry();
		const numberedModel = /^anthropic-\d+$/u.test(model.model.provider);
		const bootstrap = numberedModel ? resolvePiChildModelBootstrapEntry() : undefined;
		if (numberedModel && (!adapter || !bootstrap)) throw new Error("retained model adapter unavailable");
		const descriptor = prepareRetainedBootstrap(initial, {
			controller, cwd: realpathSync(task.cwd), baseRef: task.baseRef, model: model.model, thinking,
			builtInTools: task.builtInTools === undefined ? BUILT_IN_TOOLS : getBuiltInToolsFromActiveTools([...task.builtInTools]),
			role: task.roleId ? { id: task.roleId, label: task.roleId } : null,
			pi: source.pi, adapterEntry: adapter ? realpathSync(adapter) : null, modelBootstrapEntry: bootstrap ? realpathSync(bootstrap) : null,
			visible: task.visible ? { name: task.title, placement: task.placement!, launcher: source.sumocode,
				provisioningTimeoutMs: task.provisioningTimeoutMs } : null,
		}, { prompt: task.prompt, systemPrompt: task.appendSystemPrompt ?? null });
		if (task.signal.aborted) throw new Error("retained launch interrupted before admission");
		const env: NodeJS.ProcessEnv = { ...process.env, PI_BIN: source.pi };
		delete env.NODE_OPTIONS;
		delete env.NODE_PATH;
		const args = [source.entry, "--task-dir", taskDir, "--registry-dir", join(dirname(tasks), "registry"),
			"--id", task.id, "--owner-session", sessionId, "--nonce", descriptor.nonce];
		const owner = this.options.spawnOwner
			? this.options.spawnOwner(source.node, args, { cwd: descriptor.config.cwd, env, detached: true, stdio: "ignore" })
			: spawn(source.node, args, { cwd: descriptor.config.cwd, env, detached: true, stdio: "ignore" });
		let failed = false;
		owner.once("error", () => { failed = true; });
		owner.unref();
		// A visible launch's remaining end-to-end budget bounds this wait too: the
		// owner provisions the pane and the parent confirms the record inside the
		// same window the manager opened before the visible-spawn reservation, so
		// this must never add a fresh fixed timeout on top. Launches without a
		// caller budget (headless bootstrap) keep the owner-startup wait.
		const deadline = Date.now() + Math.max(0, task.provisioningTimeoutMs ?? RETAINED_OWNER_BOOTSTRAP_WAIT_MS);
		const operations = this.options.operations ?? systemProcessTree;
		let refusal: SubagentLaunchFailure | undefined;
		while (!failed && Date.now() < deadline) {
			const record = registry.get(task.id)!;
			if (["lost", "ambiguous"].includes(record.status)) { refusal = record.failure; break; }
			if ((record.status === "running" || record.status === "settled") && record.controlLease) {
				const authority = controlAuthority(record);
				if (record.supervisor?.identity.pid !== owner.pid || authority.owner.token !== controller.token
					|| authority.owner.pid !== controller.pid || authority.owner.processStartTime !== controller.processStartTime
					|| !registry.inspectControl(authority)) break;
				if ((await verifyRetained(record, operations, host, pi)).classification !== "verified") break;
				const view = registry.forController(controller);
				return { ...retainedControlClient(view, authority), retained: { registry: view, authority,
					supervisor: observeRemoteRetained(view, record, operations) } };
			}
			await delay(50);
		}
		if (refusal) throw new RetainedLaunchRefusal(refusal);
		throw new Error(`retained launch unconfirmed; preserved evidence for ${task.id}`);
	}
}

function sourceOwner(provenance: ExecutableProvenance, visible: boolean) {
	try {
		if (process.versions.bun || !["darwin", "linux"].includes(process.platform)) return undefined;
		const root = fileURLToPath(new URL("../../", import.meta.url));
		const entry = join(root, "src", "subagents", "retained-supervisor-entry.mjs");
		if (!existsSync(entry)) return undefined;
		const node = checkedFile(process.execPath, true);
		if (basename(node) !== "node") return undefined;
		const configuredPi = provenance.pi === "pi" ? "pi" : commandPath(provenance.pi);
		const localShim = join(root, "node_modules", ".bin", "pi");
		const installedPi = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle", "cli.js");
		const pi = checkedFile(provenance.pi === "pi" || (existsSync(localShim) && configuredPi === realpathSync(localShim)) ? installedPi : configuredPi, true);
		const fd = openSync(pi, "r");
		try {
			const header = Buffer.alloc(128);
			const count = readSync(fd, header, 0, header.length, 0);
			if (!/^#!(?:\/usr\/bin\/env node|\/[^\n ]*\/node)\r?\n/u.test(header.subarray(0, count).toString("utf8"))) return undefined;
		} finally { closeSync(fd); }
		return { node, pi, entry: checkedFile(entry, false), sumocode: visible ? checkedFile(commandPath(provenance.sumocode), true) : "" };
	} catch { return undefined; }
}

function commandPath(command: string): string {
	if (isAbsolute(command) || command.includes("/")) return realpathSync(resolve(command));
	for (const directory of (process.env.PATH ?? "").split(":")) {
		if (!isAbsolute(directory)) continue;
		const path = join(directory, command);
		if (existsSync(path)) return realpathSync(path);
	}
	throw new Error("retained executable unavailable");
}

function checkedFile(path: string, executable: boolean): string {
	const canonical = realpathSync(path);
	const stat = lstatSync(canonical);
	if (!stat.isFile() || (stat.mode & 0o022) !== 0 || (executable && (stat.mode & 0o111) === 0)) throw new Error("unsafe retained executable");
	return canonical;
}
