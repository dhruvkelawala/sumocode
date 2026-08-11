# SumoCode real-world startup perf snapshot

Report-only measurements from herdr using the operator's real SumoCode configuration and installed extension set. Results are machine-dependent and are not CI gates.

- commit: `79e8467`
- generated: 2026-08-11T11:43:28.251Z
- scratch project: `/tmp/sumocode-perf-rw-52754`

| Run | Startup | First frame | App ready | Reload | Reload app ready | Notes |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 1295ms | 1294ms | 1915ms | 1366ms | 1891ms |  |
| 2 | 1285ms | 1285ms | 1827ms | 1360ms | 1879ms |  |
| 3 | 1300ms | 1299ms | 1844ms | 1358ms | 1827ms |  |

| Metric | Median |
| --- | ---: |
| startup_ms | 1295ms |
| first_frame_ms | 1294ms |
| app_ready_ms | 1844ms |
| reload_ms | 1360ms |
| reload_app_ready_ms | 1879ms |
