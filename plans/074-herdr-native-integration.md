# Plan 074: Herdr-native integration — approval attention queue + native worktree workspaces

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 4e80e66..HEAD -- src/terminal-host/ src/commands/worktree.ts src/approval-modal.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plan 072 (DONE — `src/terminal-host/` facade landed, PR #313)
- **Category**: direction
- **Planned at**: commit `4e80e66`, 2026-07-18
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/316

## Why this matters

The operator's primary terminal host is now herdr, and plans 071–073 landed
the facade, worktree UX, and theme. The herdr capability research
(`docs/research/HERDR_CAPABILITIES_2026.md` — read its Addendum before
starting) surfaced two herdr-native integrations the landed code does not
use yet:

1. **Approval → attention queue.** Herdr's installed Pi integration exposes a
   documented, ref-counted event hook — `pi.events.emit("herdr:blocked",
   { active, label? })` — that flips the pane's agent state to `blocked`.
   SumoCode's dangerous-command approval modal doesn't emit it, so a pane
   waiting on approval looks `working` in herdr's sidebar instead of jumping
   the priority attention queue.
2. **Native worktree workspaces.** `/sumo:worktree` opens generic splits on
   every host. Under herdr, `herdr worktree create/open --branch/--base/
   --path/--label` produces a first-class labeled **workspace** per worktree
   (sidebar entry, per-workspace agent roll-up) while explicit `--branch`/
   `--path` flags let SumoCode keep its `sumo/<slug>` + sibling-dir
   conventions.

Both are small, additive, and guarded on `host.kind === "herdr"`; cmux
behavior is untouched.

## Current state

- `src/terminal-host/types.ts` (lines 1–22) — the landed facade:

  ```ts
  export interface TerminalHost {
      readonly kind: TerminalHostKind;
      openCommandInSplit(pi, direction, { cwd, shellCommand }): Promise<HostResult<{ pane: PaneRef }>>;
      replaceCurrentPane?(...); closePane(...); notify(...); focusPane?(...);
  }
  ```

  `PaneRef = { host: "cmux" | "herdr"; paneId: string; workspaceId?: string }`.
- `src/terminal-host/herdr.ts` — herdr impl over the JSON CLI envelope
  (`{"id","result":{...}}`); read it for the exec/parse helpers to reuse.
- `src/commands/worktree.ts` — landed 071 grammar
  (`fresh | reopen | delegate | prune`, `--base`); all three open modes call
  `terminalHost.openCommandInSplit(...)` (lines ~188 and ~213) with commands
  built by `commandForFreshWorktree`/`commandForWorktree` (lines ~75–90);
  worktree creation stays in `src/git/worktree.ts` (`createWorktree`,
  `resolveCreateOptions` — `sumo/<slug>` branch + sibling
  `<repo>.sumo-worktrees/` path).
- `src/approval-modal.ts` — `showApprovalModal` (line ~293) and
  `showRpcApprovalPrompt` (line ~273) are the two prompt paths;
  `installApprovalGate` wires them. All exits normalize to a choice
  (`normalizeApprovalChoice`, line ~258).
- Herdr hook contract (verified in
  `~/.pi/agent/extensions/herdr-agent-state.ts`, integration v5): listens on
  `pi.events.on("herdr:blocked", ({ active, label }) => …)`; blocked signals
  are ref-counted (`blockedCount`), so paired emit(true)/emit(false) is
  mandatory; the integration no-ops unless `HERDR_ENV=1` +
  `HERDR_SOCKET_PATH` + `HERDR_PANE_ID`.
- Herdr worktree CLI (verified against v0.7.0, running server):
  - `herdr worktree create [--workspace ID | --cwd PATH] [--branch NAME]
    [--base REF] [--path PATH] [--label TEXT] [--focus] [--json]`
  - `herdr worktree open [--workspace ID | --cwd PATH] (--path PATH |
    --branch NAME) [--label TEXT] [--focus] [--json]`
  - `herdr worktree list [--json]` — reports externally-created worktrees
    (`branch`, `path`, `is_linked_worktree`, `open_workspace_id`)
  - `herdr pane list [--workspace ID]` — JSON with `pane_id`/`workspace_id`
  - `herdr pane run <pane_id> <command>` — command text + Enter
- Conventions: tabs, strict TS, typed `HostResult`, colocated vitest tests
  with injected exec fns (see `src/terminal-host/herdr.test.ts`).

## Commands you will need

| Purpose   | Command                                              | Expected on success |
|-----------|------------------------------------------------------|---------------------|
| Typecheck | `pnpm typecheck`                                     | exit 0              |
| All tests | `pnpm test`                                          | all pass            |
| One file  | `pnpm vitest run src/terminal-host/herdr.test.ts`    | all pass            |

## Scope

**In scope**:
- `src/approval-modal.ts` (additive `herdr:blocked` emission)
- `src/approval-modal.test.ts` (extend)
- `src/terminal-host/types.ts`, `herdr.ts`, `herdr.test.ts` (optional
  `openWorktreeWorkspace` capability)
- `src/commands/worktree.ts` + `worktree.test.ts` (herdr-native path)

**Out of scope**:
- cmux implementation — zero changes; its fixtures must pass unmodified.
- `src/git/worktree.ts` — conventions stay the single source of truth.
- The `pane report-metadata --custom-status` mirror for headless subagent
  counts — recorded in plan 068's maintenance notes; belongs there.
- Any bg_task/orchestration surface (plans 065–070).
- Worktree removal via herdr (`worktree remove`) — SumoCode's
  never-auto-remove rule stands; `prune` keeps using `src/git/worktree.ts`.

## Git workflow

- Branch: `advisor/074-herdr-native-integration`
- Conventional commits, e.g. `feat(approval): surface pending approvals in herdr attention queue`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Approval gate → `herdr:blocked`

In `src/approval-modal.ts`, wrap BOTH prompt paths (`showApprovalModal`,
`showRpcApprovalPrompt`) with a paired emission:

```ts
const herdrBlocked = (pi: ExtensionAPI, active: boolean) => {
    if (detectTerminalHost() !== "herdr") return;
    try { pi.events.emit("herdr:blocked", active ? { active, label: "approval" } : { active }); } catch { /* never break approvals */ }
};
```

Emit `true` immediately before showing the prompt and `false` in a `finally`
so every exit path (yes/no/always, cancel, timeout, thrown error, missing UI)
releases the ref-count exactly once. Do not touch the approval decision
logic — AGENTS.md/audit history requires the gate to stay fail-closed.

**Verify**: `pnpm vitest run src/approval-modal.test.ts` → new tests: a spy
`pi.events.emit` sees exactly one `{active:true}` and one `{active:false}`
per prompt for approve, deny, and abnormal-exit paths; zero emissions when
the detected host is not herdr.

### Step 2: `openWorktreeWorkspace` capability on the herdr host

Add to `TerminalHost` (optional method, herdr-only):

```ts
openWorktreeWorkspace?(pi: PiExecLike, options: {
    branch: string; baseRef: string; path: string; label: string; shellCommand: string;
}): Promise<HostResult<{ pane: PaneRef }>>;
```

Herdr implementation: `herdr worktree create --branch <branch> --base
<baseRef> --path <path> --label <label> --focus --json` → parse the JSON for
the created workspace id (recon the exact field names from the live output;
STOP if no workspace id is returned) → `herdr pane list --workspace <id>` →
take the single pane's `pane_id` → `herdr pane run <paneId> <shellCommand>`
→ return the `PaneRef`. For an ALREADY-EXISTING worktree add a sibling
`openExistingWorktreeWorkspace?` using `herdr worktree open --path <path>
--focus --json` with the same pane lookup + run.

**Verify**: `pnpm vitest run src/terminal-host/herdr.test.ts` → fake-exec
tests for arg construction, JSON parse, pane lookup, and error paths
(create refuses `--path`, empty pane list).

### Step 3: Use it in `/sumo:worktree`

In `src/commands/worktree.ts`, for `fresh` and `delegate` modes: after
`resolveCreateOptions` yields `{ branch, baseRef, path }`, if
`terminalHost.openWorktreeWorkspace` exists, call it with the mode's
existing `paneCommand` INSTEAD OF `createWorktree` + `openCommandInSplit`
(herdr runs the `git worktree add` itself; on `{ok:false}` fall back to the
existing `createWorktree` + generic-split path and notify which path was
used). For `reopen` mode: prefer `openExistingWorktreeWorkspace` when
present, same fallback. Success notify becomes
`` opened <branch> as herdr workspace "<label>" · setup: … ``.

**Verify**: `pnpm vitest run src/commands/worktree.test.ts` → new cases:
herdr host with native capability uses it (no `createWorktree` call for
fresh); native failure falls back to generic split; cmux host behavior
byte-identical (existing tests unmodified).

### Step 4: Live smoke + full check

In a real herdr session: `/sumo:worktree new smoke-074` → a labeled
workspace appears in herdr's sidebar with a SumoCode session on branch
`sumo/smoke-074` at the conventional sibling path; trigger a dangerous
command → the pane flips to `blocked` in the sidebar while the approval
modal is open and clears after deny. Capture both observations in the
commit/PR body. Clean up: `/sumo:worktree prune sumo/smoke-074`.

**Verify**: `pnpm typecheck && pnpm test` → exit 0, all pass.

## Test plan

- `approval-modal.test.ts`: paired-emission invariants across all exit paths
  + non-herdr no-op (Step 1).
- `herdr.test.ts`: native worktree capability happy/error paths (Step 2).
- `worktree.test.ts`: native-vs-fallback routing per host (Step 3).
- Exemplars: existing fake-exec harnesses in `src/terminal-host/*.test.ts`,
  fake-collaborator harness in `src/commands/worktree.test.ts`.

## Done criteria

- [ ] `pnpm typecheck` exits 0; `pnpm test` exits 0
- [ ] Paired `herdr:blocked` emission proven for every approval exit path
- [ ] Fresh/reopen under herdr produce labeled workspaces with `sumo/<slug>`
      branches at `<repo>.sumo-worktrees/` paths (live smoke evidence)
- [ ] Native failure falls back to the generic split (test-proven)
- [ ] cmux fixtures pass unmodified; approval decision logic untouched
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- `herdr worktree create --json` output contains no machine-readable
  workspace id, or refuses/ignores explicit `--path` — report the observed
  JSON; do not adopt `~/.herdr/worktrees` layout for SumoCode worktrees.
- The installed Pi integration's `herdr:blocked` contract differs from the
  Current state description (re-read `~/.pi/agent/extensions/herdr-agent-state.ts`).
- Pairing the emission requires restructuring approval control flow (the
  fail-closed gate must not change shape).
- `pane run` visibly mangles the session launch command (splash swallowed,
  wrong cwd) in the live smoke.

## Maintenance notes

- Herdr integrations are version-managed files (`HERDR_INTEGRATION_VERSION`);
  a herdr update can change the hook contract — the emission helper is one
  place to fix.
- When plan 068 lands, its footer/manager state is the natural second
  `herdr:blocked` emitter (label `"subagents"`) and the home for the
  `report-metadata --custom-status` mirror — both recorded there.
- If herdr ships `worktree remove --json` semantics SumoCode wants for
  `prune`, revisit only with the never-auto-remove rule intact.
