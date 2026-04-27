# Phase 5 retained cathedral narrow smoke (<120 cols).
# The sidebar policy switches to overlay below 120 cols after chat exists;
# splash remains sidebar-hidden, covering EC-17.6.

Output docs/visual/out/sumo-tui-cathedral-narrow.png

Set Shell zsh
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 14
Set Width 900
Set Height 1200
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

Screenshot docs/visual/out/sumo-tui-cathedral-narrow.png

Ctrl+C
Sleep 300ms
Ctrl+D
Sleep 300ms
