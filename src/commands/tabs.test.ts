import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	TABS_LOCAL_CONFIG_KEY,
	isTopChromeHidden,
	registerTabsCommand,
	setTopChromeHidden,
} from "./tabs.js";

describe("tabs slash command — local config flag", () => {
	let tmpHome: string;
	let configPath: string;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "sumocode-tabs-"));
		configPath = join(tmpHome, "local-config.json");
	});

	afterEach(() => {
		rmSync(tmpHome, { recursive: true, force: true });
	});

	it("isTopChromeHidden returns false when no config file exists", () => {
		expect(isTopChromeHidden(configPath)).toBe(false);
	});

	it("isTopChromeHidden returns true when config has topChromeHidden: true", () => {
		writeFileSync(configPath, JSON.stringify({ [TABS_LOCAL_CONFIG_KEY]: true }));
		expect(isTopChromeHidden(configPath)).toBe(true);
	});

	it("isTopChromeHidden returns false when config has the key set to false", () => {
		writeFileSync(configPath, JSON.stringify({ [TABS_LOCAL_CONFIG_KEY]: false }));
		expect(isTopChromeHidden(configPath)).toBe(false);
	});

	it("isTopChromeHidden returns false on malformed JSON (graceful fallback)", () => {
		writeFileSync(configPath, "this is not json");
		expect(isTopChromeHidden(configPath)).toBe(false);
	});

	it("setTopChromeHidden writes the flag and preserves other keys", () => {
		writeFileSync(configPath, JSON.stringify({ otherSetting: "preserved", sidebarAnchor: "right-center" }));
		setTopChromeHidden(true, configPath);
		const written = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
		expect(written[TABS_LOCAL_CONFIG_KEY]).toBe(true);
		expect(written.otherSetting).toBe("preserved");
		expect(written.sidebarAnchor).toBe("right-center");
	});

	it("setTopChromeHidden creates the file when it doesn't exist", () => {
		setTopChromeHidden(true, configPath);
		const written = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
		expect(written[TABS_LOCAL_CONFIG_KEY]).toBe(true);
	});
});

describe("registerTabsCommand", () => {
	it("registers a /sumo:tabs slash command on the pi API", () => {
		const registerCommand = vi.fn();
		registerTabsCommand({ registerCommand } as never);
		expect(registerCommand).toHaveBeenCalledWith(
			"sumo:tabs",
			expect.objectContaining({ description: expect.any(String), handler: expect.any(Function) }),
		);
	});

	it("/sumo:tabs hide sets the flag", async () => {
		const tmpHome = mkdtempSync(join(tmpdir(), "sumocode-tabs-cmd-"));
		const configPath = join(tmpHome, "local-config.json");
		try {
			let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
			const registerCommand = vi.fn((_name: string, opts: { handler: typeof handler }) => {
				handler = opts.handler;
			});
			const notify = vi.fn();
			registerTabsCommand({ registerCommand } as never, { configPath });
			await handler!("hide", { ui: { notify } });
			expect(isTopChromeHidden(configPath)).toBe(true);
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("hidden"), "info");
		} finally {
			rmSync(tmpHome, { recursive: true, force: true });
		}
	});

	it("/sumo:tabs show clears the flag", async () => {
		const tmpHome = mkdtempSync(join(tmpdir(), "sumocode-tabs-cmd-show-"));
		const configPath = join(tmpHome, "local-config.json");
		try {
			writeFileSync(configPath, JSON.stringify({ [TABS_LOCAL_CONFIG_KEY]: true }));
			let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
			const registerCommand = vi.fn((_name: string, opts: { handler: typeof handler }) => {
				handler = opts.handler;
			});
			const notify = vi.fn();
			registerTabsCommand({ registerCommand } as never, { configPath });
			await handler!("show", { ui: { notify } });
			expect(isTopChromeHidden(configPath)).toBe(false);
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("visible"), "info");
		} finally {
			rmSync(tmpHome, { recursive: true, force: true });
		}
	});

	it("/sumo:tabs (no args) shows current state", async () => {
		const tmpHome = mkdtempSync(join(tmpdir(), "sumocode-tabs-cmd-status-"));
		const configPath = join(tmpHome, "local-config.json");
		try {
			let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
			const registerCommand = vi.fn((_name: string, opts: { handler: typeof handler }) => {
				handler = opts.handler;
			});
			const notify = vi.fn();
			registerTabsCommand({ registerCommand } as never, { configPath });
			await handler!("", { ui: { notify } });
			expect(notify).toHaveBeenCalled();
			const message = notify.mock.calls[0]?.[0] as string;
			expect(message.toLowerCase()).toMatch(/visible|hidden/);
		} finally {
			rmSync(tmpHome, { recursive: true, force: true });
		}
	});
});
