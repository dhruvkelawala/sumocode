# SumoCode real-world startup perf snapshot

Report-only measurements from herdr using the operator's real SumoCode configuration and installed extension set. Results are machine-dependent and are not CI gates.

- commit: `567157b`
- generated: 2026-08-11T11:47:21.949Z
- scratch project: `/tmp/sumocode-perf-rw-57285`

| Run | Startup | First frame | App ready | Reload | Reload app ready | Notes |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 458ms | 458ms | 1868ms | 544ms | 1832ms |  |
| 2 | 467ms | 467ms | 1761ms | 532ms | 1891ms |  |
| 3 | 471ms | 471ms | 1836ms | 545ms | 1845ms |  |

| Metric | Median |
| --- | ---: |
| startup_ms | 467ms |
| first_frame_ms | 467ms |
| app_ready_ms | 1836ms |
| reload_ms | 544ms |
| reload_app_ready_ms | 1845ms |
