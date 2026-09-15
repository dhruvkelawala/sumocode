import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { withAbortResponsiveTools, raceToolAbort } from "./abort-responsive-tools.js";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];
type ToolResult = Awaited<ReturnType<RegisteredTool["execute"]>>;

const answer = (text: string): ToolResult => ({ content: [{ type: "text", text }], details: undefined });

interface PendingWork {
	readonly promise: Promise<ToolResult>;
	settle(result: ToolResult): void;
}

/** A tool call that never finishes on its own -- the shape every blocking wait has. */
function neverSettles(): PendingWork {
	let settle!: (result: ToolResult) => void;
	const promise = new Promise<ToolResult>((resolve) => { settle = resolve; });
	return { promise, settle };
}

describe("raceToolAbort", () => {
	it("returns the tool's own result when nothing aborts", async () => {
		await expect(raceToolAbort("subagent_spawn", () => Promise.resolve(answer("spawned")), new AbortController().signal))
			.resolves.toEqual(answer("spawned"));
	});

	it("stops waiting on abort and tells the agent to stop, leaving the work running", async () => {
		const controller = new AbortController();
		const work = neverSettles();

		const raced = raceToolAbort("subagent_spawn", () => work.promise, controller.signal);
		controller.abort();
		const result = await raced;

		expect(result.terminate).toBe(true);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("subagent_spawn") });
		// Abandoned, not cancelled: the spawn is still free to finish afterwards.
		expect(() => work.settle(answer("late"))).not.toThrow();
	});

	it("never starts the work when the signal is already aborted", async () => {
		const start = vi.fn(() => neverSettles().promise);

		const result = await raceToolAbort("question", start, AbortSignal.abort());

		expect(result.terminate).toBe(true);
		// No worktree cut, no pane launched, no human prompted for a turn already over.
		expect(start).not.toHaveBeenCalled();
	});

	it("does not leave an unhandled rejection behind for abandoned work", async () => {
		const controller = new AbortController();
		// Abandoned first, then it fails: the spawn that outlived its tool call is
		// exactly the promise nothing is awaiting any more.
		const raced = raceToolAbort("subagent_spawn", () => new Promise<ToolResult>((_resolve, reject) => {
			setTimeout(() => reject(new Error("pane launch failed")), 0);
		}), controller.signal);
		controller.abort();

		await expect(raced).resolves.toMatchObject({ terminate: true });
		await new Promise((resolve) => { setTimeout(resolve, 5); });
	});

	it("passes a tool rejection through untouched while the turn is live", async () => {
		await expect(raceToolAbort("terminal_start", () => Promise.reject(new Error("boom")), new AbortController().signal))
			.rejects.toThrow("boom");
	});

	it("leaves a tool with no signal exactly as it was", () => {
		const work = neverSettles().promise;
		expect(raceToolAbort("subagent_list", () => work, undefined)).toBe(work);
	});
});

describe("withAbortResponsiveTools", () => {
	it("wraps tools registered through the view while preserving the definition", async () => {
		let registered: RegisteredTool | undefined;
		const stub: Pick<ExtensionAPI, "registerTool"> = {
			registerTool: (tool) => {
				// SAFETY: the captured definition is only re-invoked through `execute`, whose
				// signature is identical across every generic instantiation.
				registered = tool as RegisteredTool;
			},
		};
		// SAFETY: the view forwards every other member to this stub, and nothing under
		// test reads one.
		const pi = stub as ExtensionAPI;
		const execute = vi.fn(() => neverSettles().promise);
		const parameters = Type.Object({});

		withAbortResponsiveTools(pi).registerTool({ name: "subagent_spawn", label: "spawn", description: "d", parameters, execute });

		const wrapped = registered!;
		// Everything but execute survives the wrap, so renderers and schemas keep working.
		expect(wrapped.name).toBe("subagent_spawn");
		expect(wrapped.label).toBe("spawn");
		expect(wrapped.parameters).toBe(parameters);

		const controller = new AbortController();
		// SAFETY: the wrapper forwards ctx to the wrapped tool without reading it, and
		// this stub tool ignores it too, so an empty context is never dereferenced.
		const emptyContext = {} as never;
		const call = wrapped.execute("call-1", {}, controller.signal, undefined, emptyContext);
		controller.abort();
		await expect(call).resolves.toMatchObject({ terminate: true });
		expect(execute).toHaveBeenCalledOnce();
	});

	it("forwards other members with their original identity", () => {
		const registerCommand = vi.fn();
		const stub: Pick<ExtensionAPI, "registerTool" | "registerCommand"> = { registerTool: vi.fn(), registerCommand };
		// SAFETY: the view forwards every other member to this stub verbatim.
		const view = stub as ExtensionAPI;

		// InteractionRegistry saves a member, swaps in a wrapper, and restores the
		// saved value. A per-read copy (`.bind`) would restore a stand-in and strand
		// Pi's own function, so forwarding must be identity-preserving.
		expect(withAbortResponsiveTools(view).registerCommand).toBe(registerCommand);
	});

	it("leaves Pi's own object untouched", () => {
		const registerTool = vi.fn();
		const stub: Pick<ExtensionAPI, "registerTool"> = { registerTool };
		// SAFETY: same stub contract as above.
		const pi = stub as ExtensionAPI;

		const view = withAbortResponsiveTools(pi);

		expect(pi.registerTool).toBe(registerTool);
		expect(view.registerTool).not.toBe(registerTool);
	});
});
