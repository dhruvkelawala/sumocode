## Architectural bug: ghost UI elements stack in chat scrollback

When sumocode runs and the user sends messages (especially anything that triggers code blocks or long tool output), the chat scrollback accumulates ghost copies of the entire UI shell — `INPUT` boxes appear in the middle of chat history, code blocks render alongside stale chat content, vertical bands of cathedral surface bg appear between rows.

## Root cause

`SumoInteractiveRuntime.renderChatLines(width, height)` composites the **entire** retained Yoga tree into a CellBuffer and returns the result as `string[]` to Pi's `chatContainer.render` override.

If `this.root` contains the whole shell (top chrome + chat + input frame + footer + sidebar + splash), every call returns N lines containing ALL UI elements. Pi treats `chatContainer.render` output as scrollback content and APPENDS each render to the viewport. Result:

- Frame 1: returns lines `[topChrome, splash, inputBox, footer]` → Pi writes them
- User sends a message
- Frame 2: returns `[topChrome, message1, inputBox, footer]` → Pi writes them BELOW frame 1
- User sends another message
- Frame 3: returns `[topChrome, message1, message2, inputBox, footer]` → Pi writes them BELOW frame 2

Net visible: 3× topChrome, 3× inputBox, 3× footer stacked in scrollback, with messages interleaved.

This is why:
1. Long sessions show ghost UI elements between messages
2. Code blocks "break the layout" — they cause a re-render with new content, which adds another copy of the shell
3. Sidebar shows fine because it's rendered SEPARATELY by Pi's setWidget (not inside our composite)

## Fix

`this.root` (the runtime's composite target for `chatContainer.render`) must contain ONLY chat content (chat region or splash, NOT input/footer/top-chrome). Pi already mounts the input box, footer, and top chrome as separate widgets via `setFooter`/`setEditorComponent`/`setHeader`/`setWidget`. We should NOT include those in our composite.

Specifically:
- Move splash + chat scrollbox into a `chatRoot` that's separate from the main runtime root
- `renderChatLines(width, height)` composites only `chatRoot`
- The shell-level layout (header, footer, sidebar dock) stays in Pi's own component tree via Pi extension API — same way `installFooter`, `installTopChrome`, `installSidebar`, `installInputHints` already work

## Acceptance criteria

- [ ] `chatContainer.render` returns ONLY chat content (messages or splash), NOT input/footer/top chrome
- [ ] Stale ghost UI elements do not accumulate in scrollback
- [ ] All 376 unit + 14 integration tests still pass
- [ ] `vhs docs/visual/sumo-tui-real-runtime.tape` shows clean active state with no ghost shells
- [ ] PR opened with `Closes #67`

## Why my earlier fixes didn't catch this

I was checking VHS tapes that drive demo extensions (`pnpm exec tsx ./src/sumo-tui/demo/issue56-polish-demo.ts`), not actual `pi -e ./src/extension.ts`. The demo extensions render through a different code path that doesn't accumulate scrollback. The real-pty tape (#66, just merged) is now the canonical pre-merge check.

## References

- `src/sumo-tui/pi-compat/sumo-interactive-mode.ts` — `renderChatLines()` composes the full root tree
- `src/sumo-tui/cathedral/sidebar-tree.ts` — `createSidebarTree` builds the offending root structure
- Pi extension API: `setHeader`, `setFooter`, `setEditorComponent`, `setWidget` are the proper mount points for shell elements
