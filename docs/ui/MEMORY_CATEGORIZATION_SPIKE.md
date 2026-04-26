# Memory Categorization Spike

Date: 2026-04-26  
Repo: `dhruvkelawala/sumocode`  
Remnic version inspected: `@remnic/cli` v1.0.5

## Context

Element 7 is the `/sumo:memory edit` experience.

Already locked:

- **Q7.1 scope:** read-only browser for v1. Editing remains slash-command driven.
- **Q7.3 visual:** flat-hybrid modal matching Element 6 approval modal.

Open decision:

- **Q7.2 categorization:** Dhruv prefers Stitch v3-style categorized memory if achievable without major friction. Otherwise flat list is acceptable.

Relevant mockups:

- `docs/ui/stitch/cathedral/v1/05-memory-editor.png` shows a four-panel browser: `IDENTITY`, `PREFERENCES`, `STACK`, `PROJECTS`.
- `docs/ui/stitch/cathedral/v3/05-memory-editor.png` shows a single-entry editor with grouped sections: `IDENTITY`, `PREFERENCES`, `STACK ALIGNMENT`.

## VERDICT

**Recommended approach: Approach 2-lite — Remnic-native metadata + SumoCode display taxonomy.**

Use Remnic's real fields:

- `category` — fixed enum (`fact`, `preference`, `decision`, `rule`, `procedure`, etc.)
- `tags` — arbitrary string array, max 50 tags, each max 256 chars
- `entityRef` — optional entity key
- `status`, `created`, `updated`, `confidence`, `source`

Then render a v3-style categorized read-only modal by grouping client-side into SumoCode panels:

1. `IDENTITY`
2. `PREFERENCES`
3. `WORKFLOW`
4. `PROJECTS`
5. `SYSTEM`
6. `GENERAL` fallback, hidden if empty

This is honest because Remnic **does not** have a native custom `identity` / `stack` / `project` type system, but it **does** support enough native metadata to make categorized display durable without an LLM and without fragile text prefixes.

### Why this beats the flat list

- Dhruv explicitly prefers v3-style categorization.
- Remnic's schema already supports `category` and `tags`; we do not need to mutate internal state.
- The modal is read-only, so categorization can be display-only at first. No data-loss risk.
- Existing untagged memories can be shown through deterministic routing and `GENERAL` fallback.
- Future `/sumo:memory add` can write tags properly, progressively improving the panels.

### Migration cost

Low-to-medium.

- **No destructive migration for v1.** Existing facts remain untouched.
- At render time, route each fact using:
  1. `sumocode:*` tag if present
  2. Remnic `category`
  3. deterministic keyword rules
  4. `GENERAL`
- Later, if desired, add a `/sumo:memory classify` command that restores facts as tagged copies and archives old ones through the public `POST /engram/v1/memories` + `POST /engram/v1/review-disposition` flow.

### Rollback plan

If grouping feels wrong, the same data model can render as a flat list immediately. No stored data changes are required.

---

## Remnic actual data model

### Public write schema

Source: `/opt/homebrew/lib/node_modules/@remnic/cli/node_modules/@remnic/core/dist/chunk-WCLICCGB.js`

`memoryStoreRequestSchema` accepts:

```ts
{
  schemaVersion?: number;
  idempotencyKey?: string;
  dryRun?: boolean;
  sessionKey?: string;
  content: string;                 // 1..50_000 chars in access schema
  category?:
    | "fact"
    | "preference"
    | "correction"
    | "entity"
    | "decision"
    | "relationship"
    | "principle"
    | "commitment"
    | "moment"
    | "skill"
    | "rule"
    | "procedure"
    | "reasoning_trace";
  confidence?: number;             // 0..1
  namespace?: string;
  tags?: string[];                 // max 50, each max 256 chars
  entityRef?: string;
  ttl?: string;
  sourceReason?: string;
}
```

Source: `/opt/homebrew/lib/node_modules/@remnic/cli/node_modules/@remnic/core/dist/chunk-3FPTCC3Z.js`

`validateExplicitCaptureInput()` defaults category to `fact`, rejects unsupported categories, deduplicates tags, and stores via `storage.writeMemory(category, content, { confidence, tags, entityRef, expiresAt, source })`.

### Does Remnic support tags / labels / categories / namespaces?

| Capability | Verdict | Evidence |
|---|---:|---|
| Fixed categories | Yes | `categorySchema` enum in `chunk-WCLICCGB.js`; also `INLINE_ALLOWED_CATEGORIES` in `chunk-3FPTCC3Z.js` |
| Arbitrary tags | Yes | `tagsSchema = z.array(z.string().max(256)).max(50).optional()` |
| Arbitrary UI labels | Not directly | no custom `type` field; custom meaning should live in `tags` or client-side grouping |
| Namespaces | Yes in schema; currently disabled locally | `/health` reports `namespacesEnabled: false`, `defaultNamespace: "default"` |
| Entity references | Yes | `entityRef` in schema and serialized summaries |

### Does Remnic support typed facts?

**Partially.** It supports a fixed `category` enum. It does **not** support arbitrary typed schemas such as:

```json
{ "type": "identity", "primaryAlias": "Dhruv Kelawala" }
```

Attempting `category: "identity"` fails validation:

```json
{
  "error": "request validation failed",
  "code": "validation_error",
  "details": [
    {
      "field": "category",
      "message": "Invalid enum value. Expected 'fact' | 'preference' | ... | 'reasoning_trace', received 'identity'"
    }
  ]
}
```

So Stitch v3-style `IDENTITY` / `STACK ALIGNMENT` should be treated as **SumoCode display sections**, not Remnic-native fact types.

### Does Remnic's graph API support clustering memories by relationship?

Not for this v1 modal.

Inspected routes include:

- `GET /engram/v1/entities`
- `GET /engram/v1/entities/:name`
- `POST /engram/v1/recall` with `mode: "graph_mode"`
- `GET /engram/v1/recall/xray`

Local data currently has no entities:

```json
{
  "namespace": "default",
  "total": 0,
  "count": 0,
  "entities": []
}
```

`graph_mode` recall did not produce useful grouping for the current store. It is retrieval-oriented, not a stable UI clustering API.

### What metadata does each memory carry?

From `GET /engram/v1/memories/:id`, a memory has:

```json
{
  "id": "fact-1777214500725-3yyl",
  "path": "memory/facts/2026-04-26/fact-1777214500725-3yyl.md",
  "category": "fact",
  "status": "active",
  "created": "2026-04-26T14:41:40.725Z",
  "updated": "2026-04-26T14:41:40.725Z",
  "content": "cmux ships vertical tabs...",
  "frontmatter": {
    "id": "fact-1777214500725-3yyl",
    "category": "fact",
    "created": "2026-04-26T14:41:40.725Z",
    "updated": "2026-04-26T14:41:40.725Z",
    "source": "explicit",
    "confidence": 0.95,
    "confidenceTier": "explicit",
    "tags": [],
    "status": "active",
    "contentHash": "..."
  }
}
```

Browse summaries include:

```ts
{
  id: string;
  path: string;
  category: string;
  status: string;
  created: string;
  updated: string;
  tags: string[];
  entityRef?: string;
  preview: string;
}
```

Source: `serializeMemory()` / `serializeMemorySummary()` in `chunk-STGWEHYR.js`.

### Public HTTP endpoints inspected

Source: `/opt/homebrew/lib/node_modules/@remnic/cli/node_modules/@remnic/core/dist/chunk-UWB5LMWY.js`

| Endpoint | Method | Purpose | Payload / query |
|---|---:|---|---|
| `/engram/v1/health` | GET | daemon health | none |
| `/engram/v1/adapters` | GET | adapter registry | none |
| `/engram/v1/recall` | POST | recall memories | `recallRequestSchema` |
| `/engram/v1/coding-context` | POST | set coding context | `setCodingContextRequestSchema` |
| `/engram/v1/recall/explain` | POST | explain recall | `recallExplainRequestSchema` |
| `/engram/v1/recall/tier-explain` | GET | tier explanation | `session`, `namespace` |
| `/engram/v1/recall/xray` | GET | recall x-ray | `q`, `session`, `namespace`, `budget` |
| `/engram/v1/observe` | POST | observe chat messages | `observeRequestSchema` |
| `/engram/v1/lcm/search` | POST | LCM search | `lcmSearchRequestSchema` |
| `/engram/v1/lcm/status` | GET | LCM status | none |
| `/engram/v1/memories` | POST | store explicit memory | `memoryStoreRequestSchema` |
| `/engram/v1/suggestions` | POST | queue memory suggestion | `suggestionSubmitRequestSchema` |
| `/engram/v1/memories` | GET | browse memories | `q`, `status`, `category`, `namespace`, `sort`, `limit`, `offset` |
| `/engram/v1/memories/:id` | GET | get full memory | `namespace` |
| `/engram/v1/memories/:id/timeline` | GET | memory lifecycle | `namespace`, `limit` |
| `/engram/v1/entities` | GET | list entities | `q`, `namespace`, `limit`, `offset` |
| `/engram/v1/entities/:name` | GET | get entity | `namespace` |
| `/engram/v1/review-queue` | GET | review queue | `runId`, `namespace` |
| `/engram/v1/maintenance` | GET | maintenance summary | `namespace` |
| `/engram/v1/quality` | GET | quality summary | `namespace` |
| `/engram/v1/trust-zones/status` | GET | trust zone status | `namespace` |
| `/engram/v1/procedural/stats` | GET | procedure stats | `namespace` |
| `/engram/v1/trust-zones/records` | GET | browse trust records | `q`, `zone`, `kind`, `sourceClass`, `namespace`, `limit`, `offset` |
| `/engram/v1/review-disposition` | POST | archive/reject/etc memory | `reviewDispositionRequestSchema` |
| `/engram/v1/trust-zones/promote` | POST | promote trust record | `trustZonePromoteRequestSchema` |
| `/engram/v1/trust-zones/demo-seed` | POST | seed trust demo | `trustZoneDemoSeedRequestSchema` |
| `/engram/v1/review/contradictions` | GET | contradictions list | query params |
| `/engram/v1/review/contradictions/:id` | GET | contradiction detail | path param |
| `/engram/v1/review/resolve` | POST | resolve contradiction | body |
| `/engram/v1/contradiction-scan` | POST | scan contradictions | body |

### CLI commands inspected

`remnic --help` reports:

- `init`
- `migrate`
- `status`
- `query`
- `doctor`
- `config`
- `openclaw install`
- `daemon start|stop|restart|install|uninstall|status`
- `token generate|list|revoke`
- `tree generate|watch|validate`
- `onboard`
- `curate`
- `review list|approve|dismiss|flag`
- `sync run|watch`
- `dedup`
- `connectors list|install|remove|doctor|marketplace`
- `extensions list|show|validate|reload`
- `space list|switch|create|delete|push|pull|share|promote|audit`
- `bench ...`
- `briefing`
- `versions`
- `binary scan|status|run|clean`
- `taxonomy show|resolver|add|remove|resolve`
- `enrich`
- `training:export`

The CLI is broad, but the SumoCode memory editor should prefer the public HTTP API already used by `src/memory.ts`.

---

## Current local memory store

`GET /engram/v1/health`:

```json
{
  "ok": true,
  "memoryDir": "./memory",
  "namespacesEnabled": false,
  "defaultNamespace": "default",
  "searchBackend": "qmd",
  "qmdEnabled": true,
  "nativeKnowledgeEnabled": false,
  "projectionAvailable": false
}
```

`GET /engram/v1/memories?limit=20&status=active&sort=updated_desc` currently returns 3 active memories:

```json
{
  "id": "fact-1777214500725-3yyl",
  "category": "fact",
  "status": "active",
  "tags": [],
  "entityRef": null,
  "preview": "cmux ships vertical tabs and is purpose-built for AI coding agents. Visual verification of SumoCode UI must account for the cmux host..."
}
```

```json
{
  "id": "fact-1777214500714-5ypz",
  "category": "fact",
  "status": "active",
  "tags": [],
  "entityRef": null,
  "preview": "dhruv runs sumocode inside cmux from manaflow-ai/cmux..., not Ghostty directly..."
}
```

```json
{
  "id": "preference-1777214459876-twh4",
  "category": "preference",
  "status": "active",
  "tags": [],
  "entityRef": null,
  "preview": "mac mini is in portrait orientation. macbook is landscape. sidebar layout must support both."
}
```

Existing facts already carry useful `category` metadata (`fact`, `preference`) but no tags, no entity refs, and no entities.

---

## Approach evaluations

## Approach 1 — Prefix-tagged content

Tell users to add memories like:

```txt
identity: Dhruv is a Senior Frontend Engineer at Argent in London.
preference: prefers TDD and visual approval before UI slices are done.
stack: uses pnpm, TypeScript strict, React Native, Next.js.
project: SumoCode runs inside cmux; sidebar hidden on splash.
```

### Remnic support

Client-side only. Remnic stores this as plain `content`; it does not parse these prefixes into first-class fields.

### Friction

Medium. User has to remember prefix discipline. Existing memories without a prefix need migration or go to `GENERAL`.

### Implementation cost

Small.

- Parse `/^([a-z-]+):\s+/` from `content` or `preview`.
- Strip prefix in display.
- Group into panels.

### Pros

- Very easy.
- Works with current Remnic API.
- Human-readable in markdown files.

### Cons

- Pollutes memory text.
- Relies on user discipline.
- Duplicates Remnic's real `category` field poorly.
- Weak long-term architecture.

### Render sketch

```txt
                              SUMOCODE MEMORY
   ────────────────────────────────────────────────────────────────────────

   ╭─ IDENTITY ─────────────────────╮  ╭─ PREFERENCES ───────────────────╮
   │ Dhruv · Senior FE · Argent     │  │ TDD by default                  │
   │ London / BST                   │  │ visual approval before done     │
   │                                │  │ pnpm, not npm                   │
   ╰────────────────────────────────╯  ╰────────────────────────────────╯

   ╭─ STACK ────────────────────────╮  ╭─ PROJECTS ──────────────────────╮
   │ TypeScript strict              │  │ SumoCode inside cmux            │
   │ React Native / Expo            │  │ Cathedral v0.2 parity           │
   │ Next.js / Convex               │  │ OpenClaw ACPX integration       │
   ╰────────────────────────────────╯  ╰────────────────────────────────╯

   ────────────────────────────────────────────────────────────────────────
   ↑↓ navigate    / search    ⏎ copy id    esc close
```

### Verdict

Acceptable fallback, but not recommended. We can do better with real Remnic metadata.

---

## Approach 2 — Remnic-native typed facts

Use Remnic's real fields: `category`, `tags`, `entityRef`.

### Remnic support

Genuine, but limited.

- Yes: fixed `category` enum.
- Yes: arbitrary `tags`.
- Yes: `entityRef`.
- No: arbitrary `type` schemas such as `identity` or `stackAlignment`.

### Recommended SumoCode taxonomy

Because Remnic category names are generic, SumoCode should define a display taxonomy on top:

| SumoCode panel | Native signals |
|---|---|
| `IDENTITY` | tag `sumocode:identity`, `entityRef=dhruv`, content with `dhruv`, `london`, `argent`, `senior frontend`, category `entity`/`relationship` |
| `PREFERENCES` | category `preference`, `rule`, `principle`; tag `sumocode:preference` |
| `WORKFLOW` | category `procedure`, `skill`, `rule`, `decision`; tags `sumocode:workflow`, `sumocode:tdd`, `sumocode:visual` |
| `PROJECTS` | tags `sumocode:project`, `project:sumocode`, `project:openclaw`, content with `sumocode`, `openclaw`, `cmux`, `cathedral` |
| `SYSTEM` | tags `sumocode:system`, content with hardware/runtime constraints: `mac mini`, `macbook`, `cmux`, `terminal`, `visual verification` |
| `GENERAL` | anything unclassified |

Panel label change from the Stitch v1/v3 mockups:

- `STACK` becomes **`WORKFLOW`** because the stored facts are mostly process/runtime/product constraints, not just libraries.
- Add **`SYSTEM`** because Dhruv's actual memories include machine/terminal/orientation constraints.
- Keep `PROJECTS` because SumoCode/OpenClaw facts are project-scoped.

### Friction

Low if `/sumo:memory add` auto-tags.

Manual command examples could be:

```txt
/sumo:memory add --panel identity "Dhruv is a Senior Frontend Engineer at Argent in London."
/sumo:memory add --panel workflow "Use TDD for all v0.2+ SumoCode slices."
/sumo:memory add --panel project:sumocode "Sidebar hidden on splash; Path D accepted for active chat."
```

Internally this stores:

```json
{
  "content": "Use TDD for all v0.2+ SumoCode slices.",
  "category": "rule",
  "tags": ["sumocode:workflow", "project:sumocode"],
  "sourceReason": "sumocode memory add"
}
```

### Implementation cost

Medium.

Required SumoCode pieces:

1. Extend `MemoryFact` to include `status`, `tags`, `entityRef`, `path`, `confidence` if needed.
2. Add `browse({ status, q, limit, offset })` to `RemnicMemoryClient`; `query()` recall is the wrong API for this modal.
3. Add pure grouping function:
   - input: `MemoryFact[]`
   - output: `{ panel: PanelId; facts: MemoryFact[] }[]`
   - deterministic and fully unit tested.
4. Render flat-hybrid modal with grouped panels.
5. Later: update `/sumo:memory add` to support `--panel` and write tags.

### Pros

- Uses real Remnic schema.
- Avoids LLM cost and latency.
- Does not pollute memory text.
- Existing memories still show up.
- Can look v3-style immediately.

### Cons

- Not a truly native Remnic `identity` type.
- Browse endpoint has `category` filter but no explicit `tag` filter. For v1, fetch active memories and filter/group client-side.
- Existing facts are untagged, so initial categorization is heuristic.

### Render sketch

```txt
                              SUMOCODE MEMORY
   ────────────────────────────────────────────────────────────────────────

   │ search memories…                                      3 active facts │

   IDENTITY                         PREFERENCES
   ─────────────────────────────    ─────────────────────────────
   · Dhruv runs SumoCode...         ❯ mac mini portrait; macbook landscape

   WORKFLOW                         PROJECTS
   ─────────────────────────────    ─────────────────────────────
   · visual verification via cmux   · SumoCode UI targets Cathedral parity
   · sidebar supports both screens  · OpenClaw ACPX integration planned

   SYSTEM                           GENERAL
   ─────────────────────────────    ─────────────────────────────
   · cmux embeds libghostty         · unclassified active fact

   ────────────────────────────────────────────────────────────────────────
   ↑↓ navigate    / search    c copy id    esc close
```

### Verdict

Recommended.

---

## Approach 3 — LLM-classified at read time

On modal open, fetch all active memories, ask a small model to classify them into panels, and cache per memory id/content hash.

### Remnic support

Client-side only. Remnic stores facts; SumoCode owns classification and cache.

### Cost estimate

For 200 memories, assume ~60 tokens per memory preview + JSON scaffolding:

- Input: ~12k-16k tokens worst-case; current store is tiny.
- Output: ~1k-2k tokens.
- With a cheap classifier model, this is likely fractions of a cent per uncached full run, but still non-zero and depends on provider.

### Caching strategy

Store a local JSON file, not Remnic:

```txt
~/.sumocode/memory-classification-cache.json
```

Key by:

```txt
memoryId + updated + contentHash/previewHash
```

Fallback when offline/no API key:

1. Use cached classifications.
2. Then deterministic grouping.
3. Then `GENERAL`.

### Time to first paint

Should not block first paint.

- Open modal immediately with deterministic grouping.
- Show footer state: `INSCRIBING · classifying 17 uncached facts…`
- Replace groups when classification returns.

### Implementation cost

Large.

- Provider abstraction.
- Cache invalidation.
- Streaming/progress state.
- Offline fallback.
- Tests with mocked model.
- Cost cap and telemetry.

### Pros

- Best semantic grouping.
- No user prefix/tag discipline.
- Good for large messy memory stores.

### Cons

- Adds latency, cost, failure modes.
- Overkill for current 3 active facts.
- Modal becomes dependent on model availability.
- Harder to explain/debug when facts jump panels.

### Render sketch

```txt
                              SUMOCODE MEMORY
   ────────────────────────────────────────────────────────────────────────

   │ search memories…                         48 facts · 7 classifying… │

   IDENTITY                         PREFERENCES
   ─────────────────────────────    ─────────────────────────────
   · Dhruv · Senior FE · Argent     ❯ prefers TDD slices
   · London / BST                   · concise final answers

   WORKFLOW                         PROJECTS
   ─────────────────────────────    ─────────────────────────────
   · visual approval before done    · SumoCode Cathedral parity
   · use vhs, not Ghostty target    · OpenClaw ACPX CTO agent

   SYSTEM                           GENERAL
   ─────────────────────────────    ─────────────────────────────
   · Mac mini portrait              · uncached/unknown fact

   ────────────────────────────────────────────────────────────────────────
   INSCRIBING · cached 41/48    ↑↓ navigate    / search    esc close
```

### Verdict

Not for v1. Keep as future upgrade if the memory store grows large and messy.

---

## Approach 4 — Flat list with visual grouping by recency/relevance

No semantic categories. Display active facts sorted by update time, optionally with recency headers.

### Remnic support

Native. `GET /engram/v1/memories?status=active&sort=updated_desc` does exactly this.

### Friction

None.

### Implementation cost

Small.

### Pros

- Most robust.
- No invented categorization.
- Fastest to implement.
- Works with current `src/memory.ts` mental model.

### Cons

- Does not deliver Dhruv's desired v3-style memory experience.
- Less cathedral identity.
- Harder to scan once memory count grows.

### Render sketch

```txt
                              SUMOCODE MEMORY
   ────────────────────────────────────────────────────────────────────────

   │ search memories…                                      3 active facts │

   RECENT
   ────────────────────────────────────────────────────────────────────────
   ❯ cmux ships vertical tabs and is purpose-built for AI coding agents…
     fact · fact-1777214500725-3yyl · updated today

     dhruv runs sumocode inside cmux from manaflow-ai/cmux…
     fact · fact-1777214500714-5ypz · updated today

     mac mini is in portrait orientation. macbook is landscape…
     preference · preference-1777214459876-twh4 · updated today

   ────────────────────────────────────────────────────────────────────────
   ↑↓ navigate    / search    c copy id    esc close
```

### Verdict

Good rollback/fallback, but not the recommended target.

---

## Recommended Element 7 decision text

Use this in `CATHEDRAL_DECISIONS.md`:

```md
## Element 7 — Memory editor

**Locked: read-only flat-hybrid modal with v3-style categorized panels, using Remnic-native metadata plus SumoCode display taxonomy.**

- Q7.1: A — read-only browser for v1. Editing remains slash-command driven.
- Q7.2: categorized panels, but not by inventing Remnic custom types.
  - Use Remnic `category` + `tags` + `entityRef` when present.
  - Group client-side into: `IDENTITY`, `PREFERENCES`, `WORKFLOW`, `PROJECTS`, `SYSTEM`, `GENERAL`.
  - Existing untagged memories route by deterministic category/content rules; no destructive migration.
  - Future `/sumo:memory add --panel <panel>` writes `sumocode:*` tags.
- Q7.3: B — flat-hybrid modal matching approval modal.
```

---

## Personal honest opinion

V3-style categorization **is worth it**, but only if we keep it metadata/deterministic for v1.

I would not ship an LLM classifier yet. It solves a future problem, not today's problem. The current store has only 3 active facts. The right move is:

1. build the categorized renderer now,
2. make it resilient with a `GENERAL` fallback,
3. enhance `/sumo:memory add` later so new memories carry panel tags,
4. defer LLM classification until memory volume makes manual/deterministic grouping visibly inadequate.

This gives Dhruv the desired Stitch v3 feeling without turning a UI polish pass into a new memory product.
