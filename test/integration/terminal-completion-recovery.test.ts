import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalTaskManager } from "../../src/background-tasks/task-manager.js";
import { systemProcessTree, terminateProcessTree, type ProcessTreeIdentity, type ProcessTreeVerification } from "../../src/background-tasks/process-tree.js";
import { isTerminalTaskSettled, type TerminalTaskSnapshot } from "../../src/background-tasks/task-types.js";
import { TerminalDeliveryCoordinator } from "../../src/background-tasks/terminal-tools.js";
import { spawnSupervisedProcess, type SupervisedProcess } from "./harness-supervisor.js";
import { buildSpawnEnv } from "./spawn-pi-pty.js";

type JsonValue = string | number | boolean | null | undefined | readonly JsonValue[] | { readonly [key: string]: JsonValue };

interface RpcResponse {
	readonly success?: boolean;
	readonly data?: JsonValue;
	readonly error?: string;
}

interface RpcFields {
	readonly message?: string;
	readonly sessionPath?: string;
}

interface RpcClient {
	request(type: string, fields?: RpcFields): Promise<RpcResponse>;
	waitForExit(): Promise<void>;
	terminate(): Promise<void>;
	getEvidenceDir(): string;
}

interface TestRoot {
	readonly root: string;
	readonly agentDir: string;
	readonly sessionDir: string;
	readonly storeDir: string;
	readonly markerDir: string;
	readonly workspace: string;
}

interface StartMarker {
	readonly id: string;
	readonly completionPolicy: "passive" | "wake";
}

interface IndexAttemptMarker {
	readonly ready: boolean;
}

interface ToolResultMarker {
	readonly content: readonly [{ readonly type: "text"; readonly text: string }];
}

interface ProductionConstructorsMarker {
	readonly manager: string;
	readonly coordinator: string;
}

interface DeliveryTrace {
	readonly event: "observable" | "acknowledged";
	readonly completionId?: string;
}

interface OwnedTerminalTree {
	readonly id: string;
	readonly identity: ProcessTreeIdentity;
	readonly verification?: ProcessTreeVerification;
}

const SESSION_A = "019f8a78-b4f5-7b7b-b774-2d2e4bce9001";
const SESSION_B = "019f8a78-b4f5-7b7b-b774-2d2e4bce9002";
const FIXTURE = resolve("test/fixtures/terminal-delivery-extension.ts");
const roots: TestRoot[] = [];
const children: SupervisedProcess[] = [];

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- parser for untrusted Pi RPC JSON.
function isRecord(value: unknown): value is { readonly [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createRoot(): TestRoot {
	const root = mkdtempSync(join(tmpdir(), "sumocode-terminal-recovery-"));
	const paths = {
		root,
		agentDir: join(root, "agent"),
		sessionDir: join(root, "sessions"),
		storeDir: join(root, "terminals"),
		markerDir: join(root, "markers"),
		workspace: join(root, "workspace"),
	};
	roots.push(paths);
	for (const path of Object.values(paths).slice(1)) mkdirSync(path, { recursive: true, mode: 0o700 });
	return paths;
}

function createSession(paths: TestRoot, name: string, id: string): string {
	const file = join(paths.sessionDir, `${name}.jsonl`);
	writeFileSync(file, [
		JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-04T12:00:00.000Z", cwd: paths.workspace }),
		JSON.stringify({ type: "message", id: `${name}-seed`, parentId: null, timestamp: "2026-09-04T12:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "seed" }], api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.6-sol", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1_788_523_201_000 } }),
		"",
	].join("\n"), { mode: 0o600 });
	return file;
}

function launch(paths: TestRoot, sessionFile: string, overrides: NodeJS.ProcessEnv = {}): RpcClient {
	const expectsCrash = overrides.SUMOCODE_TEST_TERMINAL_CRASH === "claim"
		|| overrides.SUMOCODE_TEST_TERMINAL_CRASH === "send"
		|| overrides.SUMOCODE_TEST_TERMINAL_CRASH_AFTER_START === "1";
	const expectedCrashToken = expectsCrash ? randomUUID() : undefined;
	const expectedCrashMarker = expectedCrashToken ? join(paths.markerDir, `expected-crash-${expectedCrashToken}`) : undefined;
	const env = buildSpawnEnv(process.env, {
		PI_CODING_AGENT_DIR: paths.agentDir,
		SUMOCODE_TEST_TERMINAL_ROOT: paths.storeDir,
		SUMOCODE_TEST_TERMINAL_MARKERS: paths.markerDir,
		...overrides,
		SUMOCODE_TEST_TERMINAL_EXPECTED_CRASH_TOKEN: expectedCrashToken,
	});
	const supervised = spawnSupervisedProcess(process.env.PI_BIN ?? "pi", [
		"--mode", "rpc",
		"--offline",
		"--approve",
		"--no-extensions",
		"-e", FIXTURE,
		"--session-dir", paths.sessionDir,
		"--session", sessionFile,
	], { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
	children.push(supervised);
	// SAFETY: launch fixes all three stdio channels to pipes.
	const child = supervised.child as ChildProcessWithoutNullStreams;
	const waiters = new Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
	createInterface({ input: child.stdout }).on("line", (line) => {
		let response: unknown;
		try { response = JSON.parse(line); } catch { return; }
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- parser validates the RPC correlation discriminator.
		if (!isRecord(response) || typeof response.id !== "string") return;
		const waiter = waiters.get(response.id);
		if (!waiter) return;
		waiters.delete(response.id);
		clearTimeout(waiter.timer);
		waiter.resolve(response);
	});
	child.once("exit", (code, signal) => {
		const pending = [...waiters.values()];
		waiters.clear();
		for (const waiter of pending) clearTimeout(waiter.timer);
		if (pending.length === 0) return;
		const exit = `Pi RPC child exited early (code=${String(code)}, signal=${String(signal)})`;
		if (expectedCrashMarker && existsSync(expectedCrashMarker)) {
			for (const waiter of pending) waiter.reject(new Error(`${exit} at expected fixture crash`));
			return;
		}
		void supervised.captureFailure().then(
			(evidenceDir) => `${exit}. Evidence: ${evidenceDir}`,
			(error) => `${exit}. Evidence capture failed: ${error instanceof Error ? error.message : String(error)}`,
		).then((message) => {
			for (const waiter of pending) waiter.reject(new Error(message));
		});
	});
	let sequence = 0;
	return {
		request(type, fields = {}): Promise<RpcResponse> {
			const id = `terminal-recovery-${++sequence}`;
			return new Promise((resolveRequest, rejectRequest) => {
				const timer = setTimeout(() => {
					waiters.delete(id);
					void supervised.captureFailure().then((evidenceDir) => rejectRequest(new Error(`Timed out waiting for ${type}. Evidence: ${evidenceDir}`)));
				}, 10_000);
				waiters.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
				child.stdin.write(`${JSON.stringify({ type, id, ...fields })}\n`);
			});
		},
		waitForExit: () => exited,
		terminate: () => supervised.terminate(),
		getEvidenceDir: () => supervised.evidence.evidenceDir,
	};
}

function readMarker<T>(paths: TestRoot, name: string): T {
	// SAFETY: fixture-owned marker files are written from the corresponding named interface.
	return JSON.parse(readFileSync(join(paths.markerDir, name), "utf8")) as T;
}

function readSnapshots(paths: TestRoot): TerminalTaskSnapshot[] {
	const snapshots: TerminalTaskSnapshot[] = [];
	for (const entry of readdirSync(paths.storeDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const meta = join(paths.storeDir, entry.name, "meta.json");
		if (!existsSync(meta)) continue;
		try {
			// SAFETY: valid production metadata is a TerminalTaskSnapshot; malformed unrelated fixtures are skipped.
			snapshots.push(JSON.parse(readFileSync(meta, "utf8")) as TerminalTaskSnapshot);
		} catch {
			// Malformed records cannot provide a verified process identity.
		}
	}
	return snapshots;
}

function readSnapshot(paths: TestRoot, id: string): TerminalTaskSnapshot | undefined {
	return readSnapshots(paths).find((snapshot) => snapshot.id === id);
}

function ownedTree(snapshot: TerminalTaskSnapshot): OwnedTerminalTree | undefined {
	const { pid, processGroupId, processStartTime } = snapshot;
	if (
		pid === undefined || !Number.isSafeInteger(pid) || pid <= 1
		|| processGroupId === undefined || !Number.isSafeInteger(processGroupId) || processGroupId <= 1
		|| processStartTime === undefined || processStartTime.length === 0
	) return undefined;
	return {
		id: snapshot.id,
		identity: { pid, processGroupId, processStartTime },
		verification: snapshot.processTreeVerification,
	};
}

async function stopOwnedTerminalTrees(paths: TestRoot): Promise<OwnedTerminalTree[]> {
	const trees: OwnedTerminalTree[] = [];
	for (const snapshot of readSnapshots(paths)) {
		const tree = ownedTree(snapshot);
		if (tree) trees.push(tree);
		else if (!isTerminalTaskSettled(snapshot.status)) {
			throw new Error(`cannot verify live terminal ${snapshot.id}; retained owned root ${paths.root}`);
		}
	}
	const verifiedTrees: OwnedTerminalTree[] = [];
	for (const tree of trees) {
		const verification = tree.verification ?? systemProcessTree.captureTreeVerification?.(tree.identity);
		const verifiedTree = verification ? { ...tree, verification } : tree;
		if (!systemProcessTree.isTreeEmpty(tree.identity, verification)) {
			const stopped = await terminateProcessTree(systemProcessTree, tree.identity, { termGraceMs: 100, killGraceMs: 2_000 });
			if (!stopped || !systemProcessTree.isTreeEmpty(tree.identity, verification)) {
				throw new Error(`could not safely stop terminal ${tree.id}; retained owned root ${paths.root}`);
			}
		}
		verifiedTrees.push(verifiedTree);
	}
	return verifiedTrees;
}

async function waitForMarker(paths: TestRoot, name: string): Promise<void> {
	await vi.waitFor(() => expect(existsSync(join(paths.markerDir, name))).toBe(true), { timeout: 10_000, interval: 20 });
}

async function waitForSnapshot(paths: TestRoot, id: string, predicate: (snapshot: TerminalTaskSnapshot) => boolean): Promise<TerminalTaskSnapshot> {
	let snapshot: TerminalTaskSnapshot | undefined;
	await vi.waitFor(() => {
		snapshot = readSnapshot(paths, id);
		expect(snapshot && predicate(snapshot)).toBe(true);
	}, { timeout: 10_000, interval: 20 });
	// SAFETY: vi.waitFor returns only after assigning a snapshot accepted by the predicate.
	return snapshot!;
}

async function waitForClaimLeaseExpiry(paths: TestRoot, id: string, leaseMs = 150): Promise<TerminalTaskSnapshot> {
	const claimed = await waitForSnapshot(paths, id, (snapshot) => snapshot.deliveryState === "claimed");
	await vi.waitFor(() => expect(Date.now() - claimed.updatedAt).toBeGreaterThanOrEqual(leaseMs), { timeout: 10_000, interval: 20 });
	return claimed;
}

function terminalMessages(value: JsonValue, completionId: string): Array<{ readonly [key: string]: JsonValue }> {
	const matches: Array<{ readonly [key: string]: JsonValue }> = [];
	const visit = (candidate: JsonValue): void => {
		if (Array.isArray(candidate)) {
			for (const item of candidate) visit(item);
			return;
		}
		if (!isRecord(candidate)) return;
		const details = candidate.details;
		if (candidate.customType === "terminal-result" && isRecord(details) && details.completionId === completionId) matches.push(candidate);
		for (const nested of Object.values(candidate)) visit(nested);
	};
	visit(value);
	return matches;
}

function persistedTerminalMessages(sessionFile: string, completionId: string): Array<{ readonly [key: string]: JsonValue }> {
	return readFileSync(sessionFile, "utf8").trim().split("\n")
		.flatMap((line) => terminalMessages(JSON.parse(line), completionId));
}

function resetIndexMarkers(paths: TestRoot): void {
	for (const name of ["index-attempt.json", "index-scheduled", "index-release", "index-diagnostics.jsonl"]) {
		rmSync(join(paths.markerDir, name), { force: true });
	}
}

function createCorruptRecord(paths: TestRoot): void {
	const directory = join(paths.storeDir, "term-corrupt-1");
	mkdirSync(directory, { mode: 0o700 });
	writeFileSync(join(directory, "meta.json"), "{malformed\n", { mode: 0o600 });
}

async function startBusyPendingCompletion(paths: TestRoot, sessionFile: string): Promise<{ readonly client: RpcClient; readonly pending: TerminalTaskSnapshot }> {
	writeFileSync(join(paths.markerDir, "busy"), "busy\n", { mode: 0o600 });
	const client = launch(paths, sessionFile);
	const start = await client.request("prompt", { message: "/terminal-recovery-start passive" });
	expect(start.success).toBe(true);
	await waitForMarker(paths, "started.json");
	const { id } = readMarker<StartMarker>(paths, "started.json");
	const pending = await waitForSnapshot(paths, id, (snapshot) => snapshot.deliveryState === "pending");
	return { client, pending };
}

async function seedPendingCompletion(paths: TestRoot, sessionFile: string): Promise<TerminalTaskSnapshot> {
	const { client, pending } = await startBusyPendingCompletion(paths, sessionFile);
	await client.terminate();
	rmSync(join(paths.markerDir, "busy"), { force: true });
	resetIndexMarkers(paths);
	return pending;
}

afterEach(async () => {
	const errors: Error[] = [];
	for (const child of children.splice(0)) {
		try {
			await child.terminate();
		} catch (error) {
			errors.push(error instanceof Error ? error : new Error(String(error)));
		}
	}
	for (const paths of roots.splice(0)) {
		try {
			await stopOwnedTerminalTrees(paths);
			rmSync(paths.root, { recursive: true, force: true });
		} catch (error) {
			errors.push(error instanceof Error ? error : new Error(String(error)));
		}
	}
	if (errors.length > 0) throw new AggregateError(errors, "terminal recovery cleanup failed; owned roots retained");
});

// The child fixture constructs the real TerminalTaskManager and TerminalDeliveryCoordinator through the production installers.
describe("terminal completion delivery recovery", () => {
	it("delivers a passive terminal once through the real coordinator", async () => {
		const paths = createRoot();
		const sessionFile = createSession(paths, "session-a", SESSION_A);
		const first = launch(paths, sessionFile, { SUMOCODE_TEST_TERMINAL_LARGE_OUTPUT: "1" });

		await waitForMarker(paths, "production-constructors.json");
		expect(readMarker<ProductionConstructorsMarker>(paths, "production-constructors.json")).toEqual({
			manager: TerminalTaskManager.name,
			coordinator: TerminalDeliveryCoordinator.name,
		});
		const start = await first.request("prompt", { message: "/terminal-recovery-start passive" });
		expect(start.success).toBe(true);
		await waitForMarker(paths, "started.json");
		const { id } = readMarker<StartMarker>(paths, "started.json");
		const delivered = await waitForSnapshot(paths, id, (snapshot) => snapshot.deliveryState === "delivered");
		const live = await first.request("get_messages");

		expect(delivered).toMatchObject({ ownerSessionId: SESSION_A, status: "completed", exitCode: 0, completionPolicy: "passive" });
		expect(delivered.completionId).toEqual(expect.any(String));
		const liveMessages = terminalMessages(live, delivered.completionId!);
		expect(liveMessages).toHaveLength(1);
		expect(Buffer.byteLength(JSON.stringify(liveMessages[0]), "utf8")).toBeLessThan(30 * 1024);
		expect(persistedTerminalMessages(sessionFile, delivered.completionId!)).toHaveLength(1);
		expect(JSON.stringify(live)).not.toContain("terminal-secret-value");
		expect(JSON.stringify(live)).toContain("benign completion");

		await first.terminate();
		const replacement = launch(paths, sessionFile);
		const hydrated = await replacement.request("get_messages");
		const hydratedMessages = terminalMessages(hydrated, delivered.completionId!);
		expect(hydratedMessages).toHaveLength(1);
		expect(hydratedMessages[0]?.details).toEqual(liveMessages[0]?.details);
		expect(persistedTerminalMessages(sessionFile, delivered.completionId!)).toHaveLength(1);
	});

	it("defers replacement delivery until the terminal index is ready", async () => {
		const paths = createRoot();
		const sessionFile = createSession(paths, "session-a", SESSION_A);
		const { client, pending } = await startBusyPendingCompletion(paths, sessionFile);
		createCorruptRecord(paths);
		resetIndexMarkers(paths);
		writeFileSync(join(paths.markerDir, "index-hold"), "hold\n", { mode: 0o600 });
		// Pi rebuilds the extension on a same-session switch, giving us a real replacement without another OS process.
		await client.request("switch_session", { sessionPath: sessionFile });

		await waitForMarker(paths, "index-scheduled");
		expect(readSnapshot(paths, pending.id)).toMatchObject({ deliveryState: "pending" });
		expect(terminalMessages(await client.request("get_messages"), pending.completionId!)).toHaveLength(0);
		expect(existsSync(join(paths.markerDir, "index-attempt.json"))).toBe(false);
		rmSync(join(paths.markerDir, "busy"), { force: true });
		writeFileSync(join(paths.markerDir, "index-release"), "release\n", { mode: 0o600 });

		const delivered = await waitForSnapshot(paths, pending.id, (snapshot) => snapshot.deliveryState === "delivered");
		expect(delivered).toMatchObject({ ownerSessionId: SESSION_A, completionId: pending.completionId });
		expect(readMarker<IndexAttemptMarker>(paths, "index-attempt.json")).toEqual({ ready: true });
		const live = await client.request("get_messages");
		const liveMessages = terminalMessages(live, delivered.completionId!);
		expect(liveMessages).toHaveLength(1);
		expect(Buffer.byteLength(JSON.stringify(liveMessages[0]), "utf8")).toBeLessThan(30 * 1024);
		expect(JSON.stringify(live)).not.toContain("terminal-secret-value");
		expect(JSON.stringify(live)).toContain("benign completion");
		// SAFETY: the fixture writes each delivery trace row from the DeliveryTrace event vocabulary above.
		const trace = readFileSync(join(paths.markerDir, "delivery-trace.jsonl"), "utf8").trim().split("\n")
			.map((line) => JSON.parse(line) as DeliveryTrace)
			.filter((event) => event.completionId === delivered.completionId);
		expect(trace.map((event) => event.event)).toEqual(["observable", "acknowledged"]);

		await client.request("prompt", { message: "/terminal-recovery-settle" });
		expect(terminalMessages(await client.request("get_messages"), delivered.completionId!)).toHaveLength(1);
		expect(persistedTerminalMessages(sessionFile, delivered.completionId!)).toHaveLength(1);

		// Switch once more so a fresh extension generation hydrates the delivered session record.
		await client.request("switch_session", { sessionPath: sessionFile });
		const hydratedMessages = terminalMessages(await client.request("get_messages"), delivered.completionId!);
		expect(hydratedMessages).toHaveLength(1);
		expect(hydratedMessages[0]?.details).toEqual(liveMessages[0]?.details);
		expect(persistedTerminalMessages(sessionFile, delivered.completionId!)).toHaveLength(1);
	});

	it("defers delivery for an incomplete terminal index", async () => {
		const paths = createRoot();
		const sessionFile = createSession(paths, "session-a", SESSION_A);
		const pending = await seedPendingCompletion(paths, sessionFile);
		writeFileSync(join(paths.markerDir, "index-fault"), "fault\n", { mode: 0o600 });
		const replacement = launch(paths, sessionFile);

		await waitForMarker(paths, "index-attempt.json");
		expect(readMarker<IndexAttemptMarker>(paths, "index-attempt.json")).toEqual({ ready: false });
		expect(readSnapshot(paths, pending.id)).toMatchObject({ deliveryState: "pending" });
		expect(terminalMessages(await replacement.request("get_messages"), pending.completionId!)).toHaveLength(0);
		rmSync(join(paths.markerDir, "index-fault"));

		const delivered = await waitForSnapshot(paths, pending.id, (snapshot) => snapshot.deliveryState === "delivered");
		const diagnostics = readFileSync(join(paths.markerDir, "index-diagnostics.jsonl"), "utf8");
		expect(diagnostics).toContain('"complete":false');
		expect(diagnostics).toContain('"complete":true');
		expect(terminalMessages(await replacement.request("get_messages"), delivered.completionId!)).toHaveLength(1);
		expect(persistedTerminalMessages(sessionFile, delivered.completionId!)).toHaveLength(1);
	});

	it("reclaims a claim stopped before branch observability", async () => {
		const paths = createRoot();
		const sessionFile = createSession(paths, "session-a", SESSION_A);
		const pending = await seedPendingCompletion(paths, sessionFile);
		const crashing = launch(paths, sessionFile, { SUMOCODE_TEST_TERMINAL_CRASH: "claim" });

		await waitForMarker(paths, "crashed-after-claim");
		await crashing.waitForExit();
		expect(readSnapshot(paths, pending.id)).toMatchObject({ deliveryState: "claimed", completionId: pending.completionId });
		expect(persistedTerminalMessages(sessionFile, pending.completionId!)).toHaveLength(0);
		await waitForClaimLeaseExpiry(paths, pending.id);
		expect(readSnapshot(paths, pending.id)).toMatchObject({ deliveryState: "claimed", completionId: pending.completionId });

		resetIndexMarkers(paths);
		const replacement = launch(paths, sessionFile);
		const delivered = await waitForSnapshot(paths, pending.id, (snapshot) => snapshot.deliveryState === "delivered");
		expect(delivered.completionId).toBe(pending.completionId);
		expect(terminalMessages(await replacement.request("get_messages"), delivered.completionId!)).toHaveLength(1);
		expect(persistedTerminalMessages(sessionFile, delivered.completionId!)).toHaveLength(1);
	});

	it("acknowledges an observable completion without reinserting after replacement", async () => {
		const paths = createRoot();
		const sessionFile = createSession(paths, "session-a", SESSION_A);
		const pending = await seedPendingCompletion(paths, sessionFile);
		const crashing = launch(paths, sessionFile, { SUMOCODE_TEST_TERMINAL_CRASH: "send" });

		await waitForMarker(paths, "crashed-after-send");
		await crashing.waitForExit();
		expect(readSnapshot(paths, pending.id)).toMatchObject({ deliveryState: "claimed", completionId: pending.completionId });
		expect(persistedTerminalMessages(sessionFile, pending.completionId!)).toHaveLength(1);
		await waitForClaimLeaseExpiry(paths, pending.id);
		expect(readSnapshot(paths, pending.id)).toMatchObject({ deliveryState: "claimed", completionId: pending.completionId });

		resetIndexMarkers(paths);
		const replacement = launch(paths, sessionFile);
		const delivered = await waitForSnapshot(paths, pending.id, (snapshot) => snapshot.deliveryState === "delivered");
		expect(delivered.completionId).toBe(pending.completionId);
		expect(terminalMessages(await replacement.request("get_messages"), delivered.completionId!)).toHaveLength(1);
		expect(persistedTerminalMessages(sessionFile, delivered.completionId!)).toHaveLength(1);
	});

	it("cleans a held terminal after its expected fixture crash", async () => {
		const paths = createRoot();
		const sessionFile = createSession(paths, "session-a", SESSION_A);
		const crashing = launch(paths, sessionFile, {
			SUMOCODE_TEST_TERMINAL_HOLD: "1",
			SUMOCODE_TEST_TERMINAL_CRASH_AFTER_START: "1",
		});
		const startRequest = expect(crashing.request("prompt", { message: "/terminal-recovery-start passive" }))
			.rejects.toThrow("expected fixture crash");
		await waitForMarker(paths, "started.json");
		const { id } = readMarker<StartMarker>(paths, "started.json");
		const running = await waitForSnapshot(paths, id, (snapshot) => snapshot.status === "running");
		await crashing.waitForExit();
		await startRequest;
		expect(existsSync(join(paths.markerDir, "terminal-release"))).toBe(false);
		expect(existsSync(join(crashing.getEvidenceDir(), "argv.txt"))).toBe(false);

		const trees = await stopOwnedTerminalTrees(paths);
		const held = trees.find((tree) => tree.id === running.id);
		expect(held).toBeDefined();
		expect(systemProcessTree.isTreeEmpty(held!.identity, held!.verification)).toBe(true);
	});

	it("holds a wake completion for its busy owner session while another session is active", async () => {
		const paths = createRoot();
		const sessionA = createSession(paths, "session-a", SESSION_A);
		const sessionB = createSession(paths, "session-b", SESSION_B);
		const first = launch(paths, sessionA, {
			SUMOCODE_TEST_TERMINAL_HOLD: "1",
			SUMOCODE_TEST_TERMINAL_CRASH_AFTER_START: "1",
		});
		const startRequest = first.request("prompt", { message: "/terminal-recovery-start wake" }).catch(() => undefined);
		await waitForMarker(paths, "started.json");
		await first.waitForExit();
		await startRequest;
		const { id } = readMarker<StartMarker>(paths, "started.json");
		expect(readSnapshot(paths, id)).toMatchObject({ ownerSessionId: SESSION_A, status: "running", completionPolicy: "wake" });

		resetIndexMarkers(paths);
		const wrongOwner = launch(paths, sessionB);
		writeFileSync(join(paths.markerDir, "terminal-release"), "release\n", { mode: 0o600 });
		const pending = await waitForSnapshot(paths, id, (snapshot) => snapshot.deliveryState === "pending");
		expect(terminalMessages(await wrongOwner.request("get_messages"), pending.completionId!)).toHaveLength(0);
		await wrongOwner.terminate();

		writeFileSync(join(paths.markerDir, "busy"), "busy\n", { mode: 0o600 });
		resetIndexMarkers(paths);
		const owner = launch(paths, sessionA);
		await waitForMarker(paths, "index-attempt.json");
		expect(terminalMessages(await owner.request("get_messages"), pending.completionId!)).toHaveLength(0);
		rmSync(join(paths.markerDir, "busy"));
		await owner.request("prompt", { message: "/terminal-recovery-settle" });

		const delivered = await waitForSnapshot(paths, id, (snapshot) => snapshot.deliveryState === "delivered");
		expect(terminalMessages(await owner.request("get_messages"), delivered.completionId!)).toHaveLength(1);
		expect(persistedTerminalMessages(sessionB, delivered.completionId!)).toHaveLength(0);
		expect(persistedTerminalMessages(sessionA, delivered.completionId!)).toHaveLength(1);
	});

	it("lets terminal_check win an observation race without a duplicate completion", async () => {
		const paths = createRoot();
		const sessionFile = createSession(paths, "session-a", SESSION_A);
		const { client, pending } = await startBusyPendingCompletion(paths, sessionFile);

		await client.request("prompt", { message: "/terminal-recovery-check" });
		await waitForMarker(paths, "checked.json");
		const checked = readMarker<ToolResultMarker>(paths, "checked.json");
		expect(checked.content).toHaveLength(1);
		expect(checked.content[0].text).toContain("benign completion");
		expect(readSnapshot(paths, pending.id)).toMatchObject({ deliveryState: "suppressed", observedAt: expect.any(Number) });
		expect(existsSync(join(paths.markerDir, "race-idle"))).toBe(true);
		expect(terminalMessages(await client.request("get_messages"), pending.completionId!)).toHaveLength(0);
		expect(persistedTerminalMessages(sessionFile, pending.completionId!)).toHaveLength(0);
	});

	it("lets terminal_wait win an observation race without a duplicate completion", async () => {
		const paths = createRoot();
		const sessionFile = createSession(paths, "session-a", SESSION_A);
		const { client, pending } = await startBusyPendingCompletion(paths, sessionFile);

		await client.request("prompt", { message: "/terminal-recovery-wait" });
		await waitForMarker(paths, "waited.json");
		const waited = readMarker<ToolResultMarker>(paths, "waited.json");
		expect(waited.content).toHaveLength(1);
		expect(waited.content[0].text).toContain("benign completion");
		expect(readSnapshot(paths, pending.id)).toMatchObject({ deliveryState: "suppressed", consumedAt: expect.any(Number) });
		expect(existsSync(join(paths.markerDir, "race-idle"))).toBe(true);
		expect(terminalMessages(await client.request("get_messages"), pending.completionId!)).toHaveLength(0);
		expect(persistedTerminalMessages(sessionFile, pending.completionId!)).toHaveLength(0);
	});

	it("cancels a real terminal child through terminal_stop and cleans its process tree", async () => {
		const paths = createRoot();
		const sessionFile = createSession(paths, "session-a", SESSION_A);
		const client = launch(paths, sessionFile, { SUMOCODE_TEST_TERMINAL_HOLD: "1" });
		await client.request("prompt", { message: "/terminal-recovery-start passive" });
		await waitForMarker(paths, "started.json");
		const { id } = readMarker<StartMarker>(paths, "started.json");
		const running = await waitForSnapshot(paths, id, (snapshot) => snapshot.status === "running");

		await client.request("prompt", { message: "/terminal-recovery-stop" });
		await waitForMarker(paths, "stopped.json");
		const cancelled = await waitForSnapshot(paths, id, (snapshot) => snapshot.status === "cancelled");
		expect(cancelled).toMatchObject({ deliveryState: "suppressed", completionId: expect.any(String) });
		await vi.waitFor(() => {
			let alive = true;
			try { process.kill(running.pid!, 0); } catch { alive = false; }
			expect(alive).toBe(false);
		}, { timeout: 10_000, interval: 20 });
		expect(persistedTerminalMessages(sessionFile, cancelled.completionId!)).toHaveLength(0);
	});
});
