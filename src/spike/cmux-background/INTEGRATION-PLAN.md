# Integration plan: `@sumocode/pi-background-cmux`

Follow-on implementation plan after spike approval. This spike does **not** implement the fork — it validates the cmux adapter and documents the seam.

## Phase 0 — Spike (this PR)

- [x] Research matrix (pi-subagents, pi-cmux, opencode-cmux, pi-background-tasks)
- [x] Portable `cmux-adapter.ts` + tests
- [x] `visible-spawn.ts` wrapper builder + tests
- [x] Visual explainer HTML

## Phase 1 — Fork package (estimated 2–3 days)

1. Vendor or fork `vanillagreencom/vstack/pi-extensions/pi-background-tasks` into `packages/pi-background-cmux/` (or private sumocode-config extension path — prefer **public sumocode repo** under `packages/` if we want MIT propagation).

2. Add settings schema:

```json
{
  "cmux": {
    "enabled": true,
    "defaultVisible": false,
    "direction": "right",
    "focusSplit": false,
    "closeSurfaceOnExit": false,
    "statusKey": "sumocode-bg",
    "notifyOnComplete": true
  }
}
```

3. Extend `SpawnTaskOptions`:

```typescript
interface SpawnTaskOptions {
  // existing fields…
  visible?: boolean;
  cmuxDirection?: "right" | "down";
  cmuxFocus?: boolean;
}
```

4. Extend `ManagedTask` / snapshot:

```typescript
interface ManagedTask {
  // existing…
  cmux?: {
    workspaceRef: string;
    surfaceRef: string;
    mode: "visible" | "invisible";
  };
}
```

5. Branch `spawnTask()`:

```typescript
if (options.visible && cmuxSettings.enabled && isInCmux()) {
  return spawnVisibleTask(options); // cmux split + log tail watcher
}
return spawnInvisibleTask(options); // current spawn path unchanged
```

6. `spawnVisibleTask` flow:

   - Build paths via `buildVisibleTaskPaths(taskId, startedAt)`
   - Build command via `buildVisibleTaskCommand({ cwd, command, logFile, exitFile, markerFile })`
   - Call `openVisibleTaskInSplit({ direction, command, execCmux })`
   - Store `cmux.surfaceRef` on task
   - Start log tail watcher (fs.watch or interval) instead of child stdout pipes
   - On exit marker read → `finalizeTask()`

7. Register in `sumocode-config/pi-agent/settings.json`:

```json
"packages": ["npm:@sumocode/pi-background-cmux"]
```

## Phase 2 — SumoCode UX (estimated 1–2 days)

1. **Transcript renderer** — add `bg_task` / `bg_status` to tool pill pipeline (mirror `task` delegation styling or lighter variant).

2. **Footer hint** — when running visible bg tasks, show `cmux split · bg-3` in hint row.

3. **Command palette** — entries:
   - `background: list tasks`
   - `background: open split for task`

4. **Disable duplicate UI** — when SumoTUI active, set pi-background widget to hidden via extension settings.

5. **Orchestrator prompt** — append to Zeus system block:

```
Use bg_task for long shell work. Pass visible=true when the user wants a cmux split.
Use task for Pi subagent delegation with structured tools.
```

## Phase 3 — Validation

| Test | Lane |
|---|---|
| `cmux-adapter.test.ts` | unit (mock exec) |
| spawn visible + invisible in cmux | manual cmux session |
| wake on exit after parent reload | integration |
| fallback outside cmux | `pi --print` smoke |
| SumoTUI tool pill snapshot | fixture lane (optional) |

Manual smoke script (document in fork README):

```bash
# inside cmux, sumocode session
# ask: "run pnpm test in a visible background split"
# expect: right split with test output, parent continues, wake on exit
```

## Phase 4 — Upstream

- Propose `visible` + `cmuxSurfaceRef` upstream to `@vanillagreen/pi-background-tasks`
- Optionally propose shared `cmux-adapter` module to `pi-cmux` to avoid duplication

## Non-goals

- Replacing SumoCode native `task` tool
- cmux grid layout from opencode-cmux (YAGNI until >3 concurrent visible tasks)
- `pi-subagents` removal (orthogonal)

## Open questions for Dhruv

1. Package name: `@sumocode/pi-background-cmux` vs extend sumocode extension inline?
2. Default `visible`: false (safe) or true when `CMUX_SURFACE_ID` set?
3. Close split on task exit or leave pane open for inspection?
4. Install fork globally via settings or only in sumocode-config?
