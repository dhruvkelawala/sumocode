import { readSessionEntries, type SessionEntryLike, type SessionEntrySnapshot, type SessionDiskEntries } from "./session-reader.js";
import type { SessionEntryValue } from "./session-reader.js";
import type { RpcHostControls } from "./controls.js";

export interface SessionSnapshotControls {
	getEntries(since?: string): Promise<{ readonly entries: readonly unknown[]; readonly leafId: string | null }>;
}

export interface SessionSnapshotOptions {
	readonly sessionFile?: string;
	readonly sessionId?: string;
}

function isCursorNotFound(cause: unknown, cursor: string): boolean {
	if (!(cause instanceof Error)) return false;
	const notFound = `Entry not found: ${cursor}`;
	// This mirrors Pi's rpc-mode get_entries error exactly, while accepting the
	// responseData wrapper used by the host. A different missing-entry error is
	// not evidence that the since cursor was rejected and must propagate.
	return cause.message === notFound || cause.message === `get_entries failed: ${notFound}`;
}

function mergeEntries(diskEntries: readonly SessionEntryLike[], deltaEntries: readonly SessionEntryLike[]): readonly SessionEntryLike[] {
	const seen = new Set<string>();
	const merged: SessionEntryLike[] = [];
	for (const entry of [...diskEntries, ...deltaEntries]) {
		if (seen.has(entry.id)) throw new Error(`duplicate session entry id while merging: ${entry.id}`);
		seen.add(entry.id);
		merged.push(entry);
	}
	return merged;
}

function isWireString(value: string | null | undefined): value is string {
	return typeof value === "string";
}

function isSessionEntry(entry: SessionEntryValue): entry is SessionEntryLike {
	return typeof entry === "object" && entry !== null && !Array.isArray(entry)
		&& typeof entry["id"] === "string" && typeof entry["type"] === "string";
}

function asEntries(response: { readonly entries: readonly unknown[] }): readonly SessionEntryLike[] {
	if (!Array.isArray(response.entries)) throw new Error("get_entries returned an invalid entries list");
	return response.entries.map((entry) => {
		// SAFETY: wire entries are untyped JSON from Pi; the guard validates the
		// id/type fields this module relies on before the value escapes.
		if (!isSessionEntry(entry as SessionEntryValue)) throw new Error("get_entries returned an invalid session entry");
		// SAFETY: isSessionEntry validated the id/type contract; all other
		// fields are intentionally opaque session-entry payload.
		return entry as SessionEntryLike;
	});
}

function validatedLeafId(leafId: string | null | undefined): string | null {
	if (leafId === undefined || (leafId !== null && !isWireString(leafId))) throw new Error("get_entries returned an invalid leafId");
	return leafId;
}

function validatedResponse(response: { readonly entries: readonly unknown[]; readonly leafId: string | null }): SessionEntrySnapshot {
	const leafId = validatedLeafId(response.leafId);
	return { entries: mergeEntries([], asEntries({ entries: response.entries })), leafId };
}

async function fullSnapshot(controls: SessionSnapshotControls): Promise<SessionEntrySnapshot> {
	return validatedResponse(await controls.getEntries());
}

/**
 * Reads persisted entries once, then asks Pi for only entries appended after
 * the disk cursor. Full flat retrieval is reserved for the documented cases;
 * no nested RPC tree is ever requested.
 */
export async function readAuthoritativeSessionSnapshot(
	controls: SessionSnapshotControls | Pick<RpcHostControls, "getEntries">,
	options: SessionSnapshotOptions,
): Promise<SessionEntrySnapshot> {
	let disk: SessionDiskEntries | undefined;
	if (options.sessionFile) disk = await readSessionEntries(options.sessionFile);
	if (!disk || disk.entries.length === 0 || (options.sessionId !== undefined && disk.sessionId !== options.sessionId) || !disk.lastEntryId) {
		return fullSnapshot(controls);
	}

	let delta: { readonly entries: readonly unknown[]; readonly leafId: string | null };
	try {
		delta = await controls.getEntries(disk.lastEntryId);
	} catch (error) {
		if (!isCursorNotFound(error, disk.lastEntryId)) throw error;
		return fullSnapshot(controls);
	}
	const leafId = validatedLeafId(delta.leafId);
	return {
		entries: mergeEntries(disk.entries, asEntries(delta)),
		leafId,
	};
}