# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas. While startup is serial, first-frame is approximately host-import + child-first-response + hydration round trips; plan 061 changes that relationship. Child-first-response minus child-first-response-noext estimates the installed-extension-corpus cost.

- commit: `fe2afd8 fix(auth): keep login controls within modal cap`
- runs: 5
- generated: 2026-08-10T12:36:54.145Z

| Measurement | Avg middle runs | Min | Max | Runs |
| --- | ---: | ---: | ---: | ---: |
| launcher-dry-run | 8.3ms | 7.9ms | 8.9ms | 5 |
| host-import | 1146ms | 1139ms | 1283ms | 5 |
| child-first-response | 2073.4ms | 2060ms | 2148.4ms | 5 |
| child-first-response-noext | 1598.3ms | 1551.3ms | 1685.3ms | 5 |
| print-mode | 2962.5ms | 2469.2ms | 3515.4ms | 5 |
| first-frame | 2719.3ms | 2643.4ms | 2877.5ms | 5 |
| boot-screen-frame | 2816ms | 2739ms | 3308ms | 5 |
| app-ready | 2816.7ms | 2740ms | 3308ms | 5 |
| stable-chrome | 2816ms | 2739ms | 3308ms | 5 |
| input-ready | 2816.7ms | 2740ms | 3308ms | 5 |
