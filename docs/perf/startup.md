# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas. While startup is serial, first-frame is approximately host-import + child-first-response-noext + hydration round trips because the first-frame probe passes `--no-extensions`; plan 061 changes that relationship. Child-first-response minus child-first-response-noext estimates the installed-extension-corpus cost.

- commit: `79e8467 Merge remote-tracking branch 'origin/advisor/060-startup-perf-baseline-v2' into advisor/061-early-first-frame-v2`
- runs: 5
- generated: 2026-08-11T11:43:16.219Z

| Measurement | Avg middle runs | Min | Max | Runs | Failed |
| --- | ---: | ---: | ---: | ---: | ---: |
| launcher-dry-run | 7.9ms | 7.7ms | 8.6ms | 5 | 0 |
| host-import | 1136ms | 1110ms | 1771ms | 5 | 0 |
| child-first-response | 1796.9ms | 1771.9ms | 2013.6ms | 5 | 0 |
| child-first-response-noext | 1497.5ms | 1431ms | 1516.2ms | 5 | 0 |
| print-mode | 7285.5ms | 6644.6ms | 7893.9ms | 5 | 0 |
| first-frame | 1300ms | 1282.1ms | 1335.9ms | 5 | 0 |
| boot-screen-frame | 1291.3ms | 1287ms | 1303ms | 5 | 0 |
| app-ready | 1487ms | 1412ms | 1629ms | 5 | 0 |
| stable-chrome | 1487ms | 1412ms | 1629ms | 5 | 0 |
| input-ready | 1291.3ms | 1287ms | 1303ms | 5 | 0 |
