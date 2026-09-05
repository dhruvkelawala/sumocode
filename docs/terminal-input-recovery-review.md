# Terminal input recovery review

Status: bounded recovery implemented above 6537d4f0; serial verification passed.
Heavy runtime/visual verification remains pending, not waived.

## Preserved repairs

The router consumes a mouse token only when `parseSgrMouseEvent` validates the
whole token. Unknown complete CSI and invalid mouse coordinates pass through
intact. A bracketed paste remains one token, including embedded `ESC[<` bytes.

Ordinary text may reach custom runtime editors per grapheme. Bracketed paste and
raw multiline draft chunks reach them atomically; runtime tests assert individual
calls, not only their concatenation. The committed medium repair and runtime
atomic assertions remain intact. No transport or PTY regression was changed.

## Coordinator-chosen policy

The coordinator selected bounded, memory-only quarantine under the user's
authorization to continue the repair without confirmations. This is a recorded
implementation decision, not a claim of verbatim user approval of numerical
limits or UI captures.

- Incomplete CSI retains at most 256 UTF-8 bytes and uses the existing 25 ms
  delayed-dispatch lifecycle (also retained for bare Escape and SS3). Invalid
  prefixes and over-limit unfinished CSI forward atomically, never as Escape
  followed by executable interior keys. Complete unknown CSI stays intact.
  A recognizable paste opener, including a trailing fragmented opener, after
  malformed CSI starts router-owned paste; the preceding failed prefix is one
  opaque event. Otherwise Pi would start an unbounded editor paste behind the
  router. Time expiry applies before an actual paste opener is assembled; it
  never applies as an end delimiter after that opener has been recognized.
- No existing project paste byte bound was found. Paste retains a maximal
  whole-codepoint UTF-8 prefix of **64 KiB (65536 bytes)** in memory only.
  Once a codepoint does not fit, later bytes cannot fill the remaining space:
  this is a prefix, not a filtered selection. Overflow counts exclude delimiters.
- **1000 ms inactivity or overflow** enters visible **INPUT PAUSED** quarantine.
  Neither case synthesizes a terminator or enables normal command routing.
  Ctrl-D, Ctrl-C, unknown CSI, SGR mouse, and ordinary typing remain paste data.
  Silence cannot prove that a paste ended.
- The router retains the prefix until the actual `ESC[201~` is assembled,
  including across chunks. It then emits at most one complete bracketed-paste
  event containing the prefix, followed by any genuine subsequent key events.
  Recovery feedback reports retained/limit and truncated byte counts; it never
  includes payload text. If the application session gate blocks the completed
  event, feedback explicitly reports retained bytes not inserted rather than
  claiming delivery. That gate's existing no-cross-session draft policy remains.
- Each consumer has **one persistent notice slot**, not a new toast on every
  chunk. Counts update in place while paused; completion replaces that notice
  with resumed/count feedback. It does not auto-dismiss while quarantine owns
  input. Text wraps, including the restart guidance, using theme tokens and
  shared typed render primitives; no hand-written ANSI or golden promotion.
- Recovery without a terminator is an **operator-managed terminal/session
  restart from outside the input stream**. The operator must first end the
  terminal's paste stream; restarting into a still-arriving tail is unsafe.
  There is no keyboard cancel, SGR mouse reset, new signal, private recovery
  file, CLI reset framework, or invented out-of-band reset API.

The unavoidable tradeoff: if the terminal never sends a terminator, normal
keyboard input cannot safely be distinguished from paste contents. It remains
visibly paused, rather than silently consuming input or guessing that timeout
made the next Ctrl-D safe. Restart loses the memory-only retained prefix;
without restart, a natural terminator delivers it normally (subject to the
existing application input gate). Overflow loses only the suffix, with explicit
truncation feedback. This deliberately sacrifices unlimited paste size and
in-band recovery for bounded memory and non-executable late tails.

## Ownership, lifecycle and complexity

`SharedInputRouter.handleInput` owns framing, byte limits, timers, quarantine,
count-only notices and diagnostic redaction. Callers supply a notice setter,
not parser flags or manual reset transitions. All bracketed-paste input and
continuations are redacted from raw/route/mouse diagnostic hex, even after
sensitive focus changes; diagnostic lengths remain available. No payload is
written to a recovery file or diagnostic log by this repair.

`clearPendingMouseInput` and focus/session changes do not release paste
ownership (including a recognizable partial opener). Disposal cancels the one
pending timer, releases retained memory, and permanently consumes late calls
without executing them. Repeated clear/disposal cannot revive the instance.
A replacement router/process is not a safe reset for an active incoming paste;
the operator-ended-stream requirement still applies.

The RPC runtime's session input gate now runs on router-framed events, not raw
stdin chunks. Its Ctrl-C escape hatch remains for actual keys, not late paste
bytes. Apple Terminal's Shift-Enter probe also runs on framed non-paste events.
The runtime stop path disposes the router. The classic viewport controller owns
its editor-adjacent notice wrapper and restores it on disposal. These are the
minimal caller/runtime seam changes; no host lifecycle implementation in
`host.ts`, native build, launcher, or harness files were edited.

Paste storage is a single fixed-size Buffer plus counters and a tail of at most
five delimiter characters (or one split UTF-16 high surrogate). Each new chunk
is scanned with only that bounded tail, never concatenated with or rescanned
against a growing retained prefix. UTF-8 writes use the remaining buffer space;
completion decodes the retained prefix once. Work is linear in incoming paste
size, with bounded retained allocation. Counters saturate at MAX_SAFE_INTEGER.
Token regex matching is sticky, avoiding repeated scans ahead for unrelated
escape/paste sequences during ordinary text tokenization.

Pi's `CustomEditor.handleInput` checks extension shortcuts, clipboard actions,
interrupt, empty-editor `app.exit`, history and other exact key actions **before**
base `Editor.handleInput` handles paste. Base Editor accumulates until the actual
end delimiter; paste insertion is one undo operation with normalization/control
filtering. Sending partial paste bytes downstream would therefore be unsafe.
The tests include the real Cathedral → Pi CustomEditor chain, not just a fake
string accumulator. This repair bounds the shared-router/RPC stdin seam; it
does not modify Pi's separate upstream `StdinBuffer` in the classic runtime.

## Verification and remaining gates

- CSI tracer test: 4 failed / 51 passed before repair; 55 passed after repair.
- Paste tracer tests: 3 failed / 54 passed before repair; 57 passed after repair.
- Malformed CSI followed by a paste opener: 2 failed / 62 passed before the
  boundary fix. The regression ensures the opener never leaks to Pi behind
  the router.
- Malformed CSI with CR before a fragmented opener: 1 failed / 65 passed
  before fixing the raw-multiline normalization bypass. Additional CR/LF draft
  assertions preserve atomic multiline input before a fragmented opener.
- Final serial router, mouse, classic viewport controller, RPC runtime,
  Cathedral editor and notice suites: **189 passed**, covering the original
  165 tests plus recovery cases. Command:
  `pnpm vitest run src/sumo-tui/input/shared-input-router.test.ts src/sumo-tui/input/mouse.test.ts src/sumo-tui/pi-compat/chat-viewport-controller.test.ts src/sumo-tui/rpc/runtime.test.ts src/cathedral/cathedral-editor.test.ts src/sumo-tui/widgets/input-recovery-notice.test.ts --maxWorkers=1 --no-file-parallelism`.
- `pnpm exec tsc --noEmit && pnpm build`, changed-file Oxlint and
  `git diff --check`: **passed**.
- Full unit, PTY/integration, native builds/tests, visual captures/review and
  `pnpm visual:ci` remain **pending the coordinator's heavy-work grant**. sa105
  owns native work. The notice still requires capture/review evidence after
  that grant; unit wrapping assertions are not visual approval.
- No installs, heavy gates, new OS signals, golden promotion, push, or edits to
  the sa111 host lifecycle / sa105 native build / sa90 harness ownership areas.

## Review-ready gate

- Contract: bundled `review-ready/contract.md` (no repository override found).
- Changed seam: shared terminal framing/recovery and count-only caller UI.
- Trace: fragmented opener → bounded prefix → idle/overflow notice → inert late
  controls → actual fragmented terminator → one paste event → real Ctrl-D.
- Caller-knowledge: UI setters render a message; gates see whole events only.
- Deletion: removing the router would spread framing and recovery policy into
  both consumers; policy therefore stays here.
- Ownership: limits, lifecycle and recovery copy remain router-owned; the
  notice component owns only wrapping and theme-aware paint.
- Test-surface: router callbacks, classic public controller, runtime stdin and
  real editor contract; no assertions on private parser fields.
- Simplification: fixed buffer and one timer/notice slot; no recovery storage,
  reset protocol or configurable parser policy. Existing notification/editor
  rendering bridges are reused, with a small typed notice component.
- Exceptions: heavy/visual gates deferred by coordination, not claimed green;
  upstream classic Pi buffering and deliberate memory-only/truncation tradeoffs
  are explicitly outside this shared-router repair.
