import * as fs from "node:fs";
import { RetainedResults } from "./retained-results.js";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentRegistry, type SubagentRecord, type RegistryWriter, type RegistryControlAuthority } from "./registry.js";

// oxlint-disable-next-line anti-slop/no-module-mocking -- OS fault seam: private fixtures use real fs except explicitly injected ownership/rename failures.
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>() }));

const writerA: RegistryWriter = { token: "writer-a", pid: 101, processStartTime: "birth-a" };
const writerB: RegistryWriter = { token: "writer-b", pid: 102, processStartTime: "birth-b" };

function foreignOwner(path: string): void {
	const lstat = fs.lstatSync;
	vi.spyOn(fs, "lstatSync").mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
		const stat = lstat(...args);
		if (stat && args[0] === path) stat.uid = Number(stat.uid) + 1;
		return stat;
	});
}

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sumocode-registry-")));
	chmodSync(root, 0o700);
	const taskDir = join(root, "task");
	mkdirSync(taskDir, { mode: 0o700 });
	const directory = join(root, "registry");
	const record: SubagentRecord = {
		schemaVersion: 2, revision: 1, id: "sa-proof", ownerSessionId: "session-a",
		backend: "headless", status: "starting", taskDir,
		child: null, supervisor: null, pane: null, worktree: null, sessionFilePath: null,
		modelLabel: null, roleId: null, createdAt: 1000, updatedAt: 1000, settledAt: null,
		completionId: null, outcome: null, delivery: { state: "none", claim: null },
		result: null, manifest: null, writerLease: null, controlLease: null, controlHead: 0,
	};
	return { root, directory, record };
}

function control(record: SubagentRecord): RegistryControlAuthority {
	return { id: record.id, ownerSessionId: record.ownerSessionId, controllerSessionId: record.controllerSessionId, controllerGeneration: record.controllerGeneration, generation: record.controlLease!.generation, owner: record.controlLease!.owner, head: record.controlHead };
}

describe("SubagentRegistry control authority", () => {
	it("reserves a successor controller without moving the live persistence writer", () => {
		const { directory, record } = fixture();
		const options = { now: () => 1000, inspectWriter: () => "alive" as const };
		const supervisor = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerA });
		const successor = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerB });
		supervisor.create(record);
		const held = supervisor.acquireWriter(record.id, 1, 1000);
		const granted = supervisor.acquireControl(record.id, held.revision, held.writerLease!.generation, 0, writerA, 1000);
		const reserved = supervisor.reserveControl(granted.revision, control(granted), `${record.id}:2`, {
			sessionId: "session-b", owner: writerB, writerGeneration: held.writerLease!.generation,
		});
		expect(reserved.writerLease).toEqual(held.writerLease);
		expect(supervisor.inspectControl(control(granted))).toBe(false);
		expect(() => successor.acquireControl(record.id, reserved.revision, 1, reserved.controlHead, writerB, 1000, "wrong-session")).toThrow();
		const adopted = successor.acquireControl(record.id, reserved.revision, 1, reserved.controlHead, writerB, 1000, "session-b");
		expect(adopted).toMatchObject({ controllerSessionId: "session-b", controllerGeneration: 1, controlReservation: null });
		expect(adopted.writerLease).toEqual(held.writerLease);
		expect(successor.inspectControl(control(adopted))).toBe(true);
		expect(() => successor.acquireControl(record.id, reserved.revision, 1, reserved.controlHead, writerB, 1000, "session-b")).toThrow();
		expect(() => successor.transition(record.id, adopted.revision, 1, (r) => r)).toThrow();
	});
	it.each(["renew", "takeover"] as const)("%s keeps reservations bound to their authorizing writer", (action) => {
		const { directory, record } = fixture();
		let now = 1000;
		const options = { now: () => now, inspectWriter: (owner: RegistryWriter) => now >= 2000 && owner.token === writerA.token ? "dead" as const : "alive" as const };
		const supervisor = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerA });
		const successor = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerB });
		supervisor.create(record);
		const held = supervisor.acquireWriter(record.id, 1, 1000);
		const granted = supervisor.acquireControl(record.id, held.revision, 1, 0, writerA, 500);
		const reserved = supervisor.reserveControl(granted.revision, control(granted), `${record.id}:2`, { sessionId: "session-b", owner: writerB, writerGeneration: 1 });
		now = action === "renew" ? 1200 : 2000;
		const fresh = (action === "renew" ? supervisor : successor).acquireWriter(record.id, reserved.revision, 1000);
		if (action === "takeover") {
			expect(fresh.controlReservation).toBeNull();
			expect(() => successor.acquireControl(record.id, fresh.revision, 2, 2, writerB, 1000, "session-b")).toThrow(/reservation/);
		} else {
			const adopted = successor.acquireControl(record.id, fresh.revision, 2, 2, writerB, 1000, "session-b");
			expect(adopted.writerLease).toEqual(fresh.writerLease);
			expect(adopted.controllerSessionId).toBe("session-b");
		}
	});

	it.each(["nonwriter", "unknown-successor", "stale-control", "expired-control", "wrong-identity", "unknown-writer", "dead-writer", "expired-writer"] as const)("blocks %s cooperative transfer with no publication", (failure) => {
		const { directory, record } = fixture();
		let now = 1000;
		let unknown: string | undefined;
		let dead: string | undefined;
		const options = { now: () => now, inspectWriter: (owner: RegistryWriter) => owner.token === unknown ? "unknown" as const : owner.token === dead ? "dead" as const : "alive" as const };
		const supervisor = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerA });
		const successor = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerB });
		supervisor.create(record);
		const held = supervisor.acquireWriter(record.id, 1, 1000);
		const granted = supervisor.acquireControl(record.id, held.revision, 1, 0, writerA, 500);
		if (["nonwriter", "unknown-successor", "stale-control", "expired-control"].includes(failure)) {
			if (failure === "unknown-successor") unknown = writerB.token;
			if (failure === "expired-control") now = 1500;
			const authority = { ...control(granted), head: failure === "stale-control" ? 0 : granted.controlHead };
			expect(() => (failure === "nonwriter" ? successor : supervisor).reserveControl(granted.revision, authority, `${record.id}:2`, {
				sessionId: "session-b", owner: writerB, writerGeneration: 1,
			})).toThrow();
			expect(supervisor.get(record.id)).toEqual(granted);
			return;
		}
		const reserved = supervisor.reserveControl(granted.revision, control(granted), `${record.id}:2`, { sessionId: "session-b", owner: writerB, writerGeneration: 1 });
		if (failure === "unknown-writer") unknown = writerA.token;
		if (failure === "dead-writer") dead = writerA.token;
		if (failure === "expired-writer") now = 2000;
		expect(() => successor.acquireControl(record.id, reserved.revision, 1, 2, failure === "wrong-identity" ? writerA : writerB, 1000, "session-b")).toThrow();
		expect(supervisor.get(record.id)).toEqual(reserved);
	});

	it("preserves the live supervisor writer when a dead manager's successor requests session handoff", () => {
		const { directory, record } = fixture();
		let now = 1000;
		const successorIdentity = { token: "successor", pid: 103, processStartTime: "birth-c" };
		const options = { now: () => now, inspectWriter: (owner: RegistryWriter) => owner.token === writerB.token ? "dead" as const : "alive" as const };
		const supervisor = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerA });
		const successor = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: successorIdentity });
		supervisor.create(record);
		const held = supervisor.acquireWriter(record.id, 1, 100);
		// Grant while the original manager is alive, then observe its death.
		const grantor = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerA, inspectWriter: () => "alive" });
		const granted = grantor.acquireControl(record.id, held.revision, held.writerLease!.generation, 0, writerB, 100);
		now = 1100;
		expect(() => successor.handoffController(record.id, granted.revision, 0, "session-b", 100)).toThrow(/controller lease is held/);
		expect(successor.get(record.id)).toEqual(granted);
		const renewed = supervisor.acquireWriter(record.id, granted.revision, 100);
		expect(renewed.writerLease?.owner).toEqual(writerA);
		expect(renewed.controllerSessionId).toBeUndefined();
	});

	it("explicitly hands controller identity to a successor only after writer death and expiry", () => {
		const { directory, record } = fixture();
		let now = 1000;
		let former: "alive" | "dead" | "unknown" = "alive";
		const options = { now: () => now, inspectWriter: (owner: RegistryWriter) => owner.token === writerA.token ? former : "alive" as const };
		const origin = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerA });
		const successor = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerB });
		origin.create(record);
		const first = origin.handoffController(record.id, 1, 0, "session-a", 100);
		expect(first).toMatchObject({ ownerSessionId: "session-a", controllerSessionId: "session-a", controllerGeneration: 1 });
		expect(() => successor.handoffController(record.id, first.revision, 1, "session-b", 100)).toThrow(/lease/);
		now = 1100;
		for (const state of ["alive", "unknown"] as const) {
			former = state;
			expect(() => successor.handoffController(record.id, first.revision, 1, "session-b", 100)).toThrow(/lease/);
		}
		former = "dead";
		expect(() => successor.handoffController(record.id, first.revision, 0, "session-b", 100)).toThrow(/controller/);
		const next = successor.handoffController(record.id, first.revision, 1, "session-b", 100);
		expect(next).toMatchObject({ ownerSessionId: "session-a", controllerSessionId: "session-b", controllerGeneration: 2, writerLease: { generation: 2 }, controlLease: { generation: 2 } });
		expect(origin.get(record.id)).toEqual(next);
		expect(successor.inspectControl(control(next))).toBe(true);
		expect(successor.inspectControl({ ...control(next), controllerSessionId: "session-a" })).toBe(false);
		expect(() => successor.handoffController(record.id, first.revision, 1, "session-c", 100)).toThrow(/revision/);
		expect(() => successor.transition(record.id, next.revision, 2, (r) => ({ ...r, controllerSessionId: "session-c" }))).toThrow(/immutable/);
		expect(() => origin.reserveControl(next.revision, control(first), `${record.id}:3`)).toThrow(/authority/);
	});

	it("round-trips optional budgets and durable telemetry without inventing legacy observations", () => {
		const { directory, record } = fixture();
		const options = { now: () => 2000, writerIdentity: writerA, inspectWriter: () => "alive" as const };
		const registry = new SubagentRegistry(directory, "session-a", options);
		registry.create({ ...record, budget: { tokens: 100, wallTimeMs: 5000 } });
		const held = registry.acquireWriter(record.id, 1, 1000);
		registry.transition(record.id, held.revision, held.writerLease!.generation, (r) => ({ ...r,
			telemetry: { startedAt: 1500, lastProgressAt: 2000, reportedTokens: 60, reportedCostUsd: 0.25 },
		}));
		const reopened = new SubagentRegistry(directory, "session-a", options).get(record.id);
		expect(reopened).toMatchObject({ budget: { tokens: 100, wallTimeMs: 5000 }, telemetry: { startedAt: 1500, lastProgressAt: 2000, reportedTokens: 60, reportedCostUsd: 0.25 } });
		const legacy = { ...record, id: "sa-legacy" };
		registry.create(legacy);
		expect(registry.get(legacy.id)).toEqual(legacy);
	});
	it.each([
		{ budget: { tokens: 0 } },
		{ telemetry: { startedAt: null, lastProgressAt: null, reportedTokens: Infinity } },
		{ telemetry: { startedAt: null, lastProgressAt: 1001 } },
		{ telemetry: { startedAt: null, lastProgressAt: null, prompt: "not metadata" } },
	])("rejects malformed budget telemetry %j", (patch) => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a");
		// SAFETY: deliberately malformed metadata exercises the JSON validation boundary.
		expect(() => registry.create({ ...record, ...patch } as SubagentRecord)).toThrow(/schema/);
	});

	it("preserves budget and monotone telemetry across writer transitions", () => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a", { now: () => 2000, writerIdentity: writerA, inspectWriter: () => "alive" });
		registry.create({ ...record, budget: { tokens: 100 }, telemetry: { startedAt: 1000, lastProgressAt: 1000, reportedTokens: 60 } });
		const held = registry.acquireWriter(record.id, 1, 1000);
		for (const patch of [{ budget: { tokens: 200 } }, { telemetry: undefined }, { telemetry: { startedAt: 1000, lastProgressAt: null, reportedTokens: 59 } }]) {
			expect(() => registry.transition(record.id, held.revision, held.writerLease!.generation, (r) => ({ ...r, ...patch }))).toThrow(/immutable|preserved/);
		}
		expect(registry.get(record.id)).toEqual(held);
	});

	it("does not let two same-session observers race into live control, even after expiry", () => {
		const { directory, record } = fixture();
		let now = 1000;
		let former: "alive" | "dead" | "unknown" = "alive";
		const options = { now: () => now, inspectWriter: (owner: RegistryWriter) => owner.token === writerB.token ? former : "alive" as const };
		const supervisor = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerA });
		const c = { token: "observer-c", pid: 103, processStartTime: "birth-c" };
		const bObserver = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerB });
		const cObserver = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: c });
		supervisor.create(record);
		supervisor.acquireWriter(record.id, 1, 1000);
		for (const observer of [bObserver, cObserver]) expect(() => observer.acquireControl(record.id, 2, 1, 0, c, 100)).toThrow(/lease/);
		const granted = supervisor.acquireControl(record.id, 2, 1, 0, writerB, 100);
		expect(() => supervisor.acquireControl(record.id, 2, 1, 0, c, 100)).toThrow(/revision/);
		expect(() => supervisor.acquireControl(record.id, 3, 1, 0, c, 100)).toThrow(/head/);
		former = "dead";
		expect(() => supervisor.acquireControl(record.id, 3, 1, 1, c, 100)).toThrow(/lease/);
		now = 1100;
		for (const state of ["alive", "unknown"] as const) {
			former = state;
			expect(() => supervisor.acquireControl(record.id, 3, 1, 1, c, 100)).toThrow(/lease/);
			expect(() => bObserver.reserveControl(3, control(granted), "sa-proof:2")).toThrow(/control/);
		}
		former = "dead";
		const adopted = supervisor.acquireControl(record.id, 3, 1, 1, c, 100);
		expect(adopted).toMatchObject({ controlHead: 2, controlLease: { generation: 2, owner: c }, writerLease: { generation: 1, owner: writerA } });
		expect(supervisor.inspectControl(control(granted))).toBe(false);
		expect(cObserver.reserveControl(4, control(adopted), "sa-proof:3").controlHead).toBe(3);
	});

	it("keeps post-ack authority through ordinary persistence heartbeats, not control changes", async () => {
		const { directory, record } = fixture();
		let now = 1000;
		const options = { now: () => now, inspectWriter: () => "alive" as const };
		const supervisor = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerA });
		const observer = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerB });
		supervisor.create(record);
		supervisor.acquireWriter(record.id, 1, 100);
		const granted = supervisor.acquireControl(record.id, 2, 1, 0, writerB, 1000);
		const reservation = observer.reserveControl(3, control(granted), "sa-proof:2");
		const ackFence = control(reservation);
		now = 1050;
		supervisor.acquireWriter(record.id, 4, 1000);
		supervisor.transition(record.id, 5, 2, (r) => ({ ...r, roleId: "persist-only" }));
		await Promise.resolve();
		expect(supervisor.inspectControl(ackFence)).toBe(true);
		expect(() => observer.reserveControl(4, ackFence, "sa-proof:3")).toThrow(/revision/);
		supervisor.releaseControl(6, 2, ackFence);
		expect(supervisor.inspectControl(ackFence)).toBe(false);
	});

	it("binds session, record, generation, token, PID and birth; null or missing control is never authority", () => {
		const { directory, record } = fixture();
		const options = { now: () => 1000, inspectWriter: () => "alive" as const, writerIdentity: writerA };
		const registry = new SubagentRegistry(directory, "session-a", options);
		registry.create(record);
		registry.acquireWriter(record.id, 1, 100);
		const guessed = { id: record.id, ownerSessionId: "session-a", head: 0, generation: 1, owner: writerA };
		expect(registry.inspectControl(guessed)).toBe(false);
		expect(() => registry.reserveControl(2, guessed, "sa-proof:1")).toThrow(/control/);
		const granted = registry.acquireControl(record.id, 2, 1, 0, writerA, 100);
		const authority = control(granted);
		for (const changed of [
			{ ownerSessionId: "session-b" }, { id: "sa-other" }, { generation: 2 }, { head: 0 },
			{ owner: { ...writerA, token: "other" } }, { owner: { ...writerA, pid: 103 } },
			{ owner: { ...writerA, processStartTime: "reused" } },
		]) {
			expect(registry.inspectControl({ ...authority, ...changed })).toBe(false);
			expect(() => registry.reserveControl(3, { ...authority, ...changed }, "sa-proof:2")).toThrow();
		}
		const wrongSession = new SubagentRegistry(directory, "session-b", options);
		expect(() => wrongSession.reserveControl(3, authority, "sa-proof:2")).toThrow(/owner/);
		for (const patch of [{ controlLease: undefined }, { controlHead: undefined }, { controlHead: -1 }, { controlHead: 0 }]) {
			writeFileSync(join(directory, "sa-proof.json"), JSON.stringify({ ...granted, ...patch }));
			expect(() => registry.inspectControl(authority)).toThrow(/corrupt/);
			expect(() => registry.reserveControl(3, authority, "sa-proof:2")).toThrow(/corrupt/);
		}
	});

	it("refuses expiry during control identity inspection before reserving an effect", () => {
		const { directory, record } = fixture();
		let now = 1000;
		let slow = false;
		const registry = new SubagentRegistry(directory, "session-a", {
			now: () => now, writerIdentity: writerA,
			inspectWriter: () => { if (slow) now = 1100; return "alive"; },
		});
		registry.create(record);
		registry.acquireWriter(record.id, 1, 1000);
		const granted = registry.acquireControl(record.id, 2, 1, 0, writerA, 100);
		slow = true;
		expect(() => registry.reserveControl(3, control(granted), "sa-proof:2")).toThrow(/control/);
		expect(registry.get(record.id)).toEqual(granted);
	});

	it("refuses a grant if inspection outlives its grantor or proposed deadline", () => {
		const { directory, record } = fixture();
		let now = 1000;
		let slow = false;
		const registry = new SubagentRegistry(directory, "session-a", {
			now: () => now, writerIdentity: writerA,
			inspectWriter: (owner) => { if (slow && owner.token === writerB.token) now = 1100; return "alive"; },
		});
		registry.create(record);
		registry.acquireWriter(record.id, 1, 100);
		slow = true;
		expect(() => registry.acquireControl(record.id, 2, 1, 0, writerB, 1000)).toThrow(/lease/);
		expect(registry.get(record.id)?.controlHead).toBe(0);
		now = 1000;
		registry.acquireWriter(record.id, 2, 1000);
		expect(() => registry.acquireControl(record.id, 3, 2, 0, writerB, 100)).toThrow(/lease/);
		expect(registry.get(record.id)?.controlHead).toBe(0);
	});

	it("reserves synchronously with no child effect under CAS, including competing instances and lost returns", () => {
		const { directory, record } = fixture();
		const options = { now: () => 1000, writerIdentity: writerA, inspectWriter: () => "alive" as const };
		const registry = new SubagentRegistry(directory, "session-a", options);
		const competitor = new SubagentRegistry(directory, "session-a", options);
		registry.create(record);
		registry.acquireWriter(record.id, 1, 100);
		const granted = registry.acquireControl(record.id, 2, 1, 0, writerA, 100);
		const authority = control(granted);
		const signal = vi.spyOn(process, "kill");
		const effect = vi.fn(() => {
			expect(readdirSync(directory)).not.toContain("sa-proof.json.lock");
			expect(registry.get(record.id)?.controlHead).toBe(2);
		});
		const rename = fs.renameSync;
		vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
			if (to !== join(directory, "sa-proof.json")) return rename(from, to);
			expect(effect).not.toHaveBeenCalled();
			expect(() => competitor.reserveControl(3, authority, "sa-proof:2")).toThrow(/lock/);
			return rename(from, to);
		});
		const reserved = registry.reserveControl(3, authority, "sa-proof:2");
		expect(reserved).not.toBeInstanceOf(Promise);
		// Signal 0 is the shared lock's read-only liveness probe, not a child effect.
		expect(signal.mock.calls.every(([, kind]) => kind === 0)).toBe(true);
		effect();
		expect(() => competitor.reserveControl(3, authority, "sa-proof:2")).toThrow(/revision/);
		vi.mocked(fs.renameSync).mockImplementation((from, to) => {
			rename(from, to);
			if (to === join(directory, "sa-proof.json")) throw new Error("lost return after committed rename");
		});
		expect(() => registry.reserveControl(4, control(reserved), "sa-proof:3")).toThrow(/lost return/);
		const reopened = competitor.get(record.id)!;
		expect(reopened.controlHead).toBe(3);
		expect(() => competitor.reserveControl(5, control(reopened), "sa-proof:3")).toThrow(/request/);
		expect(effect).toHaveBeenCalledTimes(1);
	});

	it("fails closed on head exhaustion rather than wrapping generations", () => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a", { now: () => 1000, writerIdentity: writerA, inspectWriter: () => "alive" });
		registry.create(record);
		registry.acquireWriter(record.id, 1, 100);
		const granted = registry.acquireControl(record.id, 2, 1, 0, writerA, 100);
		const exhausted = { ...granted, controlHead: Number.MAX_SAFE_INTEGER };
		writeFileSync(join(directory, "sa-proof.json"), JSON.stringify(exhausted));
		expect(() => registry.reserveControl(3, control(exhausted), "sa-proof:9007199254740992")).toThrow(/schema/);
		expect(() => registry.releaseControl(3, 1, control(exhausted))).toThrow(/schema/);
		expect(() => registry.acquireControl(record.id, 3, 1, exhausted.controlHead, writerA, 100)).toThrow(/schema/);
		expect(registry.get(record.id)).toEqual(exhausted);
	});

	it("keeps control fields immutable to ordinary writer transitions", () => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a", { now: () => 1000, writerIdentity: writerA, inspectWriter: () => "alive" });
		registry.create(record);
		registry.acquireWriter(record.id, 1, 100);
		const granted = registry.acquireControl(record.id, 2, 1, 0, writerA, 100);
		for (const patch of [{ controlLease: null }, { controlHead: 0 }]) {
			expect(() => registry.transition(record.id, 3, 1, (r) => ({ ...r, ...patch }))).toThrow(/immutable/);
		}
		expect(registry.get(record.id)).toEqual(granted);
	});

	it("requires explicit writer revocation and never resets generations on release/reacquire", () => {
		const { directory, record } = fixture();
		const options = { now: () => 1000, inspectWriter: () => "alive" as const };
		const supervisor = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerA });
		const observer = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerB });
		supervisor.create(record);
		supervisor.acquireWriter(record.id, 1, 100);
		const first = control(supervisor.acquireControl(record.id, 2, 1, 0, writerB, 100));
		expect(() => observer.releaseControl(3, 1, first)).toThrow(/lease/);
		expect(() => supervisor.releaseControl(3, 1, { ...first, head: 0 })).toThrow(/control/);
		const released = supervisor.releaseControl(3, 1, first);
		expect(released).toMatchObject({ controlLease: null, controlHead: 2, writerLease: { owner: writerA, generation: 1 } });
		expect(supervisor.inspectControl({ ...first, head: 2 })).toBe(false);
		expect(() => observer.reserveControl(4, { ...first, head: 2 }, "sa-proof:3")).toThrow(/control/);
		const reacquired = supervisor.acquireControl(record.id, 4, 1, 2, writerB, 100);
		expect(reacquired.controlLease?.generation).toBe(3);
		expect(supervisor.inspectControl({ ...first, head: 3 })).toBe(false);
		expect(() => observer.reserveControl(5, { ...first, head: 3 }, "sa-proof:4")).toThrow(/control/);
		expect(() => supervisor.releaseControl(5, 1, { ...first, head: 3 })).toThrow(/control/);
		expect(observer.reserveControl(5, control(reacquired), "sa-proof:4").controlHead).toBe(4);
	});

	it("consumes a structural request slot before effects and fences replay without a receipt history", () => {
		const { directory, record } = fixture();
		const options = { now: () => 1000, inspectWriter: () => "alive" as const };
		const supervisor = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerA });
		const observer = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerB });
		supervisor.create(record);
		supervisor.acquireWriter(record.id, 1, 100);
		const authority = control(supervisor.acquireControl(record.id, 2, 1, 0, writerB, 100));
		expect(() => supervisor.reserveControl(3, authority, "sa-proof:2")).toThrow(/lease/);
		expect(() => observer.reserveControl(2, authority, "sa-proof:2")).toThrow(/revision/);
		expect(() => observer.reserveControl(3, { ...authority, head: 0 }, "sa-proof:1")).toThrow(/control/);
		expect(() => observer.reserveControl(3, authority, "private prompt text")).toThrow(/request/);
		const reserved = observer.reserveControl(3, authority, "sa-proof:2");
		expect(reserved).toMatchObject({ revision: 4, controlHead: 2, controlLease: { generation: 1 } });
		expect(supervisor.inspectControl(control(reserved))).toBe(true);
		expect(supervisor.inspectControl(authority)).toBe(false);
		expect(() => observer.reserveControl(4, authority, "sa-proof:2")).toThrow(/control/);
		expect(() => observer.reserveControl(4, control(reserved), "sa-proof:2")).toThrow(/request/);
		const next = observer.reserveControl(4, control(reserved), "sa-proof:3");
		expect(() => observer.reserveControl(5, control(next), "sa-proof:2")).toThrow(/request/);
		expect(readFileSync(join(directory, "sa-proof.json"), "utf8")).not.toContain("private prompt text");
	});

	it("bootstraps unowned, then lets only the acquired writer explicitly grant separate control", () => {
		const { directory, record } = fixture();
		const options = { now: () => 1000, inspectWriter: () => "alive" as const };
		const parent = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerB });
		const controller = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerA });
		expect(parent.create(record)).toMatchObject({ writerLease: null, supervisor: null, child: null, controlLease: null, controlHead: 0 });
		expect(() => parent.acquireControl(record.id, 1, 1, 0, writerB, 100)).toThrow(/lease/);
		controller.acquireWriter(record.id, 1, 100);
		expect(() => parent.acquireControl(record.id, 2, 1, 0, writerB, 100)).toThrow(/lease/);
		const granted = controller.acquireControl(record.id, 2, 1, 0, writerB, 100);
		expect(granted).toMatchObject({ revision: 3, writerLease: { owner: writerA }, controlLease: { owner: writerB, generation: 1 }, controlHead: 1 });
		expect(() => parent.transition(record.id, 3, 1, (r) => r)).toThrow(/lease/);
	});
});

describe("SubagentRegistry writer CAS", () => {
	it("uses epoch deadlines, refuses rollback and fences old generations after renewal", () => {
		const { directory, record } = fixture();
		let now = 1000;
		const registry = new SubagentRegistry(directory, "session-a", { now: () => now, writerIdentity: writerA, inspectWriter: () => "alive" });
		registry.create(record);
		registry.acquireWriter(record.id, 1, 100);
		now = 999;
		expect(() => registry.acquireWriter(record.id, 2, 100)).toThrow(/clock/);
		now = 1100;
		expect(() => registry.transition(record.id, 2, 1, (r) => r)).toThrow(/expired/);
		const renewed = registry.acquireWriter(record.id, 2, 100);
		expect(renewed.writerLease).toMatchObject({ generation: 2, renewedAt: 1100, expiresAt: 1200 });
		expect(() => registry.transition(record.id, 3, 1, (r) => r)).toThrow(/lease/);
		expect(() => registry.transition(record.id, 3, 2, (r) => { now = 1200; return r; })).toThrow(/expired/);
		expect(registry.get(record.id)?.revision).toBe(3);
		for (const duration of [0, -1, 0.1, NaN, Infinity, 60001]) expect(() => registry.acquireWriter(record.id, 3, duration)).toThrow();
		now = NaN;
		expect(() => registry.acquireWriter(record.id, 3, 100)).toThrow(/clock/);
	});

	it("checks PID/birth/token together and rejects unverifiable candidates", () => {
		const { directory, record } = fixture();
		const options = { now: () => 1000, inspectWriter: () => "alive" as const };
		const a = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerA });
		a.create(record);
		a.acquireWriter(record.id, 1, 100);
		for (const changed of [{ token: "different" }, { pid: 103 }, { processStartTime: "reused-pid" }]) {
			const contender = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: { ...writerA, ...changed } });
			expect(() => contender.transition(record.id, 2, 1, (r) => r)).toThrow(/lease/);
		}
		const unknown = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerA, inspectWriter: () => "unknown" });
		expect(() => unknown.acquireWriter(record.id, 2, 100)).toThrow(/identity/);
		const wrongOwner = new SubagentRegistry(directory, "session-b", { ...options, writerIdentity: writerA });
		expect(() => wrongOwner.acquireWriter(record.id, 2, 100)).toThrow(/owner/);
	});

	it("uses the existing kernel birth probe, never a PID-only writer credential", () => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a", { now: () => 1000 });
		registry.create(record);
		const forged = new SubagentRegistry(directory, "session-a", { now: () => 1000, writerIdentity: { token: "forged", pid: process.pid, processStartTime: "wrong birth" } });
		expect(() => forged.acquireWriter(record.id, 1, 100)).toThrow(/identity/);
		const acquired = registry.acquireWriter(record.id, 1, 100);
		expect(acquired.writerLease?.owner.pid).toBe(process.pid);
		expect(acquired.writerLease?.owner.processStartTime).not.toBe("wrong birth");
	});

	it("holds the disk lock through the callback, rejecting a competing store before either writes", () => {
		const { directory, record } = fixture();
		const options = { now: () => 1000, writerIdentity: writerA, inspectWriter: () => "alive" as const };
		const a = new SubagentRegistry(directory, "session-a", options);
		const b = new SubagentRegistry(directory, "session-a", options);
		a.create(record);
		a.acquireWriter(record.id, 1, 100);
		const result = a.transition(record.id, 2, 1, (r) => {
			expect(() => b.acquireWriter(record.id, 2, 100)).toThrow(/lock/);
			expect(b.get(record.id)?.revision).toBe(2);
			return { ...r, roleId: "winner" };
		});
		expect(result.revision).toBe(3);
		expect(b.get(record.id)?.roleId).toBe("winner");
	});

	it("preserves durable process/worktree/completion evidence and keeps unknown recovery truthful", () => {
		const { directory, record } = fixture();
		const options = { now: () => 1000, writerIdentity: writerA, inspectWriter: () => "alive" as const };
		const registry = new SubagentRegistry(directory, "session-a", options);
		registry.create(record);
		registry.acquireWriter(record.id, 1, 100);
		const child = { identity: { pid: 200, processGroupId: 200, processStartTime: "birth + nonce" }, verification: { members: [{ pid: 200, processStartTime: "birth" }] } };
		const supervisor = { identity: { pid: 201, processGroupId: 201, processStartTime: "supervisor + nonce" }, verification: { members: [{ pid: 201, processStartTime: "supervisor" }] } };
		registry.transition(record.id, 2, 1, (r) => ({ ...r, status: "running", child, supervisor, worktree: { path: record.taskDir, repoRoot: record.taskDir, baseRef: "base", branch: "sumo/proof" } }));
		const lost = registry.transition(record.id, 3, 1, (r) => ({ ...r, status: "lost" }));
		expect(lost).toMatchObject({ child, supervisor, completionId: null, outcome: null, settledAt: null, result: null });
		expect(() => registry.transition(record.id, 4, 1, (r) => ({ ...r, child: null }))).toThrow(/preserved/);
		expect(() => registry.transition(record.id, 4, 1, (r) => ({ ...r, ownerSessionId: "other" }))).toThrow(/immutable/);
		const settled = registry.transition(record.id, 4, 1, (r) => ({ ...r, status: "settled", settledAt: 1000, outcome: "failed", completionId: "completion-1", delivery: { state: "undelivered" } }));
		expect(new SubagentRegistry(directory, "session-a").get(record.id)).toEqual(settled);
		expect(() => registry.transition(record.id, 5, 1, (r) => ({ ...r, completionId: "completion-2" }))).toThrow(/preserved/);
		const ambiguous = registry.transition(record.id, 5, 1, (r) => ({ ...r, status: "ambiguous" }));
		expect(ambiguous.completionId).toBe("completion-1");
	});

	it("fences competing revisions and generations; expiry alone never evicts a live writer", () => {
		const { directory, record } = fixture();
		let now = 1000;
		let oldState: "alive" | "dead" | "unknown" = "alive";
		const options = { now: () => now, inspectWriter: (owner: RegistryWriter) => owner.token === writerA.token ? oldState : "alive" as const };
		const a = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerA });
		const b = new SubagentRegistry(directory, "session-a", { ...options, writerIdentity: writerB });
		a.create(record);
		const first = a.acquireWriter(record.id, 1, 100);
		expect(first.revision).toBe(2);
		expect(first.writerLease).toEqual({ owner: writerA, generation: 1, renewedAt: 1000, expiresAt: 1100 });
		expect(() => b.acquireWriter(record.id, 1, 100)).toThrow(/revision/);
		expect(() => b.transition(record.id, 2, 1, (r) => ({ ...r, roleId: "reviewer" }))).toThrow(/lease/);
		expect(() => b.acquireWriter(record.id, 2, 100)).toThrow(/lease/);
		oldState = "dead";
		expect(() => b.acquireWriter(record.id, 2, 100)).toThrow(/lease/);
		now = 1100;
		oldState = "alive";
		expect(() => b.acquireWriter(record.id, 2, 100)).toThrow(/lease/);
		oldState = "unknown";
		expect(() => b.acquireWriter(record.id, 2, 100)).toThrow(/lease/);
		oldState = "dead";
		const second = b.acquireWriter(record.id, 2, 100);
		expect(second.revision).toBe(3);
		expect(second.writerLease?.generation).toBe(2);
		expect(() => a.transition(record.id, 3, 1, (r) => r)).toThrow(/lease/);
		const updated = b.transition(record.id, 3, 2, (r) => ({ ...r, roleId: "reviewer" }));
		expect(updated).toMatchObject({ revision: 4, updatedAt: 1100, roleId: "reviewer" });
		expect(() => b.transition(record.id, 3, 2, (r) => r)).toThrow(/revision/);
		expect(new SubagentRegistry(directory, "session-a").get(record.id)).toEqual(updated);
	});
});

afterEach(() => { vi.restoreAllMocks(); });

describe("SubagentRegistry private records", () => {
	it("preserves schema1 experiment files and explicitly refuses unsupported authority upgrades", () => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a");
		registry.create(record);
		const path = join(directory, "sa-proof.json");
		const legacy = JSON.stringify({ ...record, schemaVersion: 1, controlLease: undefined, controlHead: undefined });
		writeFileSync(path, legacy);
		expect(() => registry.get(record.id)).toThrow(/unsupported.*version/);
		expect(() => registry.acquireControl(record.id, 1, 1, 0, writerA, 100)).toThrow(/unsupported.*version/);
		expect(readFileSync(path, "utf8")).toBe(legacy);
	});

	it("refuses launched evidence at creation and completion claims without an observed outcome", () => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a", { writerIdentity: writerA, now: () => 1000, inspectWriter: () => "alive" });
		const child = { identity: { pid: 200, processGroupId: 200, processStartTime: "birth + launch nonce" }, verification: { members: [{ pid: 200, processStartTime: "birth" }] } };
		expect(() => registry.create({ ...record, child })).toThrow();
		registry.create(record);
		registry.acquireWriter(record.id, 1, 100);
		expect(() => registry.transition(record.id, 2, 1, (r) => ({ ...r, status: "settled", settledAt: 1000, completionId: "completion-a", delivery: { state: "undelivered" } }))).toThrow(/schema/);
		expect(registry.get(record.id)?.revision).toBe(2);
	});

	it.each([
		{ schemaVersion: 1 }, { revision: 0 }, { revision: 1.5 }, { id: "sa-other" },
		{ prompt: "private prompt must not be metadata" }, { "": "hidden payload" }, { status: "done" },
		{ backend: {} }, { createdAt: -1 }, { updatedAt: 999 }, { completionId: "fake" },
		{ delivery: { state: "claimed", claim: null } }, { child: { identity: { pid: 2 } } },
		{ modelLabel: "x".repeat(4097) }, { taskDir: "/tmp/../escape" },
		{ result: { file: "../result.json", bytes: 0 } }, { manifest: { file: "manifest.json", bytes: 4194305 } },
	])("preserves and refuses corrupt schema %j on read and write", (patch) => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a", { writerIdentity: writerA, now: () => 1000, inspectWriter: () => "alive" });
		registry.create(record);
		const path = join(directory, "sa-proof.json");
		const corrupt = JSON.stringify({ ...record, ...patch });
		writeFileSync(path, corrupt, { mode: 0o600 });
		expect(() => registry.get(record.id)).toThrow();
		expect(() => registry.acquireWriter(record.id, 1, 100)).toThrow();
		expect(readFileSync(path, "utf8")).toBe(corrupt);
	});

	it("refuses truncated and oversized documents without replacing their evidence", () => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a");
		registry.create(record);
		const path = join(directory, "sa-proof.json");
		for (const content of ["{", " ".repeat(262145)]) {
			writeFileSync(path, content);
			expect(() => registry.get(record.id)).toThrow();
			expect(() => registry.create(record)).toThrow();
			expect(readFileSync(path, "utf8")).toBe(content);
		}
	});

	it("refuses symlinked roots, ancestors, records, task directories and result artifacts", () => {
		const { root, directory, record } = fixture();
		const alias = join(root, "alias");
		symlinkSync(root, alias);
		expect(() => new SubagentRegistry(alias, "session-a")).toThrow();
		expect(() => new SubagentRegistry(join(alias, "new-registry"), "session-a")).toThrow();
		const registry = new SubagentRegistry(directory, "session-a");
		const target = join(root, "foreign.json");
		writeFileSync(target, "untouched", { mode: 0o600 });
		symlinkSync(target, join(directory, "sa-proof.json"));
		expect(() => registry.create(record)).toThrow();
		expect(() => registry.get(record.id)).toThrow();
		expect(() => registry.create({ ...record, id: "sa-alias", taskDir: alias })).toThrow();
		expect(readFileSync(target, "utf8")).toBe("untouched");
	});

	it("refuses widened and foreign-owned paths rather than chmod-repairing them", () => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a");
		registry.create(record);
		const path = join(directory, "sa-proof.json");
		chmodSync(path, 0o644);
		expect(() => registry.get(record.id)).toThrow();
		expect(statSync(path).mode & 0o777).toBe(0o644);
		chmodSync(path, 0o600);
		foreignOwner(path);
		expect(() => registry.get(record.id)).toThrow(/owned/);
		vi.restoreAllMocks();
		chmodSync(directory, 0o755);
		expect(() => new SubagentRegistry(directory, "session-a")).toThrow();
		expect(statSync(directory).mode & 0o777).toBe(0o755);
	});

	it("preserves foreign-owned lock evidence instead of reclaiming it by PID", () => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a", { writerIdentity: writerA, now: () => 1000, inspectWriter: () => "alive" });
		registry.create(record);
		const path = join(directory, "sa-proof.json.lock");
		const content = JSON.stringify({ schemaVersion: 1, token: "foreign", pid: process.pid, processStartTime: "not-current-birth" });
		writeFileSync(path, content, { mode: 0o600 });
		foreignOwner(path);
		expect(() => registry.acquireWriter(record.id, 1, 100)).toThrow(/owned/);
		expect(readFileSync(path, "utf8")).toBe(content);
		expect(registry.get(record.id)?.revision).toBe(1);
	});

	it.each([false, true])("reopens the atomic canonical revision after rename failure (committed=%s), retaining crash debris", (committed) => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a", { writerIdentity: writerA, now: () => 1000, inspectWriter: () => "alive" });
		registry.create(record);
		const debris = join(directory, ".crashed-writer.tmp");
		writeFileSync(debris, "{partial", { mode: 0o600 });
		const rename = fs.renameSync;
		vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
			if (to !== join(directory, "sa-proof.json")) return rename(from, to);
			if (committed) rename(from, to);
			throw new Error("injected rename failure");
		});
		expect(() => registry.acquireWriter(record.id, 1, 100)).toThrow(/injected/);
		vi.restoreAllMocks();
		const reopened = new SubagentRegistry(directory, "session-a").get(record.id);
		expect(reopened?.revision).toBe(committed ? 2 : 1);
		expect(reopened?.writerLease?.generation ?? null).toBe(committed ? 1 : null);
		expect(readFileSync(debris, "utf8")).toBe("{partial");
		expect(readdirSync(directory)).toContain(".crashed-writer.tmp");
	});

	it("round-trips bounded private result pointers, rejecting replaced or missing evidence", () => {
		const { root, directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a", { writerIdentity: writerA, now: () => 1000, inspectWriter: () => "alive" });
		registry.create(record);
		registry.acquireWriter(record.id, 1, 100);
		const content = JSON.stringify({ finalText: "private result" });
		const resultPath = join(record.taskDir, "result.json");
		writeFileSync(resultPath, content, { mode: 0o600 });
		const result = { file: "result.json" as const, bytes: Buffer.byteLength(content) };
		const settled = registry.transition(record.id, 2, 1, (r) => ({ ...r, status: "settled", settledAt: 1000, outcome: "completed", completionId: "completion-1", delivery: { state: "undelivered" }, result }));
		expect(new SubagentRegistry(directory, "session-a").get(record.id)).toEqual(settled);
		expect(readFileSync(join(directory, "sa-proof.json"), "utf8")).not.toContain("private result");
		fs.renameSync(resultPath, join(root, "preserved-result.json"));
		expect(() => registry.get(record.id)).toThrow();
		symlinkSync(join(root, "preserved-result.json"), resultPath);
		expect(() => registry.get(record.id)).toThrow(/regular/);
		expect(readFileSync(join(root, "preserved-result.json"), "utf8")).toBe(content);
	});

	it.each(["{", JSON.stringify({ schemaVersion: 99 }), JSON.stringify({ schemaVersion: 1, token: "broken", pid: -1 })])("preserves corrupt lock %s without attempting takeover", (content) => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a");
		registry.create(record);
		const path = join(directory, "sa-proof.json.lock");
		writeFileSync(path, content, { mode: 0o600 });
		expect(() => registry.acquireWriter(record.id, 1, 100)).toThrow();
		expect(readFileSync(path, "utf8")).toBe(content);
		expect(registry.get(record.id)?.revision).toBe(1);
	});

	it.each([
		{ generation: 0, owner: writerA, renewedAt: 1000, expiresAt: 1100 },
		{ generation: 1, owner: { ...writerA, processStartTime: null }, renewedAt: 1000, expiresAt: 1100 },
		{ generation: 1, owner: writerA, renewedAt: 1000, expiresAt: 1000 },
		{ generation: 1, owner: writerA, renewedAt: 1001, expiresAt: 1100 },
	])("refuses corrupt durable writer leases %j", (writerLease) => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a");
		registry.create(record);
		const path = join(directory, "sa-proof.json");
		const content = JSON.stringify({ ...record, writerLease });
		writeFileSync(path, content);
		expect(() => registry.acquireWriter(record.id, 1, 100)).toThrow(/corrupt/);
		expect(readFileSync(path, "utf8")).toBe(content);
	});

	it("preserves visible pane/session references and a lost record whose task directory is gone", () => {
		const { root, directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a", { writerIdentity: writerA, now: () => 1000, inspectWriter: () => "alive" });
		const pane = { agentName: "worker", workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-1" };
		registry.create({ ...record, backend: "visible", pane, sessionFilePath: join(record.taskDir, "session.jsonl") });
		registry.acquireWriter(record.id, 1, 100);
		const lost = registry.transition(record.id, 2, 1, (r) => ({ ...r, status: "lost" }));
		fs.renameSync(record.taskDir, join(root, "preserved-task"));
		expect(new SubagentRegistry(directory, "session-a").get(record.id)).toEqual(lost);
		expect(lost).toMatchObject({ pane, child: null, supervisor: null, completionId: null, outcome: null });
	});

	it.each([
		[{ pid: 200, processStartTime: "birth" }, { pid: 200, processStartTime: "duplicate" }],
		[{ pid: 201, processStartTime: "not-leader" }],
		[{ pid: 200, processStartTime: "" }],
		[],
	].map((members) => ({ members })))("rejects incomplete or duplicate process anchors %j", ({ members }) => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a", { writerIdentity: writerA, now: () => 1000, inspectWriter: () => "alive" });
		registry.create(record);
		registry.acquireWriter(record.id, 1, 100);
		const child = { identity: { pid: 200, processGroupId: 200, processStartTime: "birth + nonce" }, verification: { members } };
		expect(() => registry.transition(record.id, 2, 1, (r) => ({ ...r, child }))).toThrow(/schema/);
		expect(registry.get(record.id)?.child).toBeNull();
	});

	it("bounds the serialized document, including atomic writer formatting, before publication", () => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a", { writerIdentity: writerA, now: () => 1000, inspectWriter: () => "alive" });
		registry.create(record);
		registry.acquireWriter(record.id, 1, 100);
		const child = {
			identity: { pid: 200, processGroupId: 200, processStartTime: "birth + nonce" },
			verification: { members: Array.from({ length: 2200 }, (_, index) => ({ pid: 200 + index, processStartTime: "b".repeat(64) })) },
		};
		expect(Buffer.byteLength(JSON.stringify({ ...record, child }))).toBeLessThan(262144);
		expect(Buffer.byteLength(JSON.stringify({ ...record, child }, null, 2))).toBeGreaterThan(262144);
		expect(() => registry.transition(record.id, 2, 1, (r) => ({ ...r, child }))).toThrow(/schema/);
		expect(registry.get(record.id)?.revision).toBe(2);
	});

	it("requires a private parent so another user cannot rename the registry during a write", () => {
		const { root, directory } = fixture();
		chmodSync(root, 0o777);
		try { expect(() => new SubagentRegistry(directory, "session-a")).toThrow(); }
		finally { chmodSync(root, 0o700); }
	});

	it("round-trips a versioned unlaunched record without inventing process or completion evidence", () => {
		const { directory, record } = fixture();
		const registry = new SubagentRegistry(directory, "session-a");
		expect(registry.create(record)).toEqual(record);
		expect(new SubagentRegistry(directory, "session-a").get(record.id)).toEqual(record);
		expect(statSync(directory).mode & 0o777).toBe(0o700);
		expect(statSync(join(directory, "sa-proof.json")).mode & 0o777).toBe(0o600);
		expect(() => registry.create(record)).toThrow();
		expect(() => new SubagentRegistry(directory, "session-b").get(record.id)).toThrow(/owner/);
	});
});

describe("worktree result disposition", () => {
	function completed() {
		const f = fixture();
		const registry = new SubagentRegistry(f.directory, "session-a", { now: () => 1000, inspectWriter: () => "alive", writerIdentity: writerA });
		const worktree = { path: f.root, repoRoot: f.root, branch: "sumo/child", baseRef: "a".repeat(40) };
		registry.create({ ...f.record, worktree });
		const held = registry.acquireWriter(f.record.id, 1, 60_000);
		const artifacts = new RetainedResults(f.record.taskDir);
		artifacts.append({ kind: "run-started" });
		const result = artifacts.writeResult({ kind: "completed", finalText: "answer" });
		const manifest = artifacts.writeManifest({ baseRef: worktree.baseRef, headRef: "b".repeat(40), branch: worktree.branch,
			worktreePath: worktree.path, changedPaths: ["file.txt"], dirty: false, commits: 1, exit: "completed", durationMs: 1 });
		const record = registry.transition(f.record.id, held.revision, 1, (value) => ({ ...value, status: "settled", settledAt: 1000,
			completionId: "completion-once", outcome: "completed", result: result.pointer, manifest, delivery: { state: "undelivered" } }));
		return { ...f, registry, record };
	}
	it("persists inspected state separately from immutable completion and writer authority", () => {
		const f = completed();
		const before = readFileSync(join(f.directory, `${f.record.id}.json`));
		expect(f.registry.worktreeResult(f.record.id)).toMatchObject({ id: f.record.id, completionId: "completion-once", disposition: "unreviewed", dispositionRevision: 0 });
		f.registry.setWorktreeDisposition(f.record.id, "completion-once", 0, "inspected");
		const reopened = new SubagentRegistry(f.directory, "session-a");
		expect(reopened.worktreeResult(f.record.id)).toMatchObject({ disposition: "inspected", dispositionRevision: 1 });
		expect(readFileSync(join(f.directory, `${f.record.id}.json`))).toEqual(before);
		expect(statSync(join(f.directory, `${f.record.id}.disposition.json`)).mode & 0o777).toBe(0o600);
	});
	it("rejects stale identity, backward and unreviewed destructive transitions", () => {
		const f = completed();
		expect(() => f.registry.setWorktreeDisposition(f.record.id, "other-completion", 0, "inspected")).toThrow();
		expect(() => f.registry.setWorktreeDisposition(f.record.id, "completion-once", 0, "pruned")).toThrow();
		f.registry.setWorktreeDisposition(f.record.id, "completion-once", 0, "inspected");
		expect(() => f.registry.setWorktreeDisposition(f.record.id, "completion-once", 0, "applied")).toThrow();
		f.registry.setWorktreeDisposition(f.record.id, "completion-once", 1, "applied");
		expect(() => f.registry.setWorktreeDisposition(f.record.id, "completion-once", 2, "inspected")).toThrow();
		f.registry.setWorktreeDisposition(f.record.id, "completion-once", 2, "dismissed");
		f.registry.setWorktreeDisposition(f.record.id, "completion-once", 3, "pruned");
		expect(() => f.registry.setWorktreeDisposition(f.record.id, "completion-once", 4, "applied")).toThrow();
	});
	it("dismiss changes only metadata and corrupted disposition cannot reset review state", () => {
		const f = completed();
		const artifacts = ["result.json", "manifest.json"].map((name) => readFileSync(join(f.record.taskDir, name)));
		f.registry.setWorktreeDisposition(f.record.id, "completion-once", 0, "dismissed");
		expect(f.registry.worktreeResult(f.record.id)?.disposition).toBe("dismissed");
		const path = join(f.directory, `${f.record.id}.disposition.json`);
		writeFileSync(path, "{broken", { mode: 0o600 });
		expect(() => f.registry.worktreeResult(f.record.id)).toThrow();
		expect(() => f.registry.setWorktreeDisposition(f.record.id, "completion-once", 0, "inspected")).toThrow();
		expect(readFileSync(path, "utf8")).toBe("{broken");
		expect(["result.json", "manifest.json"].map((name) => readFileSync(join(f.record.taskDir, name)))).toEqual(artifacts);
	});
	it("does not expose a running or shared-checkout task as a worktree result", () => {
		const f = fixture();
		const registry = new SubagentRegistry(f.directory, "session-a");
		registry.create(f.record);
		expect(registry.worktreeResult(f.record.id)).toBeUndefined();
		expect(() => registry.setWorktreeDisposition(f.record.id, "missing", 0, "dismissed")).toThrow();
	});
});
