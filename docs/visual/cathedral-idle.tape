# Cathedral idle baseline.
#
# Boots Pi inside the SumoCode repo, waits for the splash + sidebar to render,
# and screenshots the resulting frame. This is the "ready, no prompt yet" state
# we'll diff against the Cathedral mockups.

Output docs/visual/out/cathedral-idle.png

Set Shell zsh
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 14
Set Width 2000
Set Height 1200
Set Padding 10
Set TypingSpeed 30ms

# Land in the sumocode repo so the footer/sidebar context lines are stable.
Type "cd '/Volumes/SumoDeus NVMe/openclaw/workspace/worktrees/sumocode-fix-58'"
Enter
Sleep 250ms

Type "clear"
Enter
Sleep 100ms

Type "pi"
Enter

# Generous wait for Pi boot, extension load, splash render, and overlay mount.
Sleep 6s

Screenshot docs/visual/out/cathedral-idle.png

# Clean shutdown so vhs can finalize.
Ctrl+C
Sleep 200ms
Ctrl+D
Sleep 500ms
