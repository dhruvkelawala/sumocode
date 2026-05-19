# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas.

- commit: `78c8a29 perf(sumo-tui): optimize resume and new session hydration`
- runs: 5
- generated: 2026-05-19T10:05:55.203Z

| Measurement | Avg middle runs | Min | Max | Runs |
| --- | ---: | ---: | ---: | ---: |
| launcher-dry-run | 28ms | 26.2ms | 31.4ms | 5 |
| print-mode | 6971.9ms | 6380.1ms | 8086.3ms | 5 |
| first-frame | 45.8ms | 30.2ms | 53.5ms | 5 |
