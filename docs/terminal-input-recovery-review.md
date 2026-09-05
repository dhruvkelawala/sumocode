# Terminal input recovery review

Status: partial repair of reviewsa100 on c9ed6d2f; high finding remains blocking.

## Repaired

The router consumes a mouse token only when `parseSgrMouseEvent` validates the
whole token. Unknown complete CSI and invalid mouse coordinates pass through
intact. A bracketed paste remains one token, including embedded `ESC[<` bytes.

Ordinary text may reach custom runtime editors per grapheme. Bracketed paste and
raw multiline draft chunks must reach them atomically; runtime tests assert the
individual calls, not only their concatenation. No transport or PTY regression
was changed.

## Recovery policy needs an owner decision

Current behavior is **not bounded**: an unterminated paste, or the generic
incomplete-CSI fallback, can retain subsequent input indefinitely. This repair
does not claim to fix that high finding.

Pi's `StdinBuffer` retains paste until `ESC[201~`; its sequence timeout does not
end paste. `Editor.handleInput` likewise accumulates paste until that delimiter.
`Editor.handlePaste` inserts one undo operation, normalizes text and filters
controls. `CustomEditor.handleInput` checks application actions before the base
editor's paste logic. Thus forwarding a pasted Ctrl-D separately is unsafe even
if the base editor previously entered paste mode.

No idle duration proves a paste ended. Resetting after timeout/overflow makes a
late paste tail executable. Synthesizing an end marker also lies about stream
ownership. A keyboard cancel gesture can itself occur literally inside a paste.

Recommended next policy, **not implemented or approved**:

- Reuse the existing delayed-dispatch timer for bounded partial CSI lifetime;
  keep bare Escape's 25 ms behavior. Validate CSI prefixes and cap retained UTF-8
  bytes, not UTF-16 code units. Forward failed non-paste sequences intact, never
  split their interior into command tokens.
- For paste idle/overflow, enter explicit recovery rather than normal key
  routing. Show truthful feedback and keep late bytes non-executable until an
  actual end delimiter or an out-of-band, user-confirmed input reset.
- The owner must choose the recovery surface and data policy: bounded retained
  prefix with explicit truncation feedback, or private literal recovery storage.
  Neither silent loss nor unbounded memory is acceptable. Storage needs its own
  sensitive-input policy; do not log paste contents.
- Only after that decision choose numerical limits and implement shared-router
  ownership, timer clearing, focus/disposal safety, and router continuation
  tests (including late Ctrl-D, Unicode byte bounds and fragmented delimiters).

The tradeoff is explicit: safe quarantine cannot also promise automatic normal
keyboard recovery when the terminal never sends the paste terminator. An
out-of-band recovery action requires caller/UI work, not just a parser timer.

## Evidence

- Before mouse repair: serial router suite, 2 failed / 49 passed. Both unknown
  CSI cases disappeared; their following normal `x` survived.
- After repair: serial router + RPC runtime suites, 107 passed. Final serial
  router, mouse, classic viewport controller, RPC runtime and Cathedral editor
  suites: 165 passed, including the existing bare-Escape delayed dispatch case.
  Changed-file Oxlint and `git diff --check`: passed.
- `pnpm exec tsc --noEmit && pnpm build`: passed.
- Runtime atomic-caller assertions passed on first run (coverage strengthening,
  not a claim of a new RED→GREEN runtime bug fix).
- Full unit, PTY/integration, native and visual gates remain pending with sa95.
  No installs, heavy gates, golden promotion or harness changes were performed.
