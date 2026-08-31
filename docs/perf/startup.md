# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas. The retained timeline runs `sumocode.sh --offline --no-extensions --no-session`; do not compare it directly with a normal configured-session workload. It reports editable first paint (`editor_ready`), hydrated command dispatch (`command_ready`), and their gap. The deprecated `input_ready` / `app_ready` aliases remain visible for one release. While startup is serial, first-frame is approximately host-import + child-first-response-noext + hydration round trips because the first-frame probe passes `--no-extensions`; plan 061 changes that relationship. Child-first-response minus child-first-response-noext estimates the installed-extension-corpus cost.

- commit: `843cb91 fix(startup): report reload editor readiness before hydration`
- runs: 5
- generated: 2026-08-31T22:50:21.135Z

| Measurement | Avg middle runs | Min | Max | Runs | Failed |
| --- | ---: | ---: | ---: | ---: | ---: |
| launcher-dry-run | 34.1ms | 31.4ms | 36.4ms | 5 | 0 |
| host-import | 1078ms | 1064ms | 1297ms | 5 | 0 |
| child-first-response | 3373.8ms | 3268.3ms | 5812.8ms | 5 | 0 |
| child-first-response-noext | 1961.3ms | 1775.2ms | 2031ms | 5 | 0 |
| print-mode | 7552.8ms | 7138ms | 8020.5ms | 5 | 0 |
| first-frame | 486ms | 484.6ms | 495.4ms | 5 | 0 |
| boot-screen-frame | 494.7ms | 490ms | 504ms | 5 | 0 |
| editor-ready | 494.7ms | 490ms | 504ms | 5 | 0 |
| command-ready | 2033.3ms | 1938ms | 2047ms | 5 | 0 |
| editor-to-command-gap | 1536.3ms | 1448ms | 1550ms | 5 | 0 |
| app-ready-deprecated | 2033.3ms | 1938ms | 2046ms | 5 | 0 |
| stable-chrome | 2033.3ms | 1938ms | 2047ms | 5 | 0 |
| input-ready-deprecated | 495ms | 490ms | 504ms | 5 | 0 |
