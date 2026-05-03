/**
 * `/slate` — session-scoped idea parking lot.
 *
 * - `/slate <text>`   — park an idea
 * - `/slate`          — review parked ideas (Divine Query modal)
 * - `/slate done [n]` — resolve item (pop first if no arg)
 * - `/slate clear`    — clear all items
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Slate, SLATE_CUSTOM_TYPE } from "../slate.js";
import { showDivineQuery } from "../divine-query.js";

/** Module-level singleton — one slate per process (Pi runs one session at a time). */
let slate = new Slate();

export function getSlate(): Slate {
	return slate;
}

// ── Lifecycle ────────────────────────────────────────────────

function reconstructSlate(ctx: ExtensionContext): void {
	try {
		const entries = ctx.sessionManager.getEntries();
		slate = Slate.fromEntries(entries as Parameters<typeof Slate.fromEntries>[0]);
	} catch {
		slate = new Slate();
	}
}

function persistSlate(pi: ExtensionAPI): void {
	if (slate.isEmpty) return;
	pi.appendEntry(SLATE_CUSTOM_TYPE, slate.toJSON());
}

// ── Command handler ──────────────────────────────────────────

function parseSubcommand(rawArgs: string): { action: "add"; text: string } | { action: "list" } | { action: "done"; index?: number } | { action: "clear" } {
	const joined = rawArgs.trim();
	if (joined === "") return { action: "list" };
	if (joined === "clear") return { action: "clear" };
	if (joined === "done" || joined.startsWith("done ")) {
		const rest = joined.slice(4).trim();
		if (rest === "") return { action: "done" };
		const num = Number.parseInt(rest, 10);
		if (Number.isFinite(num) && num > 0) return { action: "done", index: num };
		return { action: "done" };
	}
	return { action: "add", text: joined };
}

async function handleSlateCommand(args: string, ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	const parsed = parseSubcommand(args);

	switch (parsed.action) {
		case "add": {
			const count = slate.add(parsed.text);
			ctx.ui.notify(`✦ slated: ${parsed.text} (${count} pending)`, "info");
			return;
		}

		case "clear": {
			const removed = slate.clear();
			ctx.ui.notify(`✦ slate cleared (${removed} item${removed === 1 ? "" : "s"} removed)`, "info");
			return;
		}

		case "done": {
			const removed = slate.remove(parsed.index);
			if (removed !== undefined) {
				ctx.ui.notify(`\u2726 resolved: ${removed} (${slate.length} remaining)`, "info");
			} else {
				ctx.ui.notify("slate is empty or index out of range", "warning");
			}
			return;
		}

		case "list": {
			if (slate.isEmpty) {
				ctx.ui.notify("slate is empty", "info");
				return;
			}
			const items = [...slate.list()];
			const options: readonly string[] = items.map((item, index) => `${index + 1}. ${item}`);
			const selectedText = await showDivineQuery(ctx, "SLATE \u2014 parked ideas", options);
			if (selectedText === undefined) return;

			const selectedIndex = options.indexOf(selectedText);
			if (selectedIndex < 0 || selectedIndex >= items.length) return;
			const item = items[selectedIndex]!;

			// Send as user message to trigger the agent
			try {
				pi.sendUserMessage(`[slate] Pick up: ${item}`, { deliverAs: "followUp" });
				ctx.ui.notify(`✦ picking up: ${item}`, "info");
			} catch {
				// Agent might be idle — send without deliverAs
				pi.sendUserMessage(`[slate] Pick up: ${item}`);
				ctx.ui.notify(`✦ picking up: ${item}`, "info");
			}
			return;
		}
	}
}

// ── Tool registration ────────────────────────────────────────

function registerSlateTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "slate_list",
		label: "Slate List",
		description: "List all items currently parked in the user's Slate",
		promptSnippet: "List parked ideas from the user's Slate",
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [{ type: "text", text: slate.formatForAgent() }],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "slate_done",
		label: "Slate Done",
		description: "Mark a slated item as done and remove it from the Slate",
		promptSnippet: "Remove a completed item from the user's Slate",
		promptGuidelines: [
			"Always ask the user for confirmation before calling slate_done. Never auto-remove slated items.",
		],
		parameters: Type.Object({
			index: Type.Number({ description: "1-based index of the item to remove" }),
		}),
		async execute(_toolCallId, params) {
			const index = typeof params.index === "number" ? params.index : 1;
			const removed = slate.remove(index);
			if (!removed) {
				return {
					content: [{ type: "text", text: `No item at index ${index}. ${slate.formatForAgent()}` }],
					details: undefined,
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: `Resolved: "${removed}". ${slate.formatForAgent()}` }],
				details: undefined,
			};
		},
	});
}

// ── Public installer ─────────────────────────────────────────

export function registerSlateCommand(pi: ExtensionAPI): void {
	pi.registerCommand("slate", {
		description: "Park an idea for later — /slate <text> to add, /slate to review",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				process.stdout.write("slate requires interactive UI\n");
				return;
			}
			await handleSlateCommand(args, ctx, pi);
		},
	});

	registerSlateTools(pi);

	pi.on("session_start", (_event, ctx) => {
		reconstructSlate(ctx);
	});

	pi.on("session_shutdown", () => {
		persistSlate(pi);
	});
}
