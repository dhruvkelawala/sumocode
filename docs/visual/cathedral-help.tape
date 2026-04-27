# Cathedral theme exercise — /help renders Pi's built-in formatted help.
#
# This scene triggers Pi's markdown rendering (headings, lists, dim text,
# code spans) so the cathedral.json theme can be visually verified for
# fg / muted / dim / accent / list-bullet / heading mappings.

Output docs/visual/out/cathedral-help.png

Set Shell zsh
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 14
Set Width 2000
Set Height 1400
Set Padding 10
Set TypingSpeed 30ms

Type "cd '/Volumes/SumoDeus NVMe/openclaw/workspace/worktrees/sumocode-fix-58'"
Enter
Sleep 250ms

Type "clear"
Enter
Sleep 100ms

Type "pi"
Enter
Sleep 5s

# Open Pi's help / settings / commands list (depending on what / lands on).
Type "/help"
Enter
Sleep 2s

Screenshot docs/visual/out/cathedral-help.png

Ctrl+C
Sleep 200ms
Ctrl+D
Sleep 500ms
