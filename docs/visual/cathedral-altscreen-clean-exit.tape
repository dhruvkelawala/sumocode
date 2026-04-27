# Phase 1 terminal lifecycle proof.
#
# Boot SumoCode, exit with Ctrl+C, then type `asd` in the shell. The final
# screenshot should show a clean shell prompt/command with no kitty keyboard or
# modifyOtherKeys escape leakage such as `7;1:3u`.

Output docs/visual/out/cathedral-altscreen-clean-exit.png

Set Shell zsh
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 14
Set Width 1600
Set Height 1000
Set Padding 10
Set TypingSpeed 30ms

Type "cd '/Volumes/SumoDeus NVMe/openclaw/workspace/worktrees/sumocode-fix-56'"
Enter
Sleep 250ms

Type "clear"
Enter
Sleep 100ms

Type "pi --offline --no-extensions -e ./src/extension.ts --no-session"
Enter
Sleep 5s

Ctrl+C
Sleep 500ms

Type "asd"
Enter
Sleep 500ms

Screenshot docs/visual/out/cathedral-altscreen-clean-exit.png

Ctrl+D
Sleep 500ms
