# SumoTUI Headless TestBackend

**Status:** active test contract for P1-C / #106  
**Owner:** SumoTUI consolidation #98  
**Code:** `src/sumo-tui/testing/test-backend.ts`  
**Tests:** `src/sumo-tui/testing/test-backend.test.ts`

## Purpose

Use `SumoTuiTestBackend` to test retained SumoTUI behavior without parsing real PTY byte streams.

PTY integration tests remain smoke coverage for the Pi/terminal boundary. Headless tests should carry detailed behavior coverage for retained renderer logic such as layout, cursor state, key routing, mouse dispatch, resize handling, and buffer assertions.

## What it exposes

`SumoTuiTestBackend` owns:

- a Yoga `root` node
- a `KeyRouter`
- current and previous `CellBuffer` snapshots
- current hardware cursor state from the compositor
- a `pilot` driver for keys, text, mouse events, resize, and explicit render ticks

## Basic usage

```ts
const backend = await SumoTuiTestBackend.create({ cols: 80, rows: 24 });

try {
	// Mount retained nodes directly.
	const node = new SumoNode(backend.yoga.Node.create(), backend.root);
	node.width = "100%";
	node.height = "100%";

	const frame = backend.render();
	expect(frame.current.getDimensions()).toEqual({ rows: 24, cols: 80 });
} finally {
	backend.dispose();
}
```

## Pilot API

```ts
backend.pilot.key("x");
backend.pilot.text("hello");
backend.pilot.mouse({ type: "scroll", scrollDir: "down", button: 65, row: 4, col: 2 });
backend.pilot.resize(120, 40);
backend.pilot.render();
```

Pilot methods render after each event so tests can immediately inspect `backend.current`, `backend.previous`, or the returned frame.

## Cursor coverage

The first tracer-bullet test ports the PTY cursor-visibility behavior into a headless retained test: a `PiEditorLeaf` is mounted, typed keys update the fake editor text, and the compositor-reported hardware cursor advances without spawning Pi.

That does **not** delete the PTY cursor smoke test. The PTY test still verifies real terminal bytes, while the headless test verifies the retained renderer logic directly.

## When to use this instead of PTY

Prefer the headless backend when testing:

- retained widget layout
- `CellBuffer` output
- hardware cursor calculation
- key routing and focus
- mouse hit-testing and scroll behavior
- resize behavior
- deterministic rendering edge cases

Keep PTY tests for:

- patched Pi startup
- altscreen/mouse/cursor terminal modes
- process signal cleanup
- real stdin/stdout behavior
- end-to-end wrapper smoke
