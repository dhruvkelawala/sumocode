# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas. While startup is serial, first-frame is approximately host-import + child-first-response-noext + hydration round trips because the first-frame probe passes `--no-extensions`; plan 061 changes that relationship. Child-first-response minus child-first-response-noext estimates the installed-extension-corpus cost.

- commit: `567157b Merge remote-tracking branch 'origin/advisor/061-early-first-frame-v2' into advisor/062-prebundled-rpc-host-entry-v2`
- runs: 5
- generated: 2026-08-11T11:47:10.094Z

| Measurement | Avg middle runs | Min | Max | Runs | Failed |
| --- | ---: | ---: | ---: | ---: | ---: |
| launcher-dry-run | 8.8ms | 8.3ms | 9.9ms | 5 | 0 |
| host-import | 1124.7ms | 1116ms | 1585ms | 5 | 0 |
| child-first-response | 1744.9ms | 1710.2ms | 1923.5ms | 5 | 0 |
| child-first-response-noext | 1351.3ms | 1246.1ms | 1458.9ms | 5 | 0 |
| print-mode | 7634.8ms | 6916.1ms | 9582.4ms | 5 | 0 |
| first-frame | 468.8ms | 457.8ms | 483.8ms | 5 | 0 |
| boot-screen-frame | 467.3ms | 462ms | 475ms | 5 | 0 |
| app-ready | 1531.3ms | 1489ms | 1556ms | 5 | 0 |
| stable-chrome | 1531.3ms | 1489ms | 1556ms | 5 | 0 |
| input-ready | 467.3ms | 462ms | 475ms | 5 | 0 |
