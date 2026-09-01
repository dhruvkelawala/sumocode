# SumoCode startup perf snapshot

Report-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas. The retained timeline runs `sumocode.sh --offline --no-extensions --no-session`; do not compare it directly with a normal configured-session workload. It reports editable first paint (`editor_ready`), hydrated command dispatch (`command_ready`), and their gap. The deprecated `input_ready` / `app_ready` aliases remain visible for one release. While startup is serial, first-frame is approximately host-import + child-first-response-noext + hydration round trips because the first-frame probe passes `--no-extensions`; plan 061 changes that relationship. Child-first-response minus child-first-response-noext estimates the installed-extension-corpus cost.

- commit: `d96ea75 fix(startup): keep launch policy behind submit handlers`
- runs: 5
- generated: 2026-09-01T00:03:23.541Z

| Measurement | Avg middle runs | Min | Max | Runs | Failed |
| --- | ---: | ---: | ---: | ---: | ---: |
| launcher-dry-run | 31.1ms | 30.2ms | 312.6ms | 5 | 0 |
| host-import | 1091.3ms | 1076ms | 1901ms | 5 | 0 |
| child-first-response | 2706.9ms | 2456.8ms | 2770.5ms | 5 | 0 |
| child-first-response-noext | 1023.6ms | 952.5ms | 1056.1ms | 5 | 0 |
| print-mode | 2637.8ms | 2258.2ms | 3993.2ms | 5 | 0 |
| first-frame | 533.6ms | 516.8ms | 567.1ms | 5 | 0 |
| boot-screen-frame | 573.7ms | 558ms | 598ms | 5 | 0 |
| editor-ready | 573.7ms | 559ms | 598ms | 5 | 0 |
| command-ready | 1190.3ms | 1146ms | 1229ms | 5 | 0 |
| editor-to-command-gap | 608.3ms | 585ms | 658ms | 5 | 0 |
| app-ready-deprecated | 1190.3ms | 1146ms | 1228ms | 5 | 0 |
| stable-chrome | 1190.3ms | 1146ms | 1228ms | 5 | 0 |
| input-ready-deprecated | 573.7ms | 559ms | 598ms | 5 | 0 |
