import { createReadStream, statSync, type Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

/**
 * Self-contained port of Pi's on-disk session format (see
 * `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js`,
 * `buildSessionInfo` and `SessionManager#getTree`). Deliberately has NO
 * dependency on `@earendil-works/pi-coding-agent` -- the host reads Pi's
 * session files directly off disk (Node `fs`/`readline` only) instead of
 * importing Pi's SessionManager, since the RPC boundary gives the host no
 * other way to list/browse sessions (`get_state` only reports the CURRENT
 * session's path).
 *
 * Format (verified against a real file under
 * `~/.pi/agent/sessions/--<encoded-cwd>--/`):
 *  - One file per session: `<isoTimestamp-with-colons-as-dashes>_<sessionId>.jsonl`.
 *  - Newline-delimited JSON. First line is always a `{type:"session", id, cwd,
 *    timestamp, version?, parentSession?}` header.
 *  - Subsequent lines are entries with `type`/`id`/`parentId`/`timestamp`, e.g.
 *    `message`, `session_info` (display-name changes), `label` (bookmarks),
 *    `branch_summary`, `model_change`, `thinking_level_change`, `compaction`,
 *    `custom`, `custom_message`. Only `message`/`session_info`/`label` affect
 *    the two functions below; every other type is preserved as an opaque node
 *    so tree structure/branching stays intact without this module having to
 *    understand its payload.
 */

export interface SessionFileHeader {
	readonly type: "session";
	readonly version?: number;
	readonly id: string;
	readonly timestamp: string;
	readonly cwd: string;
	readonly parentSession?: string;
}

/** JSON-ish value shapes found inside Pi session `.jsonl` entries. */
export type SessionEntryValue = string | number | boolean | null | SessionEntryValue[] | { [key: string]: SessionEntryValue };

export interface SessionEntryLike {
	readonly type: string;
	readonly id: string;
	readonly parentId: string | null;
	readonly timestamp: string;
	readonly [key: string]: SessionEntryValue;
}

export type SessionFileLine = SessionFileHeader | SessionEntryLike;

export interface SessionListInfo {
	readonly path: string;
	readonly id: string;
	readonly cwd: string;
	readonly name?: string;
	readonly parentSessionPath?: string;
	readonly created: Date;
	readonly modified: Date;
	readonly messageCount: number;
	readonly firstMessage: string;
	readonly truncatedScan: boolean;
}
export interface ReadSessionInfoOptions {
	readonly maxBytes?: number;
}

type SessionInfoReader = (filePath: string) => Promise<SessionListInfo | undefined>;

export interface ListSessionsOptions {
	readonly concurrency?: number;
	readonly reader?: SessionInfoReader;
}

export interface SessionDiskEntries {
	readonly sessionId: string;
	readonly entries: readonly SessionEntryLike[];
	readonly lastEntryId: string | null;
}

export interface SessionEntrySnapshot {
	readonly entries: readonly SessionEntryLike[];
	readonly leafId: string | null;
}

export type { SessionTreeNode } from "./session-tree.js";

function parseLine(line: string): SessionFileLine | undefined {
	if (!line.trim()) return undefined;
	try {
		// SAFETY: each jsonl line is untyped JSON from disk by definition;
		// every consumed field below is validated before use.
		return JSON.parse(line) as SessionFileLine;
	} catch {
		return undefined;
	}
}

function isHeader(entry: SessionFileLine): entry is SessionFileHeader {
	return entry.type === "session";
}

interface AgentMessageLike {
	readonly role?: SessionEntryValue;
	readonly content?: SessionEntryValue;
	readonly timestamp?: SessionEntryValue;
}

function isString(value: SessionEntryValue | undefined): value is string {
	return typeof value === "string";
}

function isNumber(value: SessionEntryValue | undefined): value is number {
	return typeof value === "number";
}

function isJsonObject(value: SessionEntryValue | undefined): value is { [key: string]: SessionEntryValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUserOrAssistantRole(role: SessionEntryValue | undefined): boolean {
	return role === "user" || role === "assistant";
}

function isTextBlock(block: SessionEntryValue): block is { type: "text"; text: string } {
	return isJsonObject(block) && block["type"] === "text";
}

function extractTextContent(message: AgentMessageLike): string {
	const content = message.content;
	if (isString(content)) return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(isTextBlock)
		.map((block) => block.text)
		.join(" ");
}

function messageOf(entry: SessionEntryLike): AgentMessageLike | undefined {
	// SAFETY: session entries are untyped JSON from Pi's own writer; the
	// message payload is validated field-by-field by every consumer.
	return isJsonObject(entry.message) ? entry.message as AgentMessageLike : undefined;
}

function messageActivityTime(entry: SessionEntryLike): number | undefined {
	const message = messageOf(entry);
	if (!message || !isString(message.role) || message.content === undefined) return undefined;
	if (!isUserOrAssistantRole(message.role)) return undefined;
	if (isNumber(message.timestamp)) return message.timestamp;
	const t = new Date(entry.timestamp).getTime();
	return Number.isNaN(t) ? undefined : t;
}

/**
 * Streams a bounded prefix of a single session `.jsonl` file and extracts
 * list-view metadata: session id/cwd, the latest in-window `session_info`
 * display name (explicit clears included -- "use latest" per Pi's own
 * comment), an in-window message-count floor, and the first user message text.
 * This deliberately diverges from Pi's full-file `buildSessionInfo` scan so
 * `/resume` can open without reading every byte of long sessions; tree browsing
 * below still reads full files for fidelity. Returns `undefined` for a missing
 * header or unreadable file instead of throwing, matching Pi's `catch { return
 * null; }`.
 */
export async function readSessionInfo(filePath: string, { maxBytes = 256 * 1024 }: ReadSessionInfoOptions = {}): Promise<SessionListInfo | undefined> {
	let stats: ReturnType<typeof statSync>;
	try {
		stats = statSync(filePath);
	} catch {
		return undefined;
	}
	const truncatedScan = stats.size > maxBytes;


	let header: SessionFileHeader | undefined;
	let messageCount = 0;
	let firstMessage = "";
	let name: string | undefined;
	let lastActivityTime: number | undefined;

	try {
		const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8", start: 0, end: maxBytes - 1 }), crlfDelay: Number.POSITIVE_INFINITY });
		for await (const line of rl) {
			const entry = parseLine(line);
			if (!entry) continue;
			if (!header) {
				if (!isHeader(entry)) return undefined;
				header = entry;
				continue;
			}
			if (entry.type === "session_info") {
				const rawName = entry.name;
				name = isString(rawName) ? rawName.trim() || undefined : undefined;
			}
			if (entry.type !== "message") continue;
			messageCount += 1;
			const activityTime = messageActivityTime(entry);
			if (activityTime !== undefined) lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
			const message = messageOf(entry);
			if (!message || !isString(message.role) || message.content === undefined) continue;
			if (!isUserOrAssistantRole(message.role)) continue;
			const textContent = extractTextContent(message);
			if (!textContent) continue;
			if (!firstMessage && message.role === "user") firstMessage = textContent;
		}
	} catch {
		return undefined;
	}

	if (!header) return undefined;

	const cwd = isString(header.cwd) ? header.cwd : "";
	const headerTime = isString(header.timestamp) ? new Date(header.timestamp).getTime() : Number.NaN;
	// Truncated scans only see a PREFIX of the file, so any in-window
	// activity time is stale by construction — a long-running session would
	// sort (and display its age) as of its early messages, not its latest.
	// The filesystem mtime is the authoritative "last written" signal there.
	const modified = truncatedScan
		? stats.mtime
		: lastActivityTime !== undefined && lastActivityTime > 0
			? new Date(lastActivityTime)
			: !Number.isNaN(headerTime)
				? new Date(headerTime)
				: stats.mtime;

	return {
		path: filePath,
		id: header.id,
		cwd,
		name,
		parentSessionPath: header.parentSession,
		created: new Date(header.timestamp),
		modified,
		messageCount,
		firstMessage: firstMessage || "(no messages)",
		truncatedScan,
	};
}

/**
 * Lists every session (`.jsonl` file) in `sessionDir`, newest-modified first.
 * Ports `SessionManager.list`'s directory scan (minus the optional cwd
 * filter, which the host doesn't need since `sessionDir` here is already the
 * cwd-scoped directory derived from the current session's path).
 */
async function readSessionInfosWithLimit(
	files: readonly string[],
	concurrency: number,
	reader: SessionInfoReader,
): Promise<(SessionListInfo | undefined)[]> {
	const infos: (SessionListInfo | undefined)[] = Array.from({ length: files.length });
	const normalizedConcurrency = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1;
	const workerCount = Math.min(files.length, normalizedConcurrency);
	let nextIndex = 0;

	const runWorker = async (): Promise<void> => {
		for (;;) {
			const index = nextIndex;
			nextIndex += 1;
			if (index >= files.length) return;
			infos[index] = await reader(files[index]!);
		}
	};

	const workers: Promise<void>[] = [];
	for (let index = 0; index < workerCount; index += 1) workers.push(runWorker());
	for (const worker of workers) await worker;
	return infos;
}

export async function listSessions(sessionDir: string, { concurrency = 8, reader = readSessionInfo }: ListSessionsOptions = {}): Promise<SessionListInfo[]> {
	let entries: string[];
	try {
		entries = await readdir(sessionDir);
	} catch {
		return [];
	}
	const files = entries.filter((name) => name.endsWith(".jsonl")).map((name) => join(sessionDir, name));
	const infos = await readSessionInfosWithLimit(files, concurrency, reader);
	const sessions = infos.filter((info): info is SessionListInfo => info !== undefined);
	sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return sessions;
}

/** How many session rows `listAllSessions` returns when the caller names no limit. */
export const DEFAULT_MAX_ALL_SESSIONS = 100;

export interface ListAllSessionsOptions extends ListSessionsOptions {
	readonly maxSessions?: number;
	/**
	 * Session path that must be present in the result even when it falls
	 * outside the newest window (the session the host is already in).
	 */
	readonly currentSessionFile?: string;
	/** Already-read info for `currentSessionFile`, so pinning it doesn't re-read it. */
	readonly currentSessionInfo?: SessionListInfo;
}

/** Newest-modified first; the path tiebreak keeps equal mtimes deterministic. */
function compareNewestActiveFirst(a: { readonly path: string; readonly modifiedMs: number }, b: { readonly path: string; readonly modifiedMs: number }): number {
	if (a.modifiedMs !== b.modifiedMs) return b.modifiedMs - a.modifiedMs;
	const aName = basename(a.path);
	const bName = basename(b.path);
	if (aName === bName) return a.path < b.path ? 1 : -1;
	return aName < bName ? 1 : -1;
}

/**
 * Session files ordered by session activity (file mtime) newest first, with
 * `concurrency` bounding in-flight `stat` calls. Ranking is metadata-only work
 * -- no session file is opened here -- and a file deleted between the
 * directory listing and its own stat is dropped (it cannot be read either).
 * Session mtime, not directory mtime: writing to an existing `.jsonl` updates
 * the file, not its parent directory.
 */
async function rankSessionFilesByActivity(files: readonly string[], concurrency: number): Promise<string[]> {
	const normalizedConcurrency = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1;
	const ranked: { readonly path: string; readonly modifiedMs: number }[] = [];
	let nextIndex = 0;
	const runWorker = async (): Promise<void> => {
		for (;;) {
			const index = nextIndex;
			nextIndex += 1;
			if (index >= files.length) return;
			const filePath = files[index]!;
			try {
				ranked.push({ path: filePath, modifiedMs: (await stat(filePath)).mtimeMs });
			} catch {
				// Deleted between the directory listing and this stat.
			}
		}
	};
	const workers: Promise<void>[] = [];
	for (let index = 0; index < Math.min(files.length, normalizedConcurrency); index += 1) workers.push(runWorker());
	for (const worker of workers) await worker;
	ranked.sort(compareNewestActiveFirst);
	return ranked.map((entry) => entry.path);
}

/** Session files directly inside `dir`, or `undefined` when it can't be read. */
async function collectSessionFiles(dir: string): Promise<string[] | undefined> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return undefined;
	}
	return names.filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name));
}

/**
 * Info for the newest-active `limit` candidates, dropping files with no
 * readable session header. `limit` caps the read attempts themselves, not just
 * the rows kept, so a store full of corrupt or unreadable files cannot turn
 * the window into an unbounded scan.
 */
async function readRankedSessionInfos(files: readonly string[], concurrency: number, reader: SessionInfoReader, limit: number): Promise<SessionListInfo[]> {
	const infos = await readSessionInfosWithLimit(files.slice(0, limit), concurrency, reader);
	return infos.filter((info): info is SessionListInfo => info !== undefined);
}

/**
 * The all-sessions window: `sessions` is what the picker shows, and
 * `truncated` says candidate files were dropped to stay inside the row cap, so
 * the list is a newest-N window rather than every session on disk.
 */
export interface SessionWindow {
	readonly sessions: readonly SessionListInfo[];
	readonly truncated: boolean;
}

/**
 * Reads the `maxSessions` most recently active files out of `rankedFiles`
 * (already newest first), then pins `currentSessionFile` when it fell outside
 * that window (its info comes from the caller when already read, otherwise one
 * more bounded prefix read). The pin takes the last row slot, keeping the
 * result at or below the cap. `truncated` reports candidates the cap dropped.
 */
async function listSessionsFromRankedFiles(rankedFiles: readonly string[], { concurrency = 8, reader = readSessionInfo, maxSessions = DEFAULT_MAX_ALL_SESSIONS, currentSessionFile, currentSessionInfo }: ListAllSessionsOptions = {}): Promise<SessionWindow> {
	const limit = Number.isFinite(maxSessions) ? Math.max(0, Math.floor(maxSessions)) : DEFAULT_MAX_ALL_SESSIONS;
	const sessions = limit > 0 ? await readRankedSessionInfos(rankedFiles, concurrency, reader, limit) : [];
	if (limit > 0 && currentSessionFile && !sessions.some((session) => session.path === currentSessionFile)) {
		const pinned = currentSessionInfo ?? await reader(currentSessionFile);
		if (pinned) {
			sessions.push(pinned);
			if (sessions.length > limit) sessions.splice(limit - 1, 1);
		}
	}
	sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	// A cap of 0 lists everything, so it hides nothing.
	return { sessions, truncated: limit > 0 && rankedFiles.length > limit };
}

/**
 * Every session file one level below `sessionsRoot` (Pi's
 * `<sessions>/<encoded-cwd>/<file>.jsonl` layout), in directory order --
 * ranking happens globally afterwards, so no project directory can front-load
 * the window. One `readdir` per project directory; no file is opened.
 */
async function collectSessionFilesUnder(sessionsRoot: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(sessionsRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		const projectFiles = await collectSessionFiles(join(sessionsRoot, entry.name));
		if (projectFiles) files.push(...projectFiles);
	}
	return files;
}

/**
 * Lists sessions across every project directory under `sessionsRoot` -- Pi's
 * `SessionManager.listAll` layout, `<sessions>/<encoded-cwd>/<file>.jsonl`,
 * walked one level deep. Deliberately bounded where Pi's own version is not:
 * candidates from every project directory are ranked together by session
 * activity (file mtime, newest first -- not the directory's, which a resumed
 * session does not touch), and only the `maxSessions` newest are opened
 * (bounded prefix reads). Ranking globally means one busy project cannot fill
 * the whole window. `currentSessionFile` is always included, so a session that
 * fell outside the window (old file name, or no longer active) is still
 * resumable.
 *
 * Returns the rows only; `listAllSessionsForSession` carries the truncation
 * flag the all-sessions picker renders.
 */
export async function listAllSessions(sessionsRoot: string, options: ListAllSessionsOptions = {}): Promise<SessionListInfo[]> {
	return [...(await listAllSessionsWithin(sessionsRoot, options)).sessions];
}

/** Pi's `getDefaultSessionDirPath` encoding of a cwd into a project directory name. */
function encodeSessionDirName(cwd: string): string {
	return `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Default-layout project directories always look like `--<encoded-cwd>--`. */
function isEncodedProjectDirName(name: string): boolean {
	return /^--.*--$/.test(name);
}

/**
 * `/resume`'s all-sessions read for the current session file, covering both
 * layouts Pi supports:
 *  - nested (default): `<sessions>/<encoded-cwd>/<file>.jsonl`, so the scope
 *    spans `dirname(sessionDir)`;
 *  - flat (custom `--session-dir`): session files sit directly in the
 *    configured directory (Pi's `SessionManager.listAll(customDir)`), so that
 *    directory is scanned itself and its parent -- an arbitrary directory --
 *    never is.
 * The current file's own directory is a project directory exactly when its
 * name is the encoding of the session's own `cwd` (read from its header), so
 * the layout is resolved before anything above the session's directory is
 * touched; an unreadable/not-yet-written current file falls back to the
 * directory-name shape (`--<cwd>--` means nested). The current session is
 * pinned in both layouts.
 *
 * ponytail: that fallback is a guess, and a flat custom `--session-dir`
 * literally named `--something--` is the one case it gets wrong. The RPC seam
 * carries only the current `sessionFile` -- no configured session dir -- so
 * the caller has no layout to hand down; preferring the flat reading would
 * instead hide every other project on a default install, where an unreadable
 * session file is the common case (brand-new session, or a corrupt one).
 *
 * Returns the window rather than bare rows so `/resume` can tell the user when
 * the all-sessions scope is showing a bounded window (`truncated`).
 */
export async function listAllSessionsForSession(sessionFile: string, options: ListAllSessionsOptions = {}): Promise<SessionWindow> {
	const reader = options.reader ?? readSessionInfo;
	const sessionDir = dirname(sessionFile);
	const currentSessionInfo = await reader(sessionFile);
	const resolvedOptions: ListAllSessionsOptions = { ...options, reader, currentSessionFile: sessionFile, currentSessionInfo };
	const nested = currentSessionInfo !== undefined
		? basename(sessionDir) === encodeSessionDirName(currentSessionInfo.cwd)
		: isEncodedProjectDirName(basename(sessionDir));
	if (nested) return listAllSessionsWithin(dirname(sessionDir), resolvedOptions);
	const files = (await collectSessionFiles(sessionDir)) ?? [];
	return listSessionsFromRankedFiles(await rankSessionFilesByActivity(files, options.concurrency ?? 8), resolvedOptions);
}

/** `listAllSessions` that keeps the truncation flag. */
async function listAllSessionsWithin(sessionsRoot: string, options: ListAllSessionsOptions): Promise<SessionWindow> {
	const files = await collectSessionFilesUnder(sessionsRoot);
	return listSessionsFromRankedFiles(await rankSessionFilesByActivity(files, options.concurrency ?? 8), options);
}

/**
 * Reads every entry (excluding the header) from a session file, in file
 * order.
 */
export async function readSessionEntries(filePath: string): Promise<SessionDiskEntries | undefined> {
	const entries: SessionEntryLike[] = [];
	let sessionId: string | undefined;
	try {
		const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Number.POSITIVE_INFINITY });
		for await (const line of rl) {
			const entry = parseLine(line);
			if (!entry) continue;
			if (!sessionId) {
				if (!isHeader(entry) || !isString(entry.id)) return undefined;
				sessionId = entry.id;
				continue;
			}
			if (isHeader(entry) || !isString(entry.id)) continue;
			entries.push(entry);
		}
	} catch {
		return undefined;
	}
	if (!sessionId) return undefined;
	return { sessionId, entries, lastEntryId: entries.at(-1)?.id ?? null };
}

/**
 * Builds the current session's entries into a parent/child tree, browsable
 * for `/tree`. Ports `SessionManager.getTree()`: entries with `parentId ===
 * null` (or self-referential/orphaned -- parent id not found in the file)
 * become roots; a `label` entry resolves the latest label onto its
 * `targetId` node (an empty/undefined `label` clears a prior one, matching
 * `_buildIndex`'s label bookkeeping); children are sorted oldest-first by
 * timestamp.
 */
export async function buildSessionTree(sessionFile: string): Promise<import("./session-tree.js").SessionTreeNode[] | undefined> {
	const disk = await readSessionEntries(sessionFile);
	if (!disk) return undefined;
	const { buildSessionTreeFromEntries } = await import("./session-tree.js");
	return buildSessionTreeFromEntries(disk.entries);
}
