/**
 * Syntax highlighting for the Cathedral code block renderer.
 *
 * Two tokenizers live here:
 *
 *   1. Shiki (`shiki/core` + the Oniguruma engine, whose wasm is base64-inlined
 *      into `shiki/wasm`, so the native archive still needs no sidecar file —
 *      see `createEngine` for why not the pure-JS engine). Grammars load
 *      lazily, one dynamic import per language on first use.
 *   2. The original hand-rolled regex tokenizer, kept as the synchronous
 *      fallback for the frames rendered before a grammar lands.
 *
 * Shiki's `codeToTokens` is synchronous once the highlighter and grammar
 * exist; only creation and grammar loading are async. So `highlightLine` never
 * awaits: it returns fallback spans while the grammar loads and Shiki spans
 * afterwards. Callers that want the one corrected repaint subscribe via
 * `onHighlighterReady`.
 *
 * Bringing a language up costs ~100 ms on either runtime (module imports, a
 * one-time 24 ms wasm instantiation, grammar compile), paid once per language,
 * asynchronously, after the first code block in that language appears. Frames
 * during that window use the fallback tokenizer.
 *
 * Nothing is imported until a code block renders, deliberately: importing
 * `shiki/core` plus an engine and the five common grammars costs ~38 ms, which
 * as startup init would be over budget and paid even by sessions that never
 * show code.
 *
 * Colours are always theme roles — this module never emits a hardcoded hex.
 */
import type { HighlighterCore, ThemeRegistration } from "shiki/core";
import { getThemeVersion, type ThemeApplicationRoles } from "../../themes/index.js";

export interface SyntaxSpan {
	readonly text: string;
	readonly color: string;
}

type CodeRoles = ThemeApplicationRoles["code"];

// ── Language aliasing ────────────────────────────────────────

type GrammarLoader = () => Promise<{ readonly default: unknown }>;

/**
 * Explicit per-language dynamic imports. A computed specifier
 * (`import(\`shiki/langs/${id}.mjs\`)`) is invisible to esbuild/bun, so the
 * native `--compile` host would ship a binary that cannot resolve grammars at
 * runtime. Static specifiers keep the imports lazy *and* analyzable.
 */
const GRAMMAR_LOADERS = new Map<string, GrammarLoader>([
	["css", () => import("shiki/langs/css.mjs")],
	["diff", () => import("shiki/langs/diff.mjs")],
	["docker", () => import("shiki/langs/docker.mjs")],
	["go", () => import("shiki/langs/go.mjs")],
	["html", () => import("shiki/langs/html.mjs")],
	["javascript", () => import("shiki/langs/javascript.mjs")],
	["jsx", () => import("shiki/langs/jsx.mjs")],
	["json", () => import("shiki/langs/json.mjs")],
	["jsonc", () => import("shiki/langs/jsonc.mjs")],
	["make", () => import("shiki/langs/make.mjs")],
	["markdown", () => import("shiki/langs/markdown.mjs")],
	["python", () => import("shiki/langs/python.mjs")],
	["rust", () => import("shiki/langs/rust.mjs")],
	["shellscript", () => import("shiki/langs/shellscript.mjs")],
	["sql", () => import("shiki/langs/sql.mjs")],
	["toml", () => import("shiki/langs/toml.mjs")],
	["tsx", () => import("shiki/langs/tsx.mjs")],
	["typescript", () => import("shiki/langs/typescript.mjs")],
	["yaml", () => import("shiki/langs/yaml.mjs")],
]);

/** Fence infos and file extensions → Shiki grammar ids. */
const LANGUAGE_ALIASES = new Map<string, string>([
	["bash", "shellscript"],
	["cjs", "javascript"],
	["css", "css"],
	["diff", "diff"],
	["docker", "docker"],
	["dockerfile", "docker"],
	["go", "go"],
	["golang", "go"],
	["html", "html"],
	["javascript", "javascript"],
	["js", "javascript"],
	["json", "json"],
	["json5", "jsonc"],
	["jsonc", "jsonc"],
	["jsx", "jsx"],
	["make", "make"],
	["makefile", "make"],
	["markdown", "markdown"],
	["md", "markdown"],
	["mjs", "javascript"],
	["patch", "diff"],
	["py", "python"],
	["python", "python"],
	["rs", "rust"],
	["rust", "rust"],
	["sh", "shellscript"],
	["shell", "shellscript"],
	["shellscript", "shellscript"],
	["sql", "sql"],
	["toml", "toml"],
	["ts", "typescript"],
	["tsx", "tsx"],
	["typescript", "typescript"],
	["yaml", "yaml"],
	["yml", "yaml"],
	["zsh", "shellscript"],
]);

/** Shiki grammar id for a fence info / extension, or undefined when unknown. */
export function resolveShikiLanguage(lang: string): string | undefined {
	return LANGUAGE_ALIASES.get(lang.toLowerCase());
}

// ── Theme mapping ────────────────────────────────────────────

/**
 * One TextMate theme built from the active theme's `code` roles. There is no
 * `type` role by design: type names ride the `function` colour.
 *
 * `punctuation` → foreground would otherwise steal the quotes off strings and
 * the slashes off comments (TextMate resolves the *deepest* matching scope),
 * so the string/comment rules claim their own punctuation explicitly.
 */
function sumoTextMateTheme(roles: CodeRoles, name: string): ThemeRegistration {
	return {
		name,
		type: "dark",
		colors: { "editor.foreground": roles.foreground, "editor.background": roles.surface },
		tokenColors: [
			{ scope: ["comment", "punctuation.definition.comment"], settings: { foreground: roles.comment } },
			{ scope: ["string", "string.template", "punctuation.definition.string"], settings: { foreground: roles.string } },
			{ scope: ["constant.numeric"], settings: { foreground: roles.number } },
			// `constant.language` (null/true/false) is not in the role vocabulary but
			// the Bible target paints those words with the keyword colour, which the
			// old tokenizer did by keeping them in its keyword set.
			{ scope: ["keyword", "storage", "keyword.operator.new", "constant.language"], settings: { foreground: roles.keyword } },
			{ scope: ["entity.name.function", "support.function"], settings: { foreground: roles.function } },
			{ scope: ["entity.name.type", "support.type", "support.class"], settings: { foreground: roles.function } },
			{ scope: ["variable.parameter", "punctuation"], settings: { foreground: roles.foreground } },
		],
	};
}

// ── Lazy highlighter state ───────────────────────────────────

let highlighter: HighlighterCore | undefined;
let corePromise: Promise<HighlighterCore> | undefined;
/** Shiki caches themes by name, so a theme switch needs a fresh name. */
let registeredThemeName: string | undefined;
let registeredThemeVersion = -1;
const loadedLanguages = new Set<string>();
const pendingLanguages = new Map<string, Promise<void>>();
const failedLanguages = new Set<string>();
const readyListeners = new Set<() => void>();
let generation = 0;
/**
 * Throwaway snippet tokenized when a grammar lands; see the warm-up note below.
 * It is deliberately broad (declaration, call, string, number, comment, block
 * punctuation) because the regex engine compiles patterns on first match, and
 * whatever it skips here is paid on the first real line instead.
 */
const WARMUP_SNIPPET = 'export async function fn<T>(a: string, b: Record<string, number>): Promise<T> {\n\tconst c = { x: 1, y: "s" }; // c\n\treturn [a, b, c].map((v) => v);\n}';
/** Tokenized lines keyed by theme+language+content. Bounded, cleared wholesale. */
const tokenCache = new Map<string, readonly SyntaxSpan[]>();
const TOKEN_CACHE_LIMIT = 4096;

/**
 * Bumped every time a grammar lands. Render memos key on this the same way
 * they key on `getThemeVersion()`, so rows painted with fallback spans are
 * recomputed once Shiki can do better.
 */
export function syntaxHighlightGeneration(): number {
	return generation;
}

/**
 * Notified once per grammar that finishes loading, so the caller can request a
 * single repaint of frames that were painted with fallback spans. Mirrors the
 * theme-change seam in `src/sumo-tui/rpc/runtime.ts`: subscribe on start,
 * dispose on stop, and let the callback schedule (not perform) the render.
 */
export function onHighlighterReady(listener: () => void): () => void {
	readyListeners.add(listener);
	return () => readyListeners.delete(listener);
}

/**
 * Oniguruma (wasm) on every runtime. Its wasm is base64-inlined into
 * `shiki/wasm`, so the native archive still needs no sidecar file.
 *
 * Measured, typescript grammar, node 25.6 / bun 1.4, M-series (ms):
 *
 * | engine     | runtime | import | engine init | grammar+warm-up | 1st line | 20 lines | 2nd grammar |
 * | JS         | node    |   31.4 |         0.4 |           146.7 |     1.39 |     1.45 |        38.5 |
 * | Oniguruma  | node    |   13.9 |        24.0 |            63.6 |     0.23 |     1.83 |         3.5 |
 * | JS         | bun     |   70.8 |         1.8 |           952.5 |     0.14 |     1.19 |        12.8 |
 * | Oniguruma  | bun     |   15.6 |        23.8 |            69.8 |     0.22 |     1.29 |         5.3 |
 *
 * The JS engine costs ~950 ms of blocked main thread per language on Bun,
 * which is what the native host compiles to, and it also mis-tokenizes the
 * process's very first call there (one unscoped token for the whole line, no
 * error). Oniguruma has neither problem, is faster cold on Node too, and pays
 * for it only in steady-state throughput (1.83 vs 1.45 ms per 20 lines, 1.26x)
 * and a one-time 24 ms wasm instantiation. One engine, both runtimes.
 */
async function createEngine(): Promise<Parameters<typeof import("shiki/core").createHighlighterCore>[0]["engine"]> {
	const { createOnigurumaEngine } = await import("shiki/engine/oniguruma");
	return createOnigurumaEngine(import("shiki/wasm"));
}

async function loadCore(roles: CodeRoles): Promise<HighlighterCore> {
	const [{ createHighlighterCore }, engine] = await Promise.all([import("shiki/core"), createEngine()]);
	const name = themeNameForVersion(getThemeVersion());
	const created = await createHighlighterCore({
		engine,
		themes: [sumoTextMateTheme(roles, name)],
		langs: [],
	});
	registeredThemeName = name;
	registeredThemeVersion = getThemeVersion();
	highlighter = created;
	return created;
}

function themeNameForVersion(version: number): string {
	return `sumocode-${version}`;
}

/**
 * Register the active theme's roles under a fresh name when the theme changed.
 * `getThemeVersion()` is the registry's change counter, which keeps this a pull
 * (checked on the render path) instead of a subscription this module would have
 * to dispose.
 *
 * ponytail: superseded theme registrations stay in Shiki's map — a handful of
 * tiny objects per theme switch. Add an unload pass if theme cycling ever
 * becomes automated rather than user-driven.
 */
function syncTheme(core: HighlighterCore, roles: CodeRoles): string {
	const version = getThemeVersion();
	if (registeredThemeName !== undefined && registeredThemeVersion === version) return registeredThemeName;
	const name = themeNameForVersion(version);
	core.loadThemeSync(sumoTextMateTheme(roles, name));
	registeredThemeName = name;
	registeredThemeVersion = version;
	tokenCache.clear();
	return name;
}

/**
 * Kick off the grammar load for `id`. Returns the in-flight promise while the
 * grammar is loading and `undefined` once the language is settled (loaded or
 * failed), so callers can tell "still falling back" from "done".
 */
export function ensureLanguage(id: string, roles: CodeRoles): Promise<void> | undefined {
	if (loadedLanguages.has(id) || failedLanguages.has(id)) return undefined;
	const inFlight = pendingLanguages.get(id);
	if (inFlight) return inFlight;
	const loader = GRAMMAR_LOADERS.get(id);
	if (!loader) {
		failedLanguages.add(id);
		return undefined;
	}
	const task = (async () => {
		try {
			corePromise ??= loadCore(roles);
			const core = await corePromise;
			const grammar = await loader();
			// SAFETY: Shiki's own grammar modules; `loadLanguage` validates shape.
			await core.loadLanguage(grammar.default as Parameters<HighlighterCore["loadLanguage"]>[0]);
			// The engine compiles grammar patterns on first match, so tokenize a
			// throwaway snippet here rather than paying it on the render path.
			core.codeToTokens(WARMUP_SNIPPET, { lang: id, theme: syncTheme(core, roles) });
			loadedLanguages.add(id);
		} catch {
			failedLanguages.add(id);
		} finally {
			pendingLanguages.delete(id);
		}
		generation += 1;
		for (const listener of readyListeners) listener();
	})();
	pendingLanguages.set(id, task);
	return task;
}

/** Test seam: drop every cached grammar, theme registration, and listener. */
export function resetSyntaxHighlighterForTests(): void {
	highlighter = undefined;
	corePromise = undefined;
	registeredThemeName = undefined;
	registeredThemeVersion = -1;
	loadedLanguages.clear();
	pendingLanguages.clear();
	failedLanguages.clear();
	readyListeners.clear();
	tokenCache.clear();
	generation = 0;
}

// ── Fallback tokenizer ───────────────────────────────────────

const TS_KEYWORDS = new Set(["async", "await", "const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "throw", "try", "catch", "finally", "class", "extends", "implements", "import", "export", "from", "default", "new", "typeof", "instanceof", "in", "of", "null", "undefined", "true", "false", "void", "type", "interface", "enum", "as", "is", "keyof", "readonly", "declare", "module", "namespace", "abstract", "private", "protected", "public", "static", "yield", "delete", "super", "this", "debugger", "with"]);
const JS_KEYWORDS = new Set(["async", "await", "const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "throw", "try", "catch", "finally", "class", "extends", "import", "export", "from", "default", "new", "typeof", "instanceof", "in", "of", "null", "undefined", "true", "false", "void", "yield", "delete", "super", "this", "debugger", "with"]);
const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "until", "case", "esac", "function", "return", "local", "export", "readonly", "declare", "typeset", "unset", "shift", "exit", "break", "continue", "source", "eval", "exec", "set", "trap"]);
const PYTHON_KEYWORDS = new Set(["def", "class", "return", "if", "elif", "else", "for", "while", "break", "continue", "import", "from", "as", "with", "try", "except", "finally", "raise", "pass", "yield", "lambda", "and", "or", "not", "in", "is", "True", "False", "None", "global", "nonlocal", "del", "assert", "async", "await"]);

const KEYWORD_SETS = new Map<string, ReadonlySet<string>>([
	["ts", TS_KEYWORDS],
	["tsx", TS_KEYWORDS],
	["typescript", TS_KEYWORDS],
	["js", JS_KEYWORDS],
	["jsx", JS_KEYWORDS],
	["mjs", JS_KEYWORDS],
	["cjs", JS_KEYWORDS],
	["javascript", JS_KEYWORDS],
	["bash", SHELL_KEYWORDS],
	["sh", SHELL_KEYWORDS],
	["zsh", SHELL_KEYWORDS],
	["shell", SHELL_KEYWORDS],
	["shellscript", SHELL_KEYWORDS],
	["python", PYTHON_KEYWORDS],
	["py", PYTHON_KEYWORDS],
]);

const HASH_COMMENT_LANGUAGES = new Set(["bash", "sh", "zsh", "shell", "shellscript", "python", "py", "yaml", "yml", "toml", "make", "makefile", "dockerfile", "docker"]);

function isFunctionCall(rest: string): boolean {
	return /^\s*\(/.test(rest);
}

/**
 * Tokenize a source line into coloured spans without a grammar.
 * Handles: comments (#, //), strings ("…", '…'), numbers, keywords, function calls.
 * Used for every frame rendered before the Shiki grammar lands.
 */
export function highlightLineFallback(line: string, lang: string, roles: CodeRoles): SyntaxSpan[] {
	const spans: SyntaxSpan[] = [];
	const fg = roles.foreground;
	const kw = roles.keyword;
	const str = roles.string;
	const num = roles.number;
	const fn = roles.function;
	const comment = roles.comment;

	let i = 0;
	let current = "";
	let currentColor = fg;

	function flush(): void {
		if (current.length > 0) {
			spans.push({ text: current, color: currentColor });
			current = "";
		}
	}

	function pushColored(text: string, color: string): void {
		flush();
		spans.push({ text, color });
		currentColor = fg;
	}

	while (i < line.length) {
		const ch = line[i]!;

		// Line comments: // or #
		if ((ch === "/" && line[i + 1] === "/") || (ch === "#" && HASH_COMMENT_LANGUAGES.has(lang))) {
			flush();
			spans.push({ text: line.slice(i), color: comment });
			return spans.length > 0 ? spans : [{ text: line, color: fg }];
		}

		// Strings
		if (ch === '"' || ch === "'" || ch === "`") {
			flush();
			let j = i + 1;
			while (j < line.length && line[j] !== ch) {
				if (line[j] === "\\") j += 1;
				j += 1;
			}
			j = Math.min(j + 1, line.length);
			pushColored(line.slice(i, j), str);
			i = j;
			continue;
		}

		// Numbers
		if (/[0-9]/.test(ch) && (i === 0 || /[\s(,=:<>!&|+\-*/[\]{};]/.test(line[i - 1] ?? ""))) {
			flush();
			let j = i;
			while (j < line.length && /[0-9._xXa-fA-FeEn]/.test(line[j]!)) j += 1;
			pushColored(line.slice(i, j), num);
			i = j;
			continue;
		}

		// Words (identifiers / keywords)
		if (/[a-zA-Z_$]/.test(ch)) {
			flush();
			let j = i;
			while (j < line.length && /[a-zA-Z0-9_$]/.test(line[j]!)) j += 1;
			const word = line.slice(i, j);
			const after = line.slice(j);
			const keywords = KEYWORD_SETS.get(lang);
			if (keywords?.has(word)) {
				pushColored(word, kw);
			} else if (isFunctionCall(after)) {
				pushColored(word, fn);
			} else {
				pushColored(word, fg);
			}
			i = j;
			continue;
		}

		// Default: accumulate as foreground
		current += ch;
		currentColor = fg;
		i += 1;
	}

	flush();
	return spans.length > 0 ? spans : [{ text: line, color: fg }];
}

// ── Public entry point ───────────────────────────────────────

/**
 * Tokenize one source line into coloured spans. Always synchronous; the
 * concatenated span text always equals `line`.
 *
 * Unknown languages render as plain foreground — the fallback tokenizer would
 * invent keywords and string rules the language may not have.
 */
export function highlightLine(line: string, lang: string, roles: CodeRoles): readonly SyntaxSpan[] {
	const id = resolveShikiLanguage(lang);
	if (id === undefined) return [{ text: line, color: roles.foreground }];
	ensureLanguage(id, roles);
	const core = highlighter;
	if (!core || !loadedLanguages.has(id)) return highlightLineFallback(line, lang, roles);
	try {
		// Per-line tokenization: block comments and multi-line template
		// literals lose cross-line context, matching the fallback tokenizer's
		// existing behaviour, and it stays correct under the 20-line preview
		// cap and expand folds without a block-identity cache.
		const theme = syncTheme(core, roles);
		const key = `${theme}\u0000${id}\u0000${line}`;
		const cached = tokenCache.get(key);
		if (cached) return cached;
		const tokens = core.codeToTokens(line, { lang: id, theme }).tokens[0] ?? [];
		const spans: readonly SyntaxSpan[] = tokens.length > 0
			? tokens.map((token) => ({ text: token.content, color: token.color ?? roles.foreground }))
			: [{ text: line, color: roles.foreground }];
		// ponytail: whole-cache eviction, not LRU. A transcript re-render hits
		// the same lines, so the cheap policy is fine; switch to an LRU if a
		// profile ever shows thrash here.
		if (tokenCache.size >= TOKEN_CACHE_LIMIT) tokenCache.clear();
		tokenCache.set(key, spans);
		return spans;
	} catch {
		return highlightLineFallback(line, lang, roles);
	}
}
