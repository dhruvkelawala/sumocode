# T1·06: Ctrl+C exit — verify no escape sequence leakage in scrollback,
# altscreen properly torn down. Critical regression class for terminal-control.

Output docs/visual/out/real-runtime/06-clean-exit.gif

Set Shell zsh
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 13
Set Width 1600
Set Height 900
Set Padding 8
Set TypingSpeed 20ms

Type "cd '/Volumes/SumoDeus NVMe/openclaw/workspace/sumocode'"
Enter
Sleep 200ms
Type "clear"
Enter
Sleep 100ms

Type "SUMO_TUI=1 PI_OFFLINE=1 pi --offline -e ./src/extension.ts --no-session"
Enter
Sleep 4s

# Exit
Ctrl+c
Sleep 500ms

# After exit, run a regular command to show scrollback is clean.
# If altscreen wasn't torn down or escapes leaked, this will look broken.
Type "echo === sumocode exited cleanly ==="
Enter
Sleep 200ms

Screenshot docs/visual/out/real-runtime/06-clean-exit.png
