# T1·04: Mac mini portrait dims (40 cols × 100 rows). The narrow + tall case
# stresses splash vertical centering and sidebar overlay below 120 cols.

Output docs/visual/out/real-runtime/04-portrait-40x100.gif

Set Shell zsh
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 13
Set Width 600
Set Height 1800
Set Padding 8
Set TypingSpeed 20ms

Type "cd '/Volumes/SumoDeus NVMe/openclaw/workspace/sumocode'"
Enter
Sleep 200ms
Type "clear"
Enter
Sleep 100ms

Type "stty cols 40 rows 100 && SUMO_TUI=1 PI_OFFLINE=1 pi --offline -e ./src/extension.ts --no-session"
Enter
Sleep 4s

Screenshot docs/visual/out/real-runtime/04-portrait-40x100.png

Ctrl+c
Sleep 300ms
