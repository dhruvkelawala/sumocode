# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas. While startup is serial, first-frame is approximately host-import + child-first-response + hydration round trips; plan 061 changes that relationship. Child-first-response minus child-first-response-noext estimates the installed-extension-corpus cost.

- commit: `f8a29bd perf(startup): add phase and real-world measurements`
- runs: 5
- generated: 2026-08-10T13:55:25.038Z

| Measurement | Avg middle runs | Min | Max | Runs | Failed |
| --- | ---: | ---: | ---: | ---: | ---: |
| launcher-dry-run | 8.7ms | 8.1ms | 9.3ms | 5 | 0 |
| host-import | 1150ms | 1140ms | 1244ms | 5 | 0 |
| child-first-response | 2455.6ms | 2394.6ms | 2578.9ms | 5 | 0 |
| child-first-response-noext | 1519.4ms | 1319.4ms | 1540.7ms | 5 | 0 |
| print-mode | — | — | — | 5 | 5 |
| first-frame | 1320.7ms | 1313.8ms | 1353.2ms | 5 | 0 |
| boot-screen-frame | 1331ms | 1326ms | 1370ms | 5 | 0 |
| app-ready | 1578ms | 1480ms | 1640ms | 5 | 0 |
| stable-chrome | 1578ms | 1480ms | 1640ms | 5 | 0 |
| input-ready | 1331ms | 1326ms | 1370ms | 5 | 0 |
