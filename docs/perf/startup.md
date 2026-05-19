# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas.

- commit: `d334c48 perf(startup): defer post-splash tui imports`
- runs: 5
- generated: 2026-05-19T10:26:29.153Z

| Measurement | Avg middle runs | Min | Max | Runs |
| --- | ---: | ---: | ---: | ---: |
| launcher-dry-run | 27.6ms | 25.4ms | 28.6ms | 5 |
| print-mode | 6487.6ms | 6228.4ms | 7349.2ms | 5 |
| first-frame | 2422.9ms | 2371.2ms | 2458.8ms | 5 |
