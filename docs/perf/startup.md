# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas.

- commit: `fc8dd18 perf(startup): cache jiti and streamline launcher`
- runs: 5
- generated: 2026-05-05T23:10:43.147Z

| Measurement | Avg middle runs | Min | Max | Runs |
| --- | ---: | ---: | ---: | ---: |
| launcher-dry-run | 27.3ms | 26.1ms | 30.3ms | 5 |
| print-mode | 5248.5ms | 4574.4ms | 5538.4ms | 5 |
| first-frame | 1528.4ms | 1500.5ms | 1565.6ms | 5 |
