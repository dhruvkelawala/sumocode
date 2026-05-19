# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas.

- commit: `3f84472 chore(pi): update backend to 0.75.3`
- runs: 5
- generated: 2026-05-19T09:36:37.195Z

| Measurement | Avg middle runs | Min | Max | Runs |
| --- | ---: | ---: | ---: | ---: |
| launcher-dry-run | 26.6ms | 24.2ms | 29.5ms | 5 |
| print-mode | 6963.9ms | 6368.5ms | 7273.8ms | 5 |
| first-frame | 3756.9ms | 3707.3ms | 3865.7ms | 5 |
