import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];
type ToolResult = Awaited<ReturnType<RegisteredTool["execute"]>>;

/**
 * Result handed back when the user interrupts a turn while one of SumoCode's
 * tools is still waiting. The tool call is abandoned, not cancelled: whatever
 * it started -- a spawned subagent, a managed terminal, a git worktree -- is
 * owned by its manager and keeps running, so the text points at the tool that
 * can re-observe it rather than claiming the work was undone.
 */
export function interruptedToolResult(name: string): ToolResult {
	return {
		content: [{
			type: "text",
			text: `${name} stopped waiting because the turn was interrupted. Any work it had already started keeps running in the background; re-observe it with the matching list/check tool.`,
		}],
		details: undefined,
		// An abandoned result is not an answer. Without this the agent would take
		// another step on a tool call the user just interrupted.
		terminate: true,
	};
}

/**
 * Stop awaiting `work` once `signal` aborts.
 *
 * Pi's RPC `abort` replies only after `AgentSession.waitForIdle()`, and the
 * agent loop is idle only once the in-flight tool call settles. A tool that
 * ignores its abort signal therefore holds the whole turn open: Escape looks
 * dead, the agent keeps working, and the host's `abort` request eventually
 * fails with a timeout. Most of SumoCode's waits are unbounded by design
 * (`subagent_spawn` serializes `git worktree add` across spawns and waits on a
 * Herdr pane launch; `question` waits on a human), so the wait -- not the work
 * -- is what an interrupt has to end.
 *
 * Takes `start` rather than a promise so an already-aborted turn never begins
 * the work at all: there is no reason to cut a worktree or launch a pane for a
 * turn that is over before its tool call was dispatched.
 */
export function raceToolAbort(name: string, start: () => Promise<ToolResult>, signal: AbortSignal | undefined): Promise<ToolResult> {
	if (!signal) return start();
	if (signal.aborted) return Promise.resolve(interruptedToolResult(name));
	const work = start();
	// The abandoned call keeps running, so its eventual settlement must never
	// surface as an unhandled rejection once nothing awaits it any more.
	void work.catch(() => undefined);
	let onAbort = (): void => undefined;
	const abandoned = new Promise<ToolResult>((resolve) => {
		onAbort = (): void => resolve(interruptedToolResult(name));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	return Promise.race([work, abandoned]).finally(() => signal.removeEventListener("abort", onAbort));
}

/**
 * View of `pi` whose `registerTool` makes each tool abort-responsive.
 *
 * Applied once per extension profile rather than per tool: the tools that block
 * are exactly the ones most likely to be added later, and a registration seam
 * cannot drift out of sync the way a dozen hand-written signal checks can. Pi's
 * own tools register on its side and are already abort-aware.
 *
 * A view, not a mutation: `pi` is Pi's object, and replacing a method on it
 * would change what every other holder of that reference sees.
 */
export function withAbortResponsiveTools(pi: ExtensionAPI): ExtensionAPI {
	return new Proxy(pi, {
		get(target, property) {
			// Forwarded members keep their original identity: `InteractionRegistry`
			// saves `registerCommand`, swaps in a wrapper, and restores the saved
			// value, so handing out a per-read `.bind(target)` copy would restore a
			// stand-in instead of Pi's own function. `target` is the receiver rather
			// than the proxy so any accessor still reads Pi's object -- free here,
			// since Pi builds this API as a plain object literal whose methods close
			// over locals and never touch `this` (`createExtensionAPI`, loader.ts).
			// oxlint-disable-next-line anti-slop/no-reflect-get -- a Proxy get trap forwards arbitrary keys by contract; typed access cannot express "every other member".
			if (property !== "registerTool") return Reflect.get(target, property, target);
			return (tool: RegisteredTool): void => target.registerTool({
				...tool,
				execute: (toolCallId, params, signal, onUpdate, ctx) =>
					raceToolAbort(tool.name, () => tool.execute(toolCallId, params, signal, onUpdate, ctx), signal),
			});
		},
	});
}
