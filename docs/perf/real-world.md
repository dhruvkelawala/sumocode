# SumoCode real-world startup perf snapshot

Report-only measurements from herdr using the operator's real SumoCode configuration and installed extension set. Results are machine-dependent and are not CI gates.

- commit: `0668d77`
- generated: 2026-08-11T11:52:29.864Z
- scratch project: `/tmp/sumocode-perf-rw-60619`

| Run | Startup | First frame | App ready | Reload | Reload app ready | Notes |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 429ms | 429ms | 1483ms | 494ms | 1324ms |  |
| 2 | 433ms | 433ms | 1290ms | 492ms | 1372ms |  |
| 3 | 428ms | 427ms | 1330ms | 491ms | 1372ms |  |

| Metric | Median |
| --- | ---: |
| startup_ms | 429ms |
| first_frame_ms | 429ms |
| app_ready_ms | 1330ms |
| reload_ms | 492ms |
| reload_app_ready_ms | 1372ms |
