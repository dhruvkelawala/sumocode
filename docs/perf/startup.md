# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas.

- commit: `ad3697e perf(startup): eagerly paint splash`
- runs: 5
- generated: 2026-05-06T00:01:25.444Z

| Measurement | Avg middle runs | Min | Max | Runs |
| --- | ---: | ---: | ---: | ---: |
| launcher-dry-run | 24.2ms | 23.6ms | 25.9ms | 5 |
| print-mode | 6662.3ms | 4655ms | 8257.7ms | 5 |
| first-frame | 1504.3ms | 1494.4ms | 1513.6ms | 5 |
