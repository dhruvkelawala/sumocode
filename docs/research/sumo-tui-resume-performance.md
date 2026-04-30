# SumoTUI Resume Performance

Generated: 2026-04-30T16:54:32.513Z

Machine: darwin 25.4.0, Node v25.1.0, @dhruvkelawala/sumocode@0.1.0, Apple M3 Max

## Current Bulk Resume Path (10000 messages, 30 iterations)

Budget: p95 < 500ms. Result: **PASS** at p95 29.06ms.

| Stage | p50 | p95 |
|---|---:|---:|
| session_scan | 0.00ms | 0.00ms |
| transcript_model | 1.90ms | 3.47ms |
| transcript_hydrate | 6.68ms | 8.52ms |
| yoga_first_layout | 7.76ms | 12.97ms |
| first_frame_render | 6.52ms | 7.91ms |
| total | 23.11ms | 29.06ms |

Latest retained transcript stats: 10000 accepted, 200 rendered nodes, 9800 archived behind the placeholder.

## Legacy Incremental Replay Proxy (2000 messages, 5 iterations)

This measures the old Sumo-owned replay shape: add every view model one-by-one, create archived Yoga nodes, and schedule a render per message. It is intentionally capped below 10k so the report stays quick enough for local iteration.

| Stage | p50 | p95 |
|---|---:|---:|
| session_scan | 0.00ms | 0.00ms |
| transcript_model | 0.00ms | 0.00ms |
| transcript_hydrate | 273ms | 273ms |
| yoga_first_layout | 0.00ms | 0.00ms |
| first_frame_render | 0.00ms | 0.00ms |
| total | 273ms | 274ms |

## Conclusion

Dominant Sumo-owned cost was full chat-history replay. The fix bulk-hydrates resumed transcripts, keeps only the active 200-message window as retained nodes, represents older history as a virtual archive count, and schedules one render for the resumed transcript.

Remnic memory is not on the synchronous resume hot path in this checkout: sidebar memory refreshes are debounce-triggered and run through `CancellableWorkerRuntime`.

No retained render loop idle wake is covered by `FrameScheduler` tests: after the coalesced resume render drains, no timer remains scheduled.
