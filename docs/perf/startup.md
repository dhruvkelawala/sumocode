# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas.

- commit: `f9afabb fix(approval): cap command + description rows so modal cannot overflow vertically (#241)`
- runs: 5
- generated: 2026-05-07T14:48:13.265Z

| Measurement | Avg middle runs | Min | Max | Runs |
| --- | ---: | ---: | ---: | ---: |
| launcher-dry-run | 17.3ms | 16.7ms | 20.7ms | 5 |
| print-mode | 6684.1ms | 5941.4ms | 7803.8ms | 5 |
| first-frame | 1507ms | 1475ms | 1547ms | 5 |
