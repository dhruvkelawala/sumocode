# sumo-tui Phase 3 streaming proof: ChatPager + ScrollBox sticky-bottom.

Output docs/visual/out/sumo-tui-streaming.png

Set Shell zsh
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 14
Set Width 1200
Set Height 900
Set Padding 10
Set TypingSpeed 20ms

Type "cd '/Volumes/SumoDeus NVMe/openclaw/workspace/worktrees/sumocode-fix-58'"
Enter
Sleep 250ms

Type "clear"
Enter
Sleep 100ms

Type "SUMO_TUI_PHASE3_TAPE=1 SUMO_TUI_PHASE3_DEMO=stream pnpm exec tsx ./src/sumo-tui/demo/phase3-chat-demo.ts"
Enter
Sleep 3s

Screenshot docs/visual/out/sumo-tui-streaming.png

Ctrl+C
Sleep 500ms
