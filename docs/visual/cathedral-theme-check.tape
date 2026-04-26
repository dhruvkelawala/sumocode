# Cathedral theme check — opens the /sumo:theme-check overlay so vhs can
# capture every theme color slot in one screenshot. Used as the canonical
# proof that the active Pi theme matches cathedral.json.

Output docs/visual/out/cathedral-theme-check.png

Set Shell zsh
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 14
Set Width 2000
Set Height 1600
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

Type "/sumo:theme-check"
Enter
Sleep 2s

Screenshot docs/visual/out/cathedral-theme-check.png

# Dismiss the overlay so vhs can clean up.
Space
Sleep 200ms

Ctrl+C
Sleep 200ms
Ctrl+D
Sleep 500ms
