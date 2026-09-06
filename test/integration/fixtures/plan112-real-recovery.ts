import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { preflightRecovery } from "../../../scripts/plan112-recovery-preflight.mjs";
import { signalVerifiedProcessTree, systemProcessTree } from "../../../src/background-tasks/process-tree.js";
import { createChildEvidenceContext, spawnSupervisedProcess, supervisePtyProcess } from "../harness-supervisor.js";
import { cleanupOwnedTree, type OwnedTree } from "./subagent-feasibility-cleanup.js";
import { captureBirth } from "./plan112-source-controller.js";

export async function runRealRecovery(backend: "headless" | "visible", replacement: string): Promise<void> {
	if (backend === "visible") {
		if (process.env.HERDR_ENV !== "1") throw new Error("capability: herdr unavailable");
		throw new Error("capability: visible source-controller entry unavailable");
	}
	const runRoot = process.env.PLAN112_RECOVERY_ROOT;
	if (!runRoot || process.env.SUMOCODE_INTEGRATION_RUN_ROOT !== runRoot) throw new Error("real recovery requires scripts/run-plan112-recovery.mjs supervised wrapper");
	const root = realpathSync(mkdtempSync(join(runRoot, "cell-")));
	const { node, pi, provider, env: privateEnv } = await preflightRecovery(root);
	const env = { ...privateEnv, SUMOCODE_INTEGRATION_RUN_ROOT: runRoot, SUMOCODE_INTEGRATION_MANIFEST: join(runRoot, "children.jsonl") };
	const entry = fileURLToPath(new URL("./plan112-source-controller.mjs", import.meta.url));
	const owned: OwnedTree[] = [];
	const spawned: number[] = [];
	const register = (tree: OwnedTree): void => {
		owned.push(tree);
		appendFileSync(join(runRoot, "births.jsonl"), `${JSON.stringify(tree)}\n`, { mode: 0o600 });
	};
	const admit = (pid: number): void => writeFileSync(join(root, `admit-${pid}`), "", { mode: 0o600, flag: "wx" });
	const start = async (mode: string) => {
		const child = spawnSupervisedProcess(node, [entry, root, mode, pi, provider], { env, stdio: ["ignore", "pipe", "pipe"] });
		spawned.push(child.pid);
		await new Promise<void>((resolve, reject) => { child.child.once("spawn", resolve); child.child.once("error", reject); });
		const birth = captureBirth(child.pid);
		register(birth);
		admit(child.pid);
		return birth;
	};
	const read = (name: string): { error?: string; expiresAt?: number; headlessSteering?: boolean; promptPresent?: boolean; privateRolePresent?: boolean; toolsEmpty?: boolean } => JSON.parse(readFileSync(join(root, name), "utf8"));
	const wait = async (name: string, mode: string) => {
		const deadline = Date.now() + 30_000;
		while (!existsSync(join(root, name))) {
			if (existsSync(join(root, `${mode}-error.json`))) throw new Error(read(`${mode}-error.json`).error);
			if (Date.now() >= deadline) throw new Error(`real recovery timeout: ${name}; evidence: ${root}`);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		return read(name);
	};
	try {
		const mode = replacement === "same-process factory replacement" ? "same-process" : "owner";
		await start(mode);
		await wait("anchor-birth.json", mode);
		// SAFETY: source driver writes this private birth before admitting Pi. Reverify
		// it before registering with the existing external-group supervisor seam.
		const anchor = JSON.parse(readFileSync(join(root, "anchor-birth.json"), "utf8")) as OwnedTree;
		register(anchor);
		expect(systemProcessTree.identityMatches(anchor.identity)).toBe("same");
		expect(systemProcessTree.verificationMatches!(anchor.identity, anchor.verification)).toBe("same");
		supervisePtyProcess(anchor.identity.pid, createChildEvidenceContext([node, "retained-anchor"], env), env);
		admit(anchor.identity.pid);
		const ready = await wait("owner-ready.json", mode);
		expect(read("provider-called.json")).toEqual({ promptPresent: true, privateRolePresent: true, toolsEmpty: true });
		if (mode === "same-process") {
			const result = await wait("same-process-result.json", mode);
			if (result.error) throw new Error(result.error);
		} else {
			const origin = await start("origin");
			const lease = await wait("origin-ready.json", "owner");
			expect((await signalVerifiedProcessTree(systemProcessTree, origin.identity, "SIGKILL", origin.verification)).ok).toBe(true);
			expect(await systemProcessTree.waitForTreeEmpty(origin.identity, 2000, origin.verification)).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, Math.max(0, lease.expiresAt! - Date.now() + 100)));
			await start("successor");
			const result = await wait("successor-result.json", "successor");
			writeFileSync(join(root, "finish"), "", { mode: 0o600, flag: "wx" });
			await wait("owner-result.json", "owner");
			if (result.error) {
				expect(ready.headlessSteering).toBe(false);
				throw new Error(result.error);
			}
		}
	} finally {
		const failures: number[] = [];
		for (const tree of [...owned].reverse()) {
			if (!await cleanupOwnedTree(systemProcessTree, tree, (value) => appendFileSync(join(root, "cleanup.jsonl"), `${JSON.stringify(value)}\n`, { mode: 0o600 }))) failures.push(tree.identity.pid);
		}
		const census = systemProcessTree.census!();
		if (existsSync(join(root, "anchor-spawn.json"))) spawned.push(JSON.parse(readFileSync(join(root, "anchor-spawn.json"), "utf8")).pid);
		const unregistered = spawned.filter((pid) => !owned.some((tree) => tree.identity.pid === pid));
		const zeroOwned = census !== undefined && failures.length === 0 && unregistered.length === 0 && owned.every((tree) =>
			systemProcessTree.isTreeEmpty(tree.identity, tree.verification) && !census.some((member) =>
				tree.verification.members.some((birth) => member.pid === birth.pid && member.processStartTime === birth.processStartTime)));
		writeFileSync(join(root, "zero-owned.json"), JSON.stringify({ zeroOwned, censusKnown: census !== undefined, groups: owned.length, failures, unregistered }), { mode: 0o600 });
		process.stdout.write(`[plan112] zero-owned: ${zeroOwned}; ${owned.length} birth-registered groups; evidence: ${root}\n`);
		expect(zeroOwned, "zero-owned audit: unknown is not zero").toBe(true);
	}
}
