# SumoCode setup and durable state

Choose the native release or portable source setup in [README.md](README.md#install). Source development commands run from the repository root; see [DEV_LOOP.md](DEV_LOOP.md). The public MIT repository contains product code. Persona, memory, settings, MCP and personal skills belong in the separate private sumocode-config repository and the user's Pi agent directory.

## Authentication presence

Configure providers through Pi's supported authentication/settings flow. Check only presence when troubleshooting; never print credential values:

```bash
if [ -n "${OPENAI_API_KEY:-}" ]; then
  printf 'provider credential configured\n'
else
  printf 'provider credential absent\n'
fi
```

This checks the environment variable only; it does not test credentials or inspect Pi's saved authentication.

## State ownership

The agent directory defaults to ~/.pi/agent and may be selected by `PI_CODING_AGENT_DIR`. These are user-owned runtime data, never source files to commit.

| State | Default root and override | Ownership and retention |
|---|---|---|
| Terminal | agent directory / state/sumocode-terminals | Schema-v4 session-owned records, task artifacts and locks; `0700` directories, `0600` files. Stop/recovery verifies process identity before signaling. |
| Activity | (`SUMOCODE_STATE_DIR` or agent directory / state) / sumocode/activity/v1/<session hash> | SHA-256 session key; producer owns feed.json and writer.json, host owns ui.json. Private `0700`/`0600` storage; output is bounded and redacted for known patterns but may still contain opaque secrets. |
| Subagents | same state base / sumocode/subagents/v2 | Private registry and tasks directories contain leases, bootstrap/result evidence and separate disposition metadata. Completion evidence is immutable; uncertain ownership refuses control. |
| Sessions | agent directory / sessions | Pi owns session history and resume/fork behavior. Retained work uses verified session ownership and explicit handoff. |
| Personal config | agent directory, often symlinked from private sumocode-config | The user's private configuration stays outside this public checkout. |

There is no automatic deletion of retained task evidence as part of recovery or disposition. Display compaction and in-memory bounds do not authorize deleting user data. Worktree prune is a separate confirmed action, requires a clean worktree with no ignored files, and preserves its branch and completion artifacts. Do not delete state to troubleshoot ownership failures; inspect the reported evidence and preserve it for recovery.

Physical Node source launches support retained subagent ownership on macOS/Linux. Native/Bun and unsupported executable distributions remain disposable and report that limit. See [README.md](README.md#retained-work-and-review) for the proof boundaries.

## Local checks

```bash
pnpm install
./bin/sumocode.sh doctor
./bin/sumocode.sh --dry-run
pnpm dev .
```

The interactive shell should show the active theme and accept editor input. Command readiness follows hydration; [startup measurements](docs/perf/startup.md) distinguish editor_ready from command_ready. Debug traces are opt-in and are separate from the durable stores above.
