# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas. While startup is serial, first-frame is approximately host-import + child-first-response-noext + hydration round trips because the first-frame probe passes `--no-extensions`; plan 061 changes that relationship. Child-first-response minus child-first-response-noext estimates the installed-extension-corpus cost.

- commit: `b056285 Merge remote-tracking branch 'origin/advisor/062-prebundled-rpc-host-entry-v2' into advisor/083-prebundled-extension-entry`
- runs: 5
- generated: 2026-08-11T12:04:32.783Z

| Measurement | Avg middle runs | Min | Max | Runs | Failed |
| --- | ---: | ---: | ---: | ---: | ---: |
| launcher-dry-run | 8ms | 7.8ms | 8.9ms | 5 | 0 |
| host-import | 1123ms | 1109ms | 1724ms | 5 | 0 |
| child-first-response | 1909.4ms | 1788.6ms | 2258.5ms | 5 | 0 |
| child-first-response-noext | 1614.8ms | 1567.5ms | 1643.7ms | 5 | 0 |
| print-mode | 8029.5ms | 7488.7ms | 9335ms | 5 | 0 |
| first-frame | 408.2ms | 406.1ms | 462.4ms | 5 | 0 |
| boot-screen-frame | 420ms | 417ms | 424ms | 5 | 0 |
| app-ready | 1093ms | 920ms | 1187ms | 5 | 0 |
| stable-chrome | 1093ms | 920ms | 1187ms | 5 | 0 |
| input-ready | 420.3ms | 417ms | 424ms | 5 | 0 |
