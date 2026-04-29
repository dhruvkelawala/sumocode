#!/usr/bin/env node
// Export the Cathedral Visual Bible into a static site directory suitable for
// Vercel, Cloudflare Pages, Netlify, or any plain static host.
//
// Prerequisite: run `pnpm render:bible` so docs/ui/bible/renders/*.png exists.

import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildBibleIndexHTML, listBibleMockups, normalizeBibleBasePath } from "./lib/bible-gallery.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bibleRoot = resolve(repoRoot, "docs", "ui", "bible");
const outRoot = resolve(repoRoot, process.env.BIBLE_STATIC_OUT ?? "dist/bible-site");
const bibleOutRoot = resolve(outRoot, "bible");
const basePath = normalizeBibleBasePath(process.env.BIBLE_PUBLIC_BASE ?? "/bible/");

if (!existsSync(bibleRoot)) {
	fail(`No bible directory at ${bibleRoot}`);
}

const mockups = listBibleMockups(bibleRoot);
if (mockups.length === 0) {
	fail(`No bible HTML mockups found in ${bibleRoot}`);
}

const missingRenders = mockups
	.map((html) => join(bibleRoot, "renders", html.replace(/\.html$/, ".png")))
	.filter((png) => !existsSync(png) || statSync(png).size === 0);

if (missingRenders.length > 0) {
	console.error("[export-bible-static] Missing/empty PNG renders:");
	for (const png of missingRenders.slice(0, 20)) console.error(`  ${png}`);
	if (missingRenders.length > 20) console.error(`  ...and ${missingRenders.length - 20} more`);
	fail("Run `pnpm render:bible` before exporting the static gallery.");
}

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });
cpSync(bibleRoot, bibleOutRoot, { recursive: true, dereference: true });

writeFileSync(join(bibleOutRoot, "index.html"), buildBibleIndexHTML(bibleRoot, { basePath }));
writeFileSync(join(outRoot, "index.html"), rootRedirectHTML(basePath));
writeFileSync(join(outRoot, "vercel.json"), `${JSON.stringify(vercelConfig(), null, "\t")}\n`);

console.log(`[export-bible-static] ${mockups.length} mockup(s) exported`);
console.log(`[export-bible-static] ${missingRenders.length} missing render(s)`);
console.log(`[export-bible-static] output: ${outRoot}`);
console.log(`[export-bible-static] entry: ${join(outRoot, "index.html")}`);
console.log(`[export-bible-static] bible: ${join(bibleOutRoot, "index.html")}`);

function rootRedirectHTML(target) {
	return `<!doctype html>
<meta charset="utf-8">
<title>Cathedral Visual Bible</title>
<meta http-equiv="refresh" content="0; url=${target}">
<link rel="canonical" href="${target}">
<a href="${target}">Cathedral Visual Bible</a>
`;
}

function vercelConfig() {
	return {
		headers: [
			{
				source: "/(.*)",
				headers: [
					{
						key: "Cache-Control",
						value: "public, max-age=0, must-revalidate",
					},
				],
			},
		],
	};
}

function fail(message) {
	console.error(`[export-bible-static] ${message}`);
	process.exit(1);
}
