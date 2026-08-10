# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas. While startup is serial, first-frame is approximately host-import + child-first-response + hydration round trips; plan 061 changes that relationship. Child-first-response minus child-first-response-noext estimates the installed-extension-corpus cost.

- commit: `ad68df8 perf(rpc): paint splash before hydration via pre-spawned child`
- runs: 5
- generated: 2026-08-10T14:16:35.273Z

| Measurement | Avg middle runs | Min | Max | Runs | Failed |
| --- | ---: | ---: | ---: | ---: | ---: |
| launcher-dry-run | 8.5ms | 8ms | 8.9ms | 5 | 0 |
| host-import | 1147.3ms | 1141ms | 1474ms | 5 | 0 |
| child-first-response | 2621.7ms | 2554.9ms | 2761.6ms | 5 | 0 |
| child-first-response-noext | 1560.7ms | 1454.4ms | 1650.5ms | 5 | 0 |
| print-mode | — | — | — | 5 | 5 |
| first-frame | 471.9ms | 466.5ms | 807.5ms | 5 | 0 |
| boot-screen-frame | 494.3ms | 475ms | 536ms | 5 | 0 |
| app-ready | 1706.7ms | 1479ms | 1770ms | 5 | 0 |
| stable-chrome | 1706.7ms | 1479ms | 1770ms | 5 | 0 |
| input-ready | 494.3ms | 475ms | 536ms | 5 | 0 |
