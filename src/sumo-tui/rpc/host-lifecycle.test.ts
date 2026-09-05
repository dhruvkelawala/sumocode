import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { RpcHostLifecycle } from "./host-lifecycle.js";

function fixture(env: NodeJS.ProcessEnv = {}) {
	const trace: string[] = [];
	const signals = new EventEmitter();
	let runtimeExit!: (code: number) => void;
	const runtimeExited = new Promise<number>((resolve) => { runtimeExit = resolve; });
	const runtime = {
		start: async () => { trace.push("runtime:start"); },
		stop: (code = 0, options?: { preserveTerminal?: boolean }) => {
			trace.push(options?.preserveTerminal ? "terminal:preserve" : "terminal:restore");
			runtimeExit(code);
		},
		waitForExit: () => runtimeExited,
		adoptRetainedTerminal: () => { trace.push("terminal:adopt"); },
		startInput: () => { trace.push("input:start"); },
		markEditorReady: () => { trace.push("editor:ready"); },
		markCommandReady: () => { trace.push("command:ready"); },
	};
	const lifecycle = new RpcHostLifecycle({
		env, signals,
		input: { setRawMode: () => { trace.push("raw:off"); } },
		terminal: {
			adoptRetainedSession: () => { trace.push("terminal:adopt"); },
			exitTerminal: () => { trace.push("terminal:restore"); },
		},
		stderr: { write: () => true },
		exit: (code) => { trace.push(`exit:${code}`); },
	});
	const acquire = async () => {
		lifecycle.ownCache({ write: async () => undefined, dispose: async () => { trace.push("cache:dispose"); } }, ".");
		lifecycle.ownClient({ stop: async () => { trace.push("child:stop"); }, stderr: "" });
		lifecycle.ownResource("activity", { dispose: () => { trace.push("activity:dispose"); } });
		lifecycle.ownSubscription("activity", () => { trace.push("activity:unsubscribe"); });
		lifecycle.ownResource("regions", { dispose: () => { trace.push("regions:dispose"); } });
		lifecycle.childAdopted();
		lifecycle.ownRuntime(runtime);
		await lifecycle.startRuntime();
		lifecycle.beginHydration();
		lifecycle.markCommandReady();
		return lifecycle.waitForExit();
	};
	return { lifecycle, signals, trace, acquire, runtimeExit, runtime };
}

const shutdown = ["terminal:restore", "regions:dispose", "activity:unsubscribe", "activity:dispose", "child:stop", "cache:dispose"];

describe("RpcHostLifecycle", () => {
	it("keeps lifecycle ownership behind RpcHostLifecycle", () => {
		const violations = (text: string) => {
			const source = ts.createSourceFile("host.ts", text, ts.ScriptTarget.Latest, true);
			const hosts = source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && ["runRpcHost", "runRpcHostSession"].includes(node.name?.text ?? ""));
			expect(hosts.some((node) => node.name?.text === "runRpcHost" && node.body)).toBe(true);
			const found: string[] = [];
			const visit = (node: ts.Node): void => {
				if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
					["stopPromise", "stopHost", "stop", "flushChromeCacheState", "unsubscribeActivityStore", "stopWatchingGitBranch", "regionRegistryDisposed"].includes(node.name.text)) found.push(node.name.text);
				if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
					const call = node.expression;
					if (ts.isIdentifier(call.expression)) {
						const owner = call.expression.text;
						if ((owner === "process" && ["on", "once", "removeListener"].includes(call.name.text)) ||
							(["runtime", "client", "initialRuntime", "regionRegistry", "activityStore", "chromeCache"].includes(owner) && ["stop", "dispose"].includes(call.name.text))) found.push(call.getText(source));
					}
				}
				ts.forEachChild(node, visit);
			};
			for (const host of hosts) if (host.body) visit(host.body);
			return found;
		};
		expect(violations(readFileSync(new URL("./host.ts", import.meta.url), "utf8"))).toEqual([]);
		expect(violations('async function runRpcHost() { process.once("SIGTERM", stop); }')).toEqual(["process.once"]);
		expect(violations('async function runRpcHost() { const stopPromise = runtime.stop(); }')).toEqual(["stopPromise", "runtime.stop"]);
		expect(violations('async function runRpcHost() {} async function runRpcHostSession() { client.stop(); }')).toEqual(["client.stop"]);
	});

	it("arms host signals before releasing the entry owner", async () => {
		const signals = new EventEmitter();
		const entry = () => undefined;
		signals.on("SIGTERM", entry);
		const lifecycle = new RpcHostLifecycle({
			env: {}, input: {}, signals, stderr: { write: () => true },
			onChildAdopted: () => {
				expect(signals.listenerCount("SIGTERM")).toBe(2);
				signals.removeListener("SIGTERM", entry);
			},
		});
		lifecycle.childAdopted();
		expect(signals.listenerCount("SIGTERM")).toBe(1);
		await lifecycle.stop();
		expect(signals.eventNames()).toEqual([]);
	});

	it("characterizes lifecycle order: retained reload failure after adoption before runtime", async () => {
		const f = fixture({ SUMOCODE_RELOAD: "1" });
		expect(await f.lifecycle.start(async () => {
			f.lifecycle.ownClient({ stop: async () => { f.trace.push("child:stop"); }, stderr: "" });
			f.lifecycle.childAdopted();
			throw new Error("setup failed after adoption");
		})).toBe(1);
		expect(f.trace).toEqual(["raw:off", "terminal:adopt", "terminal:restore", "child:stop"]);
	});

	it("leaves pre-adoption retained terminal cleanup with the rejecting entry", async () => {
		const f = fixture({ SUMOCODE_RELOAD: "1" });
		await expect(f.lifecycle.start(async () => { throw new Error("setup failed"); })).rejects.toThrow("setup failed");
		expect(f.trace).toEqual([]);
	});

	it("starts once and stops an idle runtime exit once", async () => {
		const f = fixture();
		const running = f.lifecycle.start(f.acquire);
		expect(f.lifecycle.start(f.acquire)).toBe(running);
		await vi.waitFor(() => expect(f.lifecycle.phase).toBe("command-ready"));
		f.runtimeExit(1);
		expect(await running).toBe(1);
		expect(f.trace.filter((entry) => entry === "runtime:start")).toHaveLength(1);
		expect(f.trace.slice(-6)).toEqual(shutdown);
	});

	it.each(["unhandledRejection", "uncaughtException"])("characterizes lifecycle order: adopted %s", async (event) => {
		const f = fixture();
		const running = f.lifecycle.start(f.acquire);
		await vi.waitFor(() => expect(f.lifecycle.phase).toBe("command-ready"));
		f.signals.emit(event, new Error("fatal"));
		f.signals.emit(event, new Error("duplicate"));
		expect(await running).toBe(1);
		expect(f.trace.slice(-7)).toEqual([...shutdown, "exit:1"]);
		expect(f.signals.eventNames()).toEqual([]);
	});

	it("finalizes timers and a watcher acquired after shutdown", async () => {
		vi.useFakeTimers();
		try {
			const f = fixture();
			const fired = vi.fn();
			f.lifecycle.scheduleTimeout("session-hydration", fired, 100);
			f.lifecycle.startStatsPolling(fired);
			const stopping = f.lifecycle.stop();
			f.lifecycle.ownGitWatcher(() => { f.trace.push("git:stop"); });
			await vi.runAllTimersAsync();
			await stopping;
			expect(fired).not.toHaveBeenCalled();
			expect(f.trace).toEqual(["git:stop"]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("characterizes lifecycle order: advisory cache timeout after child reap", async () => {
		vi.useFakeTimers();
		try {
			const f = fixture();
			f.lifecycle.ownClient({ stop: async () => { f.trace.push("child:stop"); }, stderr: "" });
			f.lifecycle.ownCache({
				write: () => new Promise<void>(() => undefined),
				dispose: async () => { f.trace.push("cache:dispose"); },
			}, ".");
			f.lifecycle.cacheChrome({ modelLabel: "model" });
			const stopping = f.lifecycle.stop();
			await vi.runAllTimersAsync();
			await stopping;
			expect(f.trace).toEqual(["child:stop", "cache:dispose"]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not publish readiness when stopped during hydration", async () => {
		const f = fixture();
		let finishHydration!: () => void;
		const hydration = new Promise<void>((resolve) => { finishHydration = resolve; });
		const running = f.lifecycle.start(async () => {
			f.lifecycle.childAdopted();
			f.lifecycle.ownRuntime(f.runtime);
			await f.lifecycle.startRuntime();
			f.lifecycle.beginHydration();
			await hydration;
			f.lifecycle.markCommandReady();
			return f.lifecycle.waitForExit();
		});
		await vi.waitFor(() => expect(f.lifecycle.phase).toBe("hydrating"));
		let returned: number | undefined;
		void running.then((code) => { returned = code; });
		try {
			await f.lifecycle.stop(130);
			await vi.waitFor(() => expect(returned).toBe(130), { timeout: 100 });
		} finally {
			finishHydration();
			await running;
		}
		expect(f.trace).not.toContain("command:ready");
	});

	it("does not mark commands ready before hydration", async () => {
		const f = fixture();
		expect(() => f.lifecycle.markCommandReady()).toThrow("expected hydrating");
		expect(f.trace).not.toContain("command:ready");
		await f.lifecycle.stop();
	});

	it("characterizes lifecycle order: runtime start failure after adoption", async () => {
		const f = fixture();
		f.runtime.start = async () => { throw new Error("runtime failed"); };
		expect(await f.lifecycle.start(f.acquire)).toBe(1);
		expect(f.trace).toEqual(shutdown);
		expect(f.signals.eventNames()).toEqual([]);
	});

	it("restores terminal modes and reaps the child when runtime cleanup throws", async () => {
		const f = fixture();
		const trace: string[] = [];
		const lifecycle = new RpcHostLifecycle({
			env: {}, signals: new EventEmitter(), stderr: { write: () => true },
			input: { setRawMode: () => { trace.push("raw:off"); } },
			terminal: {
				adoptRetainedSession: () => undefined,
				exitTerminal: () => { trace.push("terminal:restore"); },
			},
		});
		lifecycle.ownClient({ stop: async () => { trace.push("child:stop"); }, stderr: "" });
		lifecycle.ownRuntime({ ...f.runtime, stop: () => { throw new Error("runtime cleanup failed"); } });
		await lifecycle.stop();
		expect(trace).toEqual(["raw:off", "terminal:restore", "child:stop"]);
	});

	it("finalizes required resources even when another finalizer throws", async () => {
		const f = fixture();
		const running = f.lifecycle.start(async () => {
			f.lifecycle.ownResource("activity", { dispose: () => { f.trace.push("activity:dispose"); } });
			f.lifecycle.ownResource("regions", { dispose: () => { throw new Error("dispose failed"); } });
			f.lifecycle.childAdopted();
			return f.lifecycle.waitForExit();
		});
		await f.lifecycle.stop();
		expect(await running).toBe(0);
		expect(f.trace).toEqual(["activity:dispose"]);
	});

	it.each(["SIGTERM", "SIGINT", "unhandledRejection", "uncaughtException", "child-exit", "natural"])("%s waits for child reap before cache disposal and exit", async (reason) => {
		const f = fixture();
		let releaseChild!: () => void;
		const childStopped = new Promise<void>((resolve) => { releaseChild = resolve; });
		const running = f.lifecycle.start(async () => {
			f.lifecycle.ownClient({ stop: () => childStopped, stderr: "" });
			f.lifecycle.ownCache({ write: async () => undefined, dispose: async () => { f.trace.push("cache:dispose"); } }, ".");
			f.lifecycle.childAdopted();
			return reason === "natural" ? 0 : f.lifecycle.waitForExit();
		});
		const code = reason === "SIGINT" ? 130 : ["unhandledRejection", "uncaughtException", "child-exit"].includes(reason) ? 1 : 0;
		if (reason === "child-exit") void f.lifecycle.stop(code, reason).then(() => f.lifecycle.exit(code));
		else if (reason !== "natural") f.signals.emit(reason, new Error("fatal"));
		await Promise.resolve();
		if (reason !== "natural") f.signals.emit("SIGTERM");
		await Promise.resolve();
		expect(f.trace).toEqual([]);
		expect(f.signals.listenerCount("SIGTERM")).toBe(1);
		releaseChild();
		expect(await running).toBe(code);
		expect(f.trace).toEqual(reason === "natural" ? ["cache:dispose"] : ["cache:dispose", `exit:${code}`]);
		expect(f.signals.eventNames()).toEqual([]);
	});

	it.each([0, 130, 100])("characterizes lifecycle order: normal/quit/reload exit %i", async (code) => {
		const f = fixture();
		const running = f.lifecycle.start(f.acquire);
		await vi.waitFor(() => expect(f.lifecycle.phase).toBe("command-ready"));
		await Promise.all([f.lifecycle.stop(code, "quit"), f.lifecycle.stop(1, "duplicate")]);
		expect(await running).toBe(code);
		expect(f.trace.slice(-6)).toEqual(code === 100 ? ["terminal:preserve", ...shutdown.slice(1)] : shutdown);
		expect(f.lifecycle.phase).toBe("stopped");
		expect(f.signals.eventNames()).toEqual([]);
	});

	it.each([["SIGINT", 130], ["SIGTERM", 0]] as const)("characterizes lifecycle order: %s", async (signal, code) => {
		const f = fixture();
		const running = f.lifecycle.start(f.acquire);
		await vi.waitFor(() => expect(f.lifecycle.phase).toBe("command-ready"));
		f.signals.emit(signal);
		f.signals.emit(signal);
		expect(await running).toBe(code);
		expect(f.trace.slice(-7)).toEqual([...shutdown, `exit:${code}`]);
		expect(f.signals.eventNames()).toEqual([]);
	});

	it.each(["unhandledRejection", "uncaughtException"])("returns pre-adoption %s to the entry owner without exiting", async (event) => {
		const f = fixture();
		const cause = new Error("setup failed outside the awaited operation");
		let resumeSetup!: () => void;
		const setup = new Promise<void>((resolve) => { resumeSetup = resolve; });
		let rejected: unknown;
		const running = f.lifecycle.start(async () => {
			f.lifecycle.ownResource("activity", { dispose: () => { f.trace.push("activity:dispose"); } });
			await setup;
			return 0;
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- assert the exact rejection value crosses back to the entry owner.
		}).catch((error: unknown) => { rejected = error; });
		try {
			f.signals.emit(event, cause);
			await vi.waitFor(() => expect(rejected).toBe(cause), { timeout: 100 });
			expect(f.trace).toEqual(["activity:dispose"]);
			expect(f.signals.eventNames()).toEqual([]);
		} finally {
			resumeSetup();
			await running;
		}
	});

	it("finalizes partial acquisition after startup rejection", async () => {
		const f = fixture();
		await expect(f.lifecycle.start(async () => {
			f.lifecycle.ownResource("activity", { dispose: () => { f.trace.push("activity:dispose"); } });
			throw new Error("startup failed");
		})).rejects.toThrow("startup failed");
		expect(f.trace).toEqual(["activity:dispose"]);
		expect(f.signals.eventNames()).toEqual([]);
	});
});
