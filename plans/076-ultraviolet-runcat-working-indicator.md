# Plan 076: Add the RunCat working indicator to Ultraviolet Core

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving on. If a **STOP condition** occurs, stop and report instead of improvising. When complete, update this plan’s row in `plans/README.md` unless the dispatching reviewer explicitly owns the index.
>
> **Drift check (run first)**:
>
> ```bash
> git fetch origin main
> git diff --stat e56455e..origin/main -- \
>   src/themes/types.ts \
>   src/themes/index.ts \
>   src/themes/indicator.ts \
>   src/themes/indicator.test.ts \
>   src/themes/ultraviolet-core.ts \
>   src/themes/ultraviolet-core.test.ts \
>   src/working-indicator.ts \
>   src/working-indicator.test.ts \
>   src/commands/spinner.ts \
>   src/commands/spinner.test.ts \
>   src/sumo-tui/rpc/shell-adapter.ts \
>   src/sumo-tui/rpc/shell-adapter.test.ts \
>   scripts/lib/runcat-font.mjs \
>   scripts/lib/runcat-font.test.mjs \
>   scripts/runcat-font.mjs \
>   vitest.config.ts \
>   scripts/render-bible.mjs \
>   scripts/visual-v2/paths.mjs \
>   scripts/visual-v2/index.mjs \
>   scripts/visual-v2/scenario-registry.mjs \
>   scripts/visual-v2/review-pack.mjs \
>   scripts/visual-v2/review-pack.test.mjs \
>   scripts/visual-v2/final-cell-contract.mjs \
>   scripts/visual-v2/final-cell-contract.test.mjs \
>   scripts/visual-v2/terminal-dom-renderer.mjs \
>   scripts/visual-v2/terminal-dom-renderer.test.mjs \
>   scripts/gen-bible-theme-ultraviolet-core.mjs \
>   docs/visual/parity/scenarios.json \
>   src/visual-parity-contract.test.ts \
>   package.json \
>   assets/fonts/ \
>   docs/ui/stitch/ultraviolet-core/ \
>   docs/ui/bible/theme-ultraviolet-core-runcat-active.html \
>   docs/visual/parity/ULTRAVIOLET_RUNCAT_REVIEW.md \
>   README.md docs/prd.md docs/prd.html CHANGELOG.md plans/README.md
> git status --short
> ```
>
> If any in-scope file has changed since this plan was written, reconcile the **Current state** excerpts against live `origin/main` before editing. Preserve unrelated worktree changes. Never use `git reset --hard` or `git clean` to prepare this task.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 075 — Ultraviolet Core Application Theme (DONE; implementation commits include `dc6eedf` and `896715c`)
- **Category**: polish
- **Planned at**: `origin/main` commit `e56455e`, 2026-07-19
- **Execution status**: IN PROGRESS — automated implementation approved on `feat/ultraviolet-runcat-indicator` at `3747af4`; typecheck/build, 1,759 unit tests, 45 integration tests, 101 Bible renders, 22 visual scenarios, package/font checks, and final Claude autoreview pass; two-Mac human canary remains pending
- **Issue**: [#331](https://github.com/dhruvkelawala/sumocode/issues/331)
- **Upstream inspiration**: [FredySandoval/pi-runcat](https://github.com/FredySandoval/pi-runcat), pinned at `44a35444464755d8a2ade22ab8a7211cd1069c45`
- **Source tweet**: https://x.com/devfredy/status/2059960736709808403

## Decision

Ultraviolet Core gains Fredy Sandoval’s five-frame running-cat indicator as an **explicit enhanced capability**, not an unconditional PUA-font dependency:

- default Ultraviolet behavior remains its safe eight-frame ASCII orbital pulse;
- when `SUMOCODE_RUNCAT_FONT=1` is set before SumoCode starts, Ultraviolet resolves to the five RunCat PUA glyphs at the upstream 167 ms cadence;
- Cathedral, Amber CRT, Obsidian, and Herdr ignore the capability and retain their exact indicators;
- the 3.5 KB upstream font is vendored under its 0BSD licence, checksum-pinned, packaged, and installable through a safe repository command;
- the installer copies the font only. It does not silently edit Ghostty, shell, Herdr, or personal config;
- runtime code never pretends to detect terminal font mapping. A terminal cannot reliably report whether a PUA codepoint is mapped to the intended face;
- if the user enables the capability without installing/mapping the font, tofu boxes are possible. `/sumo:spinner` and the documented fallback command make this failure obvious and reversible.

This is the smallest honest architecture: delightful for configured Ultraviolet users, safe for everyone else.

## Canonical RunCat contract

### Frames and cadence

Adapt the upstream frames exactly, but remove upstream’s trailing spaces because SumoCode already owns spacing around the indicator:

```ts
export const ULTRAVIOLET_RUNCAT_FRAMES = ["\uE900", "\uE901", "\uE902", "\uE903", "\uE904"] as const;
export const ULTRAVIOLET_RUNCAT_INTERVAL_MS = 167;
export const ULTRAVIOLET_RUNCAT_CAPABILITY_ENV = "SUMOCODE_RUNCAT_FONT";
```

Each frame must:

- contain exactly one Unicode code point;
- occupy exactly one logical terminal cell in SumoCode’s xterm/styled-cell model;
- contain no leading/trailing whitespace;
- render in the active Ultraviolet accent `#B974FF`;
- preserve the existing dim lavender `Working…` label;
- cycle in upstream order without interpolation, reversal, or duplicated frames.

Do not copy upstream’s `" "` two-character frame strings. SumoCode renders ` ${frame} ${label}` already; retaining the upstream space would shift the label and visual mask by one cell.

### Safe fallback

The existing Plan 075 values remain the fallback:

```ts
export const ULTRAVIOLET_CORE_INDICATOR_FRAMES = [".", ":", "o", "O", "@", "O", "o", ":"] as const;
export const ULTRAVIOLET_CORE_INDICATOR_INTERVAL_MS = 120;
```

Unset, empty, `0`, `false`, `no`, and `off` must resolve to fallback. Accept `1`, `true`, `yes`, and `on`, case-insensitively, as explicit enablement. Any other value is disabled and reported as unrecognized by `/sumo:spinner`; do not fail startup.

### Font provenance

Vendor only the required font and licence/provenance files:

| Item | Contract |
|---|---|
| Upstream file | `runcat.ttf` at commit `44a35444464755d8a2ade22ab8a7211cd1069c45` |
| Repository destination | `assets/fonts/runcat.ttf` |
| Size | 3,532 bytes |
| SHA-256 | `3c5be14dc51cd0d21b34cbd40fe147ff61480ce03655eb43571008975b395d94` |
| Internal family/PostScript name | `icomoon` |
| PUA coverage | `U+E900–U+E904` |
| Licence | 0BSD, copyright © 2026 Fredy Sandoval |
| Licence copy | `assets/fonts/runcat.LICENSE` |
| Provenance note | `assets/fonts/runcat.SOURCE.md` |

Do not vendor the GIF, SVG source frames, npm package, or upstream extension code. SumoCode adapts only the frame codepoints/cadence and font asset within its existing indicator ownership.

## Why this matters

The working indicator is the one animation users watch during every agent turn. Ultraviolet Core is deliberately the more expressive SumoCode theme; the running cat gives it a distinctive, playful signature without diluting the violet system or touching task semantics.

The wrong implementation would install `pi-runcat` alongside SumoCode, creating two competing indicator owners, or make every Ultraviolet user depend on an invisible custom-font prerequisite. This plan avoids both failures by adapting the frames into SumoCode’s existing classic/retained/RPC paths and gating the font-backed variant explicitly.

## Current state

### Plan 075 is implemented on main

`origin/main` contains the canonical Ultraviolet bundle and application roles. `src/themes/ultraviolet-core.ts` currently defines:

```ts
export const ULTRAVIOLET_CORE_INDICATOR_FRAMES = [".", ":", "o", "O", "@", "O", "o", ":"] as const;
export const ULTRAVIOLET_CORE_INDICATOR_INTERVAL_MS = 120;

workingIndicator: {
	frames: ULTRAVIOLET_CORE_INDICATOR_FRAMES,
	intervalMs: ULTRAVIOLET_CORE_INDICATOR_INTERVAL_MS,
},
```

The core/application palette is already correct and out of scope for this follow-up. The planned baseline includes `00bc53e`, which moved the tool ledger into the canonical violet family (`#100A1D` surface, `#56347A` border, `#B974FF` label, `#DCC7FF` body/target, `#9B7BBE` muted); the executor must preserve those values.

### Theme indicator contract has no enhanced variant

`src/themes/types.ts` (around lines 39–42 on the planned main revision) currently exposes only:

```ts
export interface ThemeWorkingIndicator {
	frames: readonly string[];
	intervalMs: number;
}
```

There is no generic resolver or capability-gated variant.

### Three production paths read the raw theme indicator directly

`src/working-indicator.ts` currently reads `theme.workingIndicator` in:

- `buildActiveThemeIndicatorFrames()` for classic Pi;
- `WorkingIndicatorComponent.render()` for retained mode;
- `WorkingIndicatorComponent.startTimer()` for retained cadence;
- `installWorkingIndicator()` when forwarding classic frames/cadence.

`src/sumo-tui/rpc/shell-adapter.ts:412-415, 477-483` independently reads the same raw frames/cadence for the RPC host. A correct implementation must route all three modes through one resolver or they will disagree.

### Spinner inspection is incorrectly Cathedral-specific

`src/commands/spinner.ts:18-26` currently describes and renders “the cathedral working indicator” using `CATHEDRAL_INDICATOR_FRAMES` and `CATHEDRAL_INDICATOR_INTERVAL_MS`, even when another theme is active. RunCat would therefore be invisible to the existing debugging command unless this is fixed.

### Visual renderer loads only JetBrains Mono

`scripts/visual-v2/terminal-dom-renderer.mjs:53-71` defines only a JetBrains Mono `@font-face`. Correct PUA bytes would still render as boxes in review screenshots without a RunCat `@font-face` and `unicode-range` mapping.

### No third-party font convention exists

- There is no existing `assets/fonts/` directory or third-party notice file.
- `package.json` has no explicit `files` allowlist.
- `npm pack --dry-run` currently falls back to `.gitignore`; the new plan must prove that the font, licence, source note, and installer are included in the package rather than assuming it.

### Upstream facts verified at planning time

From upstream commit `44a3544`:

```ts
const RUNCAT_INDICATOR = {
  frames: [" ", " ", " ", " ", " "],
  intervalMs: 167,
};
```

- Licence: 0BSD.
- Font scan: family/PostScript name `icomoon`; charset includes `E900–E904`.
- The source GIF shows a recognizable compact running cat across five poses.
- Plan-time focused baseline: 3 test files, 51 tests passed (`working-indicator`, Ultraviolet theme, RPC shell adapter).

## Scope

### In scope

**Theme model and resolver**

- `src/themes/types.ts`
- `src/themes/indicator.ts` (create)
- `src/themes/indicator.test.ts` (create)
- `src/themes/index.ts`
- `src/themes/ultraviolet-core.ts`
- `src/themes/ultraviolet-core.test.ts`

**Classic, retained, RPC, and inspection consumers**

- `src/working-indicator.ts`
- `src/working-indicator.test.ts`
- `src/commands/spinner.ts`
- `src/commands/spinner.test.ts` (create)
- `src/sumo-tui/rpc/shell-adapter.ts`
- `src/sumo-tui/rpc/shell-adapter.test.ts`

**Vendored font and safe installer**

- `assets/fonts/runcat.ttf` (create, binary)
- `assets/fonts/runcat.LICENSE` (create)
- `assets/fonts/runcat.SOURCE.md` (create)
- `scripts/lib/runcat-font.mjs` (create)
- `scripts/lib/runcat-font.test.mjs` (create)
- `scripts/runcat-font.mjs` (create)
- `package.json`
- `vitest.config.ts`

**Independent design and visual evidence**

- `docs/ui/stitch/ultraviolet-core/RUNCAT.md` (create)
- `scripts/gen-bible-theme-ultraviolet-core.mjs`
- `scripts/render-bible.mjs`
- generated `docs/ui/bible/theme-ultraviolet-core-runcat-active.html`
- local ignored render `docs/ui/bible/renders/theme-ultraviolet-core-runcat-active.png`
- `scripts/visual-v2/paths.mjs`
- `scripts/visual-v2/index.mjs`
- `scripts/visual-v2/scenario-registry.mjs`
- `scripts/visual-v2/review-pack.mjs`
- `scripts/visual-v2/review-pack.test.mjs` (create)
- `scripts/visual-v2/final-cell-contract.mjs` (create)
- `scripts/visual-v2/final-cell-contract.test.mjs` (create)
- `scripts/visual-v2/terminal-dom-renderer.mjs`
- `scripts/visual-v2/terminal-dom-renderer.test.mjs` (create)
- `docs/visual/parity/scenarios.json`
- `src/visual-parity-contract.test.ts`
- `docs/visual/parity/ULTRAVIOLET_RUNCAT_REVIEW.md` (create)

**Product truth**

- `README.md`
- `docs/prd.md`
- `docs/prd.html`
- `CHANGELOG.md`
- `plans/README.md` status only

### Out of scope

- Installing the `pi-runcat` npm extension.
- Replacing SumoCode’s existing working-indicator lifecycle or moving its row.
- Changing the `Working…` label, row width gate, spacing, placement, or state semantics.
- Changing any Ultraviolet colour, application role, frame chrome, sidebar, transcript, or tool/code surface.
- Changing Cathedral, Amber CRT, Obsidian, or Herdr indicators.
- Runtime font probing or claiming that a terminal font map can be auto-detected.
- Automatically editing `~/.config/ghostty/config`, shell profiles, Herdr config, macOS font databases, or another machine’s files.
- Requiring root/sudo, writing `/Library/Fonts`, or installing system-wide fonts.
- Vendoring upstream GIF/SVG assets or the full npm package.
- Adding a general plugin marketplace, indicator selector command, or persisted config field.
- Supporting Kitty/iTerm/WezTerm-specific setup in v1; document only the verified Ghostty path used by the two target Macs.
- Golden promotion or edits under `docs/visual/parity/approved-runtime/**` without Dhruv’s separate approval.

## Target architecture

### Theme type

Extend the existing contract without changing any current theme object:

```ts
export interface ThemeWorkingIndicatorEnhancedVariant {
	readonly name: string;
	readonly frames: readonly string[];
	readonly intervalMs: number;
	readonly capabilityEnv: string;
}

export interface ThemeWorkingIndicator {
	readonly frames: readonly string[];
	readonly intervalMs: number;
	readonly enhanced?: ThemeWorkingIndicatorEnhancedVariant;
}

export interface ResolvedThemeWorkingIndicator {
	/** "default" is reserved for the base variant; enhanced variants use their declared name. */
	readonly name: string;
	readonly frames: readonly string[];
	readonly intervalMs: number;
	readonly capabilityEnv?: string;
	readonly capabilityState: "enabled" | "disabled" | "unrecognized";
}
```

Ultraviolet alone opts into `enhanced`:

```ts
workingIndicator: {
	frames: ULTRAVIOLET_CORE_INDICATOR_FRAMES,
	intervalMs: ULTRAVIOLET_CORE_INDICATOR_INTERVAL_MS,
	enhanced: {
		name: "runcat",
		frames: ULTRAVIOLET_RUNCAT_FRAMES,
		intervalMs: ULTRAVIOLET_RUNCAT_INTERVAL_MS,
		capabilityEnv: ULTRAVIOLET_RUNCAT_CAPABILITY_ENV,
	},
},
```

### Resolver

Create `resolveThemeWorkingIndicator(theme = getActiveTheme(), env = process.env)` in `src/themes/indicator.ts` and export it through `src/themes/index.ts`.

Rules:

1. If the active theme has no enhanced variant, return `{ name: "default", frames: base.frames, intervalMs: base.intervalMs, capabilityState: "disabled" }` with no `capabilityEnv` property, regardless of env.
2. If a theme has an enhanced variant, every return includes that variant’s `capabilityEnv`, including fallback returns.
3. If the enhanced capability env is explicitly truthy, return `{ name: enhanced.name, frames: enhanced.frames, intervalMs: enhanced.intervalMs, capabilityEnv, capabilityState: "enabled" }`.
4. If unset or explicitly false-like, return `{ name: "default", frames: base.frames, intervalMs: base.intervalMs, capabilityEnv, capabilityState: "disabled" }`.
5. If non-empty and neither true-like nor false-like, return `{ name: "default", frames: base.frames, intervalMs: base.intervalMs, capabilityEnv, capabilityState: "unrecognized" }`.
6. Never mutate `process.env`, the theme object, or global registry state.
7. The resolver is pure and receives `env` explicitly in tests.

Do not branch on `theme.name === "ultraviolet-core"` in consumers. Theme ownership lives only in Ultraviolet’s `enhanced` declaration.

### Installer

`scripts/lib/runcat-font.mjs` should export pure/testable helpers for:

- vendored font path resolution from repository root;
- per-user destination resolution (`~/Library/Fonts/runcat.ttf` on macOS, `~/.local/share/fonts/runcat.ttf` on Linux);
- SHA-256 calculation;
- source/destination verification;
- atomic no-clobber publication from a verified temporary sibling;
- a structured check result that distinguishes `missing`, `hash-mismatch`, and `verified`.

`scripts/runcat-font.mjs` provides:

```bash
node scripts/runcat-font.mjs check
node scripts/runcat-font.mjs install
```

Add package aliases:

```json
"runcat:check": "node scripts/runcat-font.mjs check",
"runcat:install": "node scripts/runcat-font.mjs install"
```

Behavior:

- `check` never writes and exits non-zero for missing/mismatched font;
- `install` verifies the vendored checksum before copying, creates only the per-user font directory, copies to an exclusively created temporary sibling, verifies/fsyncs it, then publishes with a same-filesystem no-clobber hard link (`link(temp, destination)`) and removes the temporary name;
- an already-correct destination is an idempotent success;
- inspect destinations with `lstat`; reject symlinks and non-regular files;
- a mismatched existing file is never overwritten: `EEXIST` from no-clobber publication triggers destination reinspection/reverification and either idempotent success for the exact hash or actionable refusal;
- neither command edits Ghostty or sets environment variables;
- successful macOS output prints these exact follow-up lines:

```text
font-codepoint-map = U+E900-U+E904=icomoon
env = SUMOCODE_RUNCAT_FONT=1
```

- output states that restart is required and `SUMOCODE_RUNCAT_FONT=0` restores the safe orbital fallback;
- tests use temporary directories and injected platform/home values; they never write the real user font directory.

## Git workflow

1. Fetch and verify the dependency before branching:

```bash
git fetch origin main
git merge-base --is-ancestor 896715c origin/main
```

Expected: exit 0. If not, STOP: Plan 075 is not on the selected base.

2. Branch from refreshed `origin/main`:

```bash
git switch -c advisor/076-ultraviolet-runcat-indicator origin/main
```

3. Suggested conventional commits:

- `feat(theme): add capability-gated ultraviolet runcat indicator`
- `feat(setup): vendor and verify runcat font`
- `test(visual): add ultraviolet runcat review evidence`
- `docs(theme): document runcat capability and provenance`

Do not push, open a PR, merge, install on a second machine, or promote goldens unless instructed.

## Steps

### Step 0: Establish dependency and baseline truth

1. Preserve unrelated worktree changes before switching branches.
2. Fetch `origin/main` and prove `896715c` is an ancestor.
3. Confirm `src/themes/ultraviolet-core.ts` has Plan 075’s application roles and orbital indicator.
4. Confirm no existing `assets/fonts/runcat.ttf` or `SUMOCODE_RUNCAT_FONT` implementation has landed.
5. Run the focused baseline:

```bash
pnpm vitest run \
  src/working-indicator.test.ts \
  src/themes/ultraviolet-core.test.ts \
  src/sumo-tui/rpc/shell-adapter.test.ts
pnpm typecheck
```

Expected: all selected tests pass before implementation.

### Step 1: Vendor the exact font and provenance first

1. Create `assets/fonts/`.
2. Fetch or copy `runcat.ttf` only from the pinned upstream commit. Do not use `main` or an unpinned release URL.
3. Verify before any commit. `fc-scan` is a useful metadata confirmation, not a universal Node/macOS prerequisite; first test whether it is available:

```bash
shasum -a 256 assets/fonts/runcat.ttf
stat -f 'bytes=%z' assets/fonts/runcat.ttf
if command -v fc-scan >/dev/null 2>&1; then
  fc-scan --format '%{family}\n%{postscriptname}\n%{charset}\n' assets/fonts/runcat.ttf
else
  echo 'fc-scan unavailable; checksum and size remain the blocking provenance checks'
fi
```

Expected:

- SHA-256 exactly `3c5be14dc51cd0d21b34cbd40fe147ff61480ce03655eb43571008975b395d94`;
- 3,532 bytes;
- family and PostScript name `icomoon`;
- charset includes `e900-e904`.

4. Copy the complete upstream 0BSD text into `assets/fonts/runcat.LICENSE`.
5. Write `assets/fonts/runcat.SOURCE.md` with repository URL, commit, original filename, checksum, adapted frame spacing note, and source tweet.
6. Do not claim SumoCode authored the cat glyphs.

**Verify**:

```bash
shasum -a 256 assets/fonts/runcat.ttf
```

Expected: exact pinned checksum.

### Step 2: Add the generic enhanced-indicator resolver test-first

1. Add failing tests in `src/themes/indicator.test.ts` for every resolver rule in **Target architecture**.
2. Extend `ThemeWorkingIndicator` and add the resolved type.
3. Implement the pure resolver and export it through `src/themes/index.ts`.
4. Test all true-like, false-like, unset, and unrecognized values.
5. Test that `SUMOCODE_RUNCAT_FONT=1` has no effect on a theme without `enhanced`.
6. Test that returned arrays are the declared arrays, not mutated copies, unless current repository immutability conventions require copying.
7. Do not read filesystem/font state in the resolver.

**Verify**:

```bash
pnpm vitest run src/themes/indicator.test.ts
```

Expected: tests fail before implementation and pass afterward.

### Step 3: Declare RunCat only on Ultraviolet

1. Add the canonical exports and enhanced declaration to `src/themes/ultraviolet-core.ts`.
2. Preserve the orbital constants and fallback declaration exactly.
3. Extend `src/themes/ultraviolet-core.test.ts` to prove:
   - five exact codepoints in order;
   - one code point and one logical terminal cell per frame;
   - no whitespace in any frame;
   - 167 ms enhanced cadence;
   - capability env exact name;
   - existing orbital fallback remains eight frames at 120 ms;
   - palette, application roles, chrome, and theme identity are unchanged.
4. Use the same terminal-width function used by the renderer/styled-cell grid, not JavaScript `.length` alone, for the one-cell assertion.

**Verify**:

```bash
pnpm vitest run src/themes/ultraviolet-core.test.ts src/themes/indicator.test.ts
```

Expected: all pass.

### Step 4: Route classic and retained modes through the resolver

1. Replace direct active-theme frame/cadence reads in `src/working-indicator.ts` with one resolved contract.
2. `buildActiveThemeIndicatorFrames(env = process.env)` must colorize the resolved frames with the active theme accent.
3. `WorkingIndicatorComponent.render()` and timer startup must resolve from the same env and therefore use matching frames/cadence.
4. Preserve idle behavior, minimum width, row shape, spacing, lifecycle, and theme-change timer restart.
5. Capability env is process-start configuration. Changing it mid-process is unsupported; documentation must say restart SumoCode after enabling/disabling.
6. Add tests for:
   - Ultraviolet + env on renders `U+E900` first in violet and advances at 167 ms;
   - Ultraviolet + env off renders orbital first frame and advances at 120 ms;
   - switching from Ultraviolet RunCat to another theme immediately changes frames/cadence;
   - switching back restores RunCat while capability remains enabled;
   - Cathedral output is byte-compatible when capability env is on;
   - classic `setWorkingIndicator` receives resolved frames/cadence;
   - retained row still contains exactly one leading space, one frame cell, one separator space, and `Working…`.

**Verify**:

```bash
pnpm vitest run src/working-indicator.test.ts
```

Expected: old tests plus new capability/fallback tests pass.

### Step 5: Route the RPC host through the same resolver

1. Replace raw frame/cadence reads in `RpcShellAdapter.renderWorkingIndicator()` and `startWorkingIndicatorTimer()`.
2. Ensure both methods resolve from the same process env.
3. Do not duplicate truthy parsing or PUA constants in the RPC module.
4. Add fake-timer/cell tests for enhanced and fallback modes.
5. Prove resize, idle/busy reset, theme switching, repaint scheduling, and disposal semantics remain unchanged.
6. Prove `SUMOCODE_RUNCAT_FONT=1` does not affect non-Ultraviolet RPC output.

**Verify**:

```bash
pnpm vitest run src/sumo-tui/rpc/shell-adapter.test.ts
```

Expected: all pass; the enhanced frame occupies the same indicator cell as the fallback frame.

### Step 6: Make `/sumo:spinner` inspect the resolved active indicator

1. Remove Cathedral-specific imports and wording from `src/commands/spinner.ts`.
2. Add a helper that formats:
   - active theme name;
   - resolved variant name (`default` or `runcat`);
   - capability env and state when applicable;
   - frame count and cadence;
   - numbered, colored frame rows.
3. Keep interactive notification and non-TTY stdout behavior.
4. For unrecognized env values, show a warning line and preview fallback frames.
5. Add `src/commands/spinner.test.ts` covering Cathedral, Ultraviolet fallback, Ultraviolet RunCat, unrecognized env, TTY notification, and stdout.
6. Do not turn this into a selector or mutate environment/config.

**Verify**:

```bash
pnpm vitest run src/commands/spinner.test.ts src/working-indicator.test.ts
```

Expected: exact active/resolved metadata and all five RunCat frames are inspectable statically.

### Step 7: Build and test the safe font installer

1. Implement pure helpers and the thin CLI as specified in **Installer**.
2. Add package scripts `runcat:check` and `runcat:install`.
3. In tests, cover macOS/Linux destinations, missing source, bad source hash, idempotent correct destination, mismatched destination refusal, destination symlink/non-regular-file refusal, `EEXIST` publication race, no-clobber hard-link publication, temporary-file cleanup, and structured status.
4. Do not execute the real install during automated tests.
5. Extend `vitest.config.ts` so both normal and integration configurations include `scripts/**/*.test.mjs`; preserve the existing `src/**/*.test.ts` and conditional `test/integration/**/*.test.ts` patterns.
6. Run the installer tests explicitly before package inspection:

```bash
pnpm vitest run scripts/lib/runcat-font.test.mjs
```

Expected: all installer tests pass and write only under temporary test directories.
7. Run package dry-run and inspect exact paths:

```bash
npm pack --dry-run --json > /tmp/sumocode-pack-runcat.json
node -e '
const p=require("/tmp/sumocode-pack-runcat.json")[0].files.map(x=>x.path);
for (const f of [
  "assets/fonts/runcat.ttf",
  "assets/fonts/runcat.LICENSE",
  "assets/fonts/runcat.SOURCE.md",
  "scripts/runcat-font.mjs",
  "scripts/lib/runcat-font.mjs"
]) if (!p.includes(f)) throw new Error(`missing from package: ${f}`);
console.log("RunCat package assets present");'
```

Expected: exit 0 and explicit confirmation. Do not create a broad `files` allowlist or `.npmignore` cleanup in this plan unless the asset is otherwise impossible to package; that would be a separate packaging task.

### Step 8: Map RunCat into deterministic visual rendering

1. Add `runcatFontPath = resolve(repoRoot, "assets", "fonts", "runcat.ttf")` in `scripts/visual-v2/paths.mjs`.
2. Extend `terminal-dom-renderer.mjs` with:

```css
@font-face {
  font-family: 'RunCat';
  font-style: normal;
  font-weight: 400;
  font-display: block;
  src: url('.../assets/fonts/runcat.ttf') format('truetype');
  unicode-range: U+E900-E904;
}
.term {
  font-family: 'RunCat', 'JetBrains Mono', ui-monospace, Menlo, monospace;
}
```

3. Keep JetBrains Mono as the effective face for all non-RunCat characters through `unicode-range` fallback.
4. Add a renderer test asserting the pinned font URL, `unicode-range`, font order, and unchanged normal cell metrics/style contract.
5. Add `scripts/gen-bible-theme-ultraviolet-core.mjs` to `scripts/render-bible.mjs`’s generator list after its structural prerequisites. Without this registration, `pnpm render:bible` cannot regenerate the target.
6. Extend the Plan 075 Ultraviolet generator to create `theme-ultraviolet-core-runcat-active.html` from independent design data. It must declare the same font mapping and place a representative RunCat glyph in the working-indicator cell without copying runtime output.
7. Update `docs/ui/stitch/ultraviolet-core/RUNCAT.md` before generator work with provenance, codepoints, cadence, fallback, spacing, and visual acceptance.
8. Run the renderer tests explicitly:

```bash
pnpm vitest run scripts/visual-v2/terminal-dom-renderer.test.mjs
```

Expected: font-face/range/order tests pass.

9. Delete the generated RunCat HTML target, run Bible generation to prove the registered generator recreates it, then run again and compare hashes:

```bash
rm -f docs/ui/bible/theme-ultraviolet-core-runcat-active.html
pnpm render:bible
test -f docs/ui/bible/theme-ultraviolet-core-runcat-active.html
shasum -a 256 docs/ui/bible/theme-ultraviolet-core-runcat-active.html > /tmp/runcat-bible-1.sha256
pnpm render:bible
shasum -a 256 docs/ui/bible/theme-ultraviolet-core-runcat-active.html > /tmp/runcat-bible-2.sha256
cmp /tmp/runcat-bible-1.sha256 /tmp/runcat-bible-2.sha256
```

Expected: deterministic target; existing Ultraviolet targets remain unchanged.

### Step 9: Add enhanced and fallback final-cell visual gates

1. Add a generic optional `finalCellAssertions` scenario contract, validated by `scenario-registry.mjs` and evaluated against the final parsed terminal snapshot. Each assertion supports integer `row`/`col`, optional exact `text`, optional `charPattern`, optional `width`, and optional `fg`. Invalid bounds/patterns fail manifest loading. Normalize foreground colours to lowercase six-digit hex before comparison so `#B974FF` and `#b974ff` are equivalent.
2. Implement evaluation in `final-cell-contract.mjs` with structured mismatches and a text artifact. Wire it into `index.mjs`; a failed final-cell contract must make `scenarioResult()` return `failed` in both review and CI modes. Extend `review-pack.mjs` to show pass/fail, mismatch details, and the artifact link instead of silently dropping the new evidence.
3. Add unit tests for exact text, regex char, width, normalized foreground, out-of-bounds cells, malformed assertions, multiple failures, passing contracts, scenario failure propagation, and review-pack visibility.
4. Keep Plan 075’s existing `ultraviolet-core-active-runtime` scenario as the env-unset fallback proof. Give it coordinate-scoped assertions at the actual final working row: orbital char pattern `[.:oO@]` at the indicator cell, `width: 1`, a literal separator space in the next cell, and exact `Working…` beginning at the following cell. Do not globally reject orbital characters; they legitimately occur elsewhere in the screen.
5. Add review-only `ultraviolet-core-runcat-active-runtime`:
   - same dimensions/command/provider as the existing Ultraviolet runtime scene;
   - `SUMOCODE_RUNCAT_FONT=1` in isolated scenario env;
   - target `theme-ultraviolet-core-runcat-active.png`;
   - require a final-cell assertion matching `[\uE900-\uE904]` at the exact indicator row/column with `width: 1` and foreground `#B974FF`;
   - require a literal separator space in the next cell and exact `Working…` text at the fixed following column;
   - retain raw-output PUA matching only as supplemental evidence, not as cell-position proof;
   - retain Plan 075’s stale-theme, empty transcript, shell, auth, stack-trace, and RPC placeholder rejection patterns.
6. Keep the existing one-cell animation-phase mask only. Do not mask the label, row, or surrounding geometry. The mask may ignore which valid phase glyph was captured, but the final-cell contract must reject tofu, fallback glyphs in enhanced mode, wrong width, wrong colour, or shifted label geometry before masking is considered.
7. Extend `src/visual-parity-contract.test.ts` to prove the two scenarios differ only by explicit capability env/target/glyph contract and both remain `review`.
8. Run the generic contract tests and scenarios:

```bash
pnpm vitest run scripts/visual-v2/final-cell-contract.test.mjs scripts/visual-v2/review-pack.test.mjs src/visual-parity-contract.test.ts
pnpm visual:review -- --scenario ultraviolet-core-active-runtime
pnpm visual:review -- --scenario ultraviolet-core-runcat-active-runtime
```

Automated expected result: both commands exit 0 only when their coordinate-scoped final-cell contracts pass. Fallback has a one-cell orbital frame; enhanced has a one-cell violet PUA frame; separator and `Working…` columns are identical. Styled-cell and broader geometry reports remain review evidence unless separately gated. Human expected result: inspect the enhanced screenshot/live loop and confirm the mapped glyph is a recognizable cat rather than tofu; automation cannot judge recognizability.

### Step 10: Document setup, rollback, and third-party truth

1. Update `README.md`, `docs/prd.md`, `docs/prd.html`, and `CHANGELOG.md` in present tense.
2. Document the verified macOS/Ghostty setup:

```bash
pnpm runcat:install
pnpm runcat:check
```

Then add to Ghostty config:

```text
font-codepoint-map = U+E900-U+E904=icomoon
env = SUMOCODE_RUNCAT_FONT=1
```

Restart Ghostty/Herdr/SumoCode and run `/sumo:spinner`.
3. Document immediate rollback:

```text
env = SUMOCODE_RUNCAT_FONT=0
```

Restart; Ultraviolet returns to the orbital fallback without uninstalling the font.
4. State clearly that `runcat:check` verifies the font file/hash, not Ghostty’s live codepoint map.
5. Credit Fredy Sandoval and link the upstream repository/tweet.
6. Write `docs/visual/parity/ULTRAVIOLET_RUNCAT_REVIEW.md` with target/capture paths, commit, commands, raw glyph evidence, geometry result, and human judgement.

### Step 11: Canonical verification and two-Mac canary

Run:

```bash
pnpm test
pnpm test:integration
pnpm typecheck
pnpm dead-code:strict
pnpm vitest run scripts/lib/runcat-font.test.mjs scripts/visual-v2/terminal-dom-renderer.test.mjs scripts/visual-v2/final-cell-contract.test.mjs scripts/visual-v2/review-pack.test.mjs
pnpm render:bible
pnpm visual:review -- --scenario ultraviolet-core-active-runtime
pnpm visual:review -- --scenario ultraviolet-core-runcat-active-runtime
pnpm visual:ci
npm pack --dry-run --json > /tmp/sumocode-pack-runcat.json
```

Then search production code for direct enhanced-indicator duplication:

- `U+E900–U+E904` literals belong only in the Ultraviolet bundle/tests/design docs;
- `SUMOCODE_RUNCAT_FONT` belongs in the Ultraviolet capability declaration, tests, installer output, scenario, and docs—not in render consumers;
- all consumers call `resolveThemeWorkingIndicator()`;
- no `theme.name === "ultraviolet-core"` branch exists outside tests/docs;
- no personal font/config path is hard-coded into runtime theme resolution.

#### Mac Mini canary first

1. Keep capability disabled. Start Ultraviolet and verify orbital fallback.
2. Run `pnpm runcat:install` and `pnpm runcat:check`.
3. Add the two documented Ghostty lines manually after reviewing the exact diff.
4. Restart Ghostty/Herdr/SumoCode.
5. Run `/sumo:spinner`; verify `theme=ultraviolet-core`, `variant=runcat`, capability enabled, five distinct cat poses, 167 ms.
6. Start a real turn and watch at least two complete loops. Verify recognizable running motion, stable one-cell geometry, violet glyph, lavender `Working…`, and no label jitter.
7. Switch to Cathedral, Herdr, Amber CRT, and Obsidian while busy. Verify each keeps its own indicator.
8. Switch back to Ultraviolet; RunCat returns without duplicate rows/timers.
9. Set capability to `0`, restart, and verify immediate orbital rollback.
10. Record exact results and one screenshot/video reference in the review document.

#### MacBook second

Repeat only after the Mini passes. Do not copy the Mini’s full config wholesale; apply the two reviewed lines to the MacBook’s own Ghostty config. Record independent install/check/live/fallback results.

## Test plan

### Unit

- exact PUA codepoints, order, cadence, one-cell width, and no whitespace;
- pure env capability parsing and unrecognized fallback;
- no effect on themes without enhanced variants;
- classic/retained/RPC frame and cadence parity;
- timer restart/disposal and theme switching;
- active spinner inspection metadata/output;
- font hash/destination/install/refusal/idempotency;
- visual renderer font-face/unicode-range contract.

### Integration

- classic Pi receives resolved RunCat/fallback frames;
- retained widget and RPC host render same cell/spacing;
- package dry-run contains font/licence/provenance/installer;
- Bible generation deterministic;
- fallback and enhanced visual scenarios remain isolated.

### Human visual

- all five poses recognizable in `/sumo:spinner`;
- running loop reads as motion at 167 ms;
- glyph remains one cell with no `Working…` jitter;
- violet accent and lavender label fit Ultraviolet;
- fallback is clean when capability is disabled;
- no tofu on either configured Mac.

## Done criteria

- [ ] Ultraviolet has a generic capability-gated `runcat` enhanced indicator and unchanged orbital fallback.
- [ ] Frames are exactly `U+E900–U+E904`, one cell each, no trailing spaces, 167 ms.
- [ ] Other themes remain byte/behavior compatible even when the capability env is enabled.
- [ ] Classic Pi, retained SumoTUI, and RPC host use one resolver for frames and cadence.
- [ ] `/sumo:spinner` reports and previews the active resolved indicator.
- [ ] Font asset matches the pinned 3,532-byte SHA-256 and ships with 0BSD licence/provenance.
- [ ] Installer is per-user, idempotent, checksum-verifying, symlink-safe, race-tested, no-clobber atomic, and never edits personal config.
- [ ] Package dry-run contains every required RunCat asset/script.
- [ ] Deterministic renderer maps only `U+E900–U+E904` to RunCat and preserves JetBrains Mono elsewhere.
- [ ] Independent RunCat Bible target is deterministic.
- [ ] Fallback and enhanced runtime scenarios fail on wrong final-cell glyph/width/colour/separator/label coordinates and complete with honest review evidence.
- [ ] No approved golden is modified/promoted.
- [ ] `pnpm test`, `pnpm test:integration`, `pnpm typecheck`, and `pnpm dead-code:strict` pass.
- [ ] Mac Mini enhanced and rollback smokes pass before the MacBook.
- [ ] Both Macs show recognizable cats, stable geometry, and no duplicate indicator owner.
- [ ] Product docs credit upstream and explain enablement, verification, limitations, and rollback.
- [ ] No unrelated source, personal config, secret, or ignored visual artifact is staged.
- [ ] `plans/README.md` is updated.

## STOP conditions

Stop and report if:

- `896715c` is not an ancestor of the selected base or Plan 075’s Ultraviolet contract is absent.
- The upstream font checksum, size, family, codepoint range, or licence differs from the pinned contract.
- Any PUA frame occupies zero or more than one logical terminal cell in the actual styled-cell/xterm model.
- Enhanced and fallback consumers require separate truthy parsing or duplicated frame constants.
- Supporting RunCat requires installing the upstream Pi extension or creates two indicator owners.
- A correct terminal mapping requires replacing the global base font rather than a PUA-only codepoint map.
- The installer needs sudo/system-wide writes, silently overwrites a mismatched font, or edits personal config.
- `npm pack --dry-run` excludes the font/licence/provenance after a scoped packaging attempt.
- Existing theme indicator output/cadence changes.
- RunCat leaks into any non-Ultraviolet theme.
- Visual evidence shows tofu, two-cell geometry, label jitter, or a non-recognizable cat on either Mac.
- Visual parity can pass only by masking more than the one animation-phase cell, loosening thresholds, or promoting a golden.
- The work expands into persisted indicator selection, cross-terminal setup, broader package allowlisting, or unrelated Ultraviolet redesign.
- A canonical command fails twice after a reasonable scoped correction.

## Risks and mitigations

1. **PUA glyphs render as boxes.**
   Explicit capability gate, vendored verified font, PUA-only Ghostty map, `/sumo:spinner`, and immediate env rollback.
2. **Custom font shifts geometry.**
   Remove upstream trailing spaces, assert one logical cell, preserve fixed-width run CSS, and compare label coordinates.
3. **Classic/retained/RPC drift.**
   One pure resolver owns frames/cadence; every consumer has parity tests.
4. **Third-party binary provenance becomes opaque.**
   Pin commit/hash/size, ship exact licence/source note, verify package contents, and never fetch at runtime.
5. **Installer damages user setup.**
   Per-user destination only, `lstat`/symlink rejection, same-filesystem no-clobber publication, mismatch/race refusal, no config edits, temp-dir tests.
6. **Capability env is mistaken for detection.**
   Docs and command output explicitly call it user-declared; `check` verifies files only.
7. **Visual harness proves bytes but not shape.**
   Map the actual font in deterministic HTML, require PUA cell evidence, and perform live human review on both Macs.
8. **Delight overwhelms the serious Ultraviolet system.**
   RunCat changes one working cell only; colour, label, spacing, chrome, and every application role remain canonical.

## Maintenance notes

- Upstream is 0BSD, but provenance remains part of product trust; keep source commit/hash current if the asset is ever replaced.
- A future enhanced indicator may reuse the generic contract, but do not add variants speculatively.
- If terminal support expands beyond Ghostty, add separately verified setup docs rather than guessing mappings.
- If `SUMOCODE_RUNCAT_FONT` is ever replaced by persisted config, maintain env backward compatibility for at least one release and migrate deliberately.
- If the working-indicator row moves, update classic/retained/RPC tests, the Bible target, phase mask, and both visual scenarios together.
