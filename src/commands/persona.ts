import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const DEFAULT_PERSONA_PATH = join(homedir(), ".pi", "agent", "APPEND_SYSTEM.md");

export type PersonaCommandResult = {
	kind: "success" | "error" | "instructions";
	message: string;
	opened: boolean;
};

export type EditorOutcome = {
	status: number;
	error?: string;
};

export type PersonaCommandDeps = {
	personaPath: string;
	isTTY: boolean;
	editor: string;
	fileExists: (path: string) => boolean;
	runEditor: (editor: string, file: string) => EditorOutcome;
};

export function runPersonaCommand(deps: PersonaCommandDeps): PersonaCommandResult {
	if (!deps.fileExists(deps.personaPath)) {
		return {
			kind: "error",
			opened: false,
			message: `persona file not found: ${deps.personaPath} — run sumocode-config/bootstrap.sh first`,
		};
	}

	if (!deps.isTTY) {
		return {
			kind: "instructions",
			opened: false,
			message: `persona file: ${deps.personaPath} — edit it directly, then reload Pi`,
		};
	}

	const outcome = deps.runEditor(deps.editor, deps.personaPath);

	if (outcome.status === 0) {
		return {
			kind: "success",
			opened: true,
			message: "persona updated — reload Pi to apply",
		};
	}

	if (outcome.error) {
		return {
			kind: "error",
			opened: true,
			message: `failed to launch editor "${deps.editor}": ${outcome.error}`,
		};
	}

	return {
		kind: "error",
		opened: true,
		message: `editor "${deps.editor}" exited with code ${outcome.status}`,
	};
}

function notify(ctx: ExtensionContext, result: PersonaCommandResult): void {
	const type = result.kind === "error" ? "error" : "info";
	if (ctx.hasUI) {
		ctx.ui.notify(result.message, type);
		return;
	}
	const stream = type === "error" ? process.stderr : process.stdout;
	stream.write(`${result.message}\n`);
}

/** Split an EDITOR value with flags (`"nvim -f"`) into command + args. */
export function parsePersonaEditorCommand(editor: string): { command: string; args: readonly string[] } {
	const parts = editor.trim().split(/\s+/).filter((part) => part.length > 0);
	return { command: parts[0] ?? editor, args: parts.slice(1) };
}

function defaultRunEditor(editor: string, file: string): EditorOutcome {
	const { command, args } = parsePersonaEditorCommand(editor);
	const child = spawnSync(command, [...args, file], { stdio: "inherit", env: process.env });
	return {
		status: child.status ?? 1,
		error: child.error?.message,
	};
}

export function registerPersonaCommand(
	pi: ExtensionAPI,
	overrides: Partial<Pick<PersonaCommandDeps, "personaPath" | "fileExists" | "runEditor">> = {},
): void {
	const personaPath = overrides.personaPath ?? DEFAULT_PERSONA_PATH;
	const fileExists = overrides.fileExists ?? existsSync;
	const runEditor = overrides.runEditor ?? defaultRunEditor;

	pi.registerCommand("sumo:persona", {
		description: "Edit the Zeus persona prompt in $EDITOR",
		handler: async (_args, ctx) => {
			// Same RPC-host guard as roles: spawnSync with stdio:inherit has no
			// TTY here and blocks the host event loop — the shell would freeze.
			if (ctx.mode === "rpc") {
				notify(ctx, {
					kind: "instructions",
					opened: false,
					message: `persona file: ${personaPath} — $EDITOR cannot run inside the rpc host — edit it directly, then reload Pi`,
				});
				return;
			}
			const result = runPersonaCommand({
				personaPath,
				isTTY: ctx.hasUI,
				editor: process.env.EDITOR?.trim() || "vi",
				fileExists,
				runEditor,
			});
			notify(ctx, result);
		},
	});
}
