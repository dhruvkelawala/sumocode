import { describe, expect, it, vi } from "vitest";
import { openCommandInCurrentSurface, parseNewSplitOutput } from "./cmux-split.js";

describe("cmux-split", () => {
	it("parseNewSplitOutput extracts surface and workspace refs", () => {
		expect(parseNewSplitOutput("OK surface:2 workspace:1\n")).toEqual({
			surfaceRef: "surface:2",
			workspaceRef: "workspace:1",
		});
	});

	it("parseNewSplitOutput returns undefined refs for empty stdout", () => {
		expect(parseNewSplitOutput("")).toEqual({});
	});

	it("respawns the caller's current cmux surface with explicit refs", async () => {
		const exec = vi.fn(async (_command: string, args: string[]) => {
			if (args[1] === "identify") {
				return {
					code: 0,
					killed: false,
					stdout: JSON.stringify({ caller: { workspace_ref: "workspace:1", surface_ref: "surface:2" } }),
					stderr: "",
				};
			}
			return { code: 0, killed: false, stdout: "", stderr: "" };
		});

		await expect(openCommandInCurrentSurface({ exec } as never, "cd '/repo.wt/fresh' && exec sumocode")).resolves.toEqual({ ok: true });
		expect(exec).toHaveBeenLastCalledWith(
			"cmux",
			[
				"respawn-pane",
				"--workspace",
				"workspace:1",
				"--surface",
				"surface:2",
				"--command",
				"cd '/repo.wt/fresh' && exec sumocode",
			],
			{ timeout: 5_000 },
		);
	});

	it("returns the cmux error when current-surface respawn fails", async () => {
		const exec = vi.fn(async (_command: string, args: string[]) => {
			if (args[1] === "identify") {
				return {
					code: 0,
					killed: false,
					stdout: JSON.stringify({ caller: { workspace_ref: "workspace:1", surface_ref: "surface:2" } }),
					stderr: "",
				};
			}
			return { code: 1, killed: false, stdout: "", stderr: "surface unavailable" };
		});

		await expect(openCommandInCurrentSurface({ exec } as never, "exec sumocode")).resolves.toEqual({
			ok: false,
			error: "surface unavailable",
		});
	});
});
