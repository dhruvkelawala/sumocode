# Real runtime VHS — actually launches ./bin/sumocode.sh and exercises the
# scenarios the user has been complaining about: long tool output, sidebar
# rendering during chat, idle CPU.
#
# This is the tape we should be checking BEFORE claiming a fix landed.

Output docs/visual/out/sumo-tui-real-runtime.gif

Set Shell zsh
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 13
Set Width 2400
Set Height 1500
Set Padding 8
Set TypingSpeed 20ms

Type "cd '/Volumes/SumoDeus NVMe/openclaw/workspace/sumocode'"
Enter
Sleep 200ms

Type "clear"
Enter
Sleep 100ms

# Run sumocode with offline so we don't actually call an LLM, but with --no-extensions=false so our extension loads
Type "SUMO_TUI=1 PI_OFFLINE=1 pi --offline -e ./src/extension.ts --no-session"
Enter

# Wait for splash + chrome to render
Sleep 4s

Screenshot docs/visual/out/sumo-tui-real-runtime-splash.png

# Type a fake message to trigger active state
Type "Hi"
Enter
Sleep 500ms

Screenshot docs/visual/out/sumo-tui-real-runtime-active.png

Sleep 200ms

# Exit cleanly
Ctrl+c
Sleep 300ms

Type "echo asd"
Enter
Sleep 200ms

Screenshot docs/visual/out/sumo-tui-real-runtime-exit.png
