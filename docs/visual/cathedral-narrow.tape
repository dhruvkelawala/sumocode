# Cathedral narrow — verifies the sidebar auto-hides at <120 cols
# (DESIGN.md §8 medium mode) when the terminal is too narrow to fit both
# chat (~70 cols) and the 49-col sidebar plus a gutter.
#
# Mac mini in portrait (~75 cols × ~130 rows) lands in this mode.

Output docs/visual/out/cathedral-narrow.png

Set Shell zsh
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 14
Set Width 1400
Set Height 2200
Set Padding 10
Set TypingSpeed 30ms

Type "cd '/Volumes/SumoDeus NVMe/openclaw/workspace/sumocode'"
Enter
Sleep 250ms

Type "clear"
Enter
Sleep 100ms

Type "pi"
Enter
Sleep 5s

Screenshot docs/visual/out/cathedral-narrow.png

Ctrl+C
Sleep 200ms
Ctrl+D
Sleep 500ms
