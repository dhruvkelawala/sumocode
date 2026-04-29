import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const bibleDir = resolve(repoRoot, "docs", "ui", "bible");
export const bibleRenderDir = resolve(bibleDir, "renders");
export const parityDir = resolve(repoRoot, "docs", "visual", "parity");
export const scenarioManifestPath = resolve(parityDir, "scenarios.json");
export const approvedRuntimeDir = resolve(parityDir, "approved-runtime");
export const outDir = resolve(repoRoot, "docs", "visual", "out", "parity");
export const bibleTokensCss = resolve(bibleDir, "_assets", "tokens.css");
export const bibleFontPath = resolve(bibleDir, "_assets", "fonts", "jetbrains-mono-nerd.woff2");
