import { getEventListeners } from "node:events";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { cleanupHeadlessChild, type HeadlessCleanup } from "./headless-cleanup-effect.js";
import type { ProcessTreeOperations } from "../background-tasks/process-tree.js";

const fixture = Effect.fn("headlessCleanupTest.fixture")(function* () {
	const clock = yield* Clock.Clock;
	const close = new AbortController();
	let empty = false;
	let same = true;
	let sleepers = 0;
	const release = vi.fn();
	const beforeSignal = vi.fn();
	const signalTree = vi.fn<ProcessTreeOperations["signalTree"]>(async (_identity, signal) => {
		if (signal === "SIGKILL") empty = true;
		return { ok: true, gone: false };
	});
	const operations: ProcessTreeOperations = {
		captureStartTime: () => "birth",
		identityMatches: () => same ? "same" : "different",
		verificationMatches: () => same ? "same" : "different",
		isTreeEmpty: () => empty,
		signalTree,
		waitForTreeEmpty: async () => { throw new Error("unscoped wait used"); },
	};
	const options = {
		operations,
		tree: () => ({ identity: { pid: 4242, processGroupId: 4242, processStartTime: "birth" }, verification: { members: [{ pid: 4242, processStartTime: "birth" }] } }),
		beforeSignal,
		closed: () => close.signal.aborted,
		subscribeClose: (notify) => { close.signal.addEventListener("abort", notify); return () => close.signal.removeEventListener("abort", notify); },
		release,
	} satisfies HeadlessCleanup;
	const trackedClock: Clock.Clock = { ...clock, sleep: (duration) => Effect.sync(() => { sleepers++; }).pipe(
		Effect.andThen(clock.sleep(duration)), Effect.ensuring(Effect.sync(() => { sleepers--; })),
	) };
	const start = Effect.fn("headlessCleanupTest.start")(function* () {
		const fiber = yield* Effect.forkChild(Effect.exit(Effect.tryPromise({
			try: () => cleanupHeadlessChild(options, trackedClock),
			catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
		})));
		// WAIT-CLASS: clock-contract — enter the cleanup runtime without consuming the grace budget
		yield* TestClock.adjust(0);
		return fiber;
	});
	return { start, signalTree, beforeSignal, operations, options,
		empty: () => { empty = true; }, reused: () => { same = false; }, close: () => close.abort(),
		assertDrained: () => { expect(sleepers).toBe(0); expect(release).toHaveBeenCalledOnce(); expect(getEventListeners(close.signal, "abort")).toHaveLength(0); },
	};
});

it.effect("TERM, KILL and pipe close settle only after whole-tree-empty evidence", () => Effect.gen(function* () {
	const f = yield* fixture();
	const fiber = yield* f.start();
	expect(f.signalTree).toHaveBeenCalledTimes(1);
	// WAIT-CLASS: clock-contract — TERM gets exactly the existing five-second grace
	yield* TestClock.adjust(4999);
	expect(f.signalTree).toHaveBeenCalledTimes(1);
	// WAIT-CLASS: clock-contract — KILL starts at the grace boundary
	yield* TestClock.adjust(1);
	expect(f.signalTree.mock.calls.map((call) => call[1])).toEqual(["SIGTERM", "SIGKILL"]);
	expect(fiber.pollUnsafe()).toBeUndefined();
	f.close();
	expect(Exit.isSuccess(yield* Fiber.join(fiber))).toBe(true);
	f.assertDrained();
}));

it.effect("direct-child close does not cancel escalation over live descendants", () => Effect.gen(function* () {
	const f = yield* fixture();
	const fiber = yield* f.start();
	f.close();
	// WAIT-CLASS: clock-contract — descendants retain ownership after the leader closes
	yield* TestClock.adjust(5000);
	expect(Exit.isSuccess(yield* Fiber.join(fiber))).toBe(true);
	expect(f.signalTree).toHaveBeenCalledTimes(2);
	f.assertDrained();
}));

it.effect("tree-empty at TERM deadline suppresses KILL and drains once", () => Effect.gen(function* () {
	const f = yield* fixture();
	const fiber = yield* f.start();
	f.empty(); f.close();
	// WAIT-CLASS: clock-contract — the next inspection observes disappearance before escalation
	yield* TestClock.adjust(5000);
	expect(Exit.isSuccess(yield* Fiber.join(fiber))).toBe(true);
	expect(f.signalTree).toHaveBeenCalledTimes(1);
	f.assertDrained();
}));

it.effect.each(["reused", "unknown", "owner lost", "signal failed", "signal threw"])("%s refuses cleanup truthfully", (reason) => Effect.gen(function* () {
	const f = yield* fixture();
	if (reason === "reused") f.reused();
	if (reason === "unknown") f.operations.identityMatches = () => "unknown";
	if (reason === "unknown") f.operations.verificationMatches = () => "unknown";
	if (reason === "owner lost") f.beforeSignal.mockImplementation(() => { throw new Error("owner lost"); });
	if (reason === "signal failed") f.signalTree.mockResolvedValue({ ok: false, gone: false });
	if (reason === "signal threw") f.signalTree.mockRejectedValue(new Error("OS refused"));
	const fiber = yield* f.start();
	expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
	if (["reused", "unknown", "owner lost"].includes(reason)) expect(f.signalTree).not.toHaveBeenCalled();
	f.assertDrained();
}));

it.effect.each(["owner lost", "identity reused"])("%s between TERM and KILL prevents the later effect", (reason) => Effect.gen(function* () {
	const f = yield* fixture();
	const fiber = yield* f.start();
	if (reason === "owner lost") f.beforeSignal.mockImplementation(() => { throw new Error("owner lost"); });
	else f.reused();
	// WAIT-CLASS: clock-contract — the KILL boundary must inspect current authority, not TERM's snapshot.
	yield* TestClock.adjust(5000);
	expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
	expect(f.signalTree).toHaveBeenCalledTimes(1);
	f.assertDrained();
}));

it.effect("a stalled signal adapter has a bounded failure, not a successful cancellation", () => Effect.gen(function* () {
	const f = yield* fixture();
	f.signalTree.mockImplementation(() => new Promise(() => {}));
	const fiber = yield* f.start();
	// WAIT-CLASS: clock-contract — bound even an adapter that never reports its signal result.
	yield* TestClock.adjust(7000);
	expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
	expect(f.signalTree).toHaveBeenCalledTimes(1);
	f.assertDrained();
}));

it.effect("a gone signal cannot substitute for whole-tree-empty evidence", () => Effect.gen(function* () {
	const f = yield* fixture();
	f.signalTree.mockResolvedValue({ ok: true, gone: true });
	const fiber = yield* f.start();
	expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
	f.assertDrained();
}));

it.effect("KILL timeout leaves a visible failure and no sleeping fibers", () => Effect.gen(function* () {
	const f = yield* fixture();
	f.signalTree.mockResolvedValue({ ok: true, gone: false });
	const fiber = yield* f.start();
	// WAIT-CLASS: clock-contract — exhaust TERM and KILL without fabricating empty evidence
	yield* TestClock.adjust(6000);
	expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
	f.assertDrained();
}));

it.effect("a synchronous drain notification still releases its subscription", () => Effect.gen(function* () {
	const f = yield* fixture();
	f.empty();
	const unsubscribe = vi.fn();
	f.options.subscribeClose = (notify) => { notify(); return unsubscribe; };
	const fiber = yield* f.start();
	expect(Exit.isSuccess(yield* Fiber.join(fiber))).toBe(true);
	expect(unsubscribe).toHaveBeenCalledOnce();
	f.assertDrained();
}));

it.effect("pipe drainage is bounded after the verified group disappears", () => Effect.gen(function* () {
	const f = yield* fixture();
	f.empty();
	const fiber = yield* f.start();
	// WAIT-CLASS: clock-contract — unowned pipe holders cannot strand cleanup beyond one second
	yield* TestClock.adjust(1000);
	expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
	expect(f.signalTree).not.toHaveBeenCalled();
	f.assertDrained();
}));

it("diagnostic write failure cannot hide a public cleanup refusal", () => {
	const modulePath = fileURLToPath(new URL("./backend-pi.ts", import.meta.url));
	const directory = mkdtempSync(join(tmpdir(), "headless-diagnostic-failure-"));
	const stdout = execFileSync(process.execPath, ["--input-type=module", "--eval", `
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createJiti } from 'jiti';
const { createPiChildSpawner } = await createJiti(import.meta.url).import(${JSON.stringify(modulePath)});
const proc = Object.assign(new EventEmitter(), { pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: Object.assign(new EventEmitter(), {write() {}, end() {}}) });
const operations = { captureStartTime: () => 'command', captureTreeVerification: () => ({members:[{pid:4242,processStartTime:'birth'}]}), identityMatches: () => 'same', verificationMatches: () => 'same', isTreeEmpty: () => false, signalTree: async () => { throw new Error('OS refused'); } };
const child = createPiChildSpawner(() => proc, () => undefined, () => '/fixture/pi', () => undefined, operations)({prompt:'fixture',cwd:${JSON.stringify(directory)},inherited:{}});
const events = []; child.events((event) => events.push(event));
await assert.rejects(child.interrupt(), (error) => error instanceof Error && !('_tag' in error) && /cleanup/.test(error.message));
assert.equal(events.filter((event) => event.kind === 'run-settled').length, 1);
assert.equal(events.at(-1).outcome.kind, 'failed');
proc.emit('close', 1);
console.log('diagnostic failure did not hide cleanup refusal');
`], { encoding: "utf8", timeout: 5000, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, SUMO_TUI_DIAG_FILE: directory } });
	expect(stdout).toContain("diagnostic failure did not hide cleanup refusal");
}, 10_000);

it("headless cleanup waits do not keep an otherwise idle Node process alive", () => {
	const modulePath = fileURLToPath(new URL("./headless-cleanup-effect.ts", import.meta.url));
	const stdout = execFileSync(process.execPath, ["--input-type=module", "--eval", `
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const { cleanupHeadlessChild } = await createJiti(import.meta.url).import(${JSON.stringify(modulePath)});
let settled = false;
const operations = { identityMatches: () => 'same', isTreeEmpty: () => false, signalTree: async () => ({ok:true,gone:false}) };
void cleanupHeadlessChild({ operations, tree: () => ({ identity: {pid:4242}, verification: {members:[]} }), beforeSignal: () => {}, closed: () => false, subscribeClose: () => () => {}, release: () => {} }).finally(() => { settled = true; });
process.on('beforeExit', () => { assert.equal(settled, false); console.log('active cleanup exited naturally'); });
`], { encoding: "utf8", timeout: 5000, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR } });
	expect(stdout).toContain("active cleanup exited naturally");
}, 10_000);
