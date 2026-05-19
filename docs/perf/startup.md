# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas.

- commit: `8982b30 perf(startup): defer heavy extension registration`
- runs: 3
- generated: 2026-05-19T10:30:41.939Z

| Measurement | Avg middle runs | Min | Max | Runs |
| --- | ---: | ---: | ---: | ---: |
| launcher-dry-run | 26.2ms | 25ms | 27.9ms | 3 |
| print-mode | 6072.1ms | 6071.4ms | 6072.4ms | 3 |
| first-frame | 2193.7ms | 2120.7ms | 2230.4ms | 3 |
