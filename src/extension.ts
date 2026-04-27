import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { installInputHints } from "./cathedral/input-hints.js";
import { registerPersonaCommand } from "./commands/persona.js";
import { registerSpinnerCommand } from "./commands/spinner.js";
import { registerTabsCommand } from "./commands/tabs.js";
import { registerThemeCommand } from "./commands/theme.js";
import { registerThemeCheckCommand } from "./commands/theme-check.js";
// Element 6 approval gate disabled per Dhruv's request 2026-04-27.
// The cathedral approval modal was blocking bash/edit/write tool calls and
// slowing down agent iteration. We trust Pi's own tool security model for now.
// Re-enable later if we want a per-tool consent UX (Phase 7+).
// import { installApprovalGate } from "./approval-modal.js";
import { installAltscreen } from "./cathedral/altscreen.js";
import { installCathedralEditor } from "./cathedral/cathedral-editor.js";
import { installCommandPalette } from "./command-palette.js";
import { installFooter } from "./footer.js";
import { registerMemoryCommand } from "./memory-editor.js";
import { installSidebar } from "./sidebar.js";
import { installSplash } from "./splash.js";
import { installTopChrome } from "./top-chrome.js";
import { installWorkingIndicator } from "./working-indicator.js";

const SUMOCODE_PACKAGE_NAME = "@dhruvkelawala/sumocode";

type ExistsFn = (path: string) => boolean;
type ReadFileFn = (path: string, encoding: BufferEncoding) => string;

export interface DuplicateInstalledExtensionOptions {
	readonly moduleUrl?: string;
	readonly cwd?: string;
	readonly homeDir?: string;
	readonly exists?: ExistsFn;
	readonly readFile?: ReadFileFn;
}

function moduleUrlToPath(moduleUrl: string): string {
	try {
		return moduleUrl.startsWith("file:") ? fileURLToPath(moduleUrl) : moduleUrl;
	} catch {
		return moduleUrl;
	}
}

export function isInstalledPiAgentGitModule(moduleUrl: string, homeDir = homedir()): boolean {
	const modulePath = resolve(moduleUrlToPath(moduleUrl));
	const agentGitRoot = `${resolve(homeDir, ".pi", "agent", "git")}${sep}`;
	return modulePath.startsWith(agentGitRoot);
}

function packageNameAt(dir: string, exists: ExistsFn, readFile: ReadFileFn): string | undefined {
	const packagePath = join(dir, "package.json");
	if (!exists(packagePath)) return undefined;
	try {
		const parsed = JSON.parse(readFile(packagePath, "utf8")) as { name?: unknown };
		return typeof parsed.name === "string" ? parsed.name : undefined;
	} catch {
		return undefined;
	}
}

export function findActiveSumoDevTree(cwd: string, options: Pick<DuplicateInstalledExtensionOptions, "exists" | "readFile"> = {}): string | undefined {
	const exists = options.exists ?? existsSync;
	const readFile = options.readFile ?? ((path, encoding) => readFileSync(path, encoding));
	let current = resolve(cwd);
	while (true) {
		const isSumocodePackage = packageNameAt(current, exists, readFile) === SUMOCODE_PACKAGE_NAME;
		const hasExtensionSource = exists(join(current, "src", "extension.ts"));
		const hasGitMetadata = exists(join(current, ".git"));
		if (isSumocodePackage && hasExtensionSource && hasGitMetadata) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function shouldNoopDuplicateInstalledExtension(options: DuplicateInstalledExtensionOptions = {}): boolean {
	const moduleUrl = options.moduleUrl ?? import.meta.url;
	if (!isInstalledPiAgentGitModule(moduleUrl, options.homeDir ?? homedir())) return false;
	return findActiveSumoDevTree(options.cwd ?? process.cwd(), options) !== undefined;
}

/**
 * SumoCode — cathedral-themed Pi extension entry point.
 *
 * Element 2 (top chrome) replaces the previous tab-bar. The splash and
 * subsequent elements continue to install as separate modules.
 *
 * The sidebar is intentionally NOT installed here yet. Element 1 in the
 * cathedral parity rework re-enables it via `installSidebar(pi)` once
 * the active-state chrome below it is stable.
 */
export default function sumocode(pi: ExtensionAPI): void {
	if (shouldNoopDuplicateInstalledExtension()) {
		console.warn("[sumocode] Skipping installed SumoCode extension because this session is already inside an active SumoCode dev checkout.");
		return;
	}

	installAltscreen(pi);
	installTopChrome(pi);
	installSplash(pi);
	installFooter(pi);
	installCathedralEditor(pi);
	installInputHints(pi);
	installCommandPalette(pi);
	// installApprovalGate(pi); // disabled — see import comment above
	installSidebar(pi);
	installWorkingIndicator(pi);
	registerPersonaCommand(pi);
	registerSpinnerCommand(pi);
	registerTabsCommand(pi);
	registerThemeCommand(pi);
	registerThemeCheckCommand(pi);
	registerMemoryCommand(pi);
}
