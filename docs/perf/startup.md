# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas.

- commit: `3e3da62 perf(startup): include module load provenance`
- runs: 5
- generated: 2026-05-06T13:45:05.709Z

| Measurement | Avg middle runs | Min | Max | Runs |
| --- | ---: | ---: | ---: | ---: |
| launcher-dry-run | 18.9ms | 16.9ms | 22.4ms | 5 |
| print-mode | 4938.2ms | 4477.2ms | 6991.6ms | 5 |
| first-frame | 1433.5ms | 1425.3ms | 1456.3ms | 5 |
