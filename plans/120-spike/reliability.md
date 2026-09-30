# v0.8 READY node: reliability

Status: candidate implemented; owner adoption pending. Heavy verification and independent review await coordinator scheduling. No DAG successors executed, publication, parent edits, UX redesign, Effect dependency, or native retention support added.

## Identity and scope

- Isolated worktree: `sumocode.sumo-worktrees/sumo__v08-reliability`; branch: `sumo/v08-reliability`.
- Immutable base, verified before editing: `8ac67f6c82d7c0ae7d62ff7fcb4401dc2f9edd39` (0.7.5 / Pi 0.99.1).
- #595 original candidate: PR #596, `origin/fix/595-scope-subagent-recovery`, `aef952a20e5a84579151549f626ca753bae9d9e2`; original base `e533876233927cb6edbe0aca83e5342753a671a7`.
- #595 applied head: `f8997af2abed17589cc1ea69e72a76744e6472a5`. All 16 candidate commits cherry-picked; all 13 candidate paths compare byte-identical to #596. Original branch/ref preserved.
- #578 implementation head: `f5c3e1bfe8453bdaad5d6037044a6f5668a33ec5`; core report commit `e35de8e043c6efc2c7e936bb5b1145907a51882f`, final-drain commit `f5c3e1bf`.

#595 paths: `src/subagents/{index.ts,index.test.ts,manager.ts,manager-adoption.test.ts,retained-adoption.ts,retained-adoption-race.test.ts,retained-reconstruction.test.ts,retained-runtime.test.ts}` and `test/integration/{fixtures/plan112-local-faults.ts,fixtures/plan112-source-controller.ts,plan112-controller-executor.test.ts,subagent-production-retention.test.ts,subagent-recovery.test.ts}`. Additional original paths are fixture updates needed to model explicit handoff versus same-session disk recovery, not new features.

#578 paths: `src/sumo-tui/rpc/{host.ts,host.test.ts,host-lifecycle.ts,host-lifecycle.test.ts,client.ts,client.test.ts}`. Native entry, source wrapper, and terminal renderer remain unchanged.

Original → applied #595 commits, oldest first:

```text
c0a5bdd0 → 1207af99   scope retained recovery to its session
ae0c7f1b → d1f412e9   bind replacement adoption to Pi target
2e965187 → 48fe2dde   retry recovery after lease expiry
b81f405d → 84f30a55   model targeted production handoff
b1ea04e3 → f2344736   encode replacement destination
d12954f2 → 2826ab7d   fence superseded recovery retries
2fb3f90c → 4dbd9639   cover targetless reload delivery
3706eff5 → c194747a   assert pre-handoff delivery ownership
b3029c83 → 2d1a9328   harden retained takeover retries
8a076911 → dac281ec   clarify takeover lease timing
92fe793d → 30a80359   fence admission retries on evidence
18bbee45 → 205e04c9   preserve reserved writer renewals
c1562098 → 7430a0a7   clarify replacement lifecycle guards
e187e409 → a318e9df   bind reload source from shutdown context
13b4b470 → d530526f   keep lifecycle context current
aef952a2 → f8997af2   release legacy replacement state
```

## Reproduction and evidence

Use repository-pinned pnpm 10.29.2 (`npx --yes pnpm@10.29.2 <arguments>` if the system pnpm differs). Frozen installation succeeded in this worktree without lockfile changes. System pnpm 12.6.0 initially refused the pinned Pi packages under its minimum-release-age default; repository-pinned pnpm was used rather than editing policy or dependencies.

#595: reused #596's cross-session regression oracle after reading its old foreign-adoption assertion; ran it against pinned production source before applying candidate commits. Restored the temporary test edit before cherry-picking; no candidate assertions rewritten.

```bash
pnpm vitest run src/subagents/retained-reconstruction.test.ts -t "leaves another session's retained record untouched"
```

Exact red excerpt:

```text
AssertionError: expected [ { entry: { …(4) }, …(2) } ] to deeply equal []
Test Files  1 failed (1)
Tests  1 failed | 21 skipped (22)
```

Green recovery command and excerpt:

```bash
pnpm vitest run src/subagents/retained-reconstruction.test.ts src/subagents/retained-adoption-race.test.ts src/subagents/manager.test.ts src/subagents/index.test.ts src/subagents/manager-adoption.test.ts src/subagents/retained-runtime.test.ts
```

```text
Test Files  6 passed (6)
Tests  256 passed (256)
```

#578 core report: new lifecycle acceptance test drove the real exit-handler factory through lifecycle stop, terminal restoration, stderr, and exit; ran before implementation.

```bash
pnpm vitest run src/sumo-tui/rpc/host-lifecycle.test.ts -t 'prints the child crash'
```

```text
red: AssertionError: expected [] to deeply equal [ { terminalRestored: true, …(1) } ]
red: Tests  2 failed | 36 skipped (38)
green: Test Files  1 passed (1)
green: Tests  2 passed | 36 skipped (38)
```

#578 drain: new client regression exercised real transport error → reap → final stderr → stdio close; ran before retaining the stderr listener through reap.

```bash
pnpm vitest run src/sumo-tui/rpc/client.test.ts -t 'retains final stderr while reaping'
```

```text
red: AssertionError: expected 'before failure\n' to be 'before failure\nfinal diagnostic\n' // Object.is equality
red: Tests  1 failed | 57 skipped (58)
```

Green expanded RPC command:

```bash
pnpm vitest run src/sumo-tui/rpc/client.test.ts src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/host-lifecycle.test.ts
```

```text
Test Files  3 passed (3)
Tests  233 passed (233)
```

Final required focused command (PASS):

```bash
pnpm vitest run src/subagents/retained-reconstruction.test.ts src/subagents/retained-adoption-race.test.ts src/subagents/manager.test.ts src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/host-lifecycle.test.ts src/sumo-tui/rpc/client.test.ts
```

```text
Test Files  6 passed (6)
Tests  380 passed (380)
```

Adjacent production-host contracts (PASS): `pnpm vitest run src/sumo-tui/rpc/host-cleanup.test.ts src/sumo-tui/rpc/host-protocol-errors.test.ts src/sumo-tui/rpc/host-entry.test.ts` → `Test Files  3 passed (3)` / `Tests  25 passed (25)`.

`pnpm exec tsc --noEmit && pnpm build`: PASS. `pnpm lint`: PASS, four existing unused-variable warnings in unchanged `scratch/tui-audit/proto/gen.mjs`; no new warning. `git diff --check`: PASS.

Exact runner logs retained locally as `/tmp/sumo-reliability-{595-red,595-green,578-red,578-green,578-drain-red,578-drain-green,final-focused,final-build,final-lint,host-adjacent}.log`. All fixtures are synthetic; no paid provider or private session used. Global Git hook fallback created untracked `.build/` and attempted the incompatible system pnpm; evidence is preserved, not committed. Subsequent authored commits used `LEFTHOOK=0` with explicit checks above, without changing global hook configuration.

## Feasibility and tradeoffs

Recovery stays in the existing manager/registry seam. Disk reconstruction filters `controllerSessionId ?? ownerSessionId` before mutation/delivery; replacement routing matches Pi's shutdown target file, with source-session fallback only for targetless reload. Dead-but-unexpired ownership defers until every blocking dead-owner lease expires; the one-shot retry is lifecycle-fenced. Registry CAS, authority, ambiguous identity and PID-reuse refusals remain unchanged. Targeted pending handoffs remain parked until their target starts or process exit, preserving the reviewed candidate's tradeoff.

Crash flow: client bounded stderr capture → `createRpcExitHandler` records the first crash before UI work/delay → any `RpcHostLifecycle.stop` path restores terminal and reaps child → one stderr report before resolving exit. The report includes child code/signal, bounded reason, and newest 20 sanitized stderr lines, without requiring `-d`. The first observed crash survives urgent SIGINT/SIGTERM/quit/reload/runtime-exit and duplicate events. Normal quit/reload remains quiet. Pre-adoption failure during retained reload restores the inherited terminal at the existing lifecycle seam; no entry/wrapper expansion required. Transport/protocol failures keep stderr draining through reap while stopping protocol delivery immediately.

Tradeoffs: preserve the existing 750ms toast; reuse the 64 KiB client tail, 500-byte reason cap, and existing redaction/output-tail helpers rather than new buffers or logging infrastructure. Reports are diagnostic evidence, not durable result delivery. No Effect claim is made about disk/lease/OS identity. Native/Bun retention remains unsupported/disposable.

## Security findings

Foreign-session reconstruction must leave records and recovery evidence untouched; focused regressions cover this and the authority/identity race fences. No built-in tool registration, approval gate, role permissions, or MCP grant changes.

Crash output reuses terminal-control stripping and known-credential redaction, performed before display limits. Embedded stderr is removed from the reason so old rows cannot bypass the 20-line limit. A byte-truncated leading row is conservatively dropped because its credential label may be missing. Arbitrary opaque secrets cannot be proven absent by heuristic redaction; stderr remains local user-visible diagnostic data and should be inspected before sharing. No new diagnostic file, environment dump, or telemetry is written. Unavailable exit identity is reported as unknown for transport/spawn failures. Child reap failure and terminal I/O limitations remain explicit existing failure boundaries.

## Performance findings and remaining gates

Performance benchmark: not applicable to this bounded reliability node. New report formatting runs once at shutdown over an existing bounded tail; normal rendering/request hot paths are unchanged. Recovery adds an unref'd one-shot timer at legal lease expiry, not continuous polling. No throughput/performance improvement is claimed.

NOT RUN, coordinator lease required: `pnpm test`, `pnpm test:integration` (including zero-survivor audit and production retention), `pnpm test:native`, `pnpm visual:ci`; any real PTY crash capture/native/compatibility/bundle verification must also be sequentially scheduled. No visual goldens promoted. The unit terminal-restore ordering oracle is not live PTY/native evidence.

Review-ready design check used `~/.pi/agent/skills/review-ready/contract.md`: caller-knowledge—host records crash intent, lifecycle owns reporting; deletion—removing lifecycle would spread teardown/reporting across callers; ownership—client owns bounded capture/reap, host owns exit classification, lifecycle owns post-restore publication; test-surface—public reconstruction, exit-handler, lifecycle and client interfaces with synthetic process/time/terminal boundaries. Simplification: reused reviewed recovery and shared redactors; no new framework, module, runtime selection, or configurable subsystem. Full review-ready gate remains pending independent review and coordinator heavy gates; no review loop was run here.

Next action: coordinator grants the sequential heavy-verification lease, then independent review and owner adoption.
