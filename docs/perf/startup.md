# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas.

- commit: `6570f8a perf(startup): lazy-load chrome after splash`
- runs: 5
- generated: 2026-05-19T10:59:54.733Z

| Measurement | Avg middle runs | Min | Max | Runs |
| --- | ---: | ---: | ---: | ---: |
| launcher-dry-run | 33.2ms | 29.2ms | 34.9ms | 5 |
| print-mode | 6170.6ms | 5783.7ms | 7007.2ms | 5 |
| first-frame | 1960.2ms | 1794.1ms | 2127.5ms | 5 |
