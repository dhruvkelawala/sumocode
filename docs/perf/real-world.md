# SumoCode real-world startup perf snapshot

Report-only measurements from herdr using the operator's real SumoCode configuration and installed extension set. Results are machine-dependent and are not CI gates.

- commit: `f8a29bd`
- generated: 2026-08-10T14:00:11.314Z
- scratch project: `/tmp/sumocode-perf-rw-90437`

| Run | Startup | First frame | App ready | Reload | Reload app ready | Notes |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 1489ms | 1489ms | 3266ms | 1344ms | 2603ms |  |
| 2 | 1328ms | 1327ms | 2596ms | 1338ms | 2639ms |  |
| 3 | 1334ms | 1334ms | 2709ms | 1344ms | 2636ms |  |

| Metric | Median |
| --- | ---: |
| startup_ms | 1334ms |
| first_frame_ms | 1334ms |
| app_ready_ms | 2709ms |
| reload_ms | 1344ms |
| reload_app_ready_ms | 2636ms |
