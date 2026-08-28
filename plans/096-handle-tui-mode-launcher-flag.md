# Plan 096: Mirror Pi option consumption without corrupting the initial prompt

> **Executor instructions**: Follow this plan step by step and run every verification command. Preserve direct-Pi bypass behavior. Mirror the pinned parser's known boolean/value/special/unknown-long-option classes; do not guess extension flag arity. Run the PTY regression and shell syntax check before the full suite. When done, update this plan's row in `plans/README.md` unless a reviewer says they own the index.
>
> **Drift check (run first)**: `git diff --stat b34bd79..HEAD -- bin/sumocode.sh test/integration/spawn-pi-pty.test.ts`
> **Working-tree preflight (run at the same time)**: `git status --short -- bin/sumocode.sh test/integration/spawn-pi-pty.test.ts`. If this reports pre-existing work, STOP and preserve it.
> If commit-range drift changes a Current state parser assumption, STOP and request plan reconciliation.
> **Dependency check**: Confirm every plan named in **Depends on** is `DONE` in `plans/README.md`. If any is not DONE, STOP; do not recreate or assume its APIs.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/issues/092.md` (sanitized public dependency)
- **Category**: bug
- **Milestone**: M1 — Command-ready foundation
- **Planned at**: commit `b34bd79`, 2026-08-28
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/390

## Why this matters

The RPC launcher extracts the first non-flag argument as its kickoff prompt. Pi's value-taking `--tui-mode` option is missing from the launcher's mirrored flag table, so `sumocode --tui-mode regular "prompt"` can submit `regular` as the prompt and misbind the real prompt as the option value.

## Current state

`bin/sumocode.sh:495-524` documents and defines two classes of value-taking Pi flags, but omits `--tui-mode`. The pinned Pi parser gives that flag distinct consumption semantics (`dist/cli/args.js:160-173`):

```js
const mode = args[i + 1];
if (mode === "regular" || mode === "fullscreen") i++;
else if (mode === undefined || mode.startsWith("-")) { /* do not consume */ }
else i++; // consume an invalid non-dash value, including @file
```

This is neither the launcher's unconditional class nor its existing `--print`/`--list-models` class (which refuses to consume `@file`). It needs an explicit mirrored case. The parser also has a generic unknown-`--flag` branch (`args.js:186-196`) that consumes one following non-dash/non-`@` value; this is how extension flags reach Pi. Mirroring that branch safely requires first recognizing Pi's known boolean flags, or a boolean such as `--offline` would wrongly consume the real prompt. Pi also treats `@file` as a file argument, never a positional prompt. `test/integration/spawn-pi-pty.test.ts` already owns launcher dry-run and PTY helper regressions.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Shell syntax | `bash -n bin/sumocode.sh` | exit 0 |
| Launcher test | `pnpm vitest run test/integration/spawn-pi-pty.test.ts` | all pass |
| Integration | `pnpm test:integration` | exit 0 |
| Full gates | `pnpm exec tsc --noEmit && pnpm build && pnpm lint && pnpm test` | exit 0 |

## Scope

**In scope**:
- `bin/sumocode.sh`
- `test/integration/spawn-pi-pty.test.ts`

**Out of scope**:
- General launcher parser rewrites.
- Changing Pi's option semantics.
- Readiness or prompt transport changes (Plans 094 and 097).

## Git workflow

- Branch: `advisor/096-handle-tui-mode-launcher-flag`
- Commit: `fix(launcher): preserve prompt after tui-mode`

- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add a failing RPC-TTY regression

Use a PTY so the launcher selects its RPC path. Run `bin/sumocode.sh --dry-run --tui-mode regular "review the diff"` with a fake `PI_BIN`. Assert:
- forwarded args contain `--tui-mode regular`;
- the extracted initial prompt is the real positional prompt (or its redacted marker after Plan 097);
- `regular` is never reported as the initial prompt.

Also cover `--tui-mode=regular`, missing value, a following flag (not consumed), an invalid plain value (consumed by Pi), an `@file` mode value (consumed as invalid by Pi), standalone `@file` (kept as a Pi file arg), known boolean `--offline` followed by the prompt, unknown `--extension-flag value` followed by the prompt, unknown boolean-style `--extension-flag` followed by another flag, `--print` with `---text`, and `--list-models` special handling.

Assert the literal dry-run prompt value under current behavior; Plan 097 will replace that assertion with a redacted presence/length assertion.

**Verify**: `pnpm vitest run test/integration/spawn-pi-pty.test.ts -t "mirrors Pi option consumption"` → expected red before implementation, failing on the `--tui-mode` and unknown-value/file-arg cases rather than fixture setup.

### Step 2: Mirror every pinned parser consumption class

Keep explicit, documented classes in `extract_first_positional()`:
1. known unconditional value flags;
2. known boolean flags (`--help/-h`, `--version/-v`, `--continue/-c`, `--resume/-r`, `--no-session`, `--no-tools/-nt`, `--no-builtin-tools/-nbt`, `--no-extensions/-ne`, `--no-skills/-ns`, `--no-prompt-templates/-np`, `--no-themes`, `--no-context-files/-nc`, `--verbose`, `--approve/-a`, `--no-approve/-na`, `--offline`);
3. dedicated `--print/-p`, `--list-models`, and `--tui-mode` branches matching their distinct lookahead rules exactly, including Pi's `---` print-message exception;
4. standalone `@file` tokens, which are kept and never extracted;
5. unknown `--flag`: keep it and consume one following value only when Pi's generic branch would (non-empty, not `-`-prefixed, not `@`-prefixed);
6. plain positional prompt extraction.

`--flag=value` remains one token. Do not infer extension flag schemas beyond Pi's generic behavior. Re-read the complete pinned `parseArgs()` during implementation; if a class cannot be mirrored without changing direct-Pi routing, STOP and report.

**Verify**: `bash -n bin/sumocode.sh && pnpm vitest run test/integration/spawn-pi-pty.test.ts -t "mirrors Pi option consumption"` → exit 0 for every table row.

### Step 3: Run full gates

**Verify**: all commands in the command table exit 0.

## Test plan

Cover space form, equals form, missing value, flags before/after the positional, direct `--mode` bypass, and `--print` bypass. Existing non-TTY dry-run tests remain green.

## Done criteria

- [ ] `--tui-mode regular "prompt"` extracts only `prompt`.
- [ ] `--tui-mode=regular "prompt"` remains correct.
- [ ] Missing/following-flag/invalid/`@file` consumption matches the pinned Pi parser exactly.
- [ ] Direct-Pi bypass behavior is unchanged.
- [ ] Known booleans, standalone `@file`, special print/list modes, and unknown long-option values match pinned Pi consumption.
- [ ] Shell syntax, targeted tests, typecheck/build, lint, unit, and full integration tests pass.
- [ ] `git status --short` contains only files listed in Scope plus this plan/index bookkeeping.
- [ ] Plan 096's `plans/README.md` row is updated to `DONE` with completion evidence.

## STOP conditions

- Commit-range/working-tree preflight changes a parser assumption, any verification fails twice after a reasonable fix, or completion requires an out-of-scope file.
- The pinned Pi parser changes one of the mirrored consumption classes.
- Fixing the case requires changing RPC/direct mode selection.
- A parser class cannot be mirrored without guessing extension-defined semantics beyond Pi's generic unknown-flag rule.

## Maintenance notes

Every Pi bump must diff the launcher's mirrored table against Pi's parser. Plan 101 adds that compatibility check to the supported-version matrix.
