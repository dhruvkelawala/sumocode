# T1·01: clean boot — splash visible, theme bg painted, cursor visible.
# Drives the REAL ./bin/sumocode.sh — no demo extensions.

Output docs/visual/out/real-runtime/01-splash.gif

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

# Splash + chrome
Sleep 4s
Screenshot docs/visual/out/real-runtime/01-splash.png

# Clean exit
Ctrl+c
Sleep 300ms
