# SumoCode real-world startup perf snapshot

Report-only measurements from herdr using the operator's real SumoCode configuration and installed extension set. Results are machine-dependent and are not CI gates.

- commit: `f45330e`
- generated: 2026-08-10T15:46:33.508Z
- scratch project: `/tmp/sumocode-perf-rw-70917`

| Run | Startup | First frame | App ready | Reload | Reload app ready | Notes |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 643ms | 643ms | 2361ms | 520ms | 2117ms |  |
| 2 | 486ms | 486ms | 2066ms | 491ms | 1902ms |  |
| 3 | 502ms | 502ms | 2051ms | 489ms | 2063ms |  |

| Metric | Median |
| --- | ---: |
| startup_ms | 502ms |
| first_frame_ms | 502ms |
| app_ready_ms | 2066ms |
| reload_ms | 491ms |
| reload_app_ready_ms | 2063ms |
