# Ultraviolet Core design contract

Ultraviolet Core is SumoCode's high-impact terminal alternative: deep violet-black chassis, violet focus/routing, pale lavender body text, ice secondary signal, localized amber tool execution, and pink approval/failure.

## Core roles

| Role | Hex | Meaning |
|---|---:|---|
| background | `#06050B` | host chassis / OSC 11 |
| surface | `#0D0917` | main/sidebar plane |
| surfaceRecess | `#0A0711` | input and generic wells |
| surfaceLifted | `#1B102E` | selected rows and overlays |
| foreground | `#DCC7FF` | pale lavender sustained body |
| foregroundDim | `#9B7BBE` | metadata / secondary hierarchy |
| divider | `#56347A` | decorative violet structure |
| accent | `#B974FF` | focus / active routing / OSC 12 |
| idle | `#DCC7FF` | healthy ready state |
| thinking | `#B974FF` | active reasoning |
| tool | `#FFC857` | execution and warning |
| approval | `#FF668F` | approval, failure, interruption |
| learning | `#75E8FF` | durable learning / ice signal |

Readable core roles exceed WCAG 4.5:1 against all four core surfaces. `divider` is decorative and must not be the sole carrier of text or state.

## Tool ledger roles

| Role | Hex |
|---|---:|
| surface | `#17100D` |
| border | `#6B4A1C` |
| label | `#FFC857` |
| target | `#FFE1A6` |
| body | `#FFE1A6` |
| bodyMuted | `#C7A96D` |

Tool bodies are amber-tinted, never generic white. Amber stays localized inside tool ledgers so the overall UI remains violet-dominant.

## Code roles

| Role | Hex |
|---|---:|
| surface | `#100A1D` |
| border | `#56347A` |
| foreground | `#DCC7FF` |
| gutter/comment | `#9B7BBE` |
| keyword | `#B974FF` |
| string/function | `#75E8FF` |
| number | `#FFC857` |

The renderer keeps its existing syntax taxonomy only: comment/string/number/keyword/function/body.

## Chrome and motion

- Message/input frames keep single-cell rounded box drawing.
- Sidebar/header sigils are ASCII: `> + * ~ #`.
- Working indicator is an eight-frame single-cell ASCII orbital pulse: `. : o O @ O o :` at 120ms.
- No gradients, glow effects, rainbow syntax, layout changes, or theme-name branches in production renderers.
