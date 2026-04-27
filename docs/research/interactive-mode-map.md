# Pi 0.70.2 `interactive-mode.js` responsibility map

Scope: `@mariozechner/pi-coding-agent@0.70.2/dist/modes/interactive/interactive-mode.js` in this worktree's `node_modules/.pnpm/...` install. The Pi CLI integration point is `dist/main.js`.

## Class structure

- `InteractiveMode` is the sole exported interactive TUI class (`interactive-mode.js:122`).
- Constructor (`interactive-mode.js:218-258`) binds the `AgentSessionRuntime`, constructs pi-tui (`new TUI(new ProcessTerminal(), ...)` at `interactive-mode.js:228`), creates root `Container`s, creates the default `CustomEditor`, footer data provider, footer component, keybindings, and theme registry.
- Convenience accessors forward to `runtimeHost.session`, `session.agent`, `session.sessionManager`, and `session.settingsManager` (`interactive-mode.js:207-216`).
- Helper class `ExpandableText` supports collapsible startup header/resource notices (`interactive-mode.js:57-71`).

## Public methods and callers

| Method | Source | Caller / purpose |
| --- | --- | --- |
| `constructor(runtimeHost, options)` | `interactive-mode.js:218-258` | Pi CLI constructs it in `dist/main.js:548-556`. |
| `init()` | `interactive-mode.js:389-483` | Called by `run()` (`interactive-mode.js:502`) and startup benchmark (`dist/main.js:557`). Builds root TUI layout, starts TUI, binds extensions, renders initial session. |
| `run()` | `interactive-mode.js:501-556` | Pi CLI awaits it at `dist/main.js:571`. Runs startup warning checks, initial prompt(s), then infinite input loop. |
| `renderInitialMessages()` | `interactive-mode.js:2569-2582` | Used after init, reload, compaction, session switch/fork/new to rebuild chat from `SessionManager`. |
| `getUserInput()` | `interactive-mode.js:2584-2590` | Used by `run()` input loop to await editor submit. |
| `clearEditor()` | `interactive-mode.js:2853-2856` | Key handler helper and external consumers. |
| `showError()`, `showWarning()`, `showNewVersionNotification()`, `showPackageUpdateNotification()` | `interactive-mode.js:2857-2895` | Startup checks, runtime exceptions, extension errors. |
| `stop()` | `interactive-mode.js:4512-4530` | Shutdown, startup benchmark, external editor suspend/resume cleanup. |

## Internal state inventory

### Runtime/session state

- `runtimeHost` drives session replacement: `newSession`, `fork`, `switchSession`, `importFromJsonl`, `dispose` (`interactive-mode.js:1128-1196`, `interactive-mode.js:3536-3577`, `interactive-mode.js:4022-4060`).
- `unsubscribe` stores the agent/session event subscription (`interactive-mode.js:2127-2130`).
- `shutdownRequested` and `isShuttingDown` gate graceful shutdown (`interactive-mode.js:2620-2635`).

### TUI root and containers

- `ui` is pi-tui `TUI` (`interactive-mode.js:228`). This is the Phase 4 seam.
- Root child order is established in `init()`:
  - `headerContainer` (`interactive-mode.js:406`)
  - `chatContainer` (`interactive-mode.js:453`)
  - `pendingMessagesContainer` (`interactive-mode.js:454`)
  - `statusContainer` (`interactive-mode.js:455`)
  - `widgetContainerAbove` (`interactive-mode.js:457`)
  - `editorContainer` (`interactive-mode.js:458`)
  - `widgetContainerBelow` (`interactive-mode.js:459`)
  - `footer` (`interactive-mode.js:460`)
- Phase 4 maps these into retained Yoga slots: `header`, `chat`, `pending`, `status`, `widgets-default`, `aboveEditor`, `editor`, `belowEditor`, `footer`.

### Editor/autocomplete

- `defaultEditor` is `CustomEditor(this.ui, getEditorTheme(), keybindings, ...)` (`interactive-mode.js:235-241`).
- `editor` can be replaced by extension UI (`interactive-mode.js:1704-1759`).
- `autocompleteProviderWrappers` stack extra extension-provided autocomplete providers (`interactive-mode.js:1522-1557`).
- `createBaseAutocompleteProvider()` builds built-in, prompt template, extension command, and skill slash completions (`interactive-mode.js:295-356`).
- `setupAutocompleteProvider()` applies wrappers and installs the provider on current/default editors (`interactive-mode.js:358-367`).

### Chat/status/streaming

- `chatContainer` holds user, assistant, tool, bash, custom, branch, and compaction components.
- `pendingMessagesContainer` renders queued steering/follow-up and deferred bash (`interactive-mode.js:2900-2930`, `interactive-mode.js:3065-3072`).
- `statusContainer` hosts loaders for agent start, compaction, and retry (`interactive-mode.js:2145-2164`, `interactive-mode.js:2276-2297`, `interactive-mode.js:2362-2383`).
- Streaming state: `streamingComponent`, `streamingMessage`, `pendingTools`, `toolOutputExpanded`, `hideThinkingBlock` (`interactive-mode.js:2132-2439`).

### Extension UI state

- `extensionSelector`, `extensionInput`, `extensionEditor` replace the editor slot for modal-like flows (`interactive-mode.js:1584-1701`).
- `extensionWidgetsAbove` / `extensionWidgetsBelow` are mutable pi-tui widget maps (`interactive-mode.js:1336-1380`).
- `customFooter`, `customHeader`, `builtInHeader` control footer/header replacement (`interactive-mode.js:1440-1520`).
- `extensionTerminalInputUnsubscribers` tracks raw input listeners (`interactive-mode.js:1521-1533`).

## TUI construction seam to replace

The minimum rendering seam is constructor + `init()` layout:

1. `new TUI(new ProcessTerminal(), showHardwareCursor)` at `interactive-mode.js:228`.
2. pi-tui containers created in constructor (`interactive-mode.js:229-245`).
3. root children added in `init()` (`interactive-mode.js:406`, `interactive-mode.js:453-460`).
4. focus, key handlers, editor submit, and TUI start at `interactive-mode.js:461-465`.

Phase 4 replaces these with:

- sumo-tui runtime/terminal lifecycle,
- retained `SumoNode` Yoga slots,
- `PiComponentLeaf` / `PiEditorLeaf` adapters,
- `RegionRegistry` for extension UI mounts,
- `SumoExtensionUIAdapter` for Pi's `ExtensionUIContext`.

All session, agent, model, command, MCP, and resource loading responsibilities should remain upstream-identical.

## Extension binding entry point

- `bindCurrentSessionExtensions()` creates `uiContext = this.createExtensionUIContext()` and passes it to `session.bindExtensions(...)` (`interactive-mode.js:1128-1207`).
- Command context actions for session replacement are supplied there (`interactive-mode.js:1131-1196`).
- After binding, Pi re-registers themes, sets autocomplete, shortcuts, resource diagnostics, and startup notices (`interactive-mode.js:1201-1207`).
- `rebindCurrentSession()` unsubscribes, applies runtime settings, binds extensions, subscribes to agent events, updates footer/model/title (`interactive-mode.js:1225-1232`).

Phase 4's safest fork is to keep `bindCurrentSessionExtensions()` logic and swap only the returned UI context plus root render target.

## Extension UI surface

Pi's public `ExtensionUIContext` is declared in `dist/core/extensions/types.d.ts:66-183`. Relevant UI hooks:

- `select`, `confirm`, `input`, `notify` (`types.d.ts:66-75`)
- `setWidget` (`types.d.ts:93-98`)
- `setFooter`, `setHeader` (`types.d.ts:103-110`)
- `custom` overlay/focus component (`types.d.ts:113-124`)
- editor text + replacement editor (`types.d.ts:127-167`)
- theme/tools helpers (`types.d.ts:169-183`)

Pi's upstream dispatch table is `interactive-mode.js:1522-1557`; Phase 4 maps those calls through `RegionRegistry`.

## Slash commands and autocomplete

- Built-in slash commands come from `BUILTIN_SLASH_COMMANDS` and are added in `createBaseAutocompleteProvider()` (`interactive-mode.js:295-304`).
- Prompt templates are mapped into slash command entries (`interactive-mode.js:319-324`).
- Extension commands are read from `session.extensionRunner.getRegisteredCommands()` and added unless they conflict with built-ins (`interactive-mode.js:326-335`).
- Skill commands are added when enabled (`interactive-mode.js:337-352`).
- Submit-time command handling is in `setupEditorSubmitHandler()` (`interactive-mode.js:1951-2125`): built-ins are handled locally; extension commands route through `session.prompt(text)`.

## Session lifecycle and events

- `subscribeToAgent()` attaches `session.subscribe(event => handleEvent(event))` (`interactive-mode.js:2127-2130`).
- `handleEvent()` reacts to `agent_start`, `queue_update`, `message_start`, `message_update`, `message_end`, `tool_execution_*`, `agent_end`, `compaction_*`, `auto_retry_*` (`interactive-mode.js:2132-2440`).
- New/resume/fork/import paths call runtimeHost methods, then `renderCurrentSessionState()` and render/status updates (`interactive-mode.js:1136-1196`, `interactive-mode.js:3536-3577`, `interactive-mode.js:4022-4060`, `interactive-mode.js:4359-4374`).
- Shutdown drains input, stops TUI, disposes runtime, exits (`interactive-mode.js:2625-2635`).

## Pi-rendered noise to suppress or relocate

- `[Extension issues]` diagnostics are rendered into chat by `showLoadedResources()` (`interactive-mode.js:1088-1118`, specific add at `interactive-mode.js:1114`). SumoCode should relocate these into a notification/status surface or hide known benign Ctrl+P conflicts once Sumo owns that keybind.
- Anthropic subscription warning string is declared at `interactive-mode.js:74` and emitted via `maybeWarnAboutAnthropicSubscriptionAuth()` (`interactive-mode.js:3261-3281`). SumoCode can keep it as a warning toast rather than chat noise.
- Version/package/tmux warnings are triggered asynchronously in `run()` (`interactive-mode.js:504-517`). These can remain chat/status but should not corrupt retained layout.

## Smallest fork surface

Observed fork requirement:

1. Pi CLI imports and constructs `InteractiveMode` in `dist/main.js:31` and `dist/main.js:548-571`.
2. Extensions cannot replace this from `src/extension.ts` because extension factories are loaded after ESM imports and before the constructor call, but the constructor reference is already bound in `main.js`.
3. Therefore Phase 4 needs a fork patch at the Pi binary/main integration point (ADR Q4:A). The smallest patch is replacing `new InteractiveMode(runtime, options)` with `new SumoInteractiveMode(runtime, options)` plus a maintained implementation that reuses upstream session/runtime logic and swaps rendering at the TUI boundary.

Target vendored/derived surface in this PR:

- `sumo-interactive-mode.ts`: boundary and citations, MIT notice.
- `region-registry.ts`: retained replacement for pi-tui root containers.
- `extension-ui-adapter.ts`: retained replacement for `createExtensionUIContext()` dispatch.
- `foreign-extension-warning.ts`: defensive v1 foreign extension policy.

The remaining unimplemented fork patch is documented in `docs/research/phase-4-progress.md` if not completed in the 7-day window.
