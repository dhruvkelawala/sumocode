# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas.

- commit: `1303711 perf(startup): parallelize yoga and async git`
- runs: 5
- generated: 2026-05-05T23:47:42.618Z

| Measurement | Avg middle runs | Min | Max | Runs |
| --- | ---: | ---: | ---: | ---: |
| launcher-dry-run | 25.9ms | 24.5ms | 27.7ms | 5 |
| print-mode | 4956.6ms | 4546.6ms | 5439.3ms | 5 |
| first-frame | 1510.7ms | 1492.2ms | 1517.8ms | 5 |
