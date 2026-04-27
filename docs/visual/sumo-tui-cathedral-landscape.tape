# Phase 5 retained cathedral landscape smoke (MacBook landscape-class viewport).
# Target terminal shape: ~240 cols × 60 rows. Verifies wide top chrome,
# centered splash, and footer pinning across a broad canvas.

Output docs/visual/out/sumo-tui-cathedral-landscape.png

Set Shell zsh
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 14
Set Width 2400
Set Height 1200
Set Padding 10
Set TypingSpeed 20ms

Type "cd '/Volumes/SumoDeus NVMe/openclaw/workspace/worktrees/sumocode-fix-56'"
Enter
Sleep 250ms

Type "clear"
Enter
Sleep 100ms

Type "./bin/sumocode.sh --offline --no-extensions --no-session"
Enter
Sleep 5s

Screenshot docs/visual/out/sumo-tui-cathedral-landscape.png

Ctrl+C
Sleep 300ms
Ctrl+D
Sleep 300ms
