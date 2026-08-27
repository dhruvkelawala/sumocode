# Plan 092: Send native RPC images without losing queued attachments

> **Executor instructions**: Do not execute until Plans 088 and 090 are DONE.
> The target release's `clear_queue` is text-only. Implement native images for
> submissions Pi can accept immediately, and fail closed for busy/compacting
> attachment submissions unless the published protocol has gained structured,
> recoverable queue entries. Never log base64, silently drop an attachment, or
> convert a native-image submission back to a path without telling the user.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 1ad967b..HEAD -- \
>   src/cathedral/editor-draft-state.ts src/cathedral/editor-draft-state.test.ts \
>   src/cathedral/cathedral-editor.ts src/cathedral/cathedral-editor.test.ts \
>   src/sumo-tui/rpc/clipboard-paste.ts src/sumo-tui/rpc/clipboard-paste.test.ts \
>   src/sumo-tui/rpc/editor.ts src/sumo-tui/rpc/editor.test.ts \
>   src/sumo-tui/rpc/host.ts src/sumo-tui/rpc/host.test.ts \
>   src/sumo-tui/rpc/client.ts src/sumo-tui/rpc/client.test.ts \
>   test/integration/rpc-child-fixture.ts docs/visual/parity/scenarios.json
> ```
>
> Reconcile the Plan 090 submission/clear transaction first. If the target Pi
> image or queue shape has changed, STOP and update this plan before coding.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plans 088 and 090
- **Category**: feature / correctness
- **Planned at**: commit `1ad967b`, 2026-08-27
- **Issue**: [#379](https://github.com/dhruvkelawala/sumocode/issues/379)
- **Execution status**: BLOCKED — wait for the published Pi release containing `clear_queue`, then Plans 088 and 090

## Outcome

An idle text+image or image-only draft sends real `ImageContent[]` through RPC
`prompt.images`. `[Image N]` remains the compact editor/history representation;
the wire payload contains validated MIME plus base64 data and never appears in
diagnostics or notifications. A failed/preflight-rejected submission preserves
the complete typed draft.

Because target-main `queue_update` and `clear_queue` expose only strings, a draft
with attachments is not sent into steering/follow-up or the local compaction
queue. While Pi is busy, SumoCode keeps the draft intact and tells the user that
native image delivery waits for idle. Text-only drafts continue to use Plan
090's native queues. This explicit capability gate prevents Alt+Up/Escape from
claiming recovery while discarding image content.

## Why this matters

SumoCode currently expands `[Image N]` back into a filesystem path and sends that
path as prompt text. Providers receive no image content; the agent must notice
and read a machine-local file. RPC already accepts native images, but adopting
them blindly would create a worse loss bug: `clear_queue` returns text only, so a
queued attachment cannot be reconstructed or identified reliably.

## Current state

- `editor.ts:323-334` writes clipboard bytes to a temp file and inserts its path.
- `EditorImageDraftState` maps `[Image N]` tokens to paths and already exposes
  `list()`, but its attachment record contains no MIME/byte metadata.
- `cathedral-editor.ts:352-366` wraps `onSubmit` by expanding tokens to path text
  and clearing the image map before the async host knows whether dispatch worked.
- `cathedral-editor.ts:401-407` exposes only expand-to-path plus clear.
- `host.ts:471-475` sends `{type:"prompt", message}` without `images`.
- The follow-up path also expands tokens to paths and clears draft metadata.
- `prompt`, `steer`, and `follow_up` accept `ImageContent[]`, but Plan 090 correctly
  uses `prompt + streamingBehavior` for editor semantics.

The target queue limitation is exact:

```text
queue_update: {steering: string[], followUp: string[]}
clear_queue:  {steering: string[], followUp: string[]}
```

There are no stable queue-entry IDs or image blocks. Duplicate/transformed prompt
text makes a host-side attachment lookup ambiguous, so do not invent one.

## Locked behavior

| Case | Required result |
|---|---|
| Idle text + images | send text and native `images[]`; clear only after correlated success |
| Idle images only | send a valid empty/minimal text with native `images[]` as permitted by the shipped type/runtime |
| Missing/unreadable/unsupported file | preserve draft and attachments; show bounded error |
| Preflight rejection | preserve full typed draft |
| Ambiguous transport failure | preserve local attachment files/metadata and say acceptance is unknown; never auto-resend |
| Busy/compacting with attachments | do not enqueue; keep draft untouched; tell user to wait for idle or remove attachments |
| Busy text-only | unchanged Plan 090 steer/follow-up behavior |
| Alt+Up/Escape | text queue recovery remains truthful; no native attachment could have entered that queue |

The busy gate is intentionally narrower than classic Pi's path-text behavior. It
is a safety boundary for this native-image enhancement, not a claim that RPC
cannot enqueue images. Remove it only after upstream returns structured queue
entries/images or another atomic recovery contract exists.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Draft/editor | `pnpm vitest run src/cathedral/editor-draft-state.test.ts src/cathedral/cathedral-editor.test.ts src/sumo-tui/rpc/editor.test.ts` | all pass |
| Clipboard/wire | `pnpm vitest run src/sumo-tui/rpc/clipboard-paste.test.ts src/sumo-tui/rpc/client.test.ts src/sumo-tui/rpc/host.test.ts` | all pass |
| Image integration | `pnpm vitest run test/integration/rpc-native-images.test.ts --fileParallelism=false` | all fixture and real-worker cases pass |
| Diagnostics | `pnpm vitest run test/integration/rpc-host-shell.test.ts --fileParallelism=false` | no base64 or raw bytes in diagnostics |
| Full gates | `pnpm lint && pnpm test && pnpm test:integration && pnpm visual:ci` | all pass |
| Required build | `pnpm exec tsc --noEmit && pnpm build` | exit 0, no errors |

## Scope

**In scope**:

- Cathedral editor image-draft state and typed RPC submission seam with tests
- RPC clipboard paste, editor, host, and client with colocated tests
- `src/sumo-tui/rpc/image-content.ts` and `image-content.test.ts` (create) for
  validation/loading/encoding
- exact fixture image request capture
- `test/integration/rpc-native-images.test.ts` (create)
- component/fixture/runtime visual evidence for image token, accepted native
  image, validation error, and busy safety gate
- `plans/README.md` status row

**Out of scope**:

- A general host-owned image delivery queue.
- Correlating attachments to text-only Pi queues by string equality/order.
- Single-entry queue IDs, structured `clear_queue`, or an upstream protocol PR.
- Image editing, resizing, recompression, OCR, or provider-specific conversion.
- Deleting temp files or changing current clipboard cleanup lifetime.
- Persisting base64 in SumoCode config, diagnostics, caches, or activity files.
- Changing classic extension-only image behavior.
- Golden promotion without explicit human approval.

## Git workflow

- Branch: `advisor/092-send-native-rpc-images-safely`
- Commit subject: `feat: send native images over Pi RPC`
- Keep binary fixtures tiny and generated from declared test bytes; do not commit
  screenshots or user files.
- Do not push or open a PR unless the operator separately asks.

## Steps

### Step 1: Re-check the published queue/image capability

Inspect the installed types/runtime from Plan 088. Confirm `prompt.images` uses
the published Pi `ImageContent` shape and `clear_queue` remains text-only. Record
the result in a test/maintenance comment beside the busy gate.

If the release unexpectedly returns stable structured queue entries with images,
STOP and amend this plan to use that atomic capability; do not keep an obsolete
idle-only gate just because this document predicted text-only main.

**Verify**: a focused type assertion compiles against the installed package, and
the Plan 088 real-worker contract still reports text arrays.

### Step 2: Add a two-phase typed submission draft

Extend `EditorImageAttachment` with the metadata needed to build wire content
while keeping path/token as the display model. Add an RPC-specific submission
capture API that returns:

```ts
type RpcEditorSubmissionDraft = {
	readonly text: string; // still contains [Image N] references
	readonly images: readonly EditorImageAttachment[];
};
```

Do not break the classic string `onSubmit` compatibility wrapper. The RPC editor
must capture without expanding or clearing; it commits history/clear only after
the host's correlated preflight succeeds. Rejection restores the exact text and
attachment map. Pruning a deleted token removes its attachment.

History recall must either restore the structured token mapping or present a
real path that can be collapsed again; a dangling `[Image N]` token is not an
acceptable history entry.

**Verify**: draft/editor tests cover one/multiple images, duplicate token text,
token deletion, text+image, image-only, success clear, rejection restore, and
actionable history recall.

### Step 3: Validate and encode images at dispatch

Create `image-content.ts` using Node read APIs only after submit. For each
referenced attachment:

1. resolve relative/home paths exactly as current paste normalization intends;
2. require an existing readable regular file;
3. accept only MIME types supported by the installed Pi image contract and
   current editor (`png`, `jpeg`, `gif`, `webp` unless the target narrows them);
4. enforce the published/runtime size boundary; if Pi publishes none, add one
   named conservative SumoCode limit with a user-visible error and tests rather
   than reading an unbounded file;
5. verify extension/MIME/signature consistency sufficiently to reject obvious
   mislabeled input;
6. encode bytes once to base64 and discard the temporary in-memory string after
   request serialization.

Do not log payloads. Diagnostics may record attachment count, MIME, and byte
count only. Error copy may mention the display token/basename, never base64.

**Verify**: tests cover supported formats, missing file, directory, permission
error, oversize, spoofed extension, paths with spaces, relative/home paths, and
redacted errors.

### Step 4: Send native images only through the safe dispatch path

Extend the Plan 090 prompt sender to accept `images`. When Pi is idle and not
compacting/summarizing, send:

```ts
{
	type: "prompt",
	message: draft.text,
	images,
	streamingBehavior: selectedMode,
}
```

Keep the behavior field even while idle, matching Plan 090's race-free command
shape. On success, commit editor history and clear the typed draft. On explicit
failure, preserve it. On ambiguous timeout/child exit, never auto-resend; retain
local attachment metadata and show acceptance-unknown recovery copy.

If session state is active/compacting or the local compaction queue would own the
submission, decline before reading/encoding files and leave the editor untouched.
Text-only drafts continue normally.

**Verify**: host/client tests assert exact JSON shape without snapshotting raw
base64, idle race behavior, success/failure/unknown ownership, and busy gate.

### Step 5: Prove real-worker and privacy behavior

Add a fixture that decodes received image data only to assert byte equality,
MIME, count, message text, and behavior. Add a real Pi offline/faux-provider
smoke for text+image and image-only input. Confirm the durable user message
contains image content and resume renders a compact image indication without
dumping bytes.

Run SumoCode with diagnostics enabled and search the JSONL/cache/output for a
unique base64 sentinel derived from the fixture. The sentinel must be absent.
Verify a busy attachment submission leaves editor text/token state unchanged
and no RPC prompt is written.

**Verify**:

```bash
pnpm vitest run test/integration/rpc-native-images.test.ts test/integration/rpc-host-shell.test.ts --fileParallelism=false
```

Expected: all wire/privacy/gate cases pass.

### Step 6: Add visual evidence and run all gates

Capture the compact token, accepted native image message, validation error, and
busy “wait for idle” state. Use existing image tags and notification primitives;
do not expose temp paths. Review styled-cell/geometry reports before PNGs.

Run every command in the table. Do not promote goldens.

## Test plan

- Structured draft capture/commit/restore/history.
- MIME/path/size/signature validation and exact byte encoding.
- Text+image and image-only RPC payloads.
- Success, explicit rejection, and ambiguous transport failure.
- Busy/compaction gate preserves every attachment and sends nothing.
- No base64/temp path in diagnostics, notifications, cache, or visual output.
- Resume/durable message renders compactly without duplicate/raw data.

## Done criteria

- [ ] Idle image drafts send real `ImageContent[]`, not path text.
- [ ] Image-only and multi-image submissions work against the real worker.
- [ ] Draft clearing is two-phase and failures preserve attachment identity.
- [ ] Busy/compacting images fail closed without entering text-only queues.
- [ ] Text-only Plan 090 behavior is unchanged.
- [ ] Base64 is absent from diagnostics, caches, notifications, and committed fixtures.
- [ ] Unit, integration, visual CI, lint, typecheck, and build pass.
- [ ] No golden was promoted without approval.
- [ ] Plan 092 and the index are updated.

## STOP conditions

- Plans 088/090 are not DONE.
- The target image wire shape differs from the plan.
- The target adds structured recoverable queue entries; amend rather than ignore them.
- Correct busy recovery requires matching attachments by prompt string/order.
- A draft would be cleared before correlated acceptance or an attachment silently dropped.
- Validation requires reading an unbounded file or logging encoded payloads.
- The change would alter classic extension-only behavior.

## Maintenance notes

- The busy gate is capability-driven. Remove it only with an atomic structured
  queue recovery API and dedicated migration tests.
- Queue text restoration matching classic Pi does not imply image restoration;
  keep those claims separate in copy and release notes.
- If provider/image limits vary, validate against the installed Pi abstraction
  first and surface provider rejection without discarding the draft.
