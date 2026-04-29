#!/usr/bin/env node
// Tiny static HTTP server for docs/ui/bible/ + auto-generated index page.
// Pair with: tailscale serve --bg --set-path=/bible http://127.0.0.1:7780/

import { createServer } from "node:http";
import { readFileSync, statSync, existsSync } from "node:fs";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { BIBLE_MIME, buildBibleIndexHTML, listBibleMockups } from "./lib/bible-gallery.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(repoRoot, "docs", "ui", "bible");
const port = Number(process.env.BIBLE_PORT ?? 7780);

const server = createServer((req, res) => {
	const url = new URL(req.url, `http://localhost`);
	let path = decodeURIComponent(url.pathname);

	// Strip /bible prefix if served via tailscale --set-path
	if (path.startsWith("/bible")) path = path.slice(6);
	if (path === "" || path === "/") {
		res.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store, max-age=0, must-revalidate",
			"Pragma": "no-cache",
			"Expires": "0",
		});
		res.end(buildBibleIndexHTML(root));
		return;
	}

	const filePath = resolve(join(root, path));
	if (!filePath.startsWith(root)) {
		res.writeHead(403);
		res.end("forbidden");
		return;
	}

	if (!existsSync(filePath)) {
		res.writeHead(404);
		res.end(`not found: ${path}`);
		return;
	}

	const stat = statSync(filePath);
	if (stat.isDirectory()) {
		// directory listing not needed here
		res.writeHead(404);
		res.end("not found");
		return;
	}

	const mime = BIBLE_MIME[extname(filePath)] ?? "application/octet-stream";
	res.writeHead(200, {
		"Content-Type": mime,
		"Cache-Control": "no-store, max-age=0, must-revalidate",
		"Pragma": "no-cache",
		"Expires": "0",
	});
	res.end(readFileSync(filePath));
});

server.listen(port, "127.0.0.1", () => {
	console.log(`bible served on http://127.0.0.1:${port}`);
	console.log(`Bible root: ${root}`);
	console.log(`Mockups: ${listBibleMockups(root).length}`);
	console.log(`Run 'pnpm render:bible' to regenerate PNG thumbnails after editing HTML.`);
});
