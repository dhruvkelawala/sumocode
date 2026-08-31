# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas. The retained timeline runs `sumocode.sh --offline --no-extensions --no-session`; do not compare it directly with a normal configured-session workload. It reports editable first paint (`editor_ready`), hydrated command dispatch (`command_ready`), and their gap. The deprecated `input_ready` / `app_ready` aliases remain visible for one release. While startup is serial, first-frame is approximately host-import + child-first-response-noext + hydration round trips because the first-frame probe passes `--no-extensions`; plan 061 changes that relationship. Child-first-response minus child-first-response-noext estimates the installed-extension-corpus cost.

- commit: `0baa533 fix(startup): keep launch policy behind submit handlers`
- runs: 5
- generated: 2026-08-31T23:18:34.101Z

| Measurement | Avg middle runs | Min | Max | Runs | Failed |
| --- | ---: | ---: | ---: | ---: | ---: |
| launcher-dry-run | 30.8ms | 30.2ms | 487.2ms | 5 | 0 |
| host-import | 1087.3ms | 1063ms | 1605ms | 5 | 0 |
| child-first-response | 3313.7ms | 3227.4ms | 4408.5ms | 5 | 0 |
| child-first-response-noext | 2022.9ms | 1955.6ms | 2037.1ms | 5 | 0 |
| print-mode | 3870.9ms | 3633.6ms | 4418.6ms | 5 | 0 |
| first-frame | 492.7ms | 486.2ms | 499.6ms | 5 | 0 |
| boot-screen-frame | 500.3ms | 491ms | 506ms | 5 | 0 |
| editor-ready | 500.7ms | 491ms | 506ms | 5 | 0 |
| command-ready | 2046.3ms | 2035ms | 2105ms | 5 | 0 |
| editor-to-command-gap | 1550.3ms | 1530ms | 1599ms | 5 | 0 |
| app-ready-deprecated | 2046ms | 2035ms | 2104ms | 5 | 0 |
| stable-chrome | 2046ms | 2035ms | 2104ms | 5 | 0 |
| input-ready-deprecated | 500.7ms | 491ms | 506ms | 5 | 0 |
