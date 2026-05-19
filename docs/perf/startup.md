# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas.

- commit: `0af672f perf(startup): defer upstream interactive import`
- runs: 3
- generated: 2026-05-19T10:53:50.031Z

| Measurement | Avg middle runs | Min | Max | Runs |
| --- | ---: | ---: | ---: | ---: |
| launcher-dry-run | 31.6ms | 30.5ms | 34ms | 3 |
| print-mode | 6368.5ms | 6033.4ms | 6550.2ms | 3 |
| first-frame | 2024.1ms | 2017.8ms | 2034.6ms | 3 |
