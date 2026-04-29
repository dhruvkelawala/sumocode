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
	// Group by element number, plus explicit non-element groups.
	const groups = new Map();
	for (const m of mockups) {
		const key = m.startsWith("scene-") ? "scene" : m.startsWith("skill-") ? "skill" : (m.match(/^(\d+)/)?.[1] ?? "misc");
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(m);
	}

	const groupOrder = (n) => {
		if (/^\d+$/.test(n)) return Number(n);
		if (n === "skill") return 9.5;
		if (n === "scene") return 99;
		return 100;
	};

	const elementName = (n) => ({
		"skill": "Skill pill",
		"scene": "Scene compositions",
		"misc": "Misc",
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
		"12": "Scroll + scribe",
		"13": "Chat messages",
	})[n] ?? "Unnamed";

	const sections = [...groups.entries()]
		.sort(([a], [b]) => groupOrder(a) - groupOrder(b) || a.localeCompare(b))
		.map(([n, files]) => {
			const cards = files
				.map((f) => {
					const label = f
						.replace(/\.html$/, "")
						.replace(/^\d+-/, "")
						.replace(/^scene-/, "scene · ")
						.replace(/^skill-/, "skill · ")
						.replace(/-/g, " ");
					const pngFile = join(root, "renders", f.replace(/\.html$/, ".png"));
					const version = existsSync(pngFile) ? `?v=${Math.round(statSync(pngFile).mtimeMs)}` : "";
					const png = `/bible/renders/${f.replace(/\.html$/, ".png")}${version}`;
				return `      <a class="card" href="/bible/${f}">
        <div class="card-frame">
          <img src="${png}" alt="${label}" loading="lazy" onerror="this.closest('.card').classList.add('missing')">
        </div>
        <div class="card-label">${label}</div>
      </a>`;
				})
				.join("\n");
			const heading = /^\d+$/.test(n) ? `Element ${n} · ${elementName(n)}` : elementName(n);
			return `    <section>
      <h2>${heading}</h2>
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
  body { padding: 20px 24px; }
  h1 { font-size: 14px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); margin: 0 0 4px; }
  h2 { font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--fg-dim); margin-top: 20px; margin-bottom: 6px; border-bottom: 1px solid var(--divider); padding-bottom: 4px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; margin-top: 12px; }
  .card { display: block; background: var(--surface); border: 1px solid var(--divider); padding: 0; text-decoration: none; color: var(--fg); transition: border-color 120ms; overflow: hidden; }
  .card:hover { border-color: var(--accent); }
  .card.missing { border-color: #C1443E; }
  .card-frame { background: var(--bg); display: flex; align-items: center; justify-content: center; padding: 8px; height: 140px; overflow: hidden; }
  .card-frame img { max-width: 100%; max-height: 100%; height: auto; display: block; image-rendering: pixelated; object-fit: contain; }
  .card.missing .card-frame::after { content: 'PNG MISSING — run pnpm render:bible'; color: #C1443E; font-size: 10px; letter-spacing: 0.08em; text-align: center; }
  .card.missing img { display: none; }
  .card-label { padding: 6px 10px; border-top: 1px solid var(--divider); font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--fg-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .meta { color: var(--fg-dim); font-size: 10px; letter-spacing: 0.05em; margin: 0 0 4px; }
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
		res.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store, max-age=0, must-revalidate",
			"Pragma": "no-cache",
			"Expires": "0",
		});
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
	console.log(`Mockups: ${listMockups().length}`);
	console.log(`Run 'pnpm render:bible' to regenerate PNG thumbnails after editing HTML.`);
});
