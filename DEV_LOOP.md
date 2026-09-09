# SumoCode development workflow

Run contributor commands from your source checkout. The maintainer's canonical primary tree and path-quoting rule remain in [AGENTS.md](AGENTS.md); other contributors can use any checkout. Never edit Pi's installed clone. [README.md](README.md) describes the current product; [plans/README.md](plans/README.md) owns execution status.

## Setup and launch

Use the Node engine and Pi peer versions declared in [package.json](package.json). CI uses Node 24 and pnpm 10.29.2; the current development Pi pin is 0.84.4.

```bash
pnpm install
pnpm dev .
./bin/sumocode.sh -d .
pi -e .
```

The first two launches exercise the source RPC host. `pi -e .` checks the classic extension profile. The stable package entry is `src/extension-entry.ts`: it validates an optional generated bundle and otherwise uses the appropriate source profile. Launcher-owned RPC children select `src/rpc-child-extension.ts`; classic Pi selects `src/extension.ts`. Shared installation lives in `src/extension-core.ts`.

Interactive TTY launches use the RPC host. Print mode, explicit `--mode`, non-TTY stdout and `--no-sumo-tui` execute Pi directly. Use `./bin/sumocode.sh --dry-run` to inspect routing and `./bin/sumocode.sh --help` for supported options. The native release's compiled host and bundled Pi child are a separate distribution; see [README.md](README.md#install).

## Verification

```bash
pnpm lint
pnpm exec tsc --noEmit
pnpm build
pnpm test
pnpm test:integration
pnpm render:bible
pnpm visual:ci
```

TypeScript runs through jiti during source development, so build is a typecheck. Runtime/visual changes require the full unit, integration and visual gates in AGENTS.md. Integration uses its owned process harness; inspect its zero-survivor audit before accepting a run. Run native contracts with `pnpm test:native` when changing distribution or executable provenance; this requires the pinned Bun described by the native builder. The supported Pi compatibility gate is `bash scripts/smoke-pi-versions.sh --supported-matrix`.

CI workflows in `.github/workflows/` also define dependency auditing, native contracts, compatibility, visual checks and report-only dead-code analysis. Prefer the workflow and package scripts over mutable test totals. `pnpm dead-code` reports findings; it is not a cleanup command.

Generated bundles and binaries stay ignored. `pnpm build:bundles` produces optional local host/extension bundles; `pnpm build:native` builds a native archive. Rebuild after integration when a plan requires it. Never commit generated dist output.

## Diagnostics and visual review

```bash
./bin/sumocode.sh doctor
./bin/sumocode.sh -d .
./bin/sumocode.sh diag
pnpm visual:review
```

Diagnostics are opt-in via debug mode or `SUMO_TUI_DIAG_FILE`; default output is /tmp/sumocode-manual.jsonl. The launcher clears that diagnostic file at startup unless `--no-clear-diag` is supplied. Preserve useful evidence before starting another debug run. This is separate from durable state in [SETUP.md](SETUP.md).

Read styled-cell and geometry reports before PNGs. The [V2 contract](docs/visual/parity/CONTRACT.md) defines required crops and explicit human approval for golden promotion. Capturing evidence does not approve a golden.

## Releases and source consumers

Version authority is `package.json`; the native builder injects that version into the executable. Update release notes and any versioned product copy together. Run required checks before creating and pushing a version tag. Releases are manual: in Actions → Native release → Run workflow, enter the existing tag matching `package.json` (for example `v0.5.0`). The workflow checks out that immutable tag, validates its version, builds and tests the macOS arm64 archive, verifies checksums, and publishes it with the tagged `CHANGELOG.md` Unreleased section plus GitHub-generated contributor notes. CLI equivalent: `gh workflow run release.yml --ref main -f tag=v0.5.0`. Existing releases are never overwritten; use a new version for corrections. Consumers install that archive as described in README.md. Pushes to main do not replace an installed native archive.

Pi git-package installs remain a separate source path. An unpinned install/update follows the upstream branch rather than selecting the newest release tag. To reproduce a source release, use an explicit tag:

```bash
pi install git:github.com/dhruvkelawala/sumocode@v0.4.1
```

Do not run releases, pushes or updates merely as verification. Follow the repository's authorization rules for publication.
