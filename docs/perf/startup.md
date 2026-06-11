# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas.

- commit: `e86879a feat(startup): add boot readiness diagnostics`
- runs: 5
- generated: 2026-06-11T10:08:38.207Z

| Measurement | Avg middle runs | Min | Max | Runs |
| --- | ---: | ---: | ---: | ---: |
| launcher-dry-run | 46.6ms | 45.6ms | 47.4ms | 5 |
| print-mode | 7081.6ms | 5812.5ms | 7577.9ms | 5 |
| first-frame | 1824.8ms | 1813.9ms | 1847.6ms | 5 |
| boot-screen-frame | 1856.3ms | 1848ms | 1866ms | 5 |
| app-ready | 1889.3ms | 1881ms | 1900ms | 5 |
| stable-chrome | 1889.3ms | 1881ms | 1900ms | 5 |
| input-ready | 1889.3ms | 1881ms | 1900ms | 5 |
