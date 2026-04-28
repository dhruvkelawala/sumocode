## Two daily-drive regressions

### 1. Splash cat face flashes for ~1 frame at boot then disappears

User reports: launching `./bin/sumocode.sh`, the cat + SUMOCODE wordmark are visible for a split second, then replaced by just the centered Saint-Exupéry quote.

Root cause: PR #57's `empty-chat-quote` (per UX_SPEC §4.4) renders whenever sidebar is visible AND chat has zero messages. This stole the no-messages slot from the splash. UX_SPEC §0 explicitly says:

```
no messages              → splash (cat + SUMOCODE wordmark + quote, full width)
first message / /resume  → cathedral active state (this spec)
```

So §0 supersedes §4.4. Splash should be the only no-messages view in v1.

### 2. Footer thinking level always shows "medium"

User reports thinking level rendering as "medium" regardless of actual setting. Tracing the code:

```ts
function getThinkingLevel(ctx: ExtensionContext): ThinkingLevel {
    const maybe = (ctx as { thinkingLevel?: ThinkingLevel }).thinkingLevel;
    return maybe ?? "medium";
}
```

`ctx.thinkingLevel` is not a public Pi API — it doesn't exist on ExtensionContext. So the `?? "medium"` fallback always wins. Pi 0.70.2 exposes the proper getter at `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts:849`:

```ts
/** Get current thinking level. */
getThinkingLevel(): ThinkingLevel;
```

We need to call the actual API.

## Acceptance criteria

- [ ] Splash visible from boot until first user message
- [ ] EmptyChatQuoteNode kept allocated but never mounted (v2 carry-over)
- [ ] Footer reads real thinking level from `ctx.getThinkingLevel()`
- [ ] All 374 existing unit tests pass
- [ ] PR opened with `Closes #60`
