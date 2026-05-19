# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas.

- commit: `f247f97 perf(startup): defer chat shell imports past splash`
- runs: 5
- generated: 2026-05-19T10:49:09.915Z

| Measurement | Avg middle runs | Min | Max | Runs |
| --- | ---: | ---: | ---: | ---: |
| launcher-dry-run | 36.5ms | 32.9ms | 41.2ms | 5 |
| print-mode | 6562.6ms | 6224.8ms | 10748.4ms | 5 |
| first-frame | 2207.1ms | 2146.6ms | 2264.9ms | 5 |
