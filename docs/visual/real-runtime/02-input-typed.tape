# T1·02: type into input — verify input box renders typed text without
# wrapping into the sidebar (catches the overflow class of bugs from #62).

Output docs/visual/out/real-runtime/02-input-typed.gif

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

# Type a long line to test wrap behavior in input box
Type "the quick brown fox jumps over the lazy dog" 
Sleep 500ms
Screenshot docs/visual/out/real-runtime/02-input-typed.png

Ctrl+c
Sleep 300ms
