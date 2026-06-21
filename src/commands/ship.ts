import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showDivineQuery } from "../divine-query.js";

export interface ShipCommandOptions {
	readonly ask?: (ctx: ExtensionContext, title: string, options: readonly string[]) => Promise<string | null>;
}

interface ExecResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly killed: boolean;
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	process.stdout.write(`${message}\n`);
}

function changedFiles(statusPorcelainZ: string): string[] {
	const out: string[] = [];
	const records = statusPorcelainZ.split("\0");
	for (let i = 0; i < records.length; i += 1) {
		const record = records[i];
		if (!record) continue;
		const xy = record.slice(0, 2);
		let path = record.slice(3);
		// Renames/copies (R/C) emit the destination path, then the source path
		// as the NEXT NUL-separated field. Consume it and keep the destination.
		if (xy[0] === "R" || xy[0] === "C") {
			i += 1;
		}
		path = path.trim();
		if (path) out.push(path);
	}
	return out;
}

export function draftCommitMessage(branch: string, files: readonly string[]): string {
	const branchSlug = branch.replace(/^sumo\//, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
	const scope = branchSlug || "changes";
	const noun = files.length === 1 ? "file" : "files";
	return `chore(${scope}): update ${files.length} ${noun}`;
}

async function exec(pi: ExtensionAPI, cmd: string, args: readonly string[], cwd: string): Promise<ExecResult> {
	return pi.exec(cmd, [...args], { cwd, timeout: 30_000 }) as Promise<ExecResult>;
}

async function ensureOk(result: ExecResult, label: string): Promise<void> {
	if (result.code === 0 && !result.killed) return;
	throw new Error(`${label} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
}

export function registerShipCommand(pi: ExtensionAPI, options: ShipCommandOptions = {}): void {
	const ask = options.ask ?? ((ctx, title, choices) => showDivineQuery(ctx, title, choices));
	pi.registerCommand("sumo:ship", {
		description: "Commit locally, then human-gate push and PR creation",
		handler: async (_args, ctx) => {
			try {
				const status = await exec(pi, "git", ["status", "--porcelain", "-z"], ctx.cwd);
				await ensureOk(status, "git status");
				const files = changedFiles(status.stdout);
				if (files.length === 0) {
					notify(ctx, "/sumo:ship: no working-tree changes to commit", "warning");
					return;
				}
				const branchResult = await exec(pi, "git", ["branch", "--show-current"], ctx.cwd);
				await ensureOk(branchResult, "git branch");
				const branch = branchResult.stdout.trim() || "HEAD";
				const message = draftCommitMessage(branch, files);
				const summary = files.slice(0, 8).join(", ") + (files.length > 8 ? `, +${files.length - 8} more` : "");

				if (ctx.hasUI) {
					const commitChoice = await ask(ctx, `Commit ${files.length} change(s) on ${branch}?\nMessage: ${message}\nFiles: ${summary}`, ["Commit", "Cancel"]);
					if (commitChoice !== "Commit") {
						notify(ctx, "/sumo:ship stopped before commit");
						return;
					}
				}

				await ensureOk(await exec(pi, "git", ["add", "-A"], ctx.cwd), "git add");
				await ensureOk(await exec(pi, "git", ["commit", "-m", message], ctx.cwd), "git commit");
				notify(ctx, `committed locally: ${message} · ${summary}`);

				if (!ctx.hasUI) {
					notify(ctx, "/sumo:ship stopped before push: interactive confirmation required", "warning");
					return;
				}
				const pushChoice = await ask(ctx, `Push branch ${branch}?\nCommit: ${message}\nFiles: ${summary}`, ["Push", "Cancel"]);
				if (pushChoice !== "Push") {
					notify(ctx, "/sumo:ship stopped before push");
					return;
				}
				await ensureOk(await exec(pi, "git", ["push", "-u", "origin", "HEAD"], ctx.cwd), "git push");
				notify(ctx, `pushed ${branch}`);

				const prChoice = await ask(ctx, `Open PR for ${branch}?\nTitle: ${message}`, ["Open PR", "Cancel"]);
				if (prChoice !== "Open PR") {
					notify(ctx, "/sumo:ship stopped before PR creation");
					return;
				}
				await ensureOk(await exec(pi, "gh", ["pr", "create", "--fill"], ctx.cwd), "gh pr create");
				notify(ctx, `PR opened for ${branch}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notify(ctx, `/sumo:ship: ${message}`, "warning");
			}
		},
	});
}
