# sumo-tui Phase 3 scrollback proof: manual scroll + unread jump banner.

Output docs/visual/out/sumo-tui-scroll-banner.png

Set Shell zsh
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 14
Set Width 1200
Set Height 900
Set Padding 10
Set TypingSpeed 20ms

Type "cd '/Volumes/SumoDeus NVMe/openclaw/workspace/worktrees/sumocode-fix-56'"
Enter
Sleep 250ms

Type "clear"
Enter
Sleep 100ms

Type "SUMO_TUI_PHASE3_TAPE=1 SUMO_TUI_PHASE3_DEMO=banner pnpm exec tsx ./src/sumo-tui/demo/phase3-chat-demo.ts"
Enter
Sleep 2s

Screenshot docs/visual/out/sumo-tui-scroll-banner.png

Ctrl+C
Sleep 500ms
