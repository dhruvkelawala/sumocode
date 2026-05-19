# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas.

- commit: `fd5c7e6 perf(startup): enable node compile cache`
- runs: 3
- generated: 2026-05-19T10:52:04.972Z

| Measurement | Avg middle runs | Min | Max | Runs |
| --- | ---: | ---: | ---: | ---: |
| launcher-dry-run | 29.1ms | 28.2ms | 30ms | 3 |
| print-mode | 6516.2ms | 6113.2ms | 15002.1ms | 3 |
| first-frame | 2165ms | 2164.8ms | 2235.5ms | 3 |
