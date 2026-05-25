import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { SUMOCODE_STATES, type SumoCodeState } from "./tokens.js";
import {
	formatCwd,
	formatFooterLine,
	installFooter,
	renderFooterBlock,
	renderSplashVersionLine,
	resolveGitBranch,
	SPLASH_VERSION_LINE,
	type FooterSnapshot,
} from "./footer.js";
import { VOICE } from "./voice.js";

const ANSI = /\u001b\[[0-9;]*m/g;
const tempDirs: string[] = [];

function withoutAnsi(value: string): string {
	return value.replace(ANSI, "");
}

function snapshot(overrides: Partial<FooterSnapshot> = {}): FooterSnapshot {
	return {
		cwd: join(process.env.HOME ?? "/Users/dev", "sample-app"),
		branch: "main",
		inputTokens: 12_000,
		outputTokens: 8_000,
		contextTokens: 42_000,
		contextWindow: 200_000,
		costUsd: 0.42,
		state: "idle",
		modelId: "claude-opus-4-7",
		thinkingLevel: "xhigh",
		...overrides,
	};
}

function tmpGitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "sumocode-footer-"));
	tempDirs.push(dir);
	execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "SumoCode Test"], { cwd: dir });
	execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir, stdio: "ignore" });
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type FooterComponent = { render(width: number): string[]; dispose?(): void };
type FooterFactory = (
	tui: { requestRender(): void },
	theme: unknown,
	footerData: Pick<ReadonlyFooterDataProvider, "getGitBranch" | "onBranchChange">,
) => FooterComponent;

function installFooterHarness(): {
	setFooter(factory: FooterFactory | undefined): void;
	fireSessionStart(ctx: ExtensionContext): void;
	latestFactory(): FooterFactory;
} {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
	let factory: FooterFactory | undefined;
	const pi = {
		on: vi.fn((eventName: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
			const list = handlers.get(eventName) ?? [];
			list.push(handler);
			handlers.set(eventName, list);
		}),
		getThinkingLevel: () => "medium",
	} as unknown as ExtensionAPI;
	installFooter(pi);
	return {
		setFooter(next: FooterFactory | undefined): void {
			factory = next;
		},
		fireSessionStart(ctx: ExtensionContext): void {
			for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start" }, ctx);
		},
		latestFactory(): FooterFactory {
			if (!factory) throw new Error("footer factory was not registered");
			return factory;
		},
	};
}

function footerCtx(options: { cwd?: string; modelId?: string; throwOnSnapshot?: boolean; setFooter?: (factory: FooterFactory | undefined) => void }): ExtensionContext {
	const branch = [{ type: "message", message: { role: "assistant", usage: { input: 10, output: 5, cost: { total: 0.01 } } } }];
	const ctx = {
		hasUI: true,
		ui: {
			setFooter: options.setFooter ?? (() => undefined),
		},
		sessionManager: {
			getBranch: () => {
				if (options.throwOnSnapshot) throw new Error("stale extension ctx");
				return branch;
			},
		},
		getContextUsage: () => {
			if (options.throwOnSnapshot) throw new Error("stale extension ctx");
			return { tokens: 15, contextWindow: 1000 };
		},
	};
	Object.defineProperties(ctx, {
		cwd: {
			get() {
				if (options.throwOnSnapshot) throw new Error("stale extension ctx");
				return options.cwd ?? "/tmp/sumocode";
			},
		},
		model: {
			get() {
				if (options.throwOnSnapshot) throw new Error("stale extension ctx");
				return { id: options.modelId ?? "test-model", contextWindow: 1000 };
			},
		},
	});
	return ctx as unknown as ExtensionContext;
}

function footerData(branch: string | null, throwOnRead = false): Pick<ReadonlyFooterDataProvider, "getGitBranch" | "onBranchChange"> {
	return {
		getGitBranch: () => {
			if (throwOnRead) throw new Error("stale footer data");
			return branch;
		},
		onBranchChange: () => () => undefined,
	};
}

describe("installFooter", () => {
	it("renders old footer components against the latest session context after replacement", () => {
		const harness = installFooterHarness();
		const tui = { requestRender: vi.fn() };
		const staleCtx = footerCtx({ throwOnSnapshot: true, setFooter: harness.setFooter });
		harness.fireSessionStart(staleCtx);
		const staleComponent = harness.latestFactory()(tui, {}, footerData("old", true));

		const freshCtx = footerCtx({ modelId: "fresh-model", setFooter: harness.setFooter });
		harness.fireSessionStart(freshCtx);
		harness.latestFactory()(tui, {}, footerData("fresh"));

		const plain = staleComponent.render(100).join("\n").replace(ANSI, "");
		expect(plain).toContain("fresh-model");
		expect(plain).toContain("15/1.0k");
	});

	it("falls back instead of throwing when the only footer context is stale", () => {
		const harness = installFooterHarness();
		const staleCtx = footerCtx({ throwOnSnapshot: true, setFooter: harness.setFooter });
		harness.fireSessionStart(staleCtx);
		const component = harness.latestFactory()({ requestRender: vi.fn() }, {}, footerData("old", true));

		expect(() => component.render(100)).not.toThrow();
	});
});

describe("formatFooterLine — F1 two-zone layout", () => {
	it.each(SUMOCODE_STATES)("left zone has dot + cathedral label + model + thinking for %s", (state: SumoCodeState) => {
		const line = formatFooterLine(snapshot({ state, thinkingLevel: "xhigh" }));
		const plain = withoutAnsi(line);

		// Left zone: ● <STATE> · claude-opus-4-7 · xhigh
		expect(plain).toContain(`● ${VOICE.status[state]}`);
		expect(plain).toContain("claude-opus-4-7");
		expect(plain).toContain("xhigh");
	});

	it("right zone has context tokens + cost", () => {
		const line = withoutAnsi(formatFooterLine(snapshot()));

		expect(line).toContain("42k/200k");
		expect(line).toContain("$0.42");
	});

	it("does NOT include cumulative input/output arrows", () => {
		const line = withoutAnsi(formatFooterLine(snapshot()));
		expect(line).not.toContain("↑");
		expect(line).not.toContain("↓");
	});

	it("places state on the left and session metrics on the right with a gap", () => {
		const line = withoutAnsi(formatFooterLine(snapshot(), 160));
		const stateIdx = line.indexOf(VOICE.status.idle);
		const tokensIdx = line.indexOf("42k/200k");

		expect(stateIdx).toBeGreaterThanOrEqual(0);
		expect(tokensIdx).toBeGreaterThanOrEqual(0);
		expect(tokensIdx).toBeGreaterThan(stateIdx);
		// At least 3 spaces of gap between zones
		expect(line).toMatch(/   {3,}/);
	});

	it("includes thinking level after model id", () => {
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"] as const) {
			const line = withoutAnsi(formatFooterLine(snapshot({ thinkingLevel: level })));
			const modelIdx = line.indexOf("claude-opus-4-7");
			const levelIdx = line.indexOf(level);
			expect(modelIdx).toBeGreaterThanOrEqual(0);
			expect(levelIdx).toBeGreaterThanOrEqual(0);
			expect(levelIdx).toBeGreaterThan(modelIdx);
		}
	});

	it("appends fast after thinking when fast mode applies", () => {
		const line = withoutAnsi(formatFooterLine(snapshot({ modelId: "gpt-5.5", thinkingLevel: "high", showFastMode: true })));
		expect(line).toContain("gpt-5.5");
		expect(line).toContain("high");
		expect(line).toContain("fast");
		expect(line.indexOf("high")).toBeLessThan(line.indexOf("fast"));
	});

	it("omits fast label when showFastMode is false", () => {
		const line = withoutAnsi(formatFooterLine(snapshot({ thinkingLevel: "high", showFastMode: false })));
		expect(line).toContain("high");
		expect(line).not.toContain("fast");
	});

	it("omits project and git branch to avoid duplicating sidebar/hint row", () => {
		const line = withoutAnsi(formatFooterLine(snapshot()));

		expect(line).not.toContain("~/sample-app");
		expect(line).not.toContain("(main)");
	});

	it("drops cost first when too narrow to fit everything", () => {
		const line = withoutAnsi(formatFooterLine(snapshot(), 80));
		expect(line).toContain("42k/200k");
		expect(line.length).toBeLessThanOrEqual(80);
	});

	it("left-zone-only at very narrow widths", () => {
		const line = withoutAnsi(formatFooterLine(snapshot(), 50));
		expect(line).toContain(VOICE.status.idle);
		expect(line.length).toBeLessThanOrEqual(50);
	});

	it("adds one-cell side padding for footer rhythm", () => {
		for (const width of [60, 160]) {
			const line = withoutAnsi(formatFooterLine(snapshot(), width));
			expect(line).toHaveLength(width);
			expect(line.startsWith(" ")).toBe(true);
			expect(line.endsWith(" ")).toBe(true);
			expect(line.trim()).toContain(VOICE.status.idle);
		}
	});
});

describe("formatFooterLine — cathedral coloring", () => {
	it("renders · separators in foregroundDim", () => {
		const line = formatFooterLine(snapshot());
		// #8B7A63 -> 139;122;99
		expect(line).toContain("\u001b[38;2;139;122;99m");
	});

	it("renders separators in foreground-dim", () => {
		const line = formatFooterLine(snapshot());
		// #8B7A63 -> 139;122;99
		expect(line).toContain("\u001b[38;2;139;122;99m");
	});

	it("keeps the path in vellum foreground", () => {
		const line = formatFooterLine(snapshot());
		// #F5E6C8 -> 245;230;200
		expect(line).toContain("\u001b[38;2;245;230;200m");
	});
});

describe("formatCwd", () => {
	it("replaces $HOME with ~", () => {
		const home = process.env.HOME ?? "/Users/dev";
		expect(formatCwd(`${home}/sample-app`)).toBe("~/sample-app");
	});

	it("returns just the basename for paths outside $HOME", () => {
		expect(formatCwd("/Volumes/SumoDeus NVMe/code/sumocode")).toBe("sumocode");
		expect(formatCwd("/opt/homebrew/etc")).toBe("etc");
	});

	it("keeps a single ~ for HOME itself", () => {
		const home = process.env.HOME ?? "/Users/dev";
		expect(formatCwd(home)).toBe("~");
	});
});

describe("renderFooterBlock — splash renders Bible version block", () => {
	it("in active state, returns one semantic footer line", () => {
		const lines = renderFooterBlock(snapshot({ isSplash: false }));
		expect(lines.length).toBe(1);
		expect(lines[0]).toMatch(/READY|MEDITATING|ILLUMINATING/);
	});

	it("on splash, returns breathing rows plus version with no status footer", () => {
		const lines = renderFooterBlock(snapshot({ isSplash: true }), 160);
		expect(lines.length).toBe(10);
		const plain = lines.map((line) => line.replace(ANSI, ""));
		expect(plain[2]).toContain(SPLASH_VERSION_LINE);
		expect(plain.join("\n")).not.toContain("READY");
	});

	it("on splash but too narrow for version line, keeps breathing rows without status footer", () => {
		const lines = renderFooterBlock(snapshot({ isSplash: true }), 30);
		expect(lines.length).toBe(9);
		expect(lines.join("\n").replace(ANSI, "")).not.toContain("READY");
	});
});

describe("renderSplashVersionLine", () => {
	it("renders the SUMOCODE V0.3.0 version string", () => {
		const line = renderSplashVersionLine(160).replace(ANSI, "");
		expect(line).toContain("SUMOCODE V0.3.0");
		expect(line).toContain("CATHEDRAL");
		expect(line).toContain("160 \u00d7 45 MONOSPACE");
	});

	it("renders in foregroundDim color (#8B7A63)", () => {
		const line = renderSplashVersionLine(160);
		// 139;122;99 = #8B7A63
		expect(line).toContain("\u001b[38;2;139;122;99m");
	});

	it("centers the version line horizontally", () => {
		const line = renderSplashVersionLine(160);
		const plain = line.replace(ANSI, "");
		expect(plain.length).toBe(160);
		// Equal-ish leading and trailing whitespace
		const leading = plain.length - plain.trimStart().length;
		const trailing = plain.length - plain.trimEnd().length;
		expect(Math.abs(leading - trailing)).toBeLessThanOrEqual(1);
	});

	it("returns empty string when too narrow for the version text", () => {
		expect(renderSplashVersionLine(20)).toBe("");
	});
});

describe("resolveGitBranch", () => {
	it("detects the current branch", () => {
		const repo = tmpGitRepo();

		expect(resolveGitBranch(repo)).toBe("main");
	});

	it("reports detached HEAD as detached", () => {
		const repo = tmpGitRepo();
		const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
		execFileSync("git", ["checkout", "--detach", sha], { cwd: repo, stdio: "ignore" });

		expect(resolveGitBranch(repo)).toBe("detached");
	});

	it("returns null outside a git repository", () => {
		const dir = mkdtempSync(join(tmpdir(), "sumocode-no-git-"));
		tempDirs.push(dir);

		expect(resolveGitBranch(dir)).toBeNull();
	});
});
