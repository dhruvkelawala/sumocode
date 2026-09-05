/* oxlint-disable anti-slop/no-reflect-get -- the fixture Proxy forwards the complete Pi API while intercepting three runtime seams. */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installBackgroundTasks } from "../../src/background-tasks/background-task-tool.js";
import { installTerminalTools } from "../../src/background-tasks/terminal-tools.js";
import { TerminalTaskStore } from "../../src/background-tasks/task-store.js";
import type { TerminalTaskManager } from "../../src/background-tasks/task-manager.js";

// oxlint-disable anti-slop/no-explicit-any -- Pi's generic tool/event definitions are captured and replayed through their real runtime arguments.
type RegisteredTool = { readonly execute: (...args: any[]) => Promise<object> };
type EventHandler = (event: any, ctx: ExtensionContext) => void | Promise<void>;
// oxlint-enable anti-slop/no-explicit-any

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function transientIoError(): NodeJS.ErrnoException {
	// SAFETY: Node filesystem errors expose their stable errno discriminator through this optional field.
	const error = new Error("injected transient terminal metadata read") as NodeJS.ErrnoException;
	error.code = "EIO";
	return error;
}

export default function terminalDeliveryFixture(pi: ExtensionAPI): void {
	const rootDir = requiredEnv("SUMOCODE_TEST_TERMINAL_ROOT");
	const markerDir = requiredEnv("SUMOCODE_TEST_TERMINAL_MARKERS");
	const faultMarker = join(markerDir, "index-fault");
	const holdMarker = join(markerDir, "index-hold");
	const releaseMarker = join(markerDir, "index-release");
	const busyMarker = join(markerDir, "busy");
	const raceIdleMarker = join(markerDir, "race-idle");
	const diagnostics = join(markerDir, "index-diagnostics.jsonl");
	const deliveryTrace = join(markerDir, "delivery-trace.jsonl");
	const crashPoint = process.env.SUMOCODE_TEST_TERMINAL_CRASH;
	const expectedCrashToken = process.env.SUMOCODE_TEST_TERMINAL_EXPECTED_CRASH_TOKEN;
	const expectedCrashMarker = expectedCrashToken ? join(markerDir, `expected-crash-${expectedCrashToken}`) : undefined;
	const tools = new Map<string, RegisteredTool>();
	let manager: TerminalTaskManager;

	const context = (ctx: ExtensionContext): ExtensionContext => new Proxy(ctx, {
		get(target, property, receiver) {
			if (property === "isIdle") return () => existsSync(raceIdleMarker) || (!existsSync(busyMarker) && target.isIdle());
			return Reflect.get(target, property, receiver);
		},
	});

	const crash = (): never => {
		if (expectedCrashMarker) writeFileSync(expectedCrashMarker, "expected\n", { mode: 0o600 });
		process.kill(process.pid, "SIGKILL");
		throw new Error("SIGKILL returned unexpectedly");
	};

	// SAFETY: the resulting Proxy preserves ExtensionAPI and only wraps methods with contract-compatible delegates.
	const fixturePi = new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") {
				return (definition: RegisteredTool & { readonly name: string }) => {
					tools.set(definition.name, definition);
					// SAFETY: the intercepted definition is the exact value supplied to ExtensionAPI.registerTool.
					return target.registerTool(definition as never);
				};
			}
			if (property === "on") {
				return (event: string, handler: EventHandler) => {
					// SAFETY: the wrapper preserves each Pi event payload and only substitutes an ExtensionContext-compatible Proxy.
					// oxlint-disable-next-line anti-slop/no-explicit-any -- Pi owns each event payload's concrete type.
					return target.on(event as never, ((value: any, ctx: ExtensionContext) => handler(value, context(ctx))) as never);
				};
			}
			if (property === "sendMessage") {
				return (...args: Parameters<ExtensionAPI["sendMessage"]>) => {
					const result = target.sendMessage(...args);
					const message = args[0];
					if (message.customType === "terminal-result") {
						appendFileSync(deliveryTrace, `${JSON.stringify({ event: "observable", completionId: message.details?.completionId })}\n`, { mode: 0o600 });
					}
					if (crashPoint === "send" && message.customType === "terminal-result") {
						writeFileSync(join(markerDir, "crashed-after-send"), "sent\n", { mode: 0o600 });
						crash();
					}
					return result;
				};
			}
			return Reflect.get(target, property, receiver);
		},
	// SAFETY: every non-intercepted property forwards to the original ExtensionAPI; intercepted methods preserve their call contracts.
	}) as ExtensionAPI;

	const store = new TerminalTaskStore({
		rootDir,
		metaReadFault: () => existsSync(faultMarker) ? transientIoError() : undefined,
		onDiagnostic: (diagnostic) => appendFileSync(diagnostics, `${JSON.stringify(diagnostic)}\n`, { mode: 0o600 }),
	});
	manager = installBackgroundTasks(fixturePi, {
		store,
		claimLeaseMs: Number(process.env.SUMOCODE_TEST_TERMINAL_LEASE_MS ?? 150),
		pollIntervalMs: 20,
		termGraceMs: 100,
		killGraceMs: 100,
		scheduleIndexInitialization: (initialize) => {
			const run = (): void => {
				if (existsSync(holdMarker) && !existsSync(releaseMarker)) {
					setTimeout(run, 10).unref?.();
					return;
				}
				initialize();
				queueMicrotask(() => writeFileSync(join(markerDir, "index-attempt.json"), `${JSON.stringify({ ready: manager.isIndexReady() })}\n`, { mode: 0o600 }));
			};
			writeFileSync(join(markerDir, "index-scheduled"), "scheduled\n", { mode: 0o600 });
			setImmediate(run);
		},
		onDiagnostic: (diagnostic) => appendFileSync(diagnostics, `${JSON.stringify(diagnostic)}\n`, { mode: 0o600 }),
	});
	const coordinator = installTerminalTools(fixturePi, manager);
	writeFileSync(join(markerDir, "production-constructors.json"), `${JSON.stringify({
		manager: manager.constructor.name,
		coordinator: coordinator.constructor.name,
	})}\n`, { mode: 0o600 });
	manager.addChangeListener((snapshot) => {
		if (snapshot.deliveryState !== "delivered") return;
		appendFileSync(deliveryTrace, `${JSON.stringify({ event: "acknowledged", completionId: snapshot.completionId })}\n`, { mode: 0o600 });
	});

	if (crashPoint === "claim") {
		manager.addChangeListener((snapshot) => {
			if (snapshot.deliveryState !== "claimed" || existsSync(join(markerDir, "crashed-after-claim"))) return;
			writeFileSync(join(markerDir, "crashed-after-claim"), `${snapshot.completionId ?? ""}\n`, { mode: 0o600 });
			crash();
		});
	}

	pi.registerCommand("terminal-recovery-start", {
		handler: async (args, ctx) => {
			const completion = args.trim() === "wake" ? "wake" : "passive";
			const tool = tools.get("terminal_start");
			if (!tool) throw new Error("terminal_start was not registered");
			const filler = process.env.SUMOCODE_TEST_TERMINAL_LARGE_OUTPUT === "1" ? "x ".repeat(16 * 1024) : "";
			const output = `omitted producer prefix\n${filler}\nAPI_KEY=terminal-secret-value\nbenign completion\n`;
			const producerFile = join(markerDir, "producer-output.txt");
			writeFileSync(producerFile, output, { mode: 0o600 });
			const completionCommand = `cat ${shellQuote(producerFile)}`;
			const command = process.env.SUMOCODE_TEST_TERMINAL_HOLD === "1"
				? `while [ ! -f ${shellQuote(join(markerDir, "terminal-release"))} ]; do sleep 0.01; done; ${completionCommand}`
				: completionCommand;
			await tool.execute("terminal-recovery-call", {
				command,
				title: "terminal recovery fixture",
				working_dir: ctx.cwd,
				completion,
			}, undefined, undefined, context(ctx));
			const started = manager.list(ctx.sessionManager.getSessionId() ?? "")[0];
			if (!started) throw new Error("terminal fixture did not start a task");
			writeFileSync(join(markerDir, "started.json"), `${JSON.stringify({ id: started.id, completionPolicy: started.completionPolicy })}\n`, { mode: 0o600 });
			if (process.env.SUMOCODE_TEST_TERMINAL_CRASH_AFTER_START === "1") crash();
		},
	});

	const beginObservationRace = (ctx: ExtensionContext): void => {
		rmSync(busyMarker, { force: true });
		writeFileSync(raceIdleMarker, "idle\n", { mode: 0o600 });
		coordinator.flushWhenIdle(context(ctx));
	};

	pi.registerCommand("terminal-recovery-check", {
		handler: async (_args, ctx) => {
			// Queue real coordinator delivery at the same idle boundary where the explicit observation starts.
			beginObservationRace(ctx);
			// SAFETY: terminal-recovery-start owns this marker and always writes its string id.
			const id = JSON.parse(readFileSync(join(markerDir, "started.json"), "utf8")) as { readonly id: string };
			const result = await tools.get("terminal_check")!.execute("terminal-recovery-check", { id: id.id }, undefined, undefined, context(ctx));
			writeFileSync(join(markerDir, "checked.json"), `${JSON.stringify(result)}\n`, { mode: 0o600 });
		},
	});

	pi.registerCommand("terminal-recovery-wait", {
		handler: async (_args, ctx) => {
			// Queue real coordinator delivery at the same idle boundary where the explicit observation starts.
			beginObservationRace(ctx);
			// SAFETY: terminal-recovery-start owns this marker and always writes its string id.
			const id = JSON.parse(readFileSync(join(markerDir, "started.json"), "utf8")) as { readonly id: string };
			const result = await tools.get("terminal_wait")!.execute("terminal-recovery-wait", { ids: [id.id], timeout_ms: 5_000 }, undefined, undefined, context(ctx));
			writeFileSync(join(markerDir, "waited.json"), `${JSON.stringify(result)}\n`, { mode: 0o600 });
		},
	});

	pi.registerCommand("terminal-recovery-stop", {
		handler: async (_args, ctx) => {
			// SAFETY: terminal-recovery-start owns this marker and always writes its string id.
			const id = JSON.parse(readFileSync(join(markerDir, "started.json"), "utf8")) as { readonly id: string };
			const result = await tools.get("terminal_stop")!.execute("terminal-recovery-stop", { ids: [id.id] }, undefined, undefined, context(ctx));
			writeFileSync(join(markerDir, "stopped.json"), `${JSON.stringify(result)}\n`, { mode: 0o600 });
		},
	});

	pi.registerCommand("terminal-recovery-settle", {
		handler: (_args, ctx) => coordinator.flushWhenIdle(context(ctx)),
	});
}
