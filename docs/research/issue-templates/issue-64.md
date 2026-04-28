## Sidebar still appears to have chat content "overflowing" + black gaps

User reports chat content (especially long tool outputs like grep results, code blocks) appears to extend into the sidebar area. Plus previous screenshot showed black bands BETWEEN sidebar sections.

Diagnosis: not actually overflow. Both symptoms are the same root cause:

1. Pi has its own render path for tool outputs / code blocks that bypasses our `chatContainer.render` override (it writes them directly to terminal at full width).
2. Sumocode's `StaticSidebarDock.render()` zips main components with sidebar lines. When sidebar has FEWER lines than main content (which is common when chat has lots of tool output), it pads the missing right-side rows with `" ".repeat(SIDEBAR_WIDTH)` — **plain spaces with no surface bg**.
3. Result: chat content from Pi's separate render path shows through the right 49 cols on rows where sidebar has no content. Looks like chat overflow.

The "black gaps between sections" issue (previous screenshot) is the same — spacer rows in the sidebar didn't paint surface bg, so terminal-default bg showed through.

## Fix

In `src/sidebar.ts` `StaticSidebarDock.render()`, replace plain-space padding with a surface-bg-painted blank row built via `surfaceLine("", SIDEBAR_WIDTH)`.

```diff
+ const blankSidebarRow = surfaceLine("", SIDEBAR_WIDTH);
  for (let i = 0; i < rowCount; i++) {
    const left = padToWidth(mainLines[i] ?? "", mainWidth);
    const right = i < sidebarLines.length
      ? padToWidth(sidebarLines[i]!, SIDEBAR_WIDTH)
-     : " ".repeat(SIDEBAR_WIDTH);
+     : blankSidebarRow;
    lines.push(`${left}${" ".repeat(STATIC_SIDEBAR_GUTTER)}${right}`);
  }
```

## Acceptance criteria

- [ ] Sidebar's right 49 cols show cathedral surface bg on every visible row, even when chat content is taller than sidebar
- [ ] Long tool outputs (grep, code blocks) no longer appear to "overflow" into sidebar area
- [ ] Black gaps between sidebar sections eliminated
- [ ] All 376 unit tests + 14 integration tests pass
- [ ] PR opened with `Closes #64`
