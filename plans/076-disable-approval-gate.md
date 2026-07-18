# Plan 076: Remove SumoCode approval gates and let tool calls proceed directly

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. This plan was intentionally created without a
> `plans/README.md` row; do **not** update `plans/README.md` unless the
> operator explicitly asks you to maintain the index.
>
> **Drift check (run first)**: `git diff --stat 780e5c9..HEAD -- src/extension.ts src/approval-modal.ts src/approval-modal.test.ts src/commands/approval.ts src/commands/approval.test.ts src/interaction-registry.ts src/interaction-registry.test.ts src/sumo-tui/rpc/extension-ui-responder.ts src/sumo-tui/rpc/extension-ui-responder.test.ts src/sumo-tui/rpc/host.ts src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/host-actions.ts src/sumo-tui/rpc/host-actions.test.ts src/sumo-tui/pi-compat/extension-ui-adapter.ts src/sumo-tui/pi-compat/extension-ui-adapter.test.ts src/sumo-tui/widgets/modal.ts src/sumo-tui/widgets/modal.test.ts README.md docs/PI_TOOL_ARCHITECTURE.md docs/cathedral/SCRIPTORIUM_CHROME.md AGENTS.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `780e5c9`, 2026-07-18

## Why this matters

The product decision is explicit: SumoCode-owned approval prompting/gating is
being removed. After this lands, classic Pi-extension mode and RPC-host mode
must let SumoCode-owned tool calls proceed without asking the user to approve,
including commands currently matched as dangerous. The change must be narrow:
remove the approval-gate UX and its special RPC bridge, but keep generic
modal/`extension_ui` infrastructure, non-approval confirmation flows, modal
input sanitization, theme approval/error colors, tool rendering, and unrelated
security checks.

## Current state

### Runtime and tool-boundary facts

- `AGENTS.md:95-103` says interactive launches default to the RPC host while
  non-interactive `--print`, explicit `--mode`, and non-TTY stdout bypass the
  host. Do not change `bin/sumocode.sh`, `SUMO_RPC`, `SUMO_TUI`, or runtime
  selection for this plan.
- `AGENTS.md:107` currently says Pi version bumps must rerun the
  approval/security regression. This will be stale after removing the gate;
  update this wording to the new bypass regression instead of deleting the
  broader RPC-contract warning.
- `AGENTS.md:127` and `src/themes/types.ts:1-5` preserve `approval` as one of
  the five state color slots. Keep that slot and all theme approval/error color
  use for failures, over-budget meters, diff removals, and status semantics.
- `docs/PI_TOOL_ARCHITECTURE.md:18-24` currently documents `bash` as having an
  approval gate and says SumoCode intercepts built-ins via `pi.on("tool_call")`
  for approval gating. That doc must be updated to say SumoCode no longer gates
  built-in tools.

Current tool-boundary excerpt:

```md
# docs/PI_TOOL_ARCHITECTURE.md:16-24
| Tool    | What it does                                     | SumoCode customization       |
|---------|--------------------------------------------------|------------------------------|
| `bash`  | Execute shell commands                           | Approval gate for dangerous commands |
...
SumoCode **does not re-register** these. It intercepts them via `pi.on("tool_call")`
for approval gating and renders them via the transcript view-model pipeline.
```

### Classic/RPC gate installation

`src/extension.ts` imports and installs the gate in both the RPC child profile
and the full classic extension profile:

```ts
// src/extension.ts:8
import { installApprovalGate } from "./approval-modal.js";

// src/extension.ts:191-195
function installRpcChildProfile(pi: ExtensionAPI): void {
	installMemoryExtraction(pi);
	installFastMode(pi);
	installApprovalGate(pi);
	if (shouldInstallNativeTaskTool({ force: process.env.SUMOCODE_NATIVE_TASK })) {

// src/extension.ts:284-289
const fastModeState = installFastMode(pi, { onChange: () => requestFooterRender?.() });
requestFooterRender = installFooter(pi, { fastModeState });
installMemoryExtraction(pi);
installCathedralEditor(pi);
installInputHints(pi);
installApprovalGate(pi);
```

The duplicate-extension comment at `src/extension.ts:116-117` explicitly names
`installApprovalGate`; update that comment so the self-noop behavior remains
explained without implying approval must install.

### Approval module behavior to remove

`src/approval-modal.ts` owns both the UI and the blocking tool-call hook:

```ts
// src/approval-modal.ts:20-23
* re-implementing Pi's tool execution), we intercept the `tool_call` event
* for destructive tools, show our cathedral modal, and let Pi proceed only
* if the user picks YES or ALWAYS. NO blocks the call.
```

RPC prompt path:

```ts
// src/approval-modal.ts:283-295
export async function showRpcApprovalPrompt(
	ctx: ExtensionContext,
	snapshot: Omit<ApprovalModalSnapshot, "activeButton">,
	pi?: ExtensionAPI,
): Promise<ApprovalChoice> {
	herdrBlocked(pi, true);
	try {
		const choice = await ctx.ui.select(
			rpcApprovalTitle(snapshot),
			[...RPC_APPROVAL_OPTIONS],
			{ timeout: RPC_APPROVAL_TIMEOUT_MS },
		);
		return normalizeApprovalChoice(choice);
```

Classic prompt path:

```ts
// src/approval-modal.ts:307-333
export async function showApprovalModal(
	ctx: ExtensionContext,
	snapshot: Omit<ApprovalModalSnapshot, "activeButton">,
	pi?: ExtensionAPI,
): Promise<ApprovalChoice> {
	if (ctx.mode === "rpc") {
		return await showRpcApprovalPrompt(ctx, snapshot, pi);
	}
...
		const choice = await ctx.ui.custom<ApprovalChoice>(
```

Blocking decision path:

```ts
// src/approval-modal.ts:339-352
function blockApproval(reason: string): { block: true; reason: string } {
	return { block: true, reason };
}

function blockDenied(): { block: true; reason: string } {
	return blockApproval("user denied via cathedral approval modal");
}

function blockUnavailable(): { block: true; reason: string } {
	return blockApproval("approval modal unavailable; blocked dangerous command");
}

function isAllowedApprovalChoice(choice: ApprovalChoice): boolean {
	return choice === "yes" || choice === "always";
}
```

Dangerous-command config and matcher:

```ts
// src/approval-modal.ts:382-419
export interface ApprovalGateConfig {
	readonly dangerousPatterns: readonly RegExp[];
	readonly extraPatterns: readonly RegExp[];
	readonly allowList: readonly RegExp[];
}
...
export function isDangerousBashCommand(command: string): boolean {
	if (activeConfig.allowList.some((p) => p.test(command))) return false;
```

Tool-call hook:

```ts
// src/approval-modal.ts:463-476
export function installApprovalGate(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;

		const command = typeof event.input.command === "string" ? event.input.command : "";
		if (!isDangerousBashCommand(command)) return;
		if (sessionAllowSet.has(command)) return;
		if (!ctx.hasUI) return blockUnavailable();

		const info = describeCommand(command);
		const choice = await requestApprovalChoice(pi, ctx, info.command, info.description);
		rememberAlways(command, choice);
		if (!isAllowedApprovalChoice(choice)) return blockDenied();
```

### Approval preview commands to remove

Classic preview command:

```ts
// src/commands/approval.ts:15-21
* `/sumo:approval` — manual QA helper for the Cathedral approval modal.
* Opens the same runtime overlay used by the approval gate, without requiring
* a dangerous tool call to trigger it.
*/
export function registerApprovalCommand(pi: ExtensionAPI): void {
	pi.registerCommand("sumo:approval", {
		description: "Open a test Cathedral approval modal",
```

Interaction registry installs it:

```ts
// src/interaction-registry.ts:3-4
import { installCommandPalette } from "./command-palette.js";
import { registerApprovalCommand } from "./commands/approval.js";

// src/interaction-registry.ts:134-140
const registry = createInteractionRegistry(pi, options.reporter);
...
registry.install("commands.approval", registerApprovalCommand);
registry.install("commands.cursor", registerCursorCommand);
```

RPC host lists and handles it separately:

```ts
// src/sumo-tui/rpc/host-actions.ts:136-139
{ name: "sumo:memory", description: "Open or update SumoCode memory" },
{ name: "sumo:theme-check", description: "Preview current theme tokens" },
{ name: "sumo:approval", description: "Preview approval overlay" },
{ name: "sumo:palette", description: "Open the command palette" },

// src/sumo-tui/rpc/host-actions.ts:638-644
case "/sumo:theme-check":
	await this.openThemeCheck();
	return true;
case "/sumo:approval":
	await this.openApprovalPreview();
	return true;
```

RPC preview component and method:

```ts
// src/sumo-tui/rpc/host-actions.ts:507-528
class HostApprovalPreviewComponent implements Component {
	private snapshot: ApprovalModalSnapshot;
...
	public render(width: number): string[] {
		return renderApprovalModal(this.snapshot, width);
	}
}

// src/sumo-tui/rpc/host-actions.ts:939-945
public async openApprovalPreview(command = "rm -rf node_modules/"): Promise<void> {
	const choice = await this.overlays.show<ApprovalChoice>(
		"approvalPreview",
		(done) => new HostApprovalPreviewComponent(command, done),
	);
	if (choice === "no") notify(this.notifications, "command blocked", "warning");
}
```

### RPC responder approval special-case to remove while preserving generic UI

`RpcExtensionUiResponder` currently imports approval rendering and special-cases
`select` requests whose title/options match the approval marker:

```ts
// src/sumo-tui/rpc/extension-ui-responder.ts:3-9
import {
	RPC_APPROVAL_TITLE_MARKER,
	renderApprovalModal,
	updateApprovalSnapshot,
	type ApprovalChoice,
	type ApprovalModalSnapshot,
} from "../../approval-modal.js";

// src/sumo-tui/rpc/extension-ui-responder.ts:71-75
function isApprovalSelect(title: string, options: readonly string[]): boolean {
	return title.startsWith(RPC_APPROVAL_TITLE_MARKER)
		&& options.length === RPC_APPROVAL_OPTIONS.length
		&& options.every((option, index) => option === RPC_APPROVAL_OPTIONS[index]);
}

// src/sumo-tui/rpc/extension-ui-responder.ts:146-154
case "select": {
	if (this.approvalOverlay && isApprovalSelect(request.title, request.options)) {
		const value = await this.showApprovalSelect(request.title, request.timeout);
		return valueResponse(request.id, value);
	}
	const value = await this.modals.select(request.title, request.options, { timeout: request.timeout });
	return valueResponse(request.id, value);
}
```

Remove only the approval special-case. The generic `select`, `confirm`,
`input`, `editor`, `notify`, `setStatus`, `setWidget`, `setTitle`, and
`set_editor_text` cases must continue working.

Preserved generic non-approval confirmation/input infrastructure is here:

```ts
// src/sumo-tui/pi-compat/extension-ui-adapter.ts:175-184
public select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
	return this.modals.select(title, options, opts);
}

public confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
	return this.modals.confirm(title, message, opts);
}

public input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
	return this.modals.input(title, placeholder, opts);
}
```

Generic modal sanitization/input validation to preserve:

```ts
// src/sumo-tui/widgets/modal.ts:176-184
public input(title: string, placeholder?: string, opts?: ModalInputOptions): Promise<string | undefined> {
	return new Promise<string | undefined>((resolve) => {
		const entry: ActiveModal = {
			kind: "input",
			title: sanitizeModalText(title),
			placeholder: placeholder === undefined ? undefined : sanitizeSingleLineModalText(placeholder),
			value: opts?.initialValue === undefined ? "" : sanitizeSingleLineModalText(opts.initialValue),
```

```ts
// src/sumo-tui/widgets/modal.ts:244-280
public handleInput(data: string): void {
	if (!this.active) return;
	if (keyEq(data, Key.escape, "escape", "esc")) {
		this.finish(this.active.kind === "confirm" ? false : undefined);
		return;
	}
...
	if (keyEq(data, Key.enter, "return", "enter")) {
		if (this.active.kind === "confirm") this.finish(this.active.selectedIndex === 0);
		else this.finish(this.active.options[this.active.selectedIndex]?.value);
	}
```

### Existing tests that must be rewritten or retained as dormant-module coverage

- `src/approval-modal.test.ts` and `src/commands/approval.test.ts` remain unchanged as coverage for dormant rendering/helpers. The runtime must no longer import, install, advertise, or route to them; file removal is explicitly out of scope without separate operator approval.
- `src/extension.test.ts:242-272` currently asserts the RPC child installs a
  fail-closed approval handler and blocks `rm -rf`; rewrite that assertion to
  prove the RPC child profile does **not** install a SumoCode approval gate and
  does not return `{ block: true }` for dangerous bash.
- `src/interaction-registry.test.ts:79` expects `sumo:approval`; remove it and
  lower the registered command count accordingly.
- `src/sumo-tui/rpc/extension-ui-responder.test.ts:335-501` covers approval
  overlay routing and fail-closed dismissal paths; remove those approval-only
  tests and keep/add generic select/confirm tests.
- `src/sumo-tui/rpc/host.test.ts:552-575` covers pending approval denial on
  child exit; remove or replace with a generic overlay drain test if not
  already covered.
- `src/sumo-tui/rpc/host-actions.test.ts:965-1000` currently expects the
  approval preview overlay; update to theme-check + memory editor only and add
  a command-list assertion that `sumo:approval` is absent.
- Keep `src/sumo-tui/pi-compat/extension-ui-adapter.test.ts:110-126` and
  `src/sumo-tui/rpc/extension-ui-responder.test.ts:95-110` passing; they are
  evidence that non-approval confirm/select flows remain intact.
- Keep or adapt `src/sumo-tui/widgets/modal.test.ts:70-83`; it proves generic
  modal sanitization still strips control sequences. The approval-title wrap
  test at `src/sumo-tui/widgets/modal.test.ts:59-68` can be rewritten with a
  non-approval multiline title, because wrapping itself is generic.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Check current SHA | `git rev-parse --short HEAD` | starts from `780e5c9` or executor consciously handles drift |
| Focused unit tests | `pnpm vitest run src/extension.test.ts src/interaction-registry.test.ts src/sumo-tui/rpc/extension-ui-responder.test.ts src/sumo-tui/rpc/host-actions.test.ts src/sumo-tui/rpc/host.test.ts src/sumo-tui/widgets/modal.test.ts src/sumo-tui/pi-compat/extension-ui-adapter.test.ts` | all listed suites pass |
| Active-runtime approval grep | `rg -n "installApprovalGate|registerApprovalCommand|sumo:approval|approvalPreview|RPC_APPROVAL_TITLE_MARKER|approvalOverlay" src/extension.ts src/interaction-registry.ts src/sumo-tui/rpc README.md docs/PI_TOOL_ARCHITECTURE.md docs/cathedral/SCRIPTORIUM_CHROME.md AGENTS.md` | no active runtime/registration/doc matches; dormant definitions under `src/approval-modal.ts` and `src/commands/approval.ts` are intentionally excluded |
| Full unit suite | `pnpm test` | all tests pass |
| Typecheck/build | `pnpm exec tsc --noEmit && pnpm build` | exit 0, no TypeScript errors |
| Integration | `pnpm test:integration` | all integration tests pass |
| Visual CI | `pnpm visual:ci` | required visual gates pass |

## Scope

**In scope** (executor may modify):

- `src/extension.ts`
- `src/extension.test.ts`
- `src/interaction-registry.ts`
- `src/interaction-registry.test.ts`
- `src/sumo-tui/rpc/extension-ui-responder.ts`
- `src/sumo-tui/rpc/extension-ui-responder.test.ts`
- `src/sumo-tui/rpc/host.ts`
- `src/sumo-tui/rpc/host.test.ts`
- `src/sumo-tui/rpc/host-actions.ts`
- `src/sumo-tui/rpc/host-actions.test.ts`
- `src/sumo-tui/widgets/modal.test.ts` (only generic test wording/fixture updates)
- `README.md`
- `docs/PI_TOOL_ARCHITECTURE.md`
- `docs/cathedral/SCRIPTORIUM_CHROME.md`
- `AGENTS.md`

**Out of scope** (do not touch):

- `bin/sumocode.sh`, `sumo-rpc-host.js`, `SUMO_RPC`, `SUMO_TUI`, and runtime
  mode selection.
- `src/approval-modal.ts`, `src/approval-modal.test.ts`, `src/commands/approval.ts`, and `src/commands/approval.test.ts` — retain these dormant files; do not delete or modify them without separate explicit operator approval.
- Pi package internals under `node_modules/` or installed copies under
  `~/.pi/agent/git/...`.
- Generic `ModalManager`, `ModalLayer`, `RpcExtensionUiResponder` methods for
  non-approval `select`/`confirm`/`input`/`editor`/`notify` requests, except
  removing the approval-specific branch and options.
- The `question` tool, Divine Query, Memory Scriptorium, command palette,
  settings/model/session selectors, `/sumo:theme-check`, and non-approval
  confirmation flows.
- Theme tokens and state names, including `approval` as an error/danger color
  slot (`src/themes/**`, `src/tokens.ts`, `src/themes/types.ts`, `src/voice.ts`).
- Tool transcript rendering and error coloring (`src/sumo-tui/transcript/**`),
  sidebar over-budget/error colors, MCP error pills, and metrics error colors.
- Visual Bible theme/color assets and generated approval mockup HTML unless the
  operator separately asks for Bible cleanup. This implementation removes the
  runtime UX, not historical design artifacts.
- Unrelated security checks: input sanitization in modals, unknown
  `extension_ui` cancellation behavior, shell argument quoting, path handling,
  task/worktree safety checks, and MCP/extension validation.

## Git workflow

- Branch: use the operator's current branch/worktree unless instructed
  otherwise. If creating a branch, use `advisor/076-disable-approval-gate`.
- Commit style: Conventional Commits, e.g.
  `feat(approval): remove sumocode approval gate` or
  `fix(rpc): stop routing approval selects through host overlay`.
- Do not push or open a PR unless the operator explicitly instructs it.

## Steps

### Step 1: Remove approval gate installation from extension startup

In `src/extension.ts`:

1. Remove `import { installApprovalGate } from "./approval-modal.js";`.
2. Remove `installApprovalGate(pi);` from `installRpcChildProfile`.
3. Remove `installApprovalGate(pi);` from the full `sumocode()` installer.
4. Update the `SUMOCODE_ROOT_DIR` comment at `src/extension.ts:108-119` so it
   still explains why the launcher must not self-noop, but no longer names
   `installApprovalGate` or claims approval must install.

Update `src/extension.test.ts`:

- Rename the RPC child profile test from “keeps tools and commands, installs
  fail-closed approval…” to wording such as “keeps tools and commands and
  skips retained chrome”.
- Remove the dangerous-bash handler invocation that expects
  `{ block: true, reason: "user denied via cathedral approval modal" }`.
- Assert the RPC child still registers expected tools/commands (`task`,
  `question`, `sumo:review`, `sumo:ship`) and still skips retained chrome.
- Assert the RPC child profile no longer registers an approval blocking handler.
  Since `footer.ts` and `top-chrome.ts` can register non-blocking `tool_call`
  state handlers in the full profile, keep this assertion scoped to the RPC
  child profile.

**Verify**: `pnpm vitest run src/extension.test.ts` → all tests pass; there is
no assertion expecting a dangerous bash command to be blocked by SumoCode.

### Step 2: Make the existing approval modules runtime-unreachable without deleting files

Retain these files unchanged:

- `src/approval-modal.ts`
- `src/approval-modal.test.ts`
- `src/commands/approval.ts`
- `src/commands/approval.test.ts`

The remaining steps remove every production installer, command registration, RPC special-case, and host preview that can reach them. Do not replace the gate with a no-op stub, and do not delete dormant files without separate operator approval.

**Verify**: `test -e src/approval-modal.ts && test -e src/commands/approval.ts` exits 0, while `rg -n "installApprovalGate|registerApprovalCommand" src/extension.ts src/interaction-registry.ts` returns no matches.

### Step 3: Remove `/sumo:approval` from classic interaction registration

In `src/interaction-registry.ts`:

1. Remove the `registerApprovalCommand` import.
2. Remove `registry.install("commands.approval", registerApprovalCommand);`.

In `src/interaction-registry.test.ts`:

1. Remove `"sumo:approval"` from the expected command list.
2. Reduce the `pi.registerCommand` call-count assertion by one (currently 17 →
   16, unless drift changes the surrounding list).
3. Keep all other command and shortcut expectations unchanged.

**Verify**: `pnpm vitest run src/interaction-registry.test.ts` → all tests pass
and the registry snapshot does not include `sumo:approval`.

### Step 4: Remove the RPC approval overlay bridge but keep generic extension_ui

In `src/sumo-tui/rpc/extension-ui-responder.ts`:

1. Remove imports from `../../approval-modal.js`.
2. Remove `ApprovalOverlayHost`, the `approvalOverlay` option, and the
   `private readonly approvalOverlay` field.
3. Remove `RPC_APPROVAL_OPTIONS`, `ANSI_PATTERN`, `CONTROL_PATTERN`,
   `isApprovalSelect`, `approvalOption`, `sanitizeApprovalText`,
   `approvalSnapshotFromTitle`, `RpcApprovalOverlayComponent`, and
   `showApprovalSelect` if they are no longer used.
4. Keep `case "select"` as a direct generic modal call:

   ```ts
   case "select": {
   	const value = await this.modals.select(request.title, request.options, { timeout: request.timeout });
   	return valueResponse(request.id, value);
   }
   ```

5. Keep `confirm`, `input`, `editor`, `notify`, `setStatus`, `setWidget`,
   `setTitle`, `set_editor_text`, and the unknown-method cancelled response.

In `src/sumo-tui/rpc/host.ts`, remove `approvalOverlay: overlays` from the
`createRpcExtensionUiResponder` options. Keep `overlays` itself; it is still
used by host-owned command palette, theme check, memory editor, hotkeys,
session selectors, and crash teardown.

In `src/sumo-tui/rpc/extension-ui-responder.test.ts`:

- Delete approval-overlay routing, approval sanitization, and fail-closed
  dismissal tests.
- Keep existing generic confirm/select/notify/status/widget/title/editor tests.
- Add or adjust one generic regression test proving a select title that happens
  to contain `APPROVAL REQUIRED` still routes through `ModalManager.select` as
  an ordinary select and resolves the user's selected option; it must not open
  an overlay or apply approval-specific deny mapping.
- Keep the unknown-method cancellation test if present.

In `src/sumo-tui/rpc/host.test.ts`:

- Update the exit-handler comment at `src/sumo-tui/rpc/host.ts:217-226` to say
  draining overlays resolves pending overlay/select/input promises during crash
  teardown. Remove the approval-specific “normalizes to No/deny” sentence.
- Remove the approval-mid-crash test and the imports of
  `normalizeApprovalChoice`/`RPC_APPROVAL_TITLE_MARKER`.
- Keep existing crash teardown tests for generic modals/overlays.

**Verify**: `pnpm vitest run src/sumo-tui/rpc/extension-ui-responder.test.ts src/sumo-tui/rpc/host.test.ts` → all tests pass; `rg -n "approvalOverlay|RPC_APPROVAL_TITLE_MARKER|normalizeApprovalChoice|renderApprovalModal" src/sumo-tui/rpc` returns no matches. Dormant definitions in `src/approval-modal.ts` are intentionally retained.

### Step 5: Remove RPC host approval preview command

In `src/sumo-tui/rpc/host-actions.ts`:

1. Remove approval-modal imports (`renderApprovalModal`,
   `updateApprovalSnapshot`, `ApprovalChoice`, `ApprovalModalSnapshot`).
2. Remove the `sumo:approval` entry from `RPC_HOST_SLASH_COMMANDS`.
3. Remove `HostApprovalPreviewComponent`.
4. Remove the `case "/sumo:approval"` branch from `handleSubmittedText`.
5. Remove `openApprovalPreview`.
6. Keep `slotColor("error")`, `slotColor("toolDiffRemoved")`, and
   `bgSlotColor("toolErrorBg")` mapped to `colors.states.approval`; these are
   error/diff colors, not approval prompts.

In `src/sumo-tui/rpc/host-actions.test.ts`:

- Update the test named “renders theme check, approval preview, and memory
  editor as host overlays” to cover only theme check and memory editor.
- Delete “does not notify when approval preview is allowed”.
- Add an assertion that `isRpcHostSlashCommandName("sumo:approval")` is false
  and/or that `/sumo:approval` follows the unknown-command path when the child
  cannot execute it. Prefer the command-list assertion to avoid coupling to
  notification text.
- Keep tests for `/sumo:theme-check`, `/sumo:memory`, `/sumo:palette`, model,
  thinking, settings, session, hotkeys, copy/export, and unknown commands.

**Verify**: `pnpm vitest run src/sumo-tui/rpc/host-actions.test.ts` → all tests
pass; `rg -n "sumo:approval|approvalPreview|HostApprovalPreviewComponent|openApprovalPreview|command blocked" src/sumo-tui/rpc/host-actions.ts src/sumo-tui/rpc/host-actions.test.ts` returns no matches.

### Step 6: Preserve generic modal behavior and input sanitization

Do not delete or weaken `ModalManager`, `ModalLayer`, or
`ExtensionUiAdapter`. Make only test fixture wording changes needed after the
approval-specific runtime is gone:

- In `src/sumo-tui/widgets/modal.test.ts`, rewrite the multiline-title test at
  `src/sumo-tui/widgets/modal.test.ts:59-68` to use a neutral title such as
  `"MULTILINE SELECT\n\nfirst detail\n\nsecond detail"` instead of
  `"APPROVAL REQUIRED..."`. The assertions should still prove every line is
  visible.
- Keep the ANSI/control-sequence sanitization tests at
  `src/sumo-tui/widgets/modal.test.ts:70-83` unchanged or stronger.
- Keep `src/sumo-tui/pi-compat/extension-ui-adapter.test.ts:110-126` unchanged;
  it proves non-approval confirm/select flows still resolve.

**Verify**: `pnpm vitest run src/sumo-tui/widgets/modal.test.ts src/sumo-tui/pi-compat/extension-ui-adapter.test.ts` → all tests pass.

### Step 7: Update docs to match the product decision without deleting color/state semantics

Update only the stale approval-gate documentation:

- `README.md`: remove the “Cathedral approval modal” feature row at
  `README.md:61`, and adjust `README.md:111` so the shared modal chrome list
  no longer names Approval as an active runtime modal. Do not remove the
  five-state row at `README.md:57` unless the product owner separately decides
  to rename/remove the `approval` state color.
- `docs/PI_TOOL_ARCHITECTURE.md`: update the built-in tool table so `bash` no
  longer lists approval gating. Remove the “Approval gate” hook row and the
  “Approval Modal” interactive modal row. Keep the “do not re-register built-in
  tools” rule, but remove “for approval gating”.
- `docs/cathedral/SCRIPTORIUM_CHROME.md`: remove `Approval Required` from the
  active shared modal table and any wording that says `src/approval-modal.ts`
  is a live modal. Keep the generic chrome guidance for Divine Query and
  Memory Scriptorium.
- `AGENTS.md`: replace the approval/security regression wording at line 107
  with a bypass-oriented check, e.g. “rerun the tool-bypass/security regression
  test”, and keep the rest of the RPC contract warning intact. Do not touch the
  “Five preattentive states” line except to clarify that `approval` remains a
  theme/error state if needed.

**Verify**: `rg -n "Cathedral approval modal|Approval gate|Approval Modal|src/approval-modal|sumo:approval|approval/security regression" README.md docs/PI_TOOL_ARCHITECTURE.md docs/cathedral/SCRIPTORIUM_CHROME.md AGENTS.md` → no matches.

### Step 8: Add final regression assertions for “allowed without approval”

Add focused assertions in the existing tests rather than creating a new harness:

- `src/extension.test.ts`: for RPC child profile, prove no handler returns
  `{ block: true }` for a representative dangerous bash command. If no
  `tool_call` handlers are registered in the RPC child profile after removal,
  assert that directly. If future drift adds non-blocking handlers, invoke them
  and assert all results are `undefined`.
- If the full classic profile has existing `tool_call` handlers from footer or
  top chrome, add a test that invokes all full-profile `tool_call` handlers with
  `{ toolName: "bash", input: { command: "rm -rf node_modules/" } }` and asserts
  none returns an object with `block: true`. This ensures classic mode also
  allows the tool call while preserving non-blocking state updates.
- `src/sumo-tui/rpc/extension-ui-responder.test.ts`: add the generic
  `APPROVAL REQUIRED` shaped select test from Step 4 so old approval-shaped
  wire messages are ordinary selects if any external extension emits them.

**Verify**: focused unit command from “Commands you will need” → all listed
suites pass.

### Step 9: Full verification

Run the full suite required for a runtime/RPC behavior change:

1. `pnpm exec tsc --noEmit && pnpm build` → exit 0.
2. `pnpm test` → all unit tests pass.
3. `pnpm test:integration` → all PTY integration tests pass.
4. `pnpm visual:ci` → required visual gates pass.
5. Approval-symbol grep from “Commands you will need” → no stale runtime/doc
   references to the removed gate or slash command.

Do not promote visual goldens. If `visual:ci` produces review artifacts, report
paths only; promotion requires explicit human approval.

## Test plan

- **Unit: extension install/bypass** — update `src/extension.test.ts` to prove
  both RPC child and classic/full extension paths do not install or execute a
  SumoCode blocking approval handler for dangerous bash.
- **Unit: command registry** — update `src/interaction-registry.test.ts` to
  prove `sumo:approval` is absent while all unrelated commands/shortcuts remain.
- **Unit: RPC extension UI** — update `src/sumo-tui/rpc/extension-ui-responder.test.ts`
  to prove generic `select`/`confirm` behavior remains and an approval-shaped
  select no longer opens a special overlay.
- **Unit: RPC host actions** — update `src/sumo-tui/rpc/host-actions.test.ts`
  to prove the host no longer advertises or handles `/sumo:approval`, while
  theme check, memory editor, palette, and other host-owned commands continue.
- **Unit: modal sanitization** — keep `src/sumo-tui/widgets/modal.test.ts` and
  `src/sumo-tui/pi-compat/extension-ui-adapter.test.ts` green for generic modal
  flows and input sanitization.
- **Integration/visual** — run `pnpm test:integration` and `pnpm visual:ci`
  because the change touches RPC host behavior and overlay routing. No new
  visual golden promotion belongs in this plan.

## Done criteria

All of the following must be true:

- [ ] `src/approval-modal.ts`, `src/approval-modal.test.ts`, `src/commands/approval.ts`, and `src/commands/approval.test.ts` still exist and remain unmodified; no active runtime path imports, installs, advertises, or routes to them.
- [ ] `src/extension.ts` no longer imports or calls `installApprovalGate`.
- [ ] `src/interaction-registry.ts` no longer imports or registers
      `registerApprovalCommand`.
- [ ] `src/sumo-tui/rpc/extension-ui-responder.ts` has no approval-specific
      branch/options/imports; `select` always uses the generic modal path.
- [ ] `src/sumo-tui/rpc/host-actions.ts` no longer lists or handles
      `/sumo:approval` and contains no approval preview component/method.
- [ ] Tests assert representative dangerous bash tool calls are not blocked by
      SumoCode in RPC child and classic/full extension paths.
- [ ] Non-approval `select`, `confirm`, `input`, `editor`, modal sanitization,
      unknown `extension_ui` cancellation, theme-check, memory editor, and
      command palette tests still pass.
- [ ] `rg -n "installApprovalGate|registerApprovalCommand|sumo:approval|approvalPreview|RPC_APPROVAL_TITLE_MARKER|approvalOverlay" src/extension.ts src/interaction-registry.ts src/sumo-tui/rpc README.md docs/PI_TOOL_ARCHITECTURE.md docs/cathedral/SCRIPTORIUM_CHROME.md AGENTS.md` returns no active runtime/registration/doc matches.
- [ ] `pnpm exec tsc --noEmit && pnpm build` exits 0.
- [ ] `pnpm test` exits 0.
- [ ] `pnpm test:integration` exits 0.
- [ ] `pnpm visual:ci` exits 0.
- [ ] No out-of-scope files are modified; verify with `git status --short`.

## STOP conditions

Stop and report back without improvising if:

- Any current-state excerpt above does not match live code after the drift
  check.
- A source import of `approval-modal.ts` remains in an active runtime path outside the intentionally dormant `src/commands/approval.ts` file.
- Removing SumoCode's gate exposes a separate Pi-core approval prompt that is
  not owned by this repository. Do not patch `node_modules` or Pi internals;
  report the upstream boundary.
- The change appears to require altering `bin/sumocode.sh`, `sumo-rpc-host.js`,
  RPC launch mode selection, or Pi package versions.
- A generic `extension_ui` flow (`select`, `confirm`, `input`, `editor`,
  `notify`, status/widget/title/editor-text requests) breaks while removing the
  approval special-case.
- A test failure suggests weakening modal input sanitization or unknown-method
  cancellation to make approval removal pass.
- The implementation requires deleting or renaming `approval` theme/state color
  slots, or changing unrelated error/diff/over-budget coloring.
- `pnpm exec tsc --noEmit && pnpm build`, `pnpm test`, `pnpm test:integration`,
  or `pnpm visual:ci` fails twice after targeted fixes.

## Maintenance notes

- This plan intentionally changes SumoCode's security posture: approval is no
  longer a SumoCode safety boundary. Reviewers should look for any remaining
  stale “fail-closed approval” comments or tests, because they create false
  confidence after the product decision.
- Keep the generic modal stack healthy. Approval removal must not become an
  excuse to delete `ModalManager`, `ModalLayer`, `ExtensionUiAdapter`, or
  `RpcExtensionUiResponder` support for normal Pi `extension_ui` requests.
- Future Pi version bumps should re-run the new bypass regression: a dangerous
  bash command should not be blocked by SumoCode in classic or RPC mode, while
  non-approval confirmation/input/select flows still work.
- Theme `approval` colors remain useful as danger/error colors even when there
  is no approval prompt. Do not remove them unless a separate design/product
  plan renames the state vocabulary.
- Visual Bible approval mockups may become historical/stale after runtime
  removal. Leave them alone in this plan unless the operator explicitly asks
  for a visual Bible cleanup and approves any golden changes.
