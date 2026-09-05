# AGENTS.md overlay for Effect v4 (draft, held for Wave 0.2)

Merge this into `AGENTS.md` once PR #451's documentation reconciliation has landed. It is the
project-specific layer on top of the two installed skills (`effect-ts`, `effect`); where a skill and
this overlay disagree, the overlay wins, and where the overlay and the installed package disagree, the
package wins.

## Section to add: "Learning more about Effect"

```md
## Effect

This repository uses the Effect TypeScript library, pinned exactly (see `package.json`).

Before writing any Effect code, read `node_modules/effect/AGENTS.md` completely and follow its links.
For any API the guide does not cover, search `node_modules/effect/src` at the pinned version. Do not
use Effect 3 memory, blog posts, or skills written against effect-smol betas; names such as
`ServiceMap.Service`, `Schema.TaggedErrorClass`, `Effect.fork`, `Layer.scoped`, `Either`, and
`catchAll` do not exist in the pinned version. The verified v4 cheat sheet lives in
`docs/research/effect-v4-feasibility.md` §6.

### Where Effect is allowed

- Allowed: subagent and terminal lifecycles, the RPC host core behind `runRpcHost()`, typed errors,
  Schema at trust boundaries, and tests (`@effect/vitest`, `TestClock`).
- Never: `src/native/main.ts`, `src/sumo-tui/rpc/spawn-child.mjs`, `sumo-rpc-host.js`, the pre-spawn and
  signal-ownership handoff, `src/sumo-tui/{render,transcript,widgets,layout,input,cathedral}`,
  `src/child-protocol.ts` framing, the `node:fs` I/O layer of `task-store.ts` and
  `activity/persistence.ts`, and `process-tree.ts` identity primitives. A build assertion enforces the
  launcher rule.

### House rules that override the installed `effect` skill

- Deep subpath imports only: `import * as Effect from "effect/Effect"`. Never `from "effect"`, never a
  `@effect/platform-*` barrel, never `effect/testing/FastCheck` or `effect/unstable/encoding` outside
  tests. Lint-enforced.
- No `effect/unstable/*` in production code. Child processes stay on `node:child_process` and files on
  `node:fs`, wrapped as `Context.Service` implementations.
- Do not rewrite `process.env` reads to `Config`; the launcher and readiness paths must stay plain.
- Do not replace the durable stores' hand-rolled caches or locks with `effect/Cache` or
  `KeyValueStore`. They are security primitives, not caches.
- Schema belongs at trust boundaries (RPC frames, config, roles, tool params), never inside per-line
  or per-cell loops. Any schema over a payload SumoCode re-encodes sets `onExcessProperty: "preserve"`.
- No Effect type crosses a Pi boundary: tool `execute` callbacks, `pi.on(...)` handlers, pi-tui
  components, and `TerminalHost` keep Promise or plain signatures. Bridge with
  `ManagedRuntime.runPromise`, `runFork`, `Queue.offerUnsafe`, `Latch.openUnsafe`.
- One `ManagedRuntime` per process, created lazily, disposed on `session_shutdown` or host stop.
  Every fire-and-forget becomes a supervised fork whose failure routes to the existing
  `onDiagnostic` seam, not only to Effect's logger.
- Interruption does not kill processes or panes. Every kill stays explicit; Effect owns only the
  bookkeeping around it.

### Style rules borrowed from OpenCode's Effect guidance

- Do not return `Effect` from a helper unless it performs effectful work. Synchronous parsing,
  validation, and option building stay synchronous.
- Bind services to named variables before calling methods; never `yield* (yield* Foo).bar()`.
- Prefer `Schema.fromJsonString` / `Schema.UnknownFromJsonString` and `decodeUnknownOption` over
  `JSON.parse` wrapped in `Effect.try`.
- Keep layer composition explicit; no broad hidden provisioning that hides a missing dependency.
- Use `it.live` for filesystem, git, child-process, lock, and real-time tests; `it.effect` with
  `TestClock` elsewhere. Never mix `vi.waitFor` with `TestClock` in one file.
```

## Checklist when merging

- [ ] PR #451 merged, so the architecture section this attaches to is current.
- [ ] `effect` pinned in `package.json` (Wave 0.1) so the `node_modules/effect/AGENTS.md` reference resolves.
- [ ] Deep-import lint rule (Wave 0.3) exists, so the import rule above is enforced, not aspirational.
