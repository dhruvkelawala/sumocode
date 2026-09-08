import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { preflightRecovery } from "../../../scripts/plan112-recovery-preflight.mjs";
import { signalVerifiedProcessTree, systemProcessTree } from "../../../src/background-tasks/process-tree.js";
import { createChildEvidenceContext, requireHarnessAuth, spawnSupervisedProcess, supervisePtyProcess } from "../harness-supervisor.js";
import { cleanupOwnedTree, type OwnedTree } from "./subagent-feasibility-cleanup.js";
import { captureBirth } from "./plan112-source-controller.js";
import { SubagentRegistry } from "../../../src/subagents/registry.js";
import { censusRetained } from "../../../src/subagents/retained-census.js";

export async function runRealRecovery(backend: "headless" | "visible", replacement: string, scenario = ""): Promise<void> {
	if (backend === "visible" && process.env.HERDR_ENV !== "1") throw new Error("capability: herdr unavailable");
	const runRoot = process.env.PLAN112_RECOVERY_ROOT;
	if (!runRoot || process.env.SUMOCODE_INTEGRATION_RUN_ROOT !== runRoot) throw new Error("real recovery requires scripts/run-plan112-recovery.mjs supervised wrapper");
	const root = realpathSync(mkdtempSync(join(runRoot, "cell-")));
	const { node, pi, provider, env: privateEnv } = await preflightRecovery(root);
	const env: NodeJS.ProcessEnv = { ...privateEnv, SUMOCODE_INTEGRATION_RUN_ROOT: runRoot, SUMOCODE_INTEGRATION_MANIFEST: join(runRoot, "children.jsonl") };
	const auth = requireHarnessAuth(env);
	if (process.env.HERDR_ENV === "1") Object.assign(env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
		HERDR_PANE_ID: process.env.HERDR_PANE_ID, PLAN112_HERDR_BIN: process.env.PLAN112_HERDR_BIN });
	if (backend === "visible") writeFileSync(join(root, "visible"), "", { mode: 0o600, flag: "wx" });
	if (scenario) writeFileSync(join(root, "scenario.json"), JSON.stringify(scenario), { mode: 0o600, flag: "wx" });
	const entry = fileURLToPath(new URL("./plan112-source-controller.mjs", import.meta.url));
	const owned: OwnedTree[] = [];
	const spawned: number[] = [];
	const register = (tree: OwnedTree): void => {
		owned.push(tree);
		appendFileSync(join(runRoot, "births.jsonl"), `${JSON.stringify(tree)}\n`, { mode: 0o600 });
	};
	const admit = (pid: number): void => writeFileSync(join(root, `admit-${pid}`), "", { mode: 0o600, flag: "wx" });
	const waitForControllerExec = async (pid: number) => {
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			const identity = systemProcessTree.captureStartTime(pid);
			if (identity?.includes(entry) && !identity.includes("harness-admission.cjs")) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`controller exec identity did not settle for pid ${pid}`);
	};
	const start = async (mode: string) => {
		const child = spawnSupervisedProcess(node, [entry, root, mode, pi, provider], { env, stdio: ["ignore", "pipe", "pipe"] });
		spawned.push(child.pid);
		await new Promise<void>((resolve, reject) => { child.child.once("spawn", resolve); child.child.once("error", reject); });
		await waitForControllerExec(child.pid);
		const birth = captureBirth(child.pid);
		register(birth);
		admit(child.pid);
		return birth;
	};
	const read = (name: string): { error?: string; steering?: string; recovery?: string; expiresAt?: number; headlessSteering?: boolean; promptPresent?: boolean; privateRolePresent?: boolean; toolsEmpty?: boolean } => JSON.parse(readFileSync(join(root, name), "utf8"));
	const wait = async (name: string, mode: string) => {
		const deadline = Date.now() + 90_000;
		while (!existsSync(join(root, name))) {
			if (existsSync(join(root, `${mode}-error.json`))) throw new Error(read(`${mode}-error.json`).error);
			if (Date.now() >= deadline) throw new Error(`real recovery timeout: ${name}; evidence: ${root}`);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		return read(name);
	};
	const kill = async (tree: OwnedTree) => {
		const result = await signalVerifiedProcessTree(systemProcessTree, tree.identity, "SIGKILL", tree.verification);
		appendFileSync(join(root, "cuts.jsonl"), `${JSON.stringify({ tree, signal: "SIGKILL", result })}\n`, { mode: 0o600 });
		expect(result.ok).toBe(true);
		expect(await systemProcessTree.waitForTreeEmpty(tree.identity, 2000, tree.verification)).toBe(true);
	};
	const registry = new SubagentRegistry(join(root, "registry"), "origin");
	try {
		if (scenario === "stale-pid" || scenario === "cleanup:same" || scenario === "cleanup:different") {
			const probe = await start("probe");
			await wait("probe-ready.json", "probe");
			if (scenario === "cleanup:same") expect(await cleanupOwnedTree(systemProcessTree, probe, () => {})).toBe(true);
			else {
				await kill(probe);
				expect((await signalVerifiedProcessTree(systemProcessTree, probe.identity, "SIGKILL", probe.verification)).ok).toBe(false);
				if (scenario === "cleanup:different") {
					expect(systemProcessTree.verificationMatches!(probe.identity, probe.verification)).toBe("different");
					expect(await cleanupOwnedTree(systemProcessTree, probe, () => {})).toBe(true);
				}
			}
			return;
		}
		const mode = replacement === "same-process factory replacement" ? "same-process" : "owner";
		const controller = await start(mode);
		if (scenario === "crash:starting") {
			await wait("cut-ready.json", mode);
			await kill(controller);
			expect(registry.get("sa-real")).toMatchObject({ status: "starting", child: null, completionId: null, launchIntent: null });
			expect(censusRetained(registry)[0].launch).toBe("never-launched");
			return;
		}
		if (backend === "visible") {
			await wait("pane-shell-birth.json", mode);
			// SAFETY: the admitted controller publishes this private birth; OS checks below precede command admission.
			const shell = JSON.parse(readFileSync(join(root, "pane-shell-birth.json"), "utf8")) as OwnedTree;
			register(shell);
			expect(systemProcessTree.identityMatches(shell.identity)).toBe("same");
			expect(systemProcessTree.verificationMatches!(shell.identity, shell.verification)).toBe("same");
			supervisePtyProcess(shell.identity.pid, createChildEvidenceContext([node, "pane-shell"], env), env, auth);
			writeFileSync(join(root, "pane-shell-birth-admitted"), "", { mode: 0o600, flag: "wx" });
		}
		await wait("anchor-birth.json", mode);
		// SAFETY: source driver writes this private birth before admitting Pi. Reverify
		// it before registering with the existing external-group supervisor seam.
		const anchor = JSON.parse(readFileSync(join(root, "anchor-birth.json"), "utf8")) as OwnedTree;
		register(anchor);
		expect(systemProcessTree.identityMatches(anchor.identity)).toBe("same");
		expect(systemProcessTree.verificationMatches!(anchor.identity, anchor.verification)).toBe("same");
		supervisePtyProcess(anchor.identity.pid, createChildEvidenceContext([node, "retained-anchor"], env), env, auth);
		if (backend === "visible") writeFileSync(join(root, "anchor-birth-admitted"), "", { mode: 0o600, flag: "wx" });
		else admit(anchor.identity.pid);
		if (scenario === "crash:pre-release") {
			await wait("cut-ready.json", mode);
			await kill(controller);
			const before = registry.get("sa-real")!;
			expect(before).toMatchObject({ status: "starting", child: null, completionId: null, launchIntent: { nonce: expect.any(String) } });
			expect(censusRetained(registry)[0].launch).toBe("launched-unknown");
			await kill(anchor);
			return;
		}
		const ready = await wait("owner-ready.json", mode);
		expect(ready.headlessSteering).toBe(backend === "visible");
		expect(read("provider-called.json")).toEqual({ promptPresent: true, privateRolePresent: true, toolsEmpty: true });
		if (scenario.startsWith("delivery:")) {
			await wait("cut-ready.json", mode);
			await kill(controller);
			const saved = ["result.json", "manifest.json"].map((name) => readFileSync(join(root, "task", name), "utf8"));
			const expires = () => Math.max(registry.get("sa-real")!.writerLease!.expiresAt, registry.get("sa-real")!.controlLease!.expiresAt);
			await new Promise((resolve) => setTimeout(resolve, Math.max(0, expires() - Date.now() + 100)));
			const successor = await start("delivery-successor");
			if (scenario === "delivery:notice-before-ack") {
				await wait("notice-cut-ready.json", "delivery-successor");
				await kill(successor);
				await new Promise((resolve) => setTimeout(resolve, Math.max(0, expires() - Date.now() + 100)));
				await start("delivery-final");
				await wait("delivery-final-result.json", "delivery-final");
			} else await wait("delivery-successor-result.json", "delivery-successor");
			expect(registry.get("sa-real")?.delivery.state).toBe("delivery-uncertain");
			expect(["result.json", "manifest.json"].map((name) => readFileSync(join(root, "task", name), "utf8"))).toEqual(saved);
			return;
		}
		if (scenario.startsWith("crash:")) {
			if (scenario !== "crash:running") writeFileSync(join(root, "finish"), "", { mode: 0o600, flag: "wx" });
			await wait("cut-ready.json", mode);
			await kill(controller);
			const durable = registry.get("sa-real")!;
			expect(durable.status).toBe(scenario === "crash:running" ? "running" : "settling");
			expect(durable.child?.identity.pid).toBe(anchor.identity.pid);
			expect(durable.completionId).toBeNull();
			if (scenario === "crash:post-manifest") for (const name of ["result.json", "manifest.json"]) expect(existsSync(join(root, "task", name))).toBe(true);
			return;
		}
		if (scenario === "writer-death" || scenario === "expired-owner") {
			await kill(controller);
			const before = registry.get("sa-real")!;
			await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.max(before.writerLease!.expiresAt, before.controlLease?.expiresAt ?? 0) - Date.now() + 100)));
			const successor = scenario === "writer-death" ? "takeover" : "recover-lost";
			await start(successor);
			await wait(`${successor}-result.json`, successor);
			return;
		}
		if (scenario === "census") {
			expect(censusRetained(registry)[0]).toMatchObject({ launch: "verified", censusKnown: true });
			writeFileSync(join(root, "finish"), "", { mode: 0o600, flag: "wx" });
			await wait("pi-exited.json", mode);
			expect(censusRetained(registry)[0]).toMatchObject({ launch: "verified", censusKnown: true });
			expect(systemProcessTree.verificationMatches!(anchor.identity, anchor.verification)).toBe("same");
			writeFileSync(join(root, "census-release"), "", { mode: 0o600, flag: "wx" });
			return;
		}
		if (mode === "same-process") {
			const result = await wait("same-process-result.json", mode);
			if (result.error) throw new Error(result.error);
			expect(result.steering).toBe(backend === "visible" ? "consumed" : "unsupported: headless steering");
		} else {
			const origin = await start("origin");
			const lease = await wait("origin-ready.json", "owner");
			if (scenario === "persist-only") {
				await start("contender");
				await wait("contender-result.json", "contender");
				writeFileSync(join(root, "finish"), "", { mode: 0o600, flag: "wx" });
				await wait("owner-result.json", "owner");
				return;
			}
			expect((await signalVerifiedProcessTree(systemProcessTree, origin.identity, "SIGKILL", origin.verification)).ok).toBe(true);
			expect(await systemProcessTree.waitForTreeEmpty(origin.identity, 2000, origin.verification)).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, Math.max(0, lease.expiresAt! - Date.now() + 100)));
			if (scenario === "competing") {
				await start("race-first"); await start("race-second");
				await wait("race-first-ready.json", "race-first"); await wait("race-second-ready.json", "race-second");
				writeFileSync(join(root, "race-release"), "", { mode: 0o600, flag: "wx" });
				const first = await wait("race-first-result.json", "race-first");
				const second = await wait("race-second-result.json", "race-second");
				expect([first, second].filter((result) => result.recovery === "adopted")).toHaveLength(1);
				expect(registry.get("sa-real")?.controllerGeneration).toBe(1);
				writeFileSync(join(root, "finish"), "", { mode: 0o600, flag: "wx" });
				await wait("owner-result.json", "owner");
				return;
			}
			await start("successor");
			const result = await wait("successor-result.json", "successor");
			writeFileSync(join(root, "finish"), "", { mode: 0o600, flag: "wx" });
			await wait("owner-result.json", "owner");
			if (result.error) throw new Error(result.error);
			expect(result.steering).toBe(backend === "visible" ? "consumed" : "unsupported: headless steering");
		}
	} finally {
		const unresolved: OwnedTree[] = [];
		for (const tree of [...owned].reverse()) {
			if (!await cleanupOwnedTree(systemProcessTree, tree, (value) => appendFileSync(join(root, "cleanup.jsonl"), `${JSON.stringify(value)}\n`, { mode: 0o600 }))) unresolved.push(tree);
		}
		const failures: number[] = [];
		for (const tree of unresolved) {
			if (!await systemProcessTree.waitForTreeEmpty(tree.identity, 2_000, tree.verification)) failures.push(tree.identity.pid);
		}
		const census = systemProcessTree.census!();
		if (existsSync(join(root, "anchor-spawn.json"))) spawned.push(JSON.parse(readFileSync(join(root, "anchor-spawn.json"), "utf8")).pid);
		if (existsSync(join(root, "pane-shell-birth.json"))) {
			// SAFETY: private controller evidence detects missing registration, never new signal authority.
			const shell = JSON.parse(readFileSync(join(root, "pane-shell-birth.json"), "utf8")) as OwnedTree;
			spawned.push(shell.identity.pid);
		}
		const unregistered = spawned.filter((pid) => !owned.some((tree) => tree.identity.pid === pid));
		const paneUnverified = existsSync(join(root, "pane-launch-intent")) && !existsSync(join(root, "pane-shell-birth.json"));
		const zeroOwned = !paneUnverified && census !== undefined && failures.length === 0 && unregistered.length === 0 && owned.every((tree) =>
			systemProcessTree.isTreeEmpty(tree.identity, tree.verification) && !census.some((member) =>
				tree.verification.members.some((birth) => member.pid === birth.pid && member.processStartTime === birth.processStartTime)));
		writeFileSync(join(root, "zero-owned.json"), JSON.stringify({ zeroOwned, censusKnown: census !== undefined, groups: owned.length, failures, unregistered, paneUnverified }), { mode: 0o600 });
		process.stdout.write(`[plan112] zero-owned: ${zeroOwned}; ${owned.length} birth-registered groups; evidence: ${root}\n`);
		expect(zeroOwned, "zero-owned audit: unknown is not zero").toBe(true);
	}
}
