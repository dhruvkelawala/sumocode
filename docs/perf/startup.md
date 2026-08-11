# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas. While startup is serial, first-frame is approximately host-import + child-first-response-noext + hydration round trips because the first-frame probe passes `--no-extensions`; plan 061 changes that relationship. Child-first-response minus child-first-response-noext estimates the installed-extension-corpus cost.

- commit: `0668d77 fix(extension): hash portable recipe inputs`
- runs: 5
- generated: 2026-08-11T11:52:20.848Z

| Measurement | Avg middle runs | Min | Max | Runs | Failed |
| --- | ---: | ---: | ---: | ---: | ---: |
| launcher-dry-run | 8.3ms | 8.1ms | 9.1ms | 5 | 0 |
| host-import | 1117ms | 1115ms | 1646ms | 5 | 0 |
| child-first-response | 1922.6ms | 1826.9ms | 2379.5ms | 5 | 0 |
| child-first-response-noext | 1533.9ms | 1263.7ms | 1604.2ms | 5 | 0 |
| print-mode | 8136.1ms | 6998.6ms | 9622ms | 5 | 0 |
| first-frame | 413.5ms | 405.4ms | 492.4ms | 5 | 0 |
| boot-screen-frame | 418.3ms | 416ms | 422ms | 5 | 0 |
| app-ready | 982ms | 925ms | 1115ms | 5 | 0 |
| stable-chrome | 982ms | 925ms | 1115ms | 5 | 0 |
| input-ready | 418.3ms | 416ms | 422ms | 5 | 0 |
