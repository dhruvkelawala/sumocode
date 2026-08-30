# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas. The retained timeline runs `sumocode.sh --offline --no-extensions --no-session`; do not compare it directly with a normal configured-session workload. It reports editable first paint (`editor_ready`), hydrated command dispatch (`command_ready`), and their gap. The deprecated `input_ready` / `app_ready` aliases remain visible for one release. While startup is serial, first-frame is approximately host-import + child-first-response-noext + hydration round trips because the first-frame probe passes `--no-extensions`; plan 061 changes that relationship. Child-first-response minus child-first-response-noext estimates the installed-extension-corpus cost.

- commit: `0a00886 docs(plans): correct stale non-empty wording in 096 class-5 spec`
- runs: 5
- generated: 2026-08-30T23:10:31.143Z

| Measurement | Avg middle runs | Min | Max | Runs | Failed |
| --- | ---: | ---: | ---: | ---: | ---: |
| launcher-dry-run | 30.5ms | 30ms | 31.1ms | 5 | 0 |
| host-import | 1101ms | 1083ms | 1116ms | 5 | 0 |
| child-first-response | 2370ms | 2349.7ms | 2385.9ms | 5 | 0 |
| child-first-response-noext | 903.1ms | 891ms | 993.8ms | 5 | 0 |
| print-mode | 6846.3ms | 6272.9ms | 7273ms | 5 | 0 |
| first-frame | 501.2ms | 495.9ms | 506.2ms | 5 | 0 |
| boot-screen-frame | 516.3ms | 506ms | 533ms | 5 | 0 |
| editor-ready | 516.3ms | 506ms | 533ms | 5 | 0 |
| command-ready | 1069.3ms | 1044ms | 1079ms | 5 | 0 |
| editor-to-command-gap | 550.3ms | 534ms | 558ms | 5 | 0 |
| app-ready-deprecated | 1069ms | 1044ms | 1079ms | 5 | 0 |
| stable-chrome | 1069ms | 1044ms | 1079ms | 5 | 0 |
| input-ready-deprecated | 516.3ms | 506ms | 533ms | 5 | 0 |
