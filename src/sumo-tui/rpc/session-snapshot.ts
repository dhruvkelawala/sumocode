import { readSessionEntries, type SessionEntryLike, type SessionEntrySnapshot, type SessionDiskEntries } from "./session-reader.js";
import type { RpcHostControls } from "./controls.js";

export interface SessionSnapshotControls {
	getEntries(since?: string): Promise<{ readonly entries: readonly unknown[]; readonly leafId: string | null }>;
}

export interface SessionSnapshotOptions {
	readonly sessionFile?: string;
	readonly sessionId?: string;
}

function isCursorNotFound(error: unknown, cursor: string): boolean {
	if (!(error instanceof Error)) return false;
	const notFound = `Entry not found: ${cursor}`;
	// This mirrors Pi's rpc-mode get_entries error exactly, while accepting the
	// responseData wrapper used by the host. A different missing-entry error is
	// not evidence that the since cursor was rejected and must propagate.
	return error.message === notFound || error.message === `get_entries failed: ${notFound}`;
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

function asEntries(entries: unknown): readonly SessionEntryLike[] {
	if (!Array.isArray(entries)) throw new Error("get_entries returned an invalid entries list");
	return entries.map((entry) => {
		if (typeof entry !== "object" || entry === null || typeof (entry as { id?: unknown }).id !== "string" || typeof (entry as { type?: unknown }).type !== "string") {
			throw new Error("get_entries returned an invalid session entry");
		}
		return entry as SessionEntryLike;
	});
}

function validLeafId(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function validatedResponse(response: { readonly entries: unknown; readonly leafId: unknown }): SessionEntrySnapshot {
	if (!validLeafId(response.leafId)) throw new Error("get_entries returned an invalid leafId");
	return { entries: mergeEntries([], asEntries(response.entries)), leafId: response.leafId };
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
	if (!validLeafId(delta.leafId)) throw new Error("get_entries returned an invalid leafId");
	return {
		entries: mergeEntries(disk.entries, asEntries(delta.entries)),
		leafId: delta.leafId,
	};
}