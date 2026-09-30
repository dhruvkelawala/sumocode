---
name: verify-sumocode
description: Launch and drive SumoCode's retained RPC terminal UI in an isolated PTY, health-check the owned instance, and capture user actions and screens. Use when proving slash commands, overlays, keybindings, or theme selectors. Use /verify for repository checks and EVIDENCE.md for PR proof and publishing.
---

# Verify SumoCode

Run from the source checkout root. Read [AGENTS.md](../../../AGENTS.md), [DEV_LOOP.md](../../../DEV_LOOP.md), and [EVIDENCE.md](../../../EVIDENCE.md) first. Read [the feature index](features/README.md) before picking a drive. This skill covers the retained RPC host, not the classic extension or native release archive.

Pi 0.87.1 accepts this skill's frontmatter but does not auto-scan `.agents/skills/` in its actual loader. Load it explicitly with `node_modules/.bin/pi --skill "$PWD/.agents/skills/verify-sumocode"`, then `/skill:verify-sumocode`, or read this file directly in an existing session. The helper also passes that absolute `--skill` path; no user settings or legacy skill-directory copies are needed.

## Launch

Use Node >=23.11 and the locked Pi peer (currently 0.87.1). `pnpm install --frozen-lockfile` is the documented setup; CI uses pnpm 10.29.2. Check `package.json` for current versions. On pnpm 12, ignored dependency builds can fail installation after packages have been materialized. Do not auto-approve scripts or reinstall/remove an existing dependency tree. Report the install failure; continue only after native loading, typecheck, and an actual PTY launch succeed. A fresh checkout without working dependencies is blocked.

```bash
node --input-type=module -e 'import pty from "node-pty"; console.log(typeof pty.spawn)'
pnpm exec tsc --noEmit
PI_BIN="$PWD/node_modules/.bin/pi" ./bin/sumocode.sh doctor
pnpm test:integration:preflight
```

The helper uses the existing `test/integration/spawn-pi-pty.ts` harness. Each test owns a fresh 100×30 PTY of this checkout's `bin/sumocode.sh --offline --no-extensions --no-session --approve --skill "$PWD/.agents/skills/verify-sumocode"`, with local `PI_BIN` and forced host/extension source fallback. Its cwd and explicit `PI_CODING_AGENT_DIR` are private OS-temporary directories. No user config, credentials, installed extension, provider mock, or LLM request is needed. Project approval applies only to this isolated scratch cwd, not an arbitrary user project.

Run one palette feature proof (both known entry points):

```bash
pnpm vitest run --config .agents/skills/verify-sumocode/scripts/vitest.config.mjs -t palette
```

This command launches, doctors, drives, captures, and cleans up. Require **2 passed** and the final zero-survivor audit. A zero-test or all-skipped run is not a proof. Ambient `PI_BIN` may resolve an installed native archive: the helper pins the checkout's Pi explicitly. Readiness is the owned instance's `stable_chrome_ready` diagnostic plus the replayed `DIVINE INVOCATION` screen, not a fixed delay.

## Doctor

Launcher `doctor` above checks prerequisites only. The helper's instance doctor is read-only: `app.waitForReady("app")`, active alternate screen, and `waitForScreenText(app, "DIVINE INVOCATION")` before sending input. Harness registration records executable argv, PID/process group, process start identity, and isolated diagnostic path. Evidence's `action.json` records source HEAD, local launcher/Pi paths, and scratch profile.

On surprise, capture and tear down that owned instance, then relaunch a fresh drive. Process health does not establish UI readiness. Never attach to the user's running SumoCode. Run preflight without `--fix` or `--purge-evidence`; repository rules reserve destructive cleanup for explicit approval.

## Drive

The executable helper files are loaded through Vitest, not invoked as standalone TypeScript:

```bash
pnpm vitest list --config .agents/skills/verify-sumocode/scripts/vitest.config.mjs
pnpm vitest run --config .agents/skills/verify-sumocode/scripts/vitest.config.mjs
```

The second command runs all six implemented entry-point recipes serially. To select one use `-t palette-key`, `-t palette-slash`, `-t hotkeys-slash`, `-t theme-slash`, `-t theme-sumo-slash`, or `-t settings-slash`. Check the named test actually passed.

Inputs are real PTY bytes. Ctrl+/ is `\u001f`; command submission uses Kitty Enter `\x1b[13u`. The harness waits for two consecutive matching **replayed screens**. Rendered selector titles are uppercase even when handler strings are sentence case. Raw ANSI substring matching is unsafe for visible text split across repaints.

The helper proves opening a surface, not changing every setting/theme or exercising every palette destination. See feature files for entry points and explicit coverage gaps. Use a new owned PTY for each extension of a recipe; after failure, never keep driving an unknown UI state.

## Evidence

Each drive creates `.evidence/verify-sumocode-<entry>-<unique>/` (git-ignored): `action.json`, `before.txt`, `after.txt` on success, `raw-output.txt`, `argv.txt`, `diagnostics.jsonl`, `final-screen.txt`, and `cleanup.json`. The action record and raw PTY stream preserve input intent and observed output; before/after text snapshots show the visible state. These are behaviour transcripts, not pixel-level visual/golden approval.

Capture occurs before teardown and is copied out of the harness namespace. Success asserts nonempty proof files **after** cleanup. On failure, captures and scratch remain for diagnosis; missing `after.txt` is not success. Report the printed path or inspect `.evidence/verify-sumocode-*`. The revision in `action.json` is the executed source revision; an uncommitted helper is a local recipe until committed and re-run.

For mutations, extend proof with a second user view and read-only inspection of the isolated persisted value. Never use internal setters as the drive. This pilot uses no provider fixture and performs no mutation, network request, push, publish, or golden promotion. Follow [EVIDENCE.md](../../../EVIDENCE.md) for PR capture standards and publication only when authorized.

## Cleanup

The helper's nested `finally` captures even failed drives and calls `app.cleanupAndWait()` even if capture fails. The existing supervisor identity-checks and terminates only its recorded process group. `cleanup.json` must show alternate screen and mouse SGR off, cursor visible; Vitest's final focused harness audit must report **0 survivors**. An audit failure blocks completion even if the feature assertion passed.

An explicit agent directory prevents automatic deletion of agent state on PTY exit. Capturing through the harness marks its evidence namespace retained, so the focused audit preserves it too. Scratch and evidence remain; do not remove files, branches, or worktrees under AGENTS.md without permission. No process created by this run should remain alive. Confirm the reported evidence files still exist and are nonempty after the audit.
