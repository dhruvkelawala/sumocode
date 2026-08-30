/**
 * Visual evidence for the /accounts row layout (AGENTS.md: visual UI work
 * requires capture/review evidence). Captures rows produced by the real
 * command through ModalLayer at portrait and landscape widths, proving the
 * active-account state survives clipping.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalLayer } from "../sumo-tui/widgets/modal-layer.js";
import { executeAccountsCommand } from "./accounts.js";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

// oxlint-disable-next-line no-control-regex -- intentional ESC byte match for terminal control sequences
const ANSI = /\u001b\[[0-9;]*m/g;

function stripAnsi(line: string): string {
	return line.replace(ANSI, "");
}

async function accountRows(): Promise<string[]> {
	const agentDir = mkdtempSync(join(tmpdir(), "sumocode-accounts-visual-"));
	tempDirs.push(agentDir);
	writeFileSync(
		join(agentDir, "claude-accounts.json"),
		JSON.stringify({ subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] }),
		"utf8",
	);
	const select = vi.fn(async (_title: string, _options: string[]): Promise<string | undefined> => undefined);
	const ctx = {
		mode: "rpc",
		hasUI: true,
		ui: { select, notify: vi.fn() },
		modelRegistry: {
			getProviderAuthStatus: () => ({ configured: true }),
			getAll: () => [],
		},
		model: { provider: "anthropic-2", id: "claude-opus-5" },
	};
	// SAFETY: the doubles supply every API and context member read before the
	// intentionally cancelled first selector.
	await executeAccountsCommand({} as never, ctx as never, { agentDir, homeDir: agentDir });
	const firstCall = select.mock.calls[0];
	if (!firstCall) throw new Error("/accounts did not open its account selector");
	return firstCall[1];
}

function renderAccountsModal(rows: string[], width: number): string {
	const modal = new ModalLayer({ copyText: () => true });
	void modal.select("CLAUDE ACCOUNTS", rows);
	try {
		return modal.render(width).map(stripAnsi).join("\n");
	} finally {
		modal.close();
	}
}

describe("accounts modal row layout", () => {
	it("captures the real account rows at the narrow portrait width", async () => {
		const text = renderAccountsModal(await accountRows(), 36);
		expect(text).toMatchSnapshot();
		expect(text).toContain("default account · signed in");
		expect(text).toContain("company · in use");
		expect(text).toContain("add Claude account");
	});

	it("keeps the active-account state visible across supported widths", async () => {
		const rows = await accountRows();
		for (const width of [36, 40, 50, 60, 80, 160]) {
			const text = renderAccountsModal(rows, width);
			expect(text, `width ${width}`).toContain("default account · signed in");
			expect(text, `width ${width}`).toContain("company · in use");
		}
	});
});
