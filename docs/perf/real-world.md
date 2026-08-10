# SumoCode real-world startup perf snapshot

Report-only measurements from herdr using the operator's real SumoCode configuration and installed extension set. Results are machine-dependent and are not CI gates.

- commit: `8f717e1`
- generated: 2026-08-10T15:11:18.437Z
- scratch project: `/tmp/sumocode-perf-rw-42495`

| Run | Startup | First frame | App ready | Reload | Reload app ready | Notes |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 538ms | 538ms | 1954ms | 837ms | 2490ms |  |
| 2 | 508ms | 508ms | 2068ms | 485ms | 2105ms |  |
| 3 | 466ms | 466ms | 2115ms | 492ms | 2138ms |  |

| Metric | Median |
| --- | ---: |
| startup_ms | 508ms |
| first_frame_ms | 508ms |
| app_ready_ms | 2068ms |
| reload_ms | 492ms |
| reload_app_ready_ms | 2138ms |
