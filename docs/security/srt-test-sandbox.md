# Opt-in local test-app sandbox

`SUMOCODE_TEST_SANDBOX=srt` wraps test **apps**, not the trusted Vitest runner,
preflight, admission, process inspection, fixture servers, native builds or
Chromium. It is off by default; unknown modes fail closed. The current wrapper
supports macOS only and has workstation-specific Node/pnpm paths.

## Local setup

Install tools only in the current worktree, outside the sandbox:

```sh
mkdir -p .srt-spike/{tooling,bin,tmp}
npm install --prefix "$PWD/.srt-spike/tooling" --ignore-scripts --no-audit --no-fund \
  @anthropic-ai/sandbox-runtime@0.0.78
cp /bin/ps .srt-spike/bin/ps
codesign -s - -f .srt-spike/bin/ps
```

The copied ps must be a regular executable without setuid/setgid. The wrapper
selects it only inside the app; product probes otherwise use absolute `/bin/ps`.
Install repository dependencies with a frozen lockfile, ignored install scripts
and a local pnpm store. Native tests additionally require the repository's pinned
Bun; visual tests require locally installed Playwright browsers. Neither is
installed automatically by the wrapper.

Supply an owned `TMPDIR` and cwd inside this worktree, an offline environment
without credentials/preloads, and only explicitly required HTTP fixture ports.
For a standalone app:

```sh
SUMOCODE_TEST_SANDBOX=srt TMPDIR="$PWD/.srt-spike/tmp" \
  node scripts/sandbox/run-app.mjs <command> <args...>
```

Do not wrap heavy lanes with `run-sandboxed.sh`: that legacy whole-command
wrapper also fences the trusted runner. App-only lanes use the switch with their
normal entry points and an owned temp namespace. Run heavy lanes sequentially.

## Boundaries and tradeoffs

- `scripts/sandbox/srt-tests.json` is authoritative: private paths remain denied,
  port 7749 is denied, local binding is disabled, and no Unix sockets are granted.
  Exact fixture HTTP ports work through the proxy, not direct TCP grants.
- Generic supervised processes remain trusted infrastructure. App launches and
  PTYs use the shared ESM supervisor; TypeScript facades re-export that seam.
  Admission is signed before execution, and workloads never receive signing keys.
- Run-scoped apps receive unique owned Pi trust fixtures for the canonical test
  checkout. Explicit agent fixtures and native owned-path/config guards take
  precedence. Developer trust/config files are never copied.
- The registered sandbox wrapper PID is not necessarily the app PID; its PGID
  remains the cleanup identity. Do not weaken birth/ownership checks to repair
  sandbox compatibility.

This is an experimental accident fence for trusted checkout tests, **not a
reviewed hostile-code boundary or a general green-heavy-lane recipe**. Prior
source-branch evidence identified retained-owner PID/PGID incompatibility and
cross-run signalling denial. Linux, exhaustive filesystem/IPC/network bypasses,
resource exhaustion and forced-crash cleanup are not validated. Integration,
native and visual behavior must be reverified after composition; prior branch
results are not proof for this integration head.
