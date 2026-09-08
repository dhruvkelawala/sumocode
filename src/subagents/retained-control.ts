import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readPrivateJson, writePrivateJsonExclusive } from "../activity/persistence.js";
import { assertPrivateArtifact, assertPrivateDir, nodeArtifactFs } from "../private-artifact.js";
import type { SpawnedChild } from "./backend-pi.js";
import type { RegistryControlAuthority, SubagentRecord, SubagentRegistry } from "./registry.js";

// oxlint-disable anti-slop/no-runtime-typeof -- private request/ack JSON is untrusted; validate it at this file I/O boundary.
const LIMIT = 256;
const MAX_BYTES = 64 * 1024;
type Action = "send" | "close" | "interrupt";

/** The supervisor alone drains private requests into its original backend handles. */
export function serveRetainedControl(registry: SubagentRegistry, id: string, child: (authority: RegistryControlAuthority) => SpawnedChild): () => void {
	const taskDir = registry.get(id)!.taskDir;
	let busy = false;
	const timer = setInterval(() => {
		if (busy) return;
		busy = true;
		void drain().catch(() => undefined).finally(() => { busy = false; });
	}, 250);
	timer.unref();
	async function drain(): Promise<void> {
		assertPrivateDir(nodeArtifactFs, taskDir, "retained control");
		const files = requestFiles(taskDir);
		for (const file of files) {
			const path = join(taskDir, file);
			if (existsSync(`${path}.claimed`)) continue;
			assertPrivateArtifact(nodeArtifactFs, path, taskDir, "retained request");
			const request = readPrivateJson(path, MAX_BYTES);
			if (!request || typeof request !== "object" || !("authority" in request) || !("action" in request)
				|| !("slot" in request) || file !== `controller-${request.slot}.json`) continue;
			const current = registry.get(id)!;
			const authority = controlAuthority(current);
			if (JSON.stringify(request.authority) !== JSON.stringify(authority) || !registry.inspectControl(authority)) continue;
			if (!["send", "close", "interrupt"].includes(String(request.action))) continue;
			const text = "text" in request ? request.text : undefined;
			if (request.action === "send" && (typeof text !== "string" || Buffer.byteLength(text) > 32 * 1024)) continue;
			// Claim before effect. A crash or lost acknowledgement never permits replay.
			writePrivateJsonExclusive(`${path}.claimed`, { head: authority.head });
			let ok = false;
			try {
				const handle = child(authority);
				if (request.action === "send" && typeof text === "string" && handle.send) await handle.send(text);
				else if (request.action === "close" && handle.requestClose) handle.requestClose();
				else if (request.action === "interrupt") handle.interrupt();
				else throw new Error("unsupported retained control");
				ok = registry.inspectControl(authority);
			} catch { /* The durable claim remains even when the effect is uncertain. */ }
			writePrivateJsonExclusive(`${path}.ack`, { ok });
		}
	}
	return () => { clearInterval(timer); };
}

export function retainedControlClient(registry: SubagentRegistry, authority: RegistryControlAuthority): SpawnedChild {
	const submit = (action: Action, text?: string): Promise<void> => {
		if (!registry.inspectControl(authority)) throw new Error("retained control refused");
		const record = registry.get(authority.id)!;
		assertPrivateDir(nodeArtifactFs, record.taskDir, "retained control");
		const files = requestFiles(record.taskDir);
		const slot = files.length + 1;
		if (slot > LIMIT || (text !== undefined && Buffer.byteLength(text) > 32 * 1024)) throw new Error("retained control bound exceeded");
		const path = join(record.taskDir, `controller-${slot}.json`);
		const request = { slot, authority, action, text };
		if (Buffer.byteLength(`${JSON.stringify(request, null, 2)}\n`) > MAX_BYTES) throw new Error("retained request exceeds byte limit");
		writePrivateJsonExclusive(path, request);
		return new Promise<void>((resolve, reject) => {
			const deadline = Date.now() + 5_000;
			const timer = setInterval(() => {
				try {
					if (!registry.inspectControl(authority)) throw new Error("retained control changed");
					if (existsSync(`${path}.ack`)) {
						assertPrivateArtifact(nodeArtifactFs, `${path}.ack`, record.taskDir, "retained acknowledgement");
						const ack = readPrivateJson(`${path}.ack`, 4096);
						if (!ack || typeof ack !== "object" || !("ok" in ack) || ack.ok !== true) throw new Error("retained control uncertain");
						clearInterval(timer); resolve();
					} else if (Date.now() >= deadline) throw new Error("retained control acknowledgement timeout");
				} catch (error) { clearInterval(timer); reject(error); }
			}, 250);
		});
	};
	return { events: () => undefined, send: (text) => submit("send", text),
		interrupt: () => submit("interrupt"),
		requestClose: () => { void submit("close").catch(() => undefined); } };
}

function requestFiles(taskDir: string): string[] {
	const files = readdirSync(taskDir).filter((name) => /^controller-\d+\.json$/.test(name));
	if (files.length > LIMIT) throw new Error("retained control bound exceeded");
	files.sort((a, b) => Number(a.slice(11, -5)) - Number(b.slice(11, -5)));
	if (files.some((file, index) => file !== `controller-${index + 1}.json`)) throw new Error("retained control journal has a gap");
	return files;
}

export function controlAuthority(record: SubagentRecord): RegistryControlAuthority {
	if (!record.controlLease) throw new Error("retained control absent");
	return { id: record.id, ownerSessionId: record.ownerSessionId, controllerSessionId: record.controllerSessionId,
		controllerGeneration: record.controllerGeneration, generation: record.controlLease.generation,
		owner: record.controlLease.owner, head: record.controlHead };
}
