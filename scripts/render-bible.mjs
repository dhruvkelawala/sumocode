#!/usr/bin/env node
// Render every docs/ui/bible/*.html → docs/ui/bible/renders/*.png at exact
// terminal-grid dimensions via Playwright + chromium.
//
// Each .html exports a `[data-render-rect]` element whose bounding box defines
// the render crop. The renderer screenshots just that element so we get pixel-
// exact terminal mockups without page chrome.

import { spawnSync } from "node:child_process";
import { readdirSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bibleDir = resolve(repoRoot, "docs", "ui", "bible");
const renderDir = resolve(bibleDir, "renders");

if (!existsSync(bibleDir)) {
	console.error(`No bible dir at ${bibleDir}`);
	process.exit(1);
}
mkdirSync(renderDir, { recursive: true });

const htmls = readdirSync(bibleDir)
	.filter((n) => n.endsWith(".html") && !n.startsWith("_"))
	.sort();

if (htmls.length === 0) {
	console.error(`No bible HTML files in ${bibleDir}`);
	process.exit(1);
}

console.log(`[render-bible] ${htmls.length} mockup(s) → ${renderDir}`);
console.log("");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
	viewport: { width: 1800, height: 1200 },
	deviceScaleFactor: 2, // retina-quality goldens
});
const page = await context.newPage();

let failed = 0;
const start = Date.now();
for (const html of htmls) {
	const fullPath = resolve(bibleDir, html);
	process.stdout.write(`  ${html.padEnd(40)} `);
	const t = Date.now();
	try {
		await page.goto(pathToFileURL(fullPath).href, { waitUntil: "networkidle" });
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(120); // settle font-paint
		const rect = await page.$("[data-render-rect]");
		const out = resolve(renderDir, html.replace(/\.html$/, ".png"));
		if (rect) {
			await rect.screenshot({ path: out, omitBackground: false });
		} else {
			await page.screenshot({ path: out, fullPage: false });
		}
		console.log(`ok  (${((Date.now() - t) / 1000).toFixed(1)}s)`);
	} catch (err) {
		failed++;
		console.log(`FAIL (${err.message})`);
	}
}

await browser.close();

const total = ((Date.now() - start) / 1000).toFixed(1);
console.log("");
if (failed > 0) {
	console.error(`${failed}/${htmls.length} failed (${total}s)`);
	process.exit(1);
}
console.log(`All ${htmls.length} rendered in ${total}s`);
