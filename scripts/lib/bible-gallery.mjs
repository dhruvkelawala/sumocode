import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const BIBLE_MIME = {
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

const ELEMENT_NAMES = {
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
};

export function listBibleMockups(root) {
	return readdirSync(root)
		.filter((n) => n.endsWith(".html") && !n.startsWith("_") && n !== "index.html")
		.sort();
}

export function normalizeBibleBasePath(basePath = "/bible/") {
	let normalized = basePath.trim();
	if (normalized === "") normalized = "/bible/";
	if (!normalized.startsWith("/")) normalized = `/${normalized}`;
	if (!normalized.endsWith("/")) normalized = `${normalized}/`;
	return normalized;
}

export function buildBibleIndexHTML(root, options = {}) {
	const basePath = normalizeBibleBasePath(options.basePath ?? "/bible/");
	const mockups = listBibleMockups(root);
	const groups = new Map();

	for (const m of mockups) {
		const key = m.startsWith("scene-") ? "scene" : m.startsWith("skill-") ? "skill" : (m.match(/^(\d+)/)?.[1] ?? "misc");
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(m);
	}

	const sections = [...groups.entries()]
		.sort(([a], [b]) => groupOrder(a) - groupOrder(b) || a.localeCompare(b))
		.map(([n, files]) => {
			const cards = files
				.map((f) => buildCard(root, basePath, f))
				.join("\n");
			const heading = /^\d+$/.test(n) ? `Element ${n} · ${elementName(n)}` : elementName(n);
			return `    <section>
      <h2>${escapeHtml(heading)}</h2>
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
<base href="${basePath}">
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

function buildCard(root, basePath, file) {
	const label = file
		.replace(/\.html$/, "")
		.replace(/^\d+-/, "")
		.replace(/^scene-/, "scene · ")
		.replace(/^skill-/, "skill · ")
		.replace(/-/g, " ");
	const pngName = file.replace(/\.html$/, ".png");
	const pngFile = join(root, "renders", pngName);
	const version = existsSync(pngFile) ? `?v=${Math.round(statSync(pngFile).mtimeMs)}` : "";
	const png = `${basePath}renders/${pngName}${version}`;
	return `      <a class="card" href="${basePath}${file}">
        <div class="card-frame">
          <img src="${png}" alt="${escapeHtml(label)}" loading="lazy" onerror="this.closest('.card').classList.add('missing')">
        </div>
        <div class="card-label">${escapeHtml(label)}</div>
      </a>`;
}

function groupOrder(n) {
	if (/^\d+$/.test(n)) return Number(n);
	if (n === "skill") return 9.5;
	if (n === "scene") return 99;
	return 100;
}

function elementName(n) {
	return ELEMENT_NAMES[n] ?? "Unnamed";
}

function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}
