import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { atomicWritePrivateJson, readPrivateJson, writePrivateJsonExclusive } from "../activity/persistence.js";
import { boundRetainedResult } from "../child-protocol.js";
import { assertPrivateDir, nodeArtifactFs, validatedArtifactStat } from "../private-artifact.js";
import type { RunOutcome, SubagentEvent } from "./domain.js";
import type { CompletionManifestEvidence } from "./manifest.js";

const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
// Two text fields, each with worst-case JSON escaping, still fit the artifact cap.
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_JOURNAL_EVENTS = 256;

type JournalEvent = { sequence: number; kind: SubagentEvent["kind"] };
type ResultDocument = { schemaVersion: 1; outcome: RunOutcome };
type ManifestDocument = { schemaVersion: 1; manifest: CompletionManifestEvidence };
type RetainedDocument = ResultDocument | ManifestDocument | { schemaVersion: 1; dropped: number; events: JournalEvent[] };

/** Private evidence for one owner lifetime. Existing final artifacts are never overwritten. */
export class RetainedResults {
	private readonly directoryIdentity: { dev: number; ino: number };
	private events: JournalEvent[] = [];
	private sequence = 0;
	private result?: ResultDocument;
	private manifest?: ManifestDocument;

	public constructor(private readonly taskDir: string) {
		this.assertDirectory();
		this.directoryIdentity = lstatSync(taskDir);
		writePrivateJsonExclusive(join(taskDir, "events.json"), { schemaVersion: 1, dropped: 0, events: [] });
	}

	/** Bounded audit suffix, not transcript replay. No child text, identifiers or arguments. */
	public append(event: SubagentEvent): void {
		this.assertDirectory();
		const path = join(this.taskDir, "events.json");
		this.assertJournal();
		const sequence = this.sequence + 1;
		const events = [...this.events.slice(-(MAX_JOURNAL_EVENTS - 1)), { sequence, kind: event.kind }];
		atomicWritePrivateJson(path, { schemaVersion: 1, dropped: Math.max(0, sequence - MAX_JOURNAL_EVENTS), events });
		this.events = events;
		this.sequence = sequence;
	}

	public writeResult(outcome: RunOutcome) {
		const partialText = outcome.kind !== "completed" && outcome.partialText !== undefined
			? boundRetainedResult(outcome.partialText, MAX_TEXT_BYTES) : undefined;
		const bounded: RunOutcome = outcome.kind === "completed"
			? { kind: "completed", finalText: boundRetainedResult(outcome.finalText, MAX_TEXT_BYTES) }
			: outcome.kind === "failed"
				? { kind: "failed", errorText: boundRetainedResult(outcome.errorText, MAX_TEXT_BYTES), partialText }
				: { kind: "interrupted", partialText };
		const document = { schemaVersion: 1 as const, outcome: bounded };
		const bytes = this.write("result.json", document);
		this.result = document;
		return { outcome: bounded, pointer: { file: "result.json" as const, bytes } };
	}

	public writeManifest(manifest: CompletionManifestEvidence) {
		const document = { schemaVersion: 1 as const, manifest: structuredClone(manifest) };
		const bytes = this.write("manifest.json", document);
		this.manifest = document;
		return { file: "manifest.json" as const, bytes };
	}

	/** Async host evidence collection must not publish files changed while it waited. */
	public verify(): void {
		this.assertDirectory();
		this.assertJournal();
		if (!this.result || !this.manifest) throw new Error("retained evidence incomplete");
		for (const [file, expected] of [["result.json", this.result], ["manifest.json", this.manifest]] as const) {
			this.assertContents(file, expected, MAX_ARTIFACT_BYTES);
		}
	}

	private assertJournal(): void {
		this.assertContents("events.json", {
			schemaVersion: 1, dropped: Math.max(0, this.sequence - MAX_JOURNAL_EVENTS), events: this.events,
		}, 32 * 1024);
	}

	private assertContents(file: string, expected: RetainedDocument, maxBytes: number): void {
		const path = join(this.taskDir, file);
		if (!validatedArtifactStat(nodeArtifactFs, path, this.taskDir, "retained evidence")
			|| JSON.stringify(readPrivateJson(path, maxBytes)) !== JSON.stringify(expected)) throw new Error("retained evidence changed");
	}

	private write(file: "result.json" | "manifest.json", value: RetainedDocument): number {
		this.assertDirectory();
		const bytes = Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`);
		if (bytes > MAX_ARTIFACT_BYTES) throw new Error("retained artifact exceeds byte limit");
		writePrivateJsonExclusive(join(this.taskDir, file), value);
		return bytes;
	}

	private assertDirectory(): void {
		assertPrivateDir(nodeArtifactFs, this.taskDir, "retained artifacts");
		const stat = lstatSync(this.taskDir);
		if (realpathSync(this.taskDir) !== this.taskDir || (stat.mode & 0o777) !== 0o700
			|| (this.directoryIdentity && (stat.dev !== this.directoryIdentity.dev || stat.ino !== this.directoryIdentity.ino))) {
			throw new Error("retained artifact directory changed");
		}
	}
}
