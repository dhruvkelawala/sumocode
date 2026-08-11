# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas. While startup is serial, first-frame is approximately host-import + child-first-response-noext + hydration round trips because the first-frame probe passes `--no-extensions`; plan 061 changes that relationship. Child-first-response minus child-first-response-noext estimates the installed-extension-corpus cost.

- commit: `b851e8e Merge remote-tracking branch 'origin/advisor/060-startup-perf-baseline-v2' into advisor/061-early-first-frame-v2`
- runs: 5
- generated: 2026-08-11T11:59:05.462Z

| Measurement | Avg middle runs | Min | Max | Runs | Failed |
| --- | ---: | ---: | ---: | ---: | ---: |
| launcher-dry-run | 8.6ms | 7.9ms | 9.8ms | 5 | 0 |
| host-import | 1134.3ms | 1116ms | 1778ms | 5 | 0 |
| child-first-response | 1882.7ms | 1801.6ms | 2120.9ms | 5 | 0 |
| child-first-response-noext | 1575.9ms | 1508.1ms | 1640.2ms | 5 | 0 |
| print-mode | 7744.3ms | 6798.6ms | 9778.9ms | 5 | 0 |
| first-frame | 1287.1ms | 1279.7ms | 1376.8ms | 5 | 0 |
| boot-screen-frame | 1325ms | 1292ms | 1382ms | 5 | 0 |
| app-ready | 1715.7ms | 1477ms | 1766ms | 5 | 0 |
| stable-chrome | 1715.7ms | 1477ms | 1766ms | 5 | 0 |
| input-ready | 1325ms | 1292ms | 1382ms | 5 | 0 |
