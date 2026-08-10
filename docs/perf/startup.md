# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas. While startup is serial, first-frame is approximately host-import + child-first-response + hydration round trips; plan 061 changes that relationship. Child-first-response minus child-first-response-noext estimates the installed-extension-corpus cost.

- commit: `8f717e1 fix(host): verify copied splash asset contents`
- runs: 5
- generated: 2026-08-10T15:10:54.261Z

| Measurement | Avg middle runs | Min | Max | Runs | Failed |
| --- | ---: | ---: | ---: | ---: | ---: |
| launcher-dry-run | 8.3ms | 7.6ms | 8.8ms | 5 | 0 |
| host-import | 1134ms | 1130ms | 1164ms | 5 | 0 |
| child-first-response | 2527.2ms | 2411.9ms | 2803.3ms | 5 | 0 |
| child-first-response-noext | 1577ms | 1284.7ms | 1621.3ms | 5 | 0 |
| print-mode | — | — | — | 5 | 5 |
| first-frame | 471.2ms | 462.9ms | 492.4ms | 5 | 0 |
| boot-screen-frame | 475.7ms | 469ms | 499ms | 5 | 0 |
| app-ready | 1337.3ms | 1257ms | 1400ms | 5 | 0 |
| stable-chrome | 1337.3ms | 1257ms | 1400ms | 5 | 0 |
| input-ready | 475.7ms | 469ms | 499ms | 5 | 0 |
