# Host memory budget (#521)

Report-only measurements from the RPC host with the new `heap` diagnostic. Figures
are machine-dependent and are not CI gates.

Instrumentation added by this change:

- `heap` — one JSONL sample every 10 s while `SUMO_TUI_DIAG_FILE` is set:
  `process.memoryUsage()` (`rss`, `heapUsed`, `heapTotal`, `external`,
  `arrayBuffers`) plus the session-scoped counters (`transcriptBlocks`,
  `viewModelRows`, `retainedFrames`, `cloneCount`).
- `heap_snapshot` — `SIGUSR2` writes `v8.writeHeapSnapshot()` to
  `SUMOCODE_HEAP_SNAPSHOT` (`1` = `<tmpdir>/sumocode-heap-<pid>.heapsnapshot`).
  Unset means no signal listener is installed.

```bash
pnpm exec vitest run src/sumo-tui/runtime/heap-monitor.test.ts
SUMOCODE_HEAP_SNAPSHOT=/tmp/host.heapsnapshot bin/sumocode.sh -d
kill -USR2 "$(pgrep -f sumo-rpc-host.js | head -1)"
```

## Reference session

- Host: `bin/sumocode.sh -d --offline <project>` (real RPC host, 120×40 pty).
- Child: the integration fixture child (`test/integration/rpc-child-fixture.ts`,
  `PI_BIN`) with an idle session, **766 KB** of transcript over 181 entries
  (markdown prose + 95-line TypeScript fences).
- Hydrated state: 545 transcript blocks, 6 161 laid-out view-model rows,
  2 retained frames (the composed frame + its previous-frame clone).

## Steady state, idle child, 10 minutes

| Metric | Median | Max (pre-snapshot) |
| --- | ---: | ---: |
| `process.memoryUsage().rss` | 54.1 MB | 85.8 MB |
| `heapUsed` | 61.4 MB | 66.7 MB |
| `external` | 22.8 MB | 22.9 MB |
| host RSS (`ps -o rss=`) | 81.8 MB | 123.2 MB |
| `transcriptBlocks` / `viewModelRows` | 545 / 6 161 | flat for all 10 minutes |
| `retainedFrames` | 2 | 2 (`render()` + `repaintRegion()` keep exactly one clone) |
| `cloneCount` | — | +2 every 5 s (the idle stats-refresh render) |

`viewModelRows` is the pager's total laid-out content height (the whole
transcript), not the rows inside the viewport — it does not move while the run
is idle. The `rss` and `heapUsed` medians come from the same sample set but are
not mutually consistent here: on macOS the OS `rss` can read below V8's
`heapUsed` when the compressor evicts heap pages (the maxima, 85.8 MB vs
66.7 MB, agree). Both are reported as measured; the budget check uses `rss`.

Idle steady state is **54–86 MB in-process / 82–123 MB `ps` RSS**, well under the
200 MB budget, and flat: the transcript counters and retained-frame count do not
move across 10 minutes.

## Live streaming (separate run, for comparison)

689 KB streamed as 300 cumulative `message_update` chunks over 30 s:

| Metric | Peak during stream | After `agent_end` + 10 s |
| --- | ---: | ---: |
| `heapUsed` | 326.2 MB | 69.7 MB |
| `rss` (in-process) | 348.4 MB | 55.2 MB |
| `viewModelRows` | 15 460 | 15 460 |

A large streaming message transiently reaches ~330 MB and collapses once the run
settles. This run does **not** attribute #520's 416 MB host: that host was sampled
idle, and the measurement base has moved since (`perf/520-idle-render-loop`).
What the two runs show is the split the issue asked for — the idle baseline is
flat and session-scoped retention is small, while the unbounded shape that
remains is the per-delta re-render of a growing message.

## Top retainers (idle snapshot, t = 606 s, 79.5 MB heap)

Retained sizes from the dominator tree of a 48.6 MB `v8.writeHeapSnapshot()`
(non-weak edges); node types reachable from the synthetic root, largest first.

| # | Retained branch | Retained | Note |
| --- | --- | ---: | --- |
| 1 | `ArrayBuffer` / `JSArrayBufferData` | 16.0 MB | single 16 MB buffer, held only by a WebAssembly `Memory` and the TypedArray prototypes; present from t = 44 s, session-independent |
| 2 | jiti `transform` closure + transformed source strings | 6.3 MB | 3.4 MB closure + 2.9 MB lazy-babel stub + 0.7 MB `__defProp` helper |
| 3 | `ModuleLoader` + `ResolveCache` + `LoadCache` | 5.4 MB | 2.7 / 1.7 / 1.0 MB |
| 4 | V8 module/runtime contexts | 3.7 MB | one 3.4 MB `system / Context` plus per-module contexts |
| 5 | Session state (`ChatMessage` ×207, `CellBuffer` ×13, `ScrollBox`, `ViewBox`) | ~1 MB | the whole 766 KB transcript plus both retained frames |

Heap-wide self size by node type, for context: `string` 31.7 MB, `native`
16.4 MB, `code` 11.1 MB, `array` 6.3 MB, `concatenated string` 4.1 MB,
`object` 2.9 MB, `object shape` 2.8 MB, `closure` 2.0 MB, `hidden` 1.9 MB.

No session-scoped object made the top five: at 766 KB the transcript view model,
the rendered rows of materialized messages, and the retained frames are each
under 1 MB. The per-tick `CellBuffer` clones from `retained-shell-renderer.ts`
are not retained either — `retainedFrames` stays at 2 and `cloneCount` only
grows when a render happens.

## Named next retainer

The streaming peak, not the idle heap, is the budget risk:

- Each `message_update` carries the **full accumulated message text**; the host
  re-parses and re-renders rows for the whole message on every delta. A 689 KB
  message retained 6.4 MB of rendered rows (~9× the source text) and pushed
  `heapUsed` to 326 MB across 300 deltas before collapsing.
- That is the #383 scaling path (work and memory proportional to history ×
  deltas), and it is the next retainer to bound — for example by reusing the
  previous render for the unchanged prefix of a growing message instead of
  rebuilding every row per delta.
- The runner-up is the ~30 MB of jiti-transformed module source and bytecode
  that every host holds from startup; bounding it means bounding the TS loader
  cache, which is a separate change.
