# SumoCode startup perf snapshot

Recorded Plan 094 source baseline at the commit and date below, not a measurement of the current checkout. These report-only numbers are not CI gates. The retained timeline runs the source launcher with --offline --no-extensions --no-session, so it is not comparable to a normal configured session or the native release. It distinguishes editable first paint (`editor_ready`) from hydrated command dispatch (`command_ready`) and their gap. Deprecated aliases in the recorded table are historical labels. See [DEV_LOOP.md](../../DEV_LOOP.md) for current verification and the [plan ledger](../../plans/README.md) for completion status.

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
