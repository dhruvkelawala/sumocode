import { createReadStream, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
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

export interface SessionEntryLike {
	readonly type: string;
	readonly id: string;
	readonly parentId: string | null;
	readonly timestamp: string;
	readonly [key: string]: unknown;
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
}

export interface SessionTreeNode {
	readonly entry: SessionEntryLike;
	readonly children: SessionTreeNode[];
	readonly label?: string;
	readonly labelTimestamp?: string;
}

function parseLine(line: string): SessionFileLine | undefined {
	if (!line.trim()) return undefined;
	try {
		return JSON.parse(line) as SessionFileLine;
	} catch {
		return undefined;
	}
}

function isHeader(entry: SessionFileLine): entry is SessionFileHeader {
	return entry.type === "session";
}

interface AgentMessageLike {
	readonly role?: unknown;
	readonly content?: unknown;
	readonly timestamp?: unknown;
}

function extractTextContent(message: AgentMessageLike): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text: string } => {
			return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text";
		})
		.map((block) => block.text)
		.join(" ");
}

function messageActivityTime(entry: SessionEntryLike): number | undefined {
	const message = entry.message as AgentMessageLike | undefined;
	if (!message || typeof message !== "object" || typeof message.role !== "string" || !("content" in message)) return undefined;
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	if (typeof message.timestamp === "number") return message.timestamp;
	const t = new Date(entry.timestamp).getTime();
	return Number.isNaN(t) ? undefined : t;
}

/**
 * Streams a single session `.jsonl` file and extracts list-view metadata:
 * session id/cwd, the latest `session_info` display name (explicit clears
 * included -- "use latest" per Pi's own comment), message count, and the
 * first user message text. Ports `buildSessionInfo` from
 * `session-manager.js` line-for-line; returns `undefined` for a missing
 * header or unreadable file instead of throwing, matching Pi's `catch { return
 * null; }`.
 */
export async function readSessionInfo(filePath: string): Promise<SessionListInfo | undefined> {
	let stats: ReturnType<typeof statSync>;
	try {
		stats = statSync(filePath);
	} catch {
		return undefined;
	}

	let header: SessionFileHeader | undefined;
	let messageCount = 0;
	let firstMessage = "";
	let name: string | undefined;
	let lastActivityTime: number | undefined;

	try {
		const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Number.POSITIVE_INFINITY });
		for await (const line of rl) {
			const entry = parseLine(line);
			if (!entry) continue;
			if (!header) {
				if (!isHeader(entry)) return undefined;
				header = entry;
				continue;
			}
			if (entry.type === "session_info") {
				const rawName = (entry as SessionEntryLike & { name?: string }).name;
				name = rawName?.trim() || undefined;
			}
			if (entry.type !== "message") continue;
			messageCount += 1;
			const activityTime = messageActivityTime(entry);
			if (typeof activityTime === "number") lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
			const message = entry.message as AgentMessageLike | undefined;
			if (!message || typeof message !== "object" || typeof message.role !== "string" || !("content" in message)) continue;
			if (message.role !== "user" && message.role !== "assistant") continue;
			const textContent = extractTextContent(message);
			if (!textContent) continue;
			if (!firstMessage && message.role === "user") firstMessage = textContent;
		}
	} catch {
		return undefined;
	}

	if (!header) return undefined;

	const cwd = typeof header.cwd === "string" ? header.cwd : "";
	const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : Number.NaN;
	const modified = typeof lastActivityTime === "number" && lastActivityTime > 0
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
	};
}

/**
 * Lists every session (`.jsonl` file) in `sessionDir`, newest-modified first.
 * Ports `SessionManager.list`'s directory scan (minus the optional cwd
 * filter, which the host doesn't need since `sessionDir` here is already the
 * cwd-scoped directory derived from the current session's path).
 */
export async function listSessions(sessionDir: string): Promise<SessionListInfo[]> {
	let entries: string[];
	try {
		entries = await readdir(sessionDir);
	} catch {
		return [];
	}
	const files = entries.filter((name) => name.endsWith(".jsonl")).map((name) => join(sessionDir, name));
	const infos = await Promise.all(files.map((file) => readSessionInfo(file)));
	const sessions = infos.filter((info): info is SessionListInfo => info !== undefined);
	sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return sessions;
}

/**
 * Reads every entry (excluding the header) from a session file, in file
 * order.
 */
async function readSessionEntries(filePath: string): Promise<SessionEntryLike[]> {
	const entries: SessionEntryLike[] = [];
	const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Number.POSITIVE_INFINITY });
	for await (const line of rl) {
		const entry = parseLine(line);
		if (!entry) continue;
		if (isHeader(entry)) continue;
		entries.push(entry);
	}
	return entries;
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
export async function buildSessionTree(sessionFile: string): Promise<SessionTreeNode[]> {
	const entries = await readSessionEntries(sessionFile);

	const labelsById = new Map<string, string>();
	const labelTimestampsById = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== "label") continue;
		const targetId = (entry as SessionEntryLike & { targetId?: string }).targetId;
		const label = (entry as SessionEntryLike & { label?: string }).label;
		if (!targetId) continue;
		if (label) {
			labelsById.set(targetId, label);
			labelTimestampsById.set(targetId, entry.timestamp);
		} else {
			labelsById.delete(targetId);
			labelTimestampsById.delete(targetId);
		}
	}

	interface MutableNode {
		entry: SessionEntryLike;
		children: MutableNode[];
		label?: string;
		labelTimestamp?: string;
	}

	const nodeMap = new Map<string, MutableNode>();
	const roots: MutableNode[] = [];

	for (const entry of entries) {
		nodeMap.set(entry.id, {
			entry,
			children: [],
			label: labelsById.get(entry.id),
			labelTimestamp: labelTimestampsById.get(entry.id),
		});
	}

	for (const entry of entries) {
		const node = nodeMap.get(entry.id);
		if (!node) continue;
		if (entry.parentId === null || entry.parentId === entry.id) {
			roots.push(node);
			continue;
		}
		const parent = nodeMap.get(entry.parentId);
		if (parent) parent.children.push(node);
		else roots.push(node);
	}

	const stack: MutableNode[] = [...roots];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node) continue;
		node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
		stack.push(...node.children);
	}

	return roots;
}
