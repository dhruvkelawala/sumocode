## Two daily-drive issues

### 1. Chat content overflows into sidebar boundary

Visible in latest screenshot: TOOL/USER/SUMO chat lines extend across the full terminal width into the cols where the sidebar lives. Sidebar paints over the right 49 cols, but the underlying chat content was painted there first. Looks "glued together" to the user.

Root cause: Pi's `chatContainer.render(width)` is called with full terminal width because we mount the sidebar via `installSidebar` (Pi's setWidget) — separate from chat. Our retained renderer composites the chat tree at the full passed-in width, so chat content paints into cells that Pi will subsequently overpaint with the sidebar widget.

Fix: in `UpstreamChatPagerBridge.render(width)`, narrow the effective width to `terminal - SIDEBAR_WIDTH` when sidebar is visible (same predicate Pi uses: `sessionHasMessages && terminalWidth >= SIDEBAR_MIN_TERMINAL_WIDTH`). Sidebar continues to render at the right 49 cols via Pi's separate widget; chat now stays inside its chat region boundary.

### 2. Footer thinking level still shows "medium" after #60

PR #60 was meant to fix this by reading `ctx.getThinkingLevel()`. But `getThinkingLevel()` lives on **`ExtensionAPI`** (the `pi` parameter), not on `ExtensionContext` (`ctx`).

Reference: `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts:849` is inside `interface ExtensionAPI` (line 768). `ExtensionContext` does NOT expose `getThinkingLevel()`.

So #60's probe always missed and silently fell back to "medium".

Fix: pass `pi` through to `createSnapshot`, call `pi.getThinkingLevel()`. Keep legacy `ctx` probe for older Pi versions / mocked test contexts.

## Acceptance criteria

- [ ] Chat content stops at the chat-sidebar boundary; no overflow into sidebar cols
- [ ] Footer thinking level reflects `pi.getThinkingLevel()` and updates live with Ctrl+T
- [ ] All 374 existing unit tests pass + 2 regression tests updated
- [ ] tsc clean
- [ ] PR opened with `Closes #62`
