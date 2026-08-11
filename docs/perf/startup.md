# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas. While startup is serial, first-frame is approximately host-import + child-first-response-noext + hydration round trips because the first-frame probe passes `--no-extensions`; plan 061 changes that relationship. Child-first-response minus child-first-response-noext estimates the installed-extension-corpus cost.

- commit: `8d3b84d fix(perf): redact successful probe diagnostics`
- runs: 5
- generated: 2026-08-11T11:57:10.125Z

| Measurement | Avg middle runs | Min | Max | Runs | Failed |
| --- | ---: | ---: | ---: | ---: | ---: |
| launcher-dry-run | 8.8ms | 8ms | 11.3ms | 5 | 0 |
| host-import | 1119.7ms | 1099ms | 1869ms | 5 | 0 |
| child-first-response | 1775.7ms | 1740.5ms | 2048.4ms | 5 | 0 |
| child-first-response-noext | 1487.6ms | 1431.4ms | 1499.8ms | 5 | 0 |
| print-mode | 8401.3ms | 7450.2ms | 9643.5ms | 5 | 0 |
| first-frame | 2651.5ms | 2435.1ms | 2706.9ms | 5 | 0 |
| boot-screen-frame | 2650.3ms | 2612ms | 2846ms | 5 | 0 |
| app-ready | 2650.7ms | 2613ms | 2846ms | 5 | 0 |
| stable-chrome | 2650.7ms | 2613ms | 2846ms | 5 | 0 |
| input-ready | 2650.7ms | 2613ms | 2846ms | 5 | 0 |
