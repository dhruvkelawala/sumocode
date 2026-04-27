# Issue #56 chat UI polish proof: retained chat pane plus populated cathedral sidebar.
# Shows USER/SUMO/TOOL rows, a fenced code sample, and sidebar panels in cathedral colors.

Output docs/visual/out/sumo-tui-chat-ui.gif

Set Shell zsh
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 14
Set Width 1600
Set Height 1000
Set Padding 10
Set TypingSpeed 20ms

Type "cd '/Volumes/SumoDeus NVMe/openclaw/workspace/worktrees/sumocode-fix-56'"
Enter
Sleep 250ms

Type "clear"
Enter
Sleep 100ms

Type "SUMO_TUI_ISSUE56_TAPE=1 SUMO_TUI_ISSUE56_COLS=100 SUMO_TUI_ISSUE56_ROWS=36 SUMO_TUI_ISSUE56_SCENARIO=chat pnpm exec tsx ./src/sumo-tui/demo/issue56-polish-demo.ts"
Enter
Sleep 2s

Screenshot docs/visual/out/sumo-tui-chat-ui.png
