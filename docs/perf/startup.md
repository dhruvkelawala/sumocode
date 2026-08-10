# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas. While startup is serial, first-frame is approximately host-import + child-first-response + hydration round trips; plan 061 changes that relationship. Child-first-response minus child-first-response-noext estimates the installed-extension-corpus cost.

- commit: `442b750 perf(startup): add phase and real-world measurements`
- runs: 5
- generated: 2026-08-10T13:09:16.345Z

| Measurement | Avg middle runs | Min | Max | Runs | Failed |
| --- | ---: | ---: | ---: | ---: | ---: |
| launcher-dry-run | 8.2ms | 7.8ms | 8.7ms | 5 | 0 |
| host-import | 1144ms | 1143ms | 1195ms | 5 | 0 |
| child-first-response | 2548.3ms | 2346.3ms | 2655.4ms | 5 | 0 |
| child-first-response-noext | 1624.4ms | 1426.3ms | 1674.3ms | 5 | 0 |
| print-mode | — | — | — | 5 | 5 |
| first-frame | 2811.8ms | 2785.7ms | 2905.7ms | 5 | 0 |
| boot-screen-frame | 2727.3ms | 2532ms | 2749ms | 5 | 0 |
| app-ready | 2727.3ms | 2532ms | 2749ms | 5 | 0 |
| stable-chrome | 2727.3ms | 2532ms | 2749ms | 5 | 0 |
| input-ready | 2727.3ms | 2532ms | 2749ms | 5 | 0 |
