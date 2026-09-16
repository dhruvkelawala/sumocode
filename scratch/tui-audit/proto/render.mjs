#!/usr/bin/env node
// Renders every proto scene to scratch/tui-audit/proto/renders/*.png.
// Same method as scripts/render-bible.mjs: 1800×1200 viewport, DPR 2,
// [data-render-rect] element screenshot, fonts.ready + 120 ms settle.

import { mkdirSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const protoDir = dirname(fileURLToPath(import.meta.url));
const renderDir = resolve(protoDir, "renders");
mkdirSync(renderDir, { recursive: true });

const DEFAULT_CHROMIUM = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

const htmls = readdirSync(protoDir)
	.filter((n) => n.endsWith(".html") && !n.startsWith("_") && n !== "index.html")
	.sort();

if (htmls.length === 0) {
	console.error(`No scene HTML in ${protoDir} — run gen.mjs first.`);
	process.exit(1);
}

const browser = await chromium.launch({
	headless: true,
	executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? DEFAULT_CHROMIUM,
});
const context = await browser.newContext({
	viewport: { width: 1800, height: 1200 },
	deviceScaleFactor: 2,
});
const page = await context.newPage();

let failed = 0;
for (const html of htmls) {
	process.stdout.write(`  ${html.padEnd(34)} `);
	try {
		await page.goto(pathToFileURL(resolve(protoDir, html)).href, { waitUntil: "networkidle" });
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(120);
		const rect = await page.$("[data-render-rect]");
		const out = resolve(renderDir, html.replace(/\.html$/, ".png"));
		if (rect) await rect.screenshot({ path: out, omitBackground: false });
		else await page.screenshot({ path: out, fullPage: false });
		console.log("ok");
	} catch (err) {
		failed++;
		console.log(`FAIL (${err.message})`);
	}
}

await browser.close();
if (failed > 0) {
	console.error(`${failed}/${htmls.length} failed`);
	process.exit(1);
}
console.log(`${htmls.length} renders → scratch/tui-audit/proto/renders/`);
