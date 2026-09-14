# Evidence

How to prove a change works in this repository. Agents read this before writing a PR body; a PR claim without a capture from this document is not evidence. Design docs (`docs/ui/bible`), goldens (`docs/visual/parity/approved-runtime`), and the parity gate (`docs/visual/parity/CONTRACT.md`) are separate: capturing evidence never approves a golden.

## Surfaces

| Surface | Path | Launch | Drive (tier) | Capture |
| --- | --- | --- | --- | --- |
| Retained TUI (RPC host) | `bin/sumocode.sh`, `sumo-rpc-host.js`, `src/sumo-tui/` | `pnpm dev .` | harness: V2 visual lanes (`docs/visual/parity/scenarios.json`) and PTY integration (`test/integration/`) | `runtime-full.png` + `styled-cell-diff.txt` + `geometry-audit.txt` per scenario |
| Completed / overlay states | `src/sumo-tui/` via `TranscriptViewModel` fixtures | none (no Pi spawned) | harness: `fixture` lane | same pipeline, `fixture-*` scenarios |
| Isolated components | `src/cathedral/`, `src/sumo-tui/cathedral/` | none | harness: `component` lane | same pipeline, `*-component` scenarios |
| CLI launcher | `bin/sumocode.sh`, `src/cli/` | `./bin/sumocode.sh <subcommand>` | manual: run the command | transcript `.txt` |
| Classic Pi extension (non-TTY / `--print` / `--mode rpc`) | `src/extension.ts`, `src/commands/` | `pi -e . --print "<prompt>"` | manual: run the command | transcript `.txt` |
| Runtime diagnostics | `SUMO_TUI_DIAG_FILE` JSONL | `./bin/sumocode.sh -d .` | manual: reproduce the interaction in the TUI | `sumocode diag` summary `.txt` |
| Visual Bible (design targets) | `docs/ui/bible/*.html` | `pnpm render:bible` | harness | rendered `docs/ui/bible/renders/<target>.png` copied to `.evidence/` (renders are gitignored) |

## Launch

### Retained TUI

```bash
pnpm install
pnpm dev .                    # interactive; RPC host, TTY required
./bin/sumocode.sh --dry-run . # prints PI_BIN / ROOT_DIR / exec line without launching
./bin/sumocode.sh doctor      # up when Pi binary, RPC host, diag path all ✓ ("stdout is not a TTY" is expected when piped)
```

Runtime visual scenarios launch it for you as `./bin/sumocode.sh --offline --no-extensions --no-session` under node-pty with an isolated `PI_CODING_AGENT_DIR`; no API key needed. Active runtime scenarios use the local faux provider `scripts/visual-v2/runtime-faux-provider.mjs`.

### Visual harness prerequisites

```bash
pnpm render:bible   # required once per checkout before any visual:* command (scenarios assert Bible PNGs exist)
```

Needs a Chromium Playwright can launch. If `browserType.launch: Executable doesn't exist`, run `pnpm exec playwright install chromium` or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to a local Chrome as CI does.

### Classic Pi extension

```bash
pi -e . --print "reply with the single word ready"   # needs a configured Pi provider key by its usual env name
```

## Capture recipes

Capture files go under `.evidence/` (git-ignored). Name files `NN-<criterion-slug>-<BEFORE|AFTER>.<ext>` as in `docs/visual/evidence/557-hint-row/`.

### Retained TUI / fixture / component (one recipe, three lanes)

```bash
pnpm visual:review -- --scenario <id>      # e.g. active-landscape-runtime, fixture-tool-ledger-landscape, footer-ready-component
pnpm visual:review -- --lane runtime       # or fixture / component
cat docs/visual/out/parity/<id>/raw/styled-cell-diff.txt   # read first
cat docs/visual/out/parity/<id>/raw/geometry-audit.txt
mkdir -p .evidence
cp docs/visual/out/parity/<id>/runtime-full.png              .evidence/01-<slug>-AFTER.png
cp docs/visual/out/parity/<id>/crops/<crop>-bible-diff.png   .evidence/02-<slug>-bible-diff-AFTER.png
cp docs/visual/out/parity/<id>/raw/styled-cell-diff.txt      .evidence/03-<slug>-styled-cell-diff-AFTER.txt
```

Before/after: run the same scenario on the base commit (`git worktree add /tmp/sumocode-base <base-sha>`, `pnpm install`, `pnpm render:bible`, `pnpm visual:review -- --scenario <id>` there) and copy with `-BEFORE`. Side by side:

```bash
ffmpeg -i .evidence/01-<slug>-BEFORE.png -i .evidence/01-<slug>-AFTER.png -filter_complex hstack .evidence/01-<slug>-compare.png
```

No scenario covers the change? Add one to `docs/visual/parity/scenarios.json` in the right lane (fixture for completed/tool/overlay states, runtime for live startup/typing) in the same PR. Review-only crops are fine; never mark `required` without an approved golden.

Behaviour that is not visual (signals, cursor, scroll, slash dispatch): the PTY integration test is the harness. Capture its transcript:

```bash
{ echo '$ pnpm vitest run test/integration/<file>.test.ts'; pnpm vitest run test/integration/<file>.test.ts; echo "exit=$?"; } 2>&1 | tee .evidence/04-<slug>-integration.txt
```

### CLI launcher

```bash
{ echo '$ ./bin/sumocode.sh doctor'; ./bin/sumocode.sh doctor; echo "exit=$?"; } 2>&1 | tee .evidence/05-<slug>-doctor.txt
{ echo '$ ./bin/sumocode.sh --dry-run .'; ./bin/sumocode.sh --dry-run .; echo "exit=$?"; } 2>&1 | tee .evidence/06-<slug>-dry-run.txt
```

`--dry-run` is the proof for launcher routing changes (`--print`, `--mode`, `--no-sumo-tui`, non-TTY stdout).

### Classic Pi extension

```bash
{ echo '$ pi -e . --print "<prompt>"'; pi -e . --print "<prompt>"; echo "exit=$?"; } 2>&1 | tee .evidence/07-<slug>-print.txt
```

### Runtime diagnostics

```bash
./bin/sumocode.sh -d --diag-file /tmp/sumocode-<slug>.jsonl .   # reproduce the interaction, then quit
./bin/sumocode.sh diag /tmp/sumocode-<slug>.jsonl | tee .evidence/08-<slug>-diag.txt
```

Use this for input-recovery, resize, paste, and signal work where the JSONL trace is the observable.

### Visual Bible

`docs/ui/bible/renders/` is gitignored; never commit under it. The committed `docs/ui/bible/*.html` diff is the source change; the rendered PNG is the evidence:

```bash
pnpm render:bible
cp docs/ui/bible/renders/<target>.png .evidence/09-<slug>-bible-AFTER.png
```

CI's `visual-bible` workflow also uploads every render as the `cathedral-visual-bible-static` artifact; link that run when a local Chromium is unavailable.

## Publish

Repo convention (see `evidence/557-hint-row`): a branch `evidence/<pr>-<slug>` cut from `main` with files under `docs/visual/evidence/<pr>-<slug>/`, pushed to `origin`. Never merge it.

```bash
git fetch origin main
git worktree add /tmp/sumocode-evidence origin/main -b evidence/<pr>-<slug>
mkdir -p /tmp/sumocode-evidence/docs/visual/evidence/<pr>-<slug>
cp .evidence/* /tmp/sumocode-evidence/docs/visual/evidence/<pr>-<slug>/
git -C /tmp/sumocode-evidence add docs/visual/evidence && git -C /tmp/sumocode-evidence commit -m "docs(visual): attach <slug> evidence for PR #<pr>"
git -C /tmp/sumocode-evidence push -u origin evidence/<pr>-<slug>
```

PR body link form (renders inline for PNG):

```md
![after](https://raw.githubusercontent.com/dhruvkelawala/sumocode/evidence/<pr>-<slug>/docs/visual/evidence/<pr>-<slug>/01-<slug>-AFTER.png)
captured at <HEAD sha>
```

Text files: link `https://github.com/dhruvkelawala/sumocode/blob/evidence/<pr>-<slug>/docs/visual/evidence/<pr>-<slug>/<file>`.

## Exemptions

- Native release archive (`pnpm build:native`, `pnpm test:native`): distribution contract, proven by `test/integration/native-contract.test.ts` transcript; no separate UI capture.
- Pure test/type/tooling changes with no runtime behaviour: cite the verification commands from AGENTS.md instead.

## Per-change checklist

1. Launch the surface the change touches (`pnpm render:bible` first for any visual lane).
2. Drive the exact behaviour each acceptance criterion names, using the surface's recorded tier, before and after when the change alters existing behaviour. Always against a local build at HEAD.
3. Capture: still for a state, recording for a flow, transcript for a CLI or API, side by side for before/after. Read `styled-cell-diff.txt` and `geometry-audit.txt` before trusting a PNG.
4. Publish to `evidence/<pr>-<slug>` and link from the PR's Evidence section with the HEAD SHA the capture came from. Golden promotion (`pnpm visual:promote`) stays a separate, Dhruv-approved step.
