# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas. While startup is serial, first-frame is approximately host-import + child-first-response-noext + hydration round trips because the first-frame probe passes `--no-extensions`; plan 061 changes that relationship. Child-first-response minus child-first-response-noext estimates the installed-extension-corpus cost.

- commit: `e318379 test(host): prove rejected startup reaps the child`
- runs: 5
- generated: 2026-08-11T12:02:36.777Z

| Measurement | Avg middle runs | Min | Max | Runs | Failed |
| --- | ---: | ---: | ---: | ---: | ---: |
| launcher-dry-run | 8.2ms | 7.8ms | 9.2ms | 5 | 0 |
| host-import | 1133.3ms | 1110ms | 1569ms | 5 | 0 |
| child-first-response | 1942.6ms | 1907.1ms | 2001.2ms | 5 | 0 |
| child-first-response-noext | 1627.4ms | 1596.8ms | 1660.5ms | 5 | 0 |
| print-mode | 9270.4ms | 7196.1ms | 10482.5ms | 5 | 0 |
| first-frame | 462ms | 453.1ms | 479.2ms | 5 | 0 |
| boot-screen-frame | 464ms | 459ms | 516ms | 5 | 0 |
| app-ready | 1653.3ms | 1571ms | 1739ms | 5 | 0 |
| stable-chrome | 1653.3ms | 1571ms | 1739ms | 5 | 0 |
| input-ready | 464ms | 459ms | 516ms | 5 | 0 |
