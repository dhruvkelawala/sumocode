# Phase 5 retained cathedral portrait smoke (Mac mini portrait-class viewport).
# Target terminal shape: ~100 cols × 80 rows. Verifies centered splash,
# pinned footer, and no sidebar during splash.

Output docs/visual/out/sumo-tui-cathedral-portrait.png

Set Shell zsh
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 14
Set Width 1000
Set Height 1600
Set Padding 10
Set TypingSpeed 20ms

Type "cd '/Volumes/SumoDeus NVMe/openclaw/workspace/worktrees/sumocode-fix-58'"
Enter
Sleep 250ms

Type "clear"
Enter
Sleep 100ms

Type "./bin/sumocode.sh --offline --no-extensions --no-session"
Enter
Sleep 5s

Screenshot docs/visual/out/sumo-tui-cathedral-portrait.png

Ctrl+C
Sleep 300ms
Ctrl+D
Sleep 300ms
