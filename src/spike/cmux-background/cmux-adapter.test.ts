import { describe, expect, it, vi } from "vitest";
import {
	buildShellCommand,
	identifyCmuxCaller,
	openVisibleTaskInSplit,
	shellEscape,
	waitForNewCmuxSurface,
	type CmuxExecFn,
	type CmuxPaneInfo,
} from "./cmux-adapter.js";

function mockExec(responses: Record<string, CmuxExecResult>): CmuxExecFn {
	return vi.fn(async (args: string[]) => {
		const key = args.join(" ");
		const response = responses[key];
		if (!response) {
			throw new Error(`unexpected cmux args: ${key}`);
		}
		return response;
	});
}

type CmuxExecResult = Awaited<ReturnType<CmuxExecFn>>;

describe("cmux-adapter spike", () => {
	it("shellEscape wraps single quotes", () => {
		expect(shellEscape("it's fine")).toBe("'it'\\''s fine'");
	});

	it("buildShellCommand cd + exec sh -lc", () => {
		expect(buildShellCommand("/repo", "pnpm test")).toContain("cd '/repo'");
		expect(buildShellCommand("/repo", "pnpm test")).toContain("exec sh -lc 'pnpm test'");
	});

	it("identifyCmuxCaller parses workspace and surface refs", async () => {
		const execCmux = mockExec({
			"--json identify": {
				ok: true,
				stdout: JSON.stringify({
					caller: { workspace_ref: "workspace:1", surface_ref: "surface:1" },
				}),
				stderr: "",
			},
		});

		const result = await identifyCmuxCaller(execCmux);
		expect(result).toEqual({
			ok: true,
			caller: { workspaceRef: "workspace:1", surfaceRef: "surface:1" },
		});
	});

	it("identifyCmuxCaller fails outside cmux", async () => {
		const execCmux = mockExec({
			"--json identify": { ok: true, stdout: "{}", stderr: "" },
		});
		const result = await identifyCmuxCaller(execCmux);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("cmux surface");
		}
	});

	it("waitForNewCmuxSurface detects new surface ref", async () => {
		const before: CmuxPaneInfo[] = [{ ref: "pane:1", surface_refs: ["surface:1"] }];
		const after: CmuxPaneInfo[] = [
			{ ref: "pane:1", surface_refs: ["surface:1"] },
			{ ref: "pane:2", selected_surface_ref: "surface:2", surface_refs: ["surface:2"] },
		];

		let listed = 0;
		const execCmux: CmuxExecFn = vi.fn(async (args) => {
			if (args[0] === "--json" && args[1] === "list-panes") {
				listed += 1;
				return {
					ok: true,
					stdout: JSON.stringify({ panes: listed === 1 ? before : after }),
					stderr: "",
				};
			}
			throw new Error(`unexpected: ${args.join(" ")}`);
		});

		const surface = await waitForNewCmuxSurface(execCmux, "workspace:1", before, 3, 0);
		expect(surface).toBe("surface:2");
	});

	it("waitForNewCmuxSurface ignores new surfaces on existing panes", async () => {
		const before: CmuxPaneInfo[] = [{ ref: "pane:1", surface_refs: ["surface:1"] }];
		const after: CmuxPaneInfo[] = [{ ref: "pane:1", surface_refs: ["surface:1", "surface:other"] }];

		const execCmux: CmuxExecFn = vi.fn(async (args) => {
			if (args[0] === "--json" && args[1] === "list-panes") {
				return { ok: true, stdout: JSON.stringify({ panes: after }), stderr: "" };
			}
			throw new Error(`unexpected: ${args.join(" ")}`);
		});

		const surface = await waitForNewCmuxSurface(execCmux, "workspace:1", before, 1, 0);
		expect(surface).toBeUndefined();
	});

	it("openVisibleTaskInSplit runs new-split then respawn-pane", async () => {
		const calls: string[] = [];
		const execCmux: CmuxExecFn = vi.fn(async (args) => {
			calls.push(args.join(" "));
			if (args.join(" ") === "--json identify") {
				return {
					ok: true,
					stdout: JSON.stringify({
						caller: { workspace_ref: "workspace:1", surface_ref: "surface:1" },
					}),
					stderr: "",
				};
			}
			if (args.join(" ").startsWith("--json list-panes")) {
				const panes =
					calls.filter((c) => c.startsWith("new-split")).length === 0
						? [{ ref: "pane:1", surface_refs: ["surface:1"] }]
						: [
								{ ref: "pane:1", surface_refs: ["surface:1"] },
								{ ref: "pane:2", selected_surface_ref: "surface:2", surface_refs: ["surface:2"] },
							];
				return { ok: true, stdout: JSON.stringify({ panes }), stderr: "" };
			}
			if (args.join(" ").startsWith("new-split")) {
				return { ok: true, stdout: "OK surface:2 workspace:1", stderr: "" };
			}
			if (args.join(" ").startsWith("respawn-pane")) {
				return { ok: true, stdout: "", stderr: "" };
			}
			throw new Error(`unexpected: ${args.join(" ")}`);
		});

		const result = await openVisibleTaskInSplit({
			direction: "right",
			command: "cd '/repo' && exec sh -lc 'pnpm test'",
			execCmux,
			surfaceBootDelayMs: 0,
			splitReadyDelayMs: 0,
		});

		expect(result).toEqual({ ok: true, workspaceRef: "workspace:1", surfaceRef: "surface:2" });
		expect(calls.some((c) => c.startsWith("new-split right"))).toBe(true);
		expect(calls.some((c) => c.startsWith("respawn-pane"))).toBe(true);
	});
});
