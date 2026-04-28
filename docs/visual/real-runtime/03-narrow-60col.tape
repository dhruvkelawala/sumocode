# T1·03: narrow terminal (60 cols × 24 rows) — sidebar should switch to
# overlay mode (it's < 120 col threshold). Catches overlay-vs-dock layout bugs.

Output docs/visual/out/real-runtime/03-narrow-60col.gif

Set Shell zsh
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 13
Set Width 800
Set Height 600
Set Padding 8
Set TypingSpeed 20ms

Type "cd '/Volumes/SumoDeus NVMe/openclaw/workspace/sumocode'"
Enter
Sleep 200ms
Type "clear"
Enter
Sleep 100ms

# Force 60×24 dims via stty before launching
Type "stty cols 60 rows 24 && SUMO_TUI=1 PI_OFFLINE=1 pi --offline -e ./src/extension.ts --no-session"
Enter
Sleep 4s

Screenshot docs/visual/out/real-runtime/03-narrow-60col.png

Ctrl+c
Sleep 300ms
