#!/usr/bin/env node
// Tiny static HTTP server for docs/ui/bible/ + auto-generated index page.
// Pair with: tailscale serve --bg --set-path=/bible http://127.0.0.1:7780/

import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(repoRoot, "docs", "ui", "bible");
const port = Number(process.env.BIBLE_PORT ?? 7780);

const MIME = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript",
	".png": "image/png",
	".gif": "image/gif",
	".jpg": "image/jpeg",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".svg": "image/svg+xml",
	".md": "text/plain; charset=utf-8",
};

function listMockups() {
	return readdirSync(root)
		.filter((n) => n.endsWith(".html") && !n.startsWith("_"))
		.sort();
}

function indexHTML() {
	const mockups = listMockups();
	// Group by element number
	const groups = new Map();
	for (const m of mockups) {
		const n = m.match(/^(\d+)/)?.[1] ?? "??";
		if (!groups.has(n)) groups.set(n, []);
		groups.get(n).push(m);
	}

	const elementName = (n) => ({
		"01": "Sidebar",
		"02": "Top bar",
		"03": "Splash",
		"04": "Active input frame",
		"05": "Footer",
		"06": "Approval modal",
		"07": "Memory editor",
		"08": "Command palette",
		"09": "Tool pills",
		"10": "Code blocks",
		"11": "DIVINE QUERY",
		"12": "Task tool",
		"13": "Chat messages",
	})[n] ?? "Unnamed";

	const sections = [...groups.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([n, files]) => {
			const cards = files
				.map((f) => {
					const label = f
						.replace(/\.html$/, "")
						.replace(/^\d+-/, "")
						.replace(/-/g, " ");
					const png = `/bible/renders/${f.replace(/\.html$/, ".png")}`;
				return `      <a class="card" href="/bible/${f}">
        <div class="card-frame">
          <img src="${png}" alt="${label}" loading="lazy">
        </div>
        <div class="card-label">${label}</div>
      </a>`;
				})
				.join("\n");
			return `    <section>
      <h2>Element ${n} · ${elementName(n)}</h2>
      <div class="grid">
${cards}
      </div>
    </section>`;
		})
		.join("\n\n");

	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Cathedral Visual Bible · index</title>
<base href="/bible/">
<style>
  :root {
    color-scheme: dark;
    --bg: #0B0806;
    --surface: #1A1511;
    --fg: #F5E6C8;
    --fg-dim: #8B7A63;
    --accent: #D97706;
    --divider: #5A4D3C;
  }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace; }
  body { padding: 32px; }
  h1 { font-size: 18px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); }
  h2 { font-size: 13px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--fg-dim); margin-top: 32px; border-bottom: 1px solid var(--divider); padding-bottom: 6px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(680px, 1fr)); gap: 24px; margin-top: 16px; }
  .card { display: block; background: var(--surface); border: 1px solid var(--divider); padding: 0; text-decoration: none; color: var(--fg); transition: border-color 120ms; overflow: hidden; }
  .card:hover { border-color: var(--accent); }
  .card-frame { background: var(--bg); display: flex; align-items: center; justify-content: center; padding: 16px; min-height: 100px; }
  .card-frame img { max-width: 100%; height: auto; display: block; image-rendering: pixelated; }
  .card-label { padding: 12px 16px; border-top: 1px solid var(--divider); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--fg-dim); }

  .meta { color: var(--fg-dim); font-size: 11px; letter-spacing: 0.08em; }
</style>
</head>
<body>
  <h1>Cathedral Visual Bible</h1>
  <p class="meta">${mockups.length} mockup(s) · click a card to open full-size · refresh to reload after changes</p>
${sections}
</body>
</html>`;
}

const server = createServer((req, res) => {
	const url = new URL(req.url, `http://localhost`);
	let path = decodeURIComponent(url.pathname);

	// Strip /bible prefix if served via tailscale --set-path
	if (path.startsWith("/bible")) path = path.slice(6);
	if (path === "" || path === "/") {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(indexHTML());
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

	const mime = MIME[extname(filePath)] ?? "application/octet-stream";
	res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
	res.end(readFileSync(filePath));
});

server.listen(port, "127.0.0.1", () => {
	console.log(`bible served on http://127.0.0.1:${port}`);
	console.log(`Bible root: ${root}`);
	console.log(`Mockups: ${listMockups().length}`);
	console.log(`Run 'pnpm render:bible' to regenerate PNG thumbnails after editing HTML.`);
});
