# pi-cmux configurable agent command boundary

Date: 2026-06-10  
Milestone: v0.4  
Issue: #280

## Decision

SumoCode keeps its small local cmux layer for v0.4 and treats `pi-cmux` as prior art until `pi-cmux` can launch an arbitrary Pi-compatible agent command without hardcoding `exec pi`.

SumoCode must never load a command path that opens classic Pi when the user intended SumoCode. `bin/sumocode.sh` owns the retained renderer environment (`SUMO_TUI=1`, `SUMO_TUI_MODULE`, launcher guards, diagnostics, task mode), so cmux helpers must launch `sumocode`, not `pi`, when invoked from SumoCode.

## Desired upstream seam

Upstream `pi-cmux` should make the launched agent configurable while preserving default Pi behavior:

```ts
const agentCommand = process.env.PI_CMUX_AGENT_COMMAND ?? "pi";
const agentLabel = process.env.PI_CMUX_AGENT_LABEL ?? "Pi";
const notifyTitle = process.env.PI_CMUX_NOTIFY_TITLE ?? agentLabel;
```

The command should be argv/template safe for paths with spaces. A single shell string is acceptable only if `pi-cmux` keeps robust shell escaping; otherwise prefer command + args fields such as:

```bash
PI_CMUX_AGENT_COMMAND="/Volumes/SumoDeus NVMe/code/sumocode/bin/sumocode.sh"
PI_CMUX_AGENT_ARGS="--no-session"
PI_CMUX_AGENT_LABEL="SumoCode"
```

## SumoCode v0.4 stance

- Do not depend on/load `pi-cmux` commands in SumoCode v0.4.
- Continue using `src/commands/cmux-split.ts`, the small attributed helper copied from `pi-cmux` with SumoCode-safe command construction.
- Keep worktree and review commands local until upstream has the agent-command seam and SumoCode has tested it in retained mode.
- If upstream-first work is taken on, open an upstream issue/PR against `pi-cmux` adding configurable agent command/label/notify title with default behavior unchanged.

## Roadmap impact

Issues #273 and #275 intentionally use SumoCode-local git/cmux helpers. `pi-cmux` remains a reference for split discovery, pane labels, notifications, and worktree continuation UX, not a runtime dependency.
