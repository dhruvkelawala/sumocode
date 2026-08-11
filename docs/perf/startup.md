# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas. While startup is serial, first-frame is approximately host-import + child-first-response-noext + hydration round trips because the first-frame probe passes `--no-extensions`; plan 061 changes that relationship. Child-first-response minus child-first-response-noext estimates the installed-extension-corpus cost.

- commit: `4d61167 fix(perf): redact failed probe diagnostics`
- runs: 5
- generated: 2026-08-11T11:33:41.394Z

| Measurement | Avg middle runs | Min | Max | Runs | Failed |
| --- | ---: | ---: | ---: | ---: | ---: |
| launcher-dry-run | 8.3ms | 8.2ms | 9.2ms | 5 | 0 |
| host-import | 1146.3ms | 1121ms | 1565ms | 5 | 0 |
| child-first-response | 1755.4ms | 1643.1ms | 2887.1ms | 5 | 0 |
| child-first-response-noext | 1464.6ms | 1420.1ms | 1493.3ms | 5 | 0 |
| print-mode | 7385.3ms | 6017.2ms | 8352.1ms | 5 | 0 |
| first-frame | 2685.5ms | 2524.4ms | 2839.1ms | 5 | 0 |
| boot-screen-frame | 2855.3ms | 2682ms | 2946ms | 5 | 0 |
| app-ready | 2855.3ms | 2682ms | 2946ms | 5 | 0 |
| stable-chrome | 2855.3ms | 2682ms | 2946ms | 5 | 0 |
| input-ready | 2855.3ms | 2682ms | 2946ms | 5 | 0 |
