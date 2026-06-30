import { describe, expect, it, vi } from "vitest";
import { draftCommitMessage, registerShipCommand } from "./ship.js";

function setup(execImpl: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>, choices: string[] = []) {
	let handler: ((args: string | undefined, ctx: { hasUI: boolean; cwd: string; ui: { notify: ReturnType<typeof vi.fn> } }) => Promise<void>) | undefined;
	const pi = {
		registerCommand: vi.fn((_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		}),
		exec: vi.fn(async (cmd: string, args: string[]) => execImpl(cmd, args)),
	};
	const ask = vi.fn(async () => choices.shift() ?? "Cancel");
	registerShipCommand(pi as never, { ask: ask as never });
	const notify = vi.fn();
	const ctx = { hasUI: true, cwd: "/repo", ui: { notify } };
	return { pi, handler, ask, notify, ctx };
}

describe("/sumo:ship", () => {
	it("drafts a conventional commit message from branch and file summary", () => {
		expect(draftCommitMessage("sumo/worktree-fanout", ["a.ts", "b.ts"])).toBe("chore(worktree-fanout): update 2 files");
		expect(draftCommitMessage("main", ["a.ts"])).toBe("chore(main): update 1 file");
	});

	it("commits locally, then gates push and PR creation", async () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const { handler, ask, notify, ctx } = setup(async (cmd, args) => {
			calls.push({ cmd, args });
			if (cmd === "git" && args[0] === "status") return { code: 0, stdout: " M src/a.ts\0?? src/b.ts\0", stderr: "", killed: false };
			if (cmd === "git" && args[0] === "branch") return { code: 0, stdout: "sumo/worktree-fanout\n", stderr: "", killed: false };
			return { code: 0, stdout: "", stderr: "", killed: false };
		}, ["Commit", "Push", "Open PR"]);

		await handler?.("", ctx);

		expect(calls.map((call) => `${call.cmd} ${call.args.join(" ")}`)).toEqual([
			"git status --porcelain -z",
			"git branch --show-current",
			"git add -A",
			"git commit -m chore(worktree-fanout): update 2 files",
			"git push -u origin HEAD",
			"gh pr create --fill",
		]);
		expect(ask).toHaveBeenCalledTimes(3);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("committed locally"), "info");
		expect(notify).toHaveBeenCalledWith("PR opened for sumo/worktree-fanout", "info");
	});

	it("never pushes when push confirmation is declined", async () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const { handler, ask, notify, ctx } = setup(async (cmd, args) => {
			calls.push({ cmd, args });
			if (cmd === "git" && args[0] === "status") return { code: 0, stdout: " M src/a.ts\0", stderr: "", killed: false };
			if (cmd === "git" && args[0] === "branch") return { code: 0, stdout: "sumo/no-push\n", stderr: "", killed: false };
			return { code: 0, stdout: "", stderr: "", killed: false };
		}, ["Commit", "Cancel"]);

		await handler?.("", ctx);

		expect(calls.some((call) => call.cmd === "git" && call.args[0] === "push")).toBe(false);
		expect(calls.some((call) => call.cmd === "gh")).toBe(false);
		expect(ask).toHaveBeenCalledTimes(2);
		expect(notify).toHaveBeenCalledWith("/sumo:ship stopped before push", "info");
	});

	it("pushes but never creates PR when PR confirmation is declined", async () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const { handler, notify, ctx } = setup(async (cmd, args) => {
			calls.push({ cmd, args });
			if (cmd === "git" && args[0] === "status") return { code: 0, stdout: " M src/a.ts\0", stderr: "", killed: false };
			if (cmd === "git" && args[0] === "branch") return { code: 0, stdout: "sumo/no-pr\n", stderr: "", killed: false };
			return { code: 0, stdout: "", stderr: "", killed: false };
		}, ["Commit", "Push", "Cancel"]);

		await handler?.("", ctx);

		expect(calls.some((call) => call.cmd === "git" && call.args[0] === "push")).toBe(true);
		expect(calls.some((call) => call.cmd === "gh")).toBe(false);
		expect(notify).toHaveBeenCalledWith("/sumo:ship stopped before PR creation", "info");
	});

	it("stops before commit when commit confirmation is declined", async () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const { handler, notify, ctx } = setup(async (cmd, args) => {
			calls.push({ cmd, args });
			if (cmd === "git" && args[0] === "status") return { code: 0, stdout: " M src/a.ts\0", stderr: "", killed: false };
			if (cmd === "git" && args[0] === "branch") return { code: 0, stdout: "sumo/no-commit\n", stderr: "", killed: false };
			return { code: 0, stdout: "", stderr: "", killed: false };
		}, ["Cancel"]);

		await handler?.("", ctx);

		expect(calls.some((call) => call.cmd === "git" && call.args[0] === "add")).toBe(false);
		expect(calls.some((call) => call.cmd === "git" && call.args[0] === "commit")).toBe(false);
		expect(calls.some((call) => call.cmd === "git" && call.args[0] === "push")).toBe(false);
		expect(calls.some((call) => call.cmd === "gh")).toBe(false);
		expect(notify).toHaveBeenCalledWith("/sumo:ship stopped before commit", "info");
	});

	it("counts rename records as one changed file", async () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const { handler, notify, ctx } = setup(async (cmd, args) => {
			calls.push({ cmd, args });
			if (cmd === "git" && args[0] === "status") return { code: 0, stdout: "R  new name.ts\0old name.ts\0 M src/b.ts\0", stderr: "", killed: false };
			if (cmd === "git" && args[0] === "branch") return { code: 0, stdout: "sumo/rename\n", stderr: "", killed: false };
			return { code: 0, stdout: "", stderr: "", killed: false };
		}, ["Commit", "Cancel"]);

		await handler?.("", ctx);

		expect(calls.map((call) => `${call.cmd} ${call.args.join(" ")}`)).toContain("git commit -m chore(rename): update 2 files");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("committed locally: chore(rename): update 2 files · new name.ts, src/b.ts"), "info");
	});

	it("reports gh failures clearly", async () => {
		const { handler, notify, ctx } = setup(async (cmd, args) => {
			if (cmd === "git" && args[0] === "status") return { code: 0, stdout: " M src/a.ts\0", stderr: "", killed: false };
			if (cmd === "git" && args[0] === "branch") return { code: 0, stdout: "sumo/ship\n", stderr: "", killed: false };
			if (cmd === "gh") return { code: 127, stdout: "", stderr: "gh: command not found", killed: false };
			return { code: 0, stdout: "", stderr: "", killed: false };
		}, ["Commit", "Push", "Open PR"]);

		await handler?.("", ctx);

		expect(notify).toHaveBeenCalledWith("/sumo:ship: gh pr create failed: gh: command not found", "warning");
	});
});
