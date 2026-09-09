import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readPrivateJson, writePrivateJsonExclusive } from "../activity/persistence.js";
import { assertPrivateArtifact, nodeArtifactFs, validatedArtifactStat } from "../private-artifact.js";
import type { ProcessTreeMemberAnchor } from "../background-tasks/process-tree.js";
import { readRetainedBootstrap, type RetainedBootstrapDescriptor } from "./retained-bootstrap.js";

export const RETAINED_BOOTSTRAP_ENV = "SUMOCODE_RETAINED_BOOTSTRAP";
const FAILURE = "unsafe retained factory receipt";
export interface BootstrapReceiptBinding {
	readonly id: string;
	readonly ownerSessionId: string;
	readonly taskDir: string;
	readonly nonce: string;
	readonly sha256: string;
	readonly launchNonce: string;
}

export function createBootstrapBinding(descriptor: RetainedBootstrapDescriptor): BootstrapReceiptBinding {
	const binding = {
		id: descriptor.id, ownerSessionId: descriptor.ownerSessionId, taskDir: descriptor.taskDir,
		nonce: descriptor.nonce, sha256: digest(descriptor), launchNonce: randomUUID(),
	};
	readBoundBootstrap(binding);
	return Object.freeze(binding);
}

export function readBoundBootstrap(binding: BootstrapReceiptBinding) {
	try {
		const data = readRetainedBootstrap(binding, binding.nonce);
		const expected = {
			id: data.descriptor.id, ownerSessionId: data.descriptor.ownerSessionId, taskDir: data.descriptor.taskDir,
			nonce: data.descriptor.nonce, sha256: digest(data.descriptor), launchNonce: binding.launchNonce,
		};
		if (!isDeepStrictEqual(binding, expected) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(binding.launchNonce)
			|| data.descriptor.backend !== "headless") throw new Error(FAILURE);
		return data;
	} catch { throw new Error(FAILURE); }
}

export function receiptPath(binding: BootstrapReceiptBinding): string { return join(binding.taskDir, "bootstrap-factory-ready.json"); }

export function assertNoFactoryReceipt(binding: BootstrapReceiptBinding): void {
	try {
		readBoundBootstrap(binding);
		if (validatedArtifactStat(nodeArtifactFs, receiptPath(binding), binding.taskDir, "factory receipt")) throw new Error(FAILURE);
	} catch { throw new Error(FAILURE); }
}

export function publishFactoryReceipt(binding: BootstrapReceiptBinding, child: ProcessTreeMemberAnchor): void {
	try {
		assertNoFactoryReceipt(binding);
		assertChild(child);
		writePrivateJsonExclusive(receiptPath(binding), { schemaVersion: 1, binding, child });
	} catch { throw new Error(FAILURE); }
}

export function hasFactoryReceipt(binding: BootstrapReceiptBinding, child: ProcessTreeMemberAnchor): boolean {
	try {
		readBoundBootstrap(binding);
		assertChild(child);
		const path = receiptPath(binding);
		if (!validatedArtifactStat(nodeArtifactFs, path, binding.taskDir, "factory receipt")) return false;
		const before = lstatSync(path);
		assertPrivateArtifact(nodeArtifactFs, path, binding.taskDir, "factory receipt");
		if ((before.mode & 0o7777) !== 0o600) throw new Error(FAILURE);
		const receipt = readPrivateJson(path, 16 * 1024);
		const after = lstatSync(path);
		if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
			|| before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
			|| !isDeepStrictEqual(receipt, { schemaVersion: 1, binding, child })) throw new Error(FAILURE);
		return true;
	} catch { throw new Error(FAILURE); }
}

/** The backend owns the readiness deadline and aborts this wait on exit/refusal. */
export function waitForFactoryReceipt(
	binding: BootstrapReceiptBinding,
	child: ProcessTreeMemberAnchor,
	signal: AbortSignal,
	checkAuthority: () => void,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setInterval> | undefined;
		const finish = (error?: Error): void => {
			clearInterval(timer);
			signal.removeEventListener("abort", abort);
			if (error) reject(error); else resolve();
		};
		const abort = (): void => finish(new Error("retained receipt wait cancelled"));
		const check = (): void => {
			try {
				checkAuthority();
				if (hasFactoryReceipt(binding, child)) finish();
			} catch { finish(new Error(FAILURE)); }
		};
		if (signal.aborted) { abort(); return; }
		signal.addEventListener("abort", abort, { once: true });
		timer = setInterval(check, 25);
		timer.unref?.();
		check();
	});
}

function assertChild(child: ProcessTreeMemberAnchor): void {
	if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || !child.processStartTime?.trim()) throw new Error(FAILURE);
}
function digest(descriptor: RetainedBootstrapDescriptor): string {
	return createHash("sha256").update(JSON.stringify(descriptor)).digest("hex");
}
