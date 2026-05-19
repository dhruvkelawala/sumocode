# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas.

- commit: `da525c7 perf(startup): import lifecycle directly`
- runs: 3
- generated: 2026-05-19T10:57:14.693Z

| Measurement | Avg middle runs | Min | Max | Runs |
| --- | ---: | ---: | ---: | ---: |
| launcher-dry-run | 31.8ms | 28ms | 34.7ms | 3 |
| print-mode | 5939.7ms | 5924.3ms | 6451ms | 3 |
| first-frame | 1853.2ms | 1829.3ms | 1859.1ms | 3 |
