# SumoCode real-world startup perf snapshot

Report-only measurements from herdr using the operator's real SumoCode configuration and installed extension set. Results are machine-dependent and are not CI gates.

- commit: `ad68df8`
- generated: 2026-08-10T14:21:20.657Z
- scratch project: `/tmp/sumocode-perf-rw-11979`

| Run | Startup | First frame | App ready | Reload | Reload app ready | Notes |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 526ms | 526ms | 2840ms | 830ms | 2997ms |  |
| 2 | 506ms | 506ms | 2732ms | 482ms | 2584ms |  |
| 3 | 470ms | 470ms | 2729ms | 495ms | 2721ms |  |

| Metric | Median |
| --- | ---: |
| startup_ms | 506ms |
| first_frame_ms | 506ms |
| app_ready_ms | 2732ms |
| reload_ms | 495ms |
| reload_app_ready_ms | 2721ms |
