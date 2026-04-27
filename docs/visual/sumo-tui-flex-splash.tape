# sumo-tui Phase 2 flex splash proof.
#
# Boots a tiny Phase 2 demo extension that renders a Yoga column with:
#   flex spacer / PiEditorLeaf splash / flex spacer / Pi Text footer.
# The footer is pinned by Yoga at the bottom; there is no manual padding math.

Output docs/visual/out/sumo-tui-flex-splash.png

Set Shell zsh
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 14
Set Width 1200
Set Height 900
Set Padding 10
Set TypingSpeed 20ms

Type "cd '/Volumes/SumoDeus NVMe/openclaw/workspace/worktrees/sumocode-phase-2'"
Enter
Sleep 250ms

Type "clear"
Enter
Sleep 100ms

Type "pi --offline --no-extensions -e ./src/sumo-tui/demo/flex-splash-extension.ts --no-session"
Enter
Sleep 3s

Screenshot docs/visual/out/sumo-tui-flex-splash.png

Ctrl+C
Sleep 500ms
