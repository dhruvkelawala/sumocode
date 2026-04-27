# Issue #58 proof: active chat viewport is pre-filled with cathedral background.
# Boots SumoCode through the patched launcher, sends one message, then captures
# the active two-pane scene. The chat pane empty cells must be #1A1511, not raw
# terminal black; the sidebar remains #241D17.

Output docs/visual/out/sumo-tui-bg-fill.gif

Set Shell zsh
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 14
Set Width 1600
Set Height 1000
Set Padding 10
Set TypingSpeed 25ms

Type "cd '/Volumes/SumoDeus NVMe/openclaw/workspace/worktrees/sumocode-fix-58'"
Enter
Sleep 250ms

Type "clear"
Enter
Sleep 100ms

Type "rm -rf /tmp/sumocode-vhs-bg-fill && mkdir -p /tmp/sumocode-vhs-bg-fill"
Enter
Sleep 100ms

Type "PI_CODING_AGENT_DIR=/tmp/sumocode-vhs-bg-fill PI_OFFLINE=1 ./bin/sumocode.sh --offline --no-session"
Enter
Sleep 6s

Type "paint a cathedral background behind every empty chat cell"
Enter
Sleep 5s

Screenshot docs/visual/out/sumo-tui-bg-fill.png

Ctrl+C
Sleep 500ms
Ctrl+D
Sleep 500ms
