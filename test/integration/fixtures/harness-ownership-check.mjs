import assert from "node:assert/strict";
import { reapHarnessProcessGroup } from "../../../scripts/preflight-integration.mjs";
import {
	HARNESS_OWNER_TOKEN_ENV_KEY,
	HARNESS_SIGNATURE,
	HARNESS_SIGNATURE_ENV_KEY,
} from "../../../scripts/lib/integration-harness-constants.mjs";

const token = "fake-owner-token";
const registration = {
	pid: 60_001,
	pgid: 60_001,
	processStart: "leader-start",
	ownerPid: 59_001,
	ownerProcessStart: "owner-start",
	ownerToken: token,
	ownershipMode: "shared",
};
const marker = `${HARNESS_SIGNATURE_ENV_KEY}=${HARNESS_SIGNATURE} ${HARNESS_OWNER_TOKEN_ENV_KEY}=${token}`;
const owner = { pid: registration.ownerPid, ppid: 58_001, pgid: 58_001, command: `${marker} node worker.js` };
const leader = { pid: registration.pid, ppid: owner.pid, pgid: registration.pgid, command: "pi" };
const member = { pid: 60_002, ppid: leader.pid, pgid: registration.pgid, command: "pi" };
const starts = new Map([
	[registration.pid, registration.processStart],
	[registration.ownerPid, registration.ownerProcessStart],
]);

async function check(rows, { nextRows = [], births = starts, registered = registration } = {}) {
	const tables = [{ rows }, ...nextRows.map((next) => ({ rows: next }))];
	const signals = [];
	const result = await reapHarnessProcessGroup(registered, {
		readProcessTable: () => tables.shift() ?? { rows: [] },
		currentPgid: 99_999,
		readProcessStart: (pid) => births.get(pid),
		kill: (pid, signal) => { signals.push([pid, signal]); return true; },
		wait: async () => {},
	});
	return { result, signals };
}

assert.deepEqual(await check([owner, leader, member], { nextRows: [[]] }), {
	result: { status: "reaped" },
	signals: [[-registration.pgid, "SIGTERM"]],
});
for (const births of [
	new Map(starts).set(registration.pid, "reused-leader"),
	new Map(starts).set(registration.ownerPid, "reused-owner"),
]) assert.deepEqual((await check([owner, leader], { births })).signals, []);
for (const wrongOwner of [
	{ ...owner, command: `${HARNESS_OWNER_TOKEN_ENV_KEY}=${token} node worker.js` },
	{ ...owner, command: `${HARNESS_SIGNATURE_ENV_KEY}=${HARNESS_SIGNATURE} ${HARNESS_OWNER_TOKEN_ENV_KEY}=${token}-forged node worker.js` },
]) assert.deepEqual((await check([wrongOwner, leader])).signals, []);
for (const wrongMember of [
	{ ...member, ppid: 60_099 },
	{ ...member, ppid: owner.pid },
	{ ...member, ppid: 0 },
]) assert.deepEqual((await check([owner, leader, wrongMember])).signals, []);
const cycleMember = { ...member, ppid: 60_003 };
const cycleParent = { pid: 60_003, ppid: member.pid, pgid: registration.pgid, command: "pi" };
assert.deepEqual((await check([owner, leader, cycleMember, cycleParent])).signals, []);
assert.deepEqual((await check([{ pid: 60_003, ppid: 1, pgid: registration.pgid, command: "pi" }])).signals, []);
const survivor = { pid: 60_003, ppid: 1, pgid: registration.pgid, command: `${marker} node child.js` };
assert.equal((await check([survivor], { nextRows: [[survivor], []] })).result.status, "reaped");
const changedOwner = { ...owner, command: `${HARNESS_SIGNATURE_ENV_KEY}=${HARNESS_SIGNATURE} ${HARNESS_OWNER_TOKEN_ENV_KEY}=wrong node worker.js` };
const changed = await check([owner, leader, member], { nextRows: [[changedOwner, leader, member]] });
assert.equal(changed.result.status, "unverified");
assert.deepEqual(changed.signals, [[-registration.pgid, "SIGTERM"]]);

process.stdout.write("ownership guard fake matrix: PASS (12 cases, fake signals only)\n");
