# Pi ↔ SumoCode Tool Architecture

## Overview

SumoCode is a Pi **extension** that wraps `@earendil-works/pi-coding-agent`.
Pi provides built-in tools (`bash`, `read`, `write`, `edit`, `mcp`) and an
extension API that lets SumoCode register additional tools, intercept tool
calls, and customize UI rendering.

## Tool Layers

### 1. Pi Built-in Tools

These ship with Pi and are always available:

| Tool    | What it does                                     | SumoCode customization       |
|---------|--------------------------------------------------|------------------------------|
| `bash`  | Execute shell commands                           | Tool pill renderer (E9)      |
| `read`  | Read file contents                               | Tool pill renderer (E9)      |
| `write` | Create/overwrite files                           | Tool pill renderer (E9)      |
| `edit`  | Precise text replacement                         | Tool pill renderer (E9)      |
| `mcp`   | Call MCP server tools                            | Tool pill renderer (E9)      |
SumoCode **does not re-register** or gate these. Built-in tool calls proceed through Pi and are rendered via the transcript view-model pipeline.

### 2. Pi Example Extensions (installed globally)

These live in Pi's examples directory and are loaded as regular extensions.
SumoCode can **override** them by registering a tool with the same `name`.

| Tool         | Pi source                                        | SumoCode override            |
|--------------|--------------------------------------------------|------------------------------|
| `question`   | `examples/extensions/question.ts`                | `src/question-tool.ts` — Divine Query single-question overlay |
| `/answer`    | `~/.pi/agent/extensions/answer.ts`               | `src/answer-tool.ts` — Cathedral multi-question wizard |

SumoCode registers its own `question` tool and `/answer` command,
overriding Pi's defaults. The user's `~/.pi/agent/extensions/answer.ts`
should be removed or disabled to avoid conflicts.

### 3. SumoCode-Only Tools

These are registered by SumoCode via `pi.registerTool()` and don't exist in
vanilla Pi.

| Tool family   | Source                         | Purpose                      |
|---------------|--------------------------------|------------------------------|
| `task`        | `src/native-task-tool.ts`       | Skill-run substrate; run isolated Pi subprocess skills and stream structured scroll/scribe state |
| `subagent_*`  | `src/subagents/`                | Spawn, steer, inspect, wait for, cancel, and list delegated child agents |
| `bg_*`        | `src/background-tasks/`         | Start, inspect, stop, and list non-interactive background shell terminals with typed completion cards |

### 4. SumoCode Extension Hooks

SumoCode may observe `pi.on("tool_call")` events for non-blocking UI state, but it must not re-register built-in tools. Current tool-call rendering flows through the transcript view-model pipeline.

## UI Rendering Layers

### Transcript View-Model Pipeline

All tool results flow through the structured transcript:

```
Pi agent event → ChatMessageViewModel → ChatBlock (tool/skill/delegation/code/question)
    → tool-renderer.ts / code-renderer.ts / scroll-renderer.ts / chat-message.ts
    → CellBuffer → ANSI → terminal
```

### Interactive Modals

| Modal              | Source                    | Triggered by                        |
|--------------------|---------------------------|-------------------------------------|
| Command Palette    | `src/command-palette.ts`  | `Ctrl+/` keybinding                 |
| Divine Query       | `src/divine-query.ts`     | `showDivineQuery()` from SumoCode code |
| Memory Editor      | `src/memory-editor.ts`    | `Ctrl+M` keybinding                 |

All modals use `ctx.ui.custom({ overlay: true })` for centered overlays.

### Pi's Internal UI (not interceptable)

Pi's own interactive mode has internal UI that SumoCode **cannot** override
without patching Pi upstream:

- `showExtensionSelector` — Pi's list selector (used by `/model`, `/session`)
- `showExtensionConfirm` — Pi's yes/no confirm
- `showExtensionInput` — Pi's text input

If Pi adds a `ui.select` override hook in the future, we can wire Divine Query
there to theme ALL selectors.

## LLM Tool Guidance

The `question` tool description includes instructions for the LLM:

> Do NOT prefix options with A)/B)/1./2. — the Cathedral UI adds labels automatically.

This ensures the Divine Query renderer doesn't produce double labels like `A) A) Yes`.

## Key Files

| File                              | Role                                          |
|-----------------------------------|-----------------------------------------------|
| `src/extension.ts`               | Main entry — wires all hooks and tools        |
| `src/divine-query.ts`            | Divine Query modal renderer + state machine   |
| `src/command-palette.ts`         | Command palette (calls `showDivineQuery`)     |
| `src/sumo-tui/transcript/*.ts`   | Tool/code/scroll renderers                    |
| `src/sumo-tui/widgets/chat-message.ts` | Chat frame + block routing              |
| `src/question-tool.ts`            | Question tool override (Divine Query)         |
| `src/answer-tool.ts`              | /answer command + Ctrl+. (Cathedral Q&A wizard) |
