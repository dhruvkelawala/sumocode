import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDocReferences } from "./check-doc-references.mjs";

function fixture(text, files = {}) {
	const root = mkdtempSync(join(tmpdir(), "sumocode-docs-"));
	const contents = {
		"package.json": JSON.stringify({ version: "0.4.1", pi: { extensions: ["src/extension-entry.ts"] }, scripts: { build: "tsc", "visual:review": "review", "visual:ci": "ci" } }),
		"README.md": text, "src/extension-entry.ts": "", "DEV_LOOP.md": "# Current workflow\n", ...files,
	};
	for (const [file, content] of Object.entries(contents)) {
		mkdirSync(join(root, file, ".."), { recursive: true });
		writeFileSync(join(root, file), content);
	}
	return (check = "all", paths = ["README.md"]) => checkDocReferences({ root, files: paths, check });
}

describe("documentation references", () => {
	it("accepts current local links, anchors, code paths and package commands", () => {
		expect(fixture("[workflow](DEV_LOOP.md#current-workflow) `src/extension-entry.ts` `pnpm build` [site](https://example.org)")()).toEqual([]);
	});
	it.each(["missing.md", "DEV_LOOP.md#missing", "https://[bad"])("rejects broken reference %s", (path) => {
		expect(fixture(`[reference](${path})`)("links").some((issue) => issue.message.includes("reference"))).toBe(true);
	});
	it.each(["`src/missing.ts`", "`pnpm missing`"])("rejects missing code reference %s", (text) => {
		expect(fixture(text)("links").length).toBeGreaterThan(0);
	});
	it.each(["pnpm missing", "node scripts/missing.mjs", "./bin/missing.sh"])("checks fenced command %s", (command) => {
		expect(fixture(`\x60\x60\x60bash\n${command}\n\x60\x60\x60`)("links").length).toBeGreaterThan(0);
	});
	it("does not mistake a negated patch claim for an active dependency", () => {
		expect(fixture("SumoCode no longer depends on a private Pi constructor patch.")("active-claims")).toEqual([]);
	});
	it.each(["Current version: 0.3.0", "The canonical entry is `src/extension.ts`.", "`src/extension.ts` is the canonical entry.", "bump `VERSION` in `src/extension.ts`", "cd \"/Volumes/SumoDeus NVMe/code/sumocode\"", "The runtime uses a private Pi constructor patch."])("rejects active stale claim: %s", (text) => {
		expect(fixture(text)("active-claims").length).toBeGreaterThan(0);
		expect(fixture(`> **Status: historical/superseded as of 2026-09-08** — [Current workflow](DEV_LOOP.md).\n\n${text}`)("active-claims")).toEqual([]);
	});
	it("requires a top historical banner with a working current-authority link", () => {
		for (const banner of ["> **Status: historical/superseded as of 2026-09-08**", "> **Status: historical/superseded as of 2026-09-08** [Current](missing.md)", "# Notes\n\nText\n\n> **Status: historical/superseded as of 2026-09-08** [Current](DEV_LOOP.md)"]) {
			expect(fixture(`${banner}\nCurrent version: 0.3.0`)("active-claims").length).toBeGreaterThan(0);
		}
	});
	it.each(['echo "$OPENAI_API_KEY"', 'printf "%s" "${ANTHROPIC_API_KEY}"', 'printenv ACCESS_TOKEN', 'echo "$(printenv API_KEY)"'])("rejects credential printing: %s", (command) => {
		expect(fixture(`\x60\x60\x60bash\n${command}\n\x60\x60\x60`)("security-state").length).toBeGreaterThan(0);
	});
	it("accepts non-printing presence checks", () => {
		expect(fixture('if [ -n "${OPENAI_API_KEY:-}" ]; then printf "configured\\n"; fi')("security-state")).toEqual([]);
	});
	it("requires terminal, activity and session state guidance in setup", () => {
		expect(fixture("", { "SETUP.md": "# Setup\n" })("security-state", ["SETUP.md"]).length).toBeGreaterThan(0);
	});
	it("checks Bible counts against actual files and requires the active visual commands", () => {
		const check = fixture("", { "docs/ui/bible/README.md": "Inventory: **1 HTML mockups · 1 PNG renders**.\n`pnpm visual:review` `pnpm visual:ci`", "docs/ui/bible/a.html": "", "docs/ui/bible/renders/a.png": "" });
		expect(check("bible", ["docs/ui/bible/README.md"])).toEqual([]);
		expect(fixture("", { "docs/ui/bible/README.md": "Inventory: **95 HTML mockups · 95 PNG renders**." })("bible", ["docs/ui/bible/README.md"]).length).toBeGreaterThan(0);
	});
});
