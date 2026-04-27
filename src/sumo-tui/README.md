# sumo-tui v0.1

`sumo-tui` is SumoCode's Node-native retained terminal renderer foundation.

Phase 1 only owns terminal lifecycle:

- enter/exit alternate screen cleanly
- enable xterm SGR mouse reporting so wheel events stop degrading into editor history keys
- restore kitty keyboard, modifyOtherKeys, bracketed paste, mouse modes, cursor visibility, and SGR state on shutdown/signals/crashes

No new UI is shipped in this phase. Pi still owns the editor, agent loop, extension API, and existing Cathedral components while `src/sumo-tui/runtime/` proves safe terminal ownership.

Sources: accepted ADR `docs/adr/0001-sumo-tui-framework.md`, Phase 1 plan `docs/research/sumo-tui-spike/IMPLEMENTATION_PLAN.md`, edge-case catalog `docs/research/sumo-tui-spike/EDGE_CASES.md`, and OpenCode/OpenTUI altscreen research `docs/research/sumo-tui-spike/01-opencode.md` section 2.
