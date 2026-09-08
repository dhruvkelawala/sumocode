import { existsSync, globSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const scopedDocs = [
	"AGENTS.md", "README.md", "DEV_LOOP.md", "SETUP.md", "docs/perf/startup.md",
	"docs/SUMO_TUI_PI_PATCH_STRATEGY.md", "docs/SUMO_TUI_AUDIT.md", "docs/SUMO_TUI_CONSOLIDATION_PLAN.md",
	"docs/adr/0001-sumo-tui-framework.md", "docs/prd.md", "docs/research/v0.4-roadmap.md",
	"docs/PI_TOOL_ARCHITECTURE.md", "docs/ui/bible/README.md", "docs/visual/README.md", "plans/README.md",
];
const checks = ["links", "active-claims", "security-state", "bible", "all"];

/** Offline checks over the public documentation surface; fixture roots use the same rules. */
export function checkDocReferences({ root, files = scopedDocs, check = "all" }) {
	if (!checks.includes(check)) throw new Error(`unknown check: ${check}`);
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const issues = [];
	for (const file of files) {
		const report = (message) => issues.push({ file, message });
		const path = join(root, file);
		if (!existsSync(path)) { report("missing documentation file"); continue; }
		const text = readFileSync(path, "utf8");
		const first = text.trimStart().split("\n")[0];
		const banner = /^> \*\*Status: historical\/superseded as of \d{4}-\d{2}-\d{2}\*\*/u.test(first);
		const authority = [...first.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)].find((match) => !/^[a-z]+:/iu.test(match[1]) && !referenceError(root, file, match[1]));
		const historical = banner && Boolean(authority);
		const run = (name) => check === "all" || check === name;
		if (run("active-claims") && text.includes("Status: historical/superseded") && !historical) report("historical status requires a top banner and valid current-authority reference");
		if (run("links")) {
			for (const match of text.matchAll(/\[[^\]\n]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"\n]*")?\)/gu)) {
				const error = referenceError(root, file, match[1].replace(/^<|>$/gu, ""));
				if (error) report(`reference ${match[1]}: ${error}`);
			}
			if (!historical) checkCodeReferences(root, file, text, pkg, report);
		}
		if (run("active-claims") && !historical) {
			for (const match of text.matchAll(/(?:current version\s*:?\s*|version-)(\d+\.\d+\.\d+)/giu)) {
				if (match[1] !== pkg.version) report(`active version ${match[1]} differs from package ${pkg.version}`);
			}
			if (/(?:(?:canonical|main|current) entry (?:is |— )?`?src\/extension\.ts|`src\/extension\.ts` is the canonical entry)/iu.test(text)) report("active entrypoint claim must use package pi.extensions");
			if (/(?:runtime uses|(?<!no longer )depends on|requires) a private Pi constructor patch/iu.test(text)) report("active private-patch claim is retired");
			if (file !== "AGENTS.md" && /(?:^|\n)\s*cd\s+["']?\/Volumes\//u.test(text)) report("active checkout command must be portable");
			if (/`VERSION` in `src\/extension\.ts`/u.test(text)) report("release version constant reference is stale");
			if (/no (?:PR )?CI|lint (?:does not exist|is not configured)/iu.test(text)) report("active CI/lint claim is stale");
		}
		if (run("security-state") && !historical) {
			for (const line of text.split("\n")) {
				if (/\bprintenv\s+[A-Z_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)/u.test(line) || /\b(?:echo|printf|printenv)\b[^;\n]*(?:\$\{?[A-Z_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)|\bprintenv\s+[A-Z_]*(?:API_KEY|TOKEN|SECRET|PASSWORD))/u.test(line)) report("credential-print command");
			}
			if (file === "SETUP.md") {
				for (const token of ["Terminal", "Activity", "Sessions", "0700", "0600", "presence", "no automatic deletion"]) if (!text.includes(token)) report(`missing state guidance: ${token}`);
			}
		}
		if (run("bible") && !historical && ["docs/ui/bible/README.md", "docs/visual/README.md"].includes(file)) {
			for (const command of ["pnpm visual:review", "pnpm visual:ci"]) if (!text.includes(command)) report(`missing visual command: ${command}`);
			if (/`pnpm visual`|VHS (?:is |as )?(?:the )?canonical/iu.test(text)) report("legacy visual workflow presented as active");
			if (file === "docs/ui/bible/README.md") {
				for (const row of text.matchAll(/^\| ([\w]+)- \|[^|]+\| (\d+) \|$/gmu)) {
					const directory = join(root, "docs/ui/bible");
					const actual = existsSync(directory) ? readdirSync(directory).filter((name) => name.startsWith(`${row[1]}-`) && name.endsWith(".html")).length : 0;
					if (Number(row[2]) !== actual) report(`Bible group ${row[1]} count differs from ${actual}`);
				}
				const count = /Inventory: \*\*(\d+) HTML mockups · (\d+) PNG renders\*\*/u.exec(text);
				if (!count) report("missing Bible inventory counts");
				else for (const [index, directory, extension] of [[1, "docs/ui/bible", ".html"], [2, "docs/ui/bible/renders", ".png"]]) {
					const path = join(root, directory);
					const actual = existsSync(path) ? readdirSync(path).filter((name) => name.endsWith(extension)).length : 0;
					if (Number(count[index]) !== actual) report(`Bible ${extension} count ${count[index]} differs from ${actual}`);
				}
			}
		}
	}
	return issues;
}

function referenceError(root, file, target) {
	if (/^[a-z][a-z\d+.-]*:/iu.test(target)) {
		try { const url = new URL(target); return ["https:", "http:", "mailto:"].includes(url.protocol) ? undefined : "unsupported URL scheme"; }
		catch { return "invalid external URL"; }
	}
	let decoded;
	try { decoded = decodeURIComponent(target); } catch { return "invalid URL encoding"; }
	const [name, anchor] = decoded.split("#");
	const path = name ? resolve(dirname(join(root, file)), name) : join(root, file);
	if (relative(root, path).startsWith("..")) return "outside repository";
	if (!existsSync(path)) return "missing local target";
	if (!anchor || !statSync(path).isFile() || !/\.(?:md|html)$/u.test(path)) return;
	const text = readFileSync(path, "utf8");
	const ids = new Set([...text.matchAll(/\bid=["']([^"']+)["']/gu)].map((match) => match[1]));
	const seen = new Map();
	for (const match of text.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gmu)) {
		const slug = match[1].toLowerCase().replace(/<[^>]*>/gu, "").replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s/gu, "-");
		const count = seen.get(slug) ?? 0;
		ids.add(count ? `${slug}-${count}` : slug);
		seen.set(slug, count + 1);
	}
	if (!ids.has(anchor)) return "missing local anchor";
}

function checkCodeReferences(root, file, text, pkg, report) {
	const examples = [...text.matchAll(/(?<!`)`([^`\n]+)`(?!`)/gu)].map((match) => match[1]);
	for (const block of text.matchAll(/^```(?:bash|sh|shell)?\n([\s\S]*?)^```/gmu)) examples.push(...block[1].split("\n").map((line) => line.trim()));
	for (const value of examples) {
		const command = /^pnpm\s+(?:run\s+)?([\w:-]+)/u.exec(value);
		if (command && !["install", "exec", "dlx", "view", "link"].includes(command[1]) && !(command[1] in pkg.scripts)) report(`command reference does not exist: ${value}`);
		const script = /^(?:(?:node|bash|sh)\s+)?(?:\.\/)?((?:scripts|bin)\/[^\s"']+)/u.exec(value);
		if (script && !existsSync(join(root, script[1].replace(/:\d+(?:-\d+)?$/u, "")))) report(`command script reference does not exist: ${script[1]}`);
		if (!/^(?:(?:src|scripts|docs|test|plans|bin|\.github)\/[^\s<>]+|[A-Z][A-Z_]*\.md)(?:#[^\s]+)?$/u.test(value)) continue;
		const [name, anchor] = value.replace(/:\d+(?:-\d+)?$/u, "").split("#");
		if (name.includes("*")) {
			if (globSync(name, { cwd: root }).length === 0) report(`path reference does not exist: ${value}`);
		} else {
			const target = relative(dirname(join(root, file)), join(root, name)) + (anchor ? `#${anchor}` : "");
			const error = referenceError(root, file, target);
			if (error) report(`path reference ${value}: ${error}`);
		}
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	if (args.length !== 2 || args[0] !== "--check" || !checks.includes(args[1])) {
		process.stderr.write(`usage: node scripts/check-doc-references.mjs --check ${checks.join("|")}\n`);
		process.exitCode = 2;
	} else {
		const issues = checkDocReferences({ root: resolve(dirname(fileURLToPath(import.meta.url)), ".."), check: args[1] });
		for (const issue of issues) process.stderr.write(`${issue.file}: ${issue.message}\n`);
		if (issues.length) process.exitCode = 1;
		else process.stdout.write(`documentation ${args[1]}: PASS\n`);
	}
}
