# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas. While startup is serial, first-frame is approximately host-import + child-first-response + hydration round trips; plan 061 changes that relationship. Child-first-response minus child-first-response-noext estimates the installed-extension-corpus cost.

- commit: `f45330e fix(startup): match bundle freshness hashes`
- runs: 5
- generated: 2026-08-10T15:46:17.485Z

| Measurement | Avg middle runs | Min | Max | Runs | Failed |
| --- | ---: | ---: | ---: | ---: | ---: |
| launcher-dry-run | 8.4ms | 8.1ms | 8.7ms | 5 | 0 |
| host-import | 1147.3ms | 1143ms | 1154ms | 5 | 0 |
| child-first-response | 2585.8ms | 2561.4ms | 2791.8ms | 5 | 0 |
| child-first-response-noext | 1663.7ms | 1590.4ms | 1686.2ms | 5 | 0 |
| print-mode | — | — | — | 5 | 5 |
| first-frame | 476.6ms | 471.5ms | 497.1ms | 5 | 0 |
| boot-screen-frame | 479.7ms | 474ms | 486ms | 5 | 0 |
| app-ready | 1317.3ms | 1231ms | 1389ms | 5 | 0 |
| stable-chrome | 1317.3ms | 1231ms | 1389ms | 5 | 0 |
| input-ready | 479.7ms | 474ms | 486ms | 5 | 0 |
