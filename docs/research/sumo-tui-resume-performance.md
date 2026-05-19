# SumoTUI Resume Performance

Generated: 2026-05-19T09:45:26.420Z

Machine: darwin 25.4.0, Node v25.6.1, @dhruvkelawala/sumocode@0.3.0, Apple M4

## Current Bulk Resume Path (10000 messages, 30 iterations)

Budget: p95 < 500ms. Result: **PASS** at p95 59.62ms.

| Stage | p50 | p95 |
|---|---:|---:|
| session_scan | 0.00ms | 0.00ms |
| transcript_model | 4.74ms | 10.30ms |
| transcript_hydrate | 15.78ms | 22.25ms |
| yoga_first_layout | 15.54ms | 24.39ms |
| first_frame_render | 13.43ms | 16.33ms |
| total | 50.23ms | 59.62ms |

Latest retained transcript stats: 10000 accepted, 200 rendered nodes, 9800 archived behind the placeholder.

## New Session Clear Path (from 10000 hydrated messages, 30 iterations)

This is the Sumo-owned part of switching to `/new`: clear the retained chat pager, recalculate layout, and paint the empty session frame without rebuilding a transcript model.

| Stage | p50 | p95 |
|---|---:|---:|
| session_scan | 0.00ms | 0.01ms |
| transcript_model | 0.00ms | 0.00ms |
| transcript_hydrate | 13.15ms | 14.58ms |
| yoga_first_layout | 0.02ms | 0.03ms |
| first_frame_render | 3.98ms | 7.18ms |
| total | 17.29ms | 21.74ms |

## Legacy Incremental Replay Proxy (2000 messages, 5 iterations)

This measures the old Sumo-owned replay shape: add every view model one-by-one, create archived Yoga nodes, and schedule a render per message. It is intentionally capped below 10k so the report stays quick enough for local iteration.

| Stage | p50 | p95 |
|---|---:|---:|
| session_scan | 0.00ms | 0.00ms |
| transcript_model | 0.00ms | 0.00ms |
| transcript_hydrate | 707ms | 817ms |
| yoga_first_layout | 0.00ms | 0.00ms |
| first_frame_render | 0.00ms | 0.00ms |
| total | 708ms | 819ms |

## Conclusion

Dominant Sumo-owned cost was full chat-history replay. The fix bulk-hydrates resumed transcripts, keeps only the active 200-message window as retained nodes, represents older history as a virtual archive count, and schedules one render for the resumed transcript.

Remnic memory is not on the synchronous resume hot path in this checkout: sidebar memory refreshes are debounce-triggered and run through `CancellableWorkerRuntime`.

No retained render loop idle wake is covered by `FrameScheduler` tests: after the coalesced resume render drains, no timer remains scheduled.
