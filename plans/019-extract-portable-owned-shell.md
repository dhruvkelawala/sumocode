# Plan 019: Extract a backend-neutral retained shell

> **Executor instructions:** Keep behavior identical for the current in-process
> retained TUI while moving ownership boundaries. Do not start RPC rewiring until
> the existing retained path still passes its tests.
>
> **Drift check (run first):**
> `git diff --stat main...HEAD -- src/sumo-tui/pi-compat src/sumo-tui/rpc src/sidebar.ts src/top-chrome.ts`

## Status

- **Priority:** P0
- **Effort:** L
- **Risk:** HIGH
- **Depends on:** 018
- **Category:** architecture
- **Planned at:** `a3966a7`, 2026-07-02
- **Review verdict:** DONE in executor commit `3d611f3`; reviewer verified focused shell/editor
  tests, integration, typecheck/build, clean autoreview, and visual reports retaining only the
  known Plan 018 active-runtime duplicate-shell failures that Plan 020 owns.

## Why this matters

The good TUI is already in `OwnedShellRenderer`; it is just tied to Pi internal
container names and the old in-process runtime wrapper. Extract it into a shared
shell package so Pi in-process and Pi RPC can both feed the same renderer.

> **Decided (Dhruv, 2026-07-02): main-as-reference, single live backend.**
> On this no-seam branch the in-process retained consumer of
> `OwnedShellRenderer` was removed (plan 014, `65f70c0`) — it is live only on
> `main`. Do NOT maintain a live in-process adapter here; that would partially
> re-create what 014 removed. Extract the shell from the code, use main's
> behavior (via Plan 018's baseline comparator) as the correctness reference,
> and keep the Pi adapter **compiling and unit/contract-tested only**. RPC is
> the sole live consumer of the shared shell on this branch. Step 3's proof is
> therefore unit/contract tests, not a live runtime. If executing this plan
> seems to require a running in-process retained mode, that is a STOP
> condition, not a green light to resurrect the seam.

## Scope

**In scope:**

- `src/sumo-tui/pi-compat/owned-shell-renderer.ts`
- new shared shell modules under `src/sumo-tui/shell/`
- thin Pi adapter modules under `src/sumo-tui/pi-compat/`
- owned-shell unit tests

**Out of scope:**

- Changing the RPC runtime to use the shell. That is Plan 020.
- Changing visual design, spacing, colors, or copy.
- Reintroducing a legacy runtime fallback.

## Steps

### Step 1: Define shared shell contracts

Create backend-neutral interfaces for:

- terminal dimensions and `TerminalSessionOwner`,
- chat node and splash node ownership,
- header/top chrome component provider,
- editor component provider,
- above-editor/below-editor widget providers,
- footer provider,
- sidebar publication provider,
- overlay host,
- selection pass.

Name them from the product domain, not from Pi. The Pi-specific adapter can
still live in `pi-compat`.

### Step 2: Move product layout without changing behavior

Move or wrap `OwnedShellRenderer` into `src/sumo-tui/shell/` so its constructor
depends on the shared contracts. Keep a compatibility export from the old path
if needed for a short transition.

Do not rewrite its layout logic. Preserve:

- splash/active switching,
- centered splash input width,
- top chrome gap behavior,
- sidebar Yoga sibling reservation,
- above-editor working indicator rows,
- pending message painting,
- footer pinning,
- overlay composition,
- hardware cursor extraction and propagation.

### Step 3: Keep the Pi adapter compiling and contract-tested (reference-only)

Update the existing Pi adapter code to build the new shell contracts from Pi's
containers so it typechecks and its unit/contract tests pass. This adapter may
still inspect Pi internals, but the shell itself must not. Per the decided
scope above, do not stand up a live in-process runtime to exercise it — the
adapter is kept as reference/portability insurance, and RPC (Plan 020) is the
live consumer.

### Step 4: Add contract tests

Extend owned-shell tests to assert:

- same row categories before and after extraction,
- same hardware cursor propagation,
- sidebar remains a structural sibling of chat,
- splash input remains centered,
- active input is full width,
- overlays hide the editor hardware cursor.

## Verification

```bash
pnpm vitest run src/sumo-tui/pi-compat/owned-shell-renderer.test.ts
pnpm vitest run src/sumo-tui/widgets/pi-editor-leaf.ts src/sumo-tui/widgets/pi-editor-leaf.test.ts
pnpm test:integration
pnpm exec tsc --noEmit && pnpm build
```

Reviewer-side visual check:

```bash
pnpm render:bible
pnpm visual:ci
```

At this stage `visual:ci` is allowed to retain the known active-runtime duplicate-shell failures
recorded by Plan 018, because Plan 020 is the first plan that wires RPC to the portable shell.
Plan 019 passes the visual check only if any active runtime failures match the Plan 018
top/input/footer blankness signature and no tracked visual assets change.

## Done criteria

- [ ] Shared shell contracts exist outside `rpc/`.
- [ ] Shared shell contracts do not export Pi-specific public API types; any Pi TUI type adaptation
  stays in `pi-compat` or private implementation casts.
- [ ] The canonical shell layout logic is not duplicated.
- [ ] Pi in-process adapter compiles and its unit/contract tests pass
  (reference-only — no live in-process runtime is stood up).
- [ ] Owned-shell, editor-leaf, integration, and typecheck/build gates pass.
- [ ] Reviewer visual check confirms no Plan-019-specific runtime regression; full active runtime
  parity remains Plan 020/024 work.

## STOP conditions

- The extraction requires changing visible layout to keep tests green.
- Hardware cursor behavior changes.
- Sidebar becomes an overlay again instead of a reserved shell sibling.
