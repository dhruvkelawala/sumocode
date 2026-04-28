# T1·05: MacBook landscape dims (160 cols × 40 rows). Wide enough for
# sidebar dock mode (>= 120 cols). Catches sidebar dock layout bugs.

Output docs/visual/out/real-runtime/05-landscape-160x40.gif

Set Shell zsh
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 13
Set Width 2000
Set Height 700
Set Padding 8
Set TypingSpeed 20ms

Type "cd '/Volumes/SumoDeus NVMe/openclaw/workspace/sumocode'"
Enter
Sleep 200ms
Type "clear"
Enter
Sleep 100ms

Type "stty cols 160 rows 40 && SUMO_TUI=1 PI_OFFLINE=1 pi --offline -e ./src/extension.ts --no-session"
Enter
Sleep 4s

Screenshot docs/visual/out/real-runtime/05-landscape-160x40.png

Ctrl+c
Sleep 300ms
