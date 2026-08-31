# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas. The retained timeline runs `sumocode.sh --offline --no-extensions --no-session`; do not compare it directly with a normal configured-session workload. It reports editable first paint (`editor_ready`), hydrated command dispatch (`command_ready`), and their gap. The deprecated `input_ready` / `app_ready` aliases remain visible for one release. While startup is serial, first-frame is approximately host-import + child-first-response-noext + hydration round trips because the first-frame probe passes `--no-extensions`; plan 061 changes that relationship. Child-first-response minus child-first-response-noext estimates the installed-extension-corpus cost.

- commit: `26036a6 fix(startup): settle hydration gate before launch-seeded kickoff submit`
- runs: 5
- generated: 2026-08-31T22:38:17.790Z

| Measurement | Avg middle runs | Min | Max | Runs | Failed |
| --- | ---: | ---: | ---: | ---: | ---: |
| launcher-dry-run | 31.2ms | 30ms | 32.5ms | 5 | 0 |
| host-import | 1068.3ms | 1064ms | 1646ms | 5 | 0 |
| child-first-response | 3392.7ms | 3343.2ms | 3948.5ms | 5 | 0 |
| child-first-response-noext | 1966.6ms | 1848ms | 2005.4ms | 5 | 0 |
| print-mode | 7152ms | 6900.6ms | 7720.9ms | 5 | 0 |
| first-frame | 484.1ms | 481.7ms | 486.2ms | 5 | 0 |
| boot-screen-frame | 496ms | 493ms | 512ms | 5 | 0 |
| editor-ready | 496ms | 493ms | 512ms | 5 | 0 |
| command-ready | 2074ms | 1940ms | 2120ms | 5 | 0 |
| editor-to-command-gap | 1574ms | 1440ms | 1627ms | 5 | 0 |
| app-ready-deprecated | 2074ms | 1939ms | 2120ms | 5 | 0 |
| stable-chrome | 2074ms | 1939ms | 2120ms | 5 | 0 |
| input-ready-deprecated | 496ms | 493ms | 512ms | 5 | 0 |
