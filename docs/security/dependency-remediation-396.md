# Dependency advisory remediation inventory — issue #396 / Plan 102

**Status:** public evidence record for [issue #396](https://github.com/dhruvkelawala/sumocode/issues/396). **Local development graph remediated; consumer-runtime graph still upstream-blocked** (correction notice below and §9).
**Commit range:** baseline `397be093` → candidate `514da877` ([PR #453](https://github.com/dhruvkelawala/sumocode/pull/453), branch `fix/396-dependency-audit-policy`)
**Tail repair:** spec finding SA123 — the per-advisory public map required by issue #396 was not present in the published PR #453 diff/body, which described remediation only in aggregate. This file supplies that map.
**Correction:** the first published version of this map (head `7519bab9`, PR #467) presented the nine consumer-runtime advisories as remediated by the Pi `0.84.4` peer floor. Codex P1 (PR #467 discussion 3941838506) correctly rejected that framing: the floor does not enforce the patched transitives in consumer graphs, the empty local policy `records[]` describes only this repository's own overridden graph, and this repo's CI does not audit consumer graphs. This page corrects those claims, keeps the valid 15-advisory map and the historical counts, marks Plan 102 **incomplete / consumer-upstream-blocked** on its consumer-runtime criterion, and adds explicit user-facing remediation guidance (§10). A proper consumer-graph gate is a separate implementation queued by the coordinating parent; **this documentation correction is not the security fix**.
**Sources:** issue body/comments, committed lockfiles and commit diffs, CI logs, GHSA/npm primary advisory metadata. No policy change, no new exceptions, no restored or invented upstream-blocked records.

## 1. What issue #396 required in public scope

Issue #396's first public-scope bullet:

> Map each high advisory to dependency chain, runtime/dev role, fixed version, and verification owner.

This document is that map for the remediation published in PR #453. The chain/role/fix columns are accurate for **this repository's graph**: the map records what PR #453 changed in SumoCode's own lock and why (§4 scope note). It is written from public sources only and introduces no dependency/security policy change and no exceptions. After the correction notice above, the map no longer implies that the consumer-runtime rows are enforced-clean in consumer installs (§6, §9, §10).

## 2. Baseline and candidate

| | Baseline | Candidate |
|---|---|---|
| Commit | `397be093` (parent of first PR #453 commit `c50ea0f7`) | `514da877` (last PR #453 commit) |
| Pi peer/dev pins | `~0.84.3` / `0.84.3` | `~0.84.4` / `0.84.4` |
| Resolved Pi packages | all `@earendil-works/pi-*` at `0.84.3` | all at `0.84.4` |
| pnpm audit (high/critical) | 15 high, 0 critical | 0 |
| pnpm audit (all severities) | 26 (15 high, 11 moderate) | 0 |

## 3. Reproduction method and evidence date

`pnpm audit --json` (pnpm 10.13.1) was run on 2026-09-05 against each exact lockfile checked out into a temporary directory, with a matching `package.json`; no install was performed (registry metadata only):

```bash
# baseline
git show 397be093:package.json     > /tmp/audit-base/package.json
git show 397be093:pnpm-lock.yaml   > /tmp/audit-base/pnpm-lock.yaml
(cd /tmp/audit-base && pnpm audit --json)
# candidate
git show 514da877:package.json     > /tmp/audit-cand/package.json
git show 514da877:pnpm-lock.yaml   > /tmp/audit-cand/pnpm-lock.yaml
(cd /tmp/audit-cand && pnpm audit --json)
```

Findings and limits:

- **Reproduced counts are authoritative for the baseline↔candidate diff** but are not a claim that the original run's set is fully archived. No audit output from the original run is committed to the repo (the policy gate does not persist `pnpm audit` JSON). Nine consumer-runtime advisory ids are independently corroborated by the upstream-blocked record committed mid-PR at `6936cb64` (see §9); the six local-development advisory ids are corroborated only by the committed overrides plus this reproduction.
- All 15 high-advisory publication dates (2026-05-12 → 2026-09-01, see §4) precede the last PR #453 commit (`514da877`, 2026-09-04 18:43Z), so the set was knowable at remediation time; advisory-database propagation lag to the npm audit endpoint is not recorded and remains an annotated unknown.
- Severity is **as of evidence**: every advisory is GHSA-reviewed `high` at publication and still `high` on 2026-09-05. Advisory databases may re-rate later; re-verify before relying on this record past that date.

## 4. High advisories and the local fixes (the required map)

Installed module version is the version resolved in the baseline lock `397be093`. `first patched` is the first version that clears the vulnerable range reported by pnpm for that installed version. Fixed version is what the candidate lock `514da877` resolves **for this repository**. Audit paths are pnpm's `findings[].paths` strings (`.` = root importer). Role semantics are defined in §7.

**Scope of the tables:** installed/fixed are SumoCode's own baseline/candidate lock resolutions. For a consumer install, `first patched` is the actionable bound — the consumer's own lock must resolve at or above it (§6, §10). The `fix` lines name the local override/pin that reaches the fixed version in SumoCode's lock; for consumer-runtime rows those overrides do **not** propagate to consumers. Parenthesized scores in the severity column are the GHSA-reported CVSS base (v4 where published, else v3) as of 2026-09-05; GHSA severity class is `high` for all rows.

### 4.1 `protobufjs` `7.5.5` → `7.6.5` (5 advisories)

Chain (pnpm audit path): `.>@earendil-works/pi-ai>@google/genai>protobufjs`
Role: **consumer-runtime** (optional Pi Gemini provider path; `@google/genai` is a hard dependency of consumer-provided `@earendil-works/pi-ai`)
Fix: local override `@google/genai>protobufjs: 7.6.5` + peer/dev floor Pi `0.84.4`

| Advisory | CVE | GHSA severity | Vulnerable (installed `7.5.5`) | First patched | Published |
|---|---|---|---|---|---|
| [GHSA-66ff-xgx4-vchm](https://github.com/advisories/GHSA-66ff-xgx4-vchm) | CVE-2026-44293 | high (7.7) | `<=7.5.5` | `>=7.5.6` | 2026-05-12 |
| [GHSA-75px-5xx7-5xc7](https://github.com/advisories/GHSA-75px-5xx7-5xc7) | CVE-2026-44291 | high (8.1) | `<=7.5.5` | `>=7.5.6` | 2026-05-12 |
| [GHSA-jvwf-75h9-cwgg](https://github.com/advisories/GHSA-jvwf-75h9-cwgg) | CVE-2026-44290 | high (7.5) | `<=7.5.5` | `>=7.5.6` | 2026-05-12 |
| [GHSA-685m-2w69-288q](https://github.com/advisories/GHSA-685m-2w69-288q) | CVE-2026-44289 | high (7.5) | `<=7.5.5` | `>=7.5.6` | 2026-05-12 |
| [GHSA-wcpc-wj8m-hjx6](https://github.com/advisories/GHSA-wcpc-wj8m-hjx6) | CVE-2026-48712 | high (7.5) | `<=7.6.0` | `>=7.6.1` | 2026-06-15 |

### 4.2 `ws` `8.20.0` → `8.21.0` (1 advisory)

Chain: `.>@earendil-works/pi-ai>@google/genai>ws`
Role: **consumer-runtime** (same optional Pi Gemini provider path)
Fix: local override `@google/genai>ws: 8.21.0` + peer/dev floor Pi `0.84.4`

| Advisory | CVE | GHSA severity | Vulnerable (installed `8.20.0`) | First patched | Published |
|---|---|---|---|---|---|
| [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p) | CVE-2026-48779 | high (7.5) | `>=8.0.0 <8.21.0` | `>=8.21.0` | 2026-06-15 |

### 4.3 `brace-expansion` `5.0.5` → `5.0.9` (3 advisories)

Chain: `.>@earendil-works/pi-coding-agent>minimatch>brace-expansion`
Role: **consumer-runtime** (`minimatch` is a hard dependency of consumer-provided `@earendil-works/pi-coding-agent`)
Fix: local override `minimatch>brace-expansion: 5.0.9` + peer/dev floor Pi `0.84.4`

| Advisory | CVE | GHSA severity | Vulnerable (installed `5.0.5`) | First patched | Published |
|---|---|---|---|---|---|
| [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) | CVE-2026-13149 | high (7.7) | `>=3.0.0 <5.0.7` | `>=5.0.7` | 2026-07-20 |
| [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) | CVE-2026-14257 | high (7.5) | `>=4.0.0 <5.0.8` | `>=5.0.8` | 2026-07-24 |
| [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895) | CVE-2026-69152 | high (7.5) | `>=4.0.0 <5.0.9` | `>=5.0.9` | 2026-08-03 |

### 4.4 `vite` `8.0.10` → `8.0.16` (1 advisory)

Chain: `.>vitest>vite`
Role: **local-development only** (vitest test toolchain; not consumer-reachable)
Fix: direct devDependency pin `vite: 8.0.16`

| Advisory | CVE | GHSA severity | Vulnerable (installed `8.0.10`) | First patched | Published |
|---|---|---|---|---|---|
| [GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff) | CVE-2026-53571 | high (8.2) | `>=8.0.0 <=8.0.15` | `>=8.0.16` | 2026-06-15 |

### 4.5 `postcss` `8.5.10` → `8.5.23` (2 advisories)

Chain: `.>vitest>vite>postcss`
Role: **local-development only** (vitest test toolchain)
Fix: local override `vite>postcss: 8.5.23`

| Advisory | CVE | GHSA severity | Vulnerable (installed `8.5.10`) | First patched | Published |
|---|---|---|---|---|---|
| [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q) | CVE-2026-45623 | high (7.5) | `<=8.5.11` | `>=8.5.12` | 2026-07-23 |
| [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) | CVE-2026-73646 | high (7.5) | `<=8.5.17` | `>=8.5.18` | 2026-07-24 |

### 4.6 `nanoid` `3.3.11` → `3.3.18` (3 advisories)

Chain: `.>vitest>vite>postcss>nanoid`
Role: **local-development only** (vitest test toolchain)
Fix: local override `postcss>nanoid: 3.3.18`

| Advisory | CVE | GHSA severity | Vulnerable (installed `3.3.11`) | First patched | Published |
|---|---|---|---|---|---|
| [GHSA-xwg4-73v4-xw9w](https://github.com/advisories/GHSA-xwg4-73v4-xw9w) | CVE-2026-73086 | high (7.4) | `<3.3.12` | `>=3.3.12` | 2026-09-01 |
| [GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv) | CVE-2026-67214 | high (8.2) | `<3.3.16` | `>=3.3.16` | 2026-07-29 |
| [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) | CVE-2026-67213 | high (8.2) | `<3.3.18` | `>=3.3.18` | 2026-07-29 |

Notes on the five override paths visible in `package.json#pnpm.overrides`:

- They are **not** one-per-advisory; each override targets the vulnerable module version and clears every advisory in that module's matching range (5 protobufjs + 1 ws + 3 brace-expansion + 2 postcss + 3 nanoid = 14 of the 15; the 15th, vite, is a direct devDependency pin, not an override).
- Every override target is **within the declaring package's published semver range**, so each is a re-resolution of an already-permitted version rather than a range widening: `@google/genai@1.52.0` declares `protobufjs ^7.5.4` and `ws ^8.18.0`; `minimatch@10.2.5` declares `brace-expansion ^5.0.5`; `vite` declares `postcss ^8.5.x`; `postcss` declares `nanoid ^3.3.x`. The baseline lock simply pinned older patch versions that predated the fixed releases.

## 5. Dependency graph delta `397be093` → `514da877`

Resolved-version deltas between the two committed lockfiles (`pnpm-lock.yaml` at each commit; peer-suffix variants omitted):

| Package | Baseline | Candidate | Driver |
|---|---|---|---|
| `@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui` | `0.84.3` | `0.84.4` | peer/dev floor bump (`eb85b169`) |
| `@earendil-works/pi-agent-core`, `pi-client`, `pi-protocol`, `pi-telemetry` | `0.84.3` | `0.84.4` | `^0.84.x` resolution aligned with the Pi floor |
| `protobufjs` (+ `@protobufjs/codegen` `2.0.4→2.0.5`, `eventemitter` `1.1.0→1.1.1`, `fetch` `1.1.0→1.1.1`, `utf8` `1.1.0→1.1.2`) | `7.5.5` | `7.6.5` | override `@google/genai>protobufjs` |
| `ws` | `8.20.0` | `8.21.0` | override `@google/genai>ws` |
| `brace-expansion` | `5.0.5` | `5.0.9` | override `minimatch>brace-expansion` |
| `vite` (+ `rolldown` `1.0.0-rc.17→1.0.3` and bindings, `tinyglobby` +`0.2.17`, `@oxc-project/types` `0.127.0→0.133.0`) | `8.0.10` | `8.0.16` | devDependency pin `vite: 8.0.16` |
| `postcss` | `8.5.10` | `8.5.23` | override `vite>postcss` |
| `nanoid` | `3.3.11` | `3.3.18` | override `postcss>nanoid` |

## 6. Fixed-version selection: parent Pi `0.84.4` vs local overrides

Two distinct remediation surfaces, per the issue's public scope:

1. **Consumer runtime (parent): version-compatibility alignment, not an enforced security constraint.** The peer (and dev) floor for the Pi trio rose from `~0.84.3`/`0.84.3` to `~0.84.4`/`0.84.4` (`eb85b169`, aligned by `b918cdef` across native build, launcher, smoke default, diagnostics instrumenter, and tests; README badge updated). `0.84.4` is the Plan 101 matrix-verified release. Precise scope of what the peer floor can and cannot do:
   - `@earendil-works/pi-ai@0.84.3` and `0.84.4` publish identical declared dependencies (`@google/genai 1.52.0`, exact), and `pi-coding-agent@0.84.3`/`0.84.4` both pin `minimatch 10.2.5`. `genai@1.52.0` declares `protobufjs ^7.5.4` and `ws ^8.18.0`; `minimatch@10.2.5` declares `brace-expansion ^5.0.5`. The vulnerable versions this PR removed from SumoCode's own lock (`7.5.5`, `8.20.0`, `5.0.5`) are **inside those declared ranges**, so raising the floor neither forces re-resolution nor constrains the transitive versions in a consumer install. The floor is a compatibility statement, **not a security constraint** on those transitives.
   - A consumer upgrading Pi **while preserving an existing lockfile** keeps whichever vulnerable transitives that lock pinned — all nine consumer-runtime advisories can remain installed after the upgrade. SumoCode's own `pnpm.overrides` never propagate to consumers (matching the issue requirement to never claim consumers inherit local overrides), so they do not repair consumer locks either.
   - A **fresh** consumer resolution selects the fixed patches only because the registry currently resolves each range to its highest in-range version (`7.6.5`, `8.21.0`, `5.0.9` are all in range, §4). PR #453 reported such a fresh-consumer Pi `0.84.4` graph with zero high/critical findings. That is a **historical, resolution-time observation**: it was not re-executed for this correction, it is not enforced by the floor, and it does not cover consumers who install or refresh from a retained lock. This repository's CI does not audit consumer graphs (§8). See §10 for user-facing remediation guidance; the remaining consumer blocker is stated in §9 and §11.
2. **Local development graph.** The five `pnpm.overrides` plus the `vite` devDependency pin force the fixed patches into SumoCode's own lock deterministically (overriding a stale lock that predated the fixed releases) rather than relying on a future lock refresh. These are development-graph-only.

## 7. Runtime/dev role semantics

The audit policy's classification rule (see `scripts/check-dependency-audit.mjs`) is: any finding whose chain starts `.>@earendil-works/pi-` is a **consumer-runtime** chain (it exists inside consumer-provided Pi and its dependencies); anything else is a **local-development** chain.

- **Consumer-runtime (this PR: 9 advisories):** protobufjs, ws (via `@earendil-works/pi-ai` → `@google/genai`, the optional Gemini provider library), brace-expansion (via `@earendil-works/pi-coding-agent` → `minimatch`). These exist in a consumer's Pi install regardless of SumoCode's own devDependencies, and they **remain installed** in any consumer lock that resolves the vulnerable versions, because the declared ranges still permit them (§6). Reachability here is dependency-presence (pnpm audit path), not an exploitability assessment of each provider path.
- **Local-development (this PR: 6 advisories):** vite, postcss, nanoid, reachable only through SumoCode's vitest toolchain. SumoCode ships a native binary and Pi extension source; its `node_modules` dev toolchain is not delivered to consumers.

## 8. Verification owner and CI evidence

The verification owner is the **automated gate**, not a human assignment:

- **Policy module:** `scripts/check-dependency-audit.mjs` — fail-closed CLI. It rejects unclassified, stale, expired, package/fixed-version/upstream/dependency-chain-mismatched, duplicate, local-path, and unremediated high/critical records, and hard-fails on audit errors (registry/network), not just findings (`83231ad6`, `514da877`).
- **Tests:** `scripts/check-dependency-audit.test.mjs` — 17 cases including multi-chain matching and local-path rejection added by the final commit.
- **CI gate:** `.github/workflows/ci.yml`, job `typecheck-and-test`, step `Dependency audit policy` (`node scripts/check-dependency-audit.mjs`) runs after `pnpm install --frozen-lockfile` on every pull request and `main` push. **The audited graph is this repository's own** — the frozen lock with its local overrides applied. CI evidence: run [33907877057](https://github.com/dhruvkelawala/sumocode/actions/runs/33907877057) (head `514da877`, 2026-09-04) logs `dependency audit policy passed; consumer-runtime upstream-blocked: 0; local-development high/critical: 0` and the 17-test focused file green. That log counts high/critical findings in the **local** audit only; with the overridden local graph clean it reports `0`, and it says nothing about any consumer graph. The separate `Pi compatibility` workflow run [33907877078](https://github.com/dhruvkelawala/sumocode/actions/runs/33907877078) on the same head covers the Plan 101 matrix gate for the `0.84.4` floor — a compatibility gate, not a consumer-security gate.
- **Human-touch fields:** the only owner/expiry fields in the policy schema belong to upstream-blocked records; none exist in the final policy (§9). That means no expiry obligation for this repository's own policy. It does **not** mean the consumer-side finding is resolved: the local policy cannot represent a finding absent from its audited (local) graph — a re-added upstream-blocked record would fail the gate's own stale-record check — so the consumer blocker is recorded here as status only (§9), with no invented owner or expiry. Real consumer-side records with owner/expiry belong to the separately queued consumer-graph gate.

## 9. Policy state — empty local record set, and what it does and does not mean

`scripts/dependency-audit-policy.json` at `514da877`:

```json
{ "schemaVersion": 1, "records": [] }
```

**What the empty set means (accurate):** for this repository's own overridden graph, no high/critical finding is waived, blocked, or accepted. The five overrides plus the `vite` pin make SumoCode's own frozen-lock audit return zero high/critical findings, so the local policy legitimately has nothing to record.

**What the empty set does not mean (the correction):** it is **not** consumer remediation, and it is not by itself the issue #396 end state. Issue #396's consumer-runtime acceptance criterion is *consumer-runtime findings are fixed by an enforced upstream Pi minimum, or recorded as upstream-blocked with owner/expiry*. Neither arm is satisfied on the consumer side by PR #453:

- the `~0.84.4` peer floor is not an *enforced* upstream minimum for the patched transitives — the Pi-declared ranges still permit the vulnerable versions (§6); and
- the empty local `records[]` is not an upstream-blocked record with owner/expiry, and the local gate cannot carry one for a finding absent from its audited graph.

The nine consumer-runtime advisories — protobufjs `1118641 1118928 1118930 1118932 1123488` and ws `1123259` (upstream `@earendil-works/pi-ai`), brace-expansion `1123898 1130591 1130734` (upstream `@earendil-works/pi-coding-agent`) — therefore remain **open high-severity findings for any consumer whose lock resolves the vulnerable versions**. This page records that status as consumer-upstream-blocked with **no false owner assignment and no waiver**; it does not invent an expiry. Plan 102 is **implementation incomplete / consumer-upstream-blocked** on its consumer-runtime criterion pending a proper consumer-graph gate (separate implementation queued by the coordinating parent).

Historical trace (preserved for transparency): from `f5151994` until `eb85b169` the policy carried three `upstream-blocked` consumer-runtime records (snapshots at `6936cb64`/`cf3a658a` show the same nine), owner `dhruvkelawala`, expiry `2026-10-04`. Those records were removed by `eb85b169` **because the audited (overridden) local graph became clean** — not because the floor or the overrides covered consumer chains. That intermediate record set remains the committed corroboration that the reproduced consumer-runtime advisory ids match what the executor observed. This correction adds no new exceptions and does not restore any record.

## 10. Consumer remediation guidance (user-facing)

The fixed patches already exist inside the declared ranges of the Pi packages consumers install, so an affected consumer can clear these nine advisories **without waiting for a new Pi release** — but only by refreshing and then verifying **their own** lockfile. Pi (and Pi extensions such as SumoCode) is a peer dependency installed by the consumer; no change published to this repository can rewrite a consumer's lock, and nothing on this page should be read as doing so.

If you maintain a project that installs `@earendil-works/pi-*` directly or via an extension such as SumoCode:

1. **Audit your existing installation — not a hypothetical fresh one.** Run the audit against the lockfile your project actually installs from (pnpm: `pnpm audit`; npm: `npm audit`; yarn: `yarn npm audit`). Look for `protobufjs` `<=7.5.5` (GHSA-66ff-xgx4-vchm, -75px-5xx7-5xc7, -jvwf-75h9-cwgg, -685m-2w69-288q; `<=7.6.0` for GHSA-wcpc-wj8m-hjx6), `ws` `<8.21.0` (GHSA-96hv-2xvq-fx4p), and `brace-expansion` `<5.0.9` (GHSA-3jxr-9vmj-r5cp, -mh99-v99m-4gvg, -rgw5-rvv9-x895). A lockfile created before those patches published keeps the vulnerable versions even after upgrading Pi to `0.84.4`, because Pi's declared ranges still permit them (§6).
2. **Refresh the vulnerable transitives to the fixed patches in your own project.** The fix is a re-resolution inside already-permitted ranges, so prefer narrow, exact overrides/resolutions over any blanket change:
   - pnpm: add to your own `package.json` → `pnpm.overrides`: `"@google/genai>protobufjs": "7.6.5"`, `"@google/genai>ws": "8.21.0"`, `"minimatch>brace-expansion": "5.0.9"` (keyed to the upstream versions your lock nests under if they differ), then `pnpm install` and re-run `pnpm audit`.
   - npm/yarn equivalents: `overrides` (npm) / `resolutions` (yarn).
   - If your lockfile merely predates the patches, an ordinary no-version-change refresh (`pnpm install` / `npm install`) re-resolves in-range versions and will usually pick the patches up — but **verify afterwards**, because "usually" is resolution-time behavior, not an enforced guarantee.
3. **Do not substitute destructive or blanket commands for verifying your own lock.** In particular: do not run `npm audit fix --force` (it applies breaking upgrades outside the declared ranges), do not treat global reinstall/upgrade of Pi or other packages as a remediation step, and do not move every dependency to `latest`. Those change versions the Pi packages did not declare and can break the install in ways an audit will not surface.
4. **Re-run the audit after every refresh and keep the result.** A passing audit against *your* lockfile is the only consumer-side evidence that clears these advisories. If your lock still reports any of the nine after refresh, you remain affected; a change on the SumoCode side does not cover you.

Maintainer-side remedy (not delivered here): the durable fix is an upstream Pi release whose declared constraints exclude the vulnerable transitives, plus a consumer-graph audit gate that continuously verifies consumer locks instead of relying on resolution-time coincidence. That work is queued separately by the coordinating parent. Until it lands, this repository can only keep its own local graph fixed and document the consumer blocker honestly — which this page now does. **This documentation correction is not the security fix for consumer installations.**

## 11. Unknowns and remaining verification

- **Historical audit counts are not reset and are not fully known.** No contemporaneous `pnpm audit` output was committed; only the nine consumer-runtime ids above are corroborated verbatim by committed history. Reproduced counts (15 high / 11 moderate at baseline, 0 at candidate, as of 2026-09-05) are the operative evidence for this diff.
- **Moderate advisories** (11 at baseline: protobufjs family incl. `@protobufjs/utf8`, ws, brace-expansion, postcss, vite) were not part of the issue's high/critical gate; they also fell to zero at the candidate lock. Exact historical moderate ids are not archived beyond this reproduction.
- **Severity drift:** all 15 are GHSA-reviewed `high` as of 2026-09-05; re-check before relying past that date.
- **Consumer-runtime reachability** is dependency-presence based (§7); this inventory does not assert exploitability of any optional provider path.
- **Fresh-consumer observation is historical and non-enforcing.** The fresh-consumer Pi `0.84.4` graph verification claimed in PR #453 was not re-executed for this correction (no heavy installs while the Plan 112 lane is active). Even re-run at zero findings, a fresh resolution would not clear retained consumer locks (§6); only a consumer-graph gate can enforce that, and it is queued separately.
- **Remaining consumer security blocker.** Until an upstream Pi release constrains the patched transitives or a consumer-graph gate is in place, consumers on retained locks can still carry the nine high advisories (§9). This repository's gate re-runs only against its own frozen (overridden) lock on every PR/`main` push and fails on any new high/critical finding in that graph; it does not measure consumer graphs. Keep issue #396 open and the Codex thread unresolved until the consumer-side remedy is evidenced.

## 12. Sources

- Issue: https://github.com/dhruvkelawala/sumocode/issues/396 (public scope, acceptance criteria)
- PR: https://github.com/dhruvkelawala/sumocode/pull/453 (body, commit list `c50ea0f7`→`514da877`)
- Correction: [PR #467](https://github.com/dhruvkelawala/sumocode/pull/467) Codex P1 review discussion 3941838506 against head `7519bab9`, accepted and applied by the correction commit on top of `7519bab9` on branch `sumo/reconcile-plan102-public-advisory-remediation-ma`
- Commits: `397be093`, `f5151994`, `eb85b169`, `b918cdef`, `926f98eb`, `6936cb64`, `83231ad6`, `514da877` (diffs to `package.json`, `pnpm-lock.yaml`, `.github/workflows/ci.yml`, `scripts/check-dependency-audit.mjs`, `scripts/check-dependency-audit.test.mjs`, `scripts/dependency-audit-policy.json`, launcher/native/tests)
- Lockfiles: `pnpm-lock.yaml` @ `397be093` and @ `514da877`
- CI logs: runs 33907877057 (`ci`), 33907877078 (`Pi compatibility`)
- Advisory metadata: GitHub Advisory Database entries linked in §4 (all `npm` ecosystem, `protobufjs`/`ws`/`brace-expansion`/`vite`/`postcss`/`nanoid`)
- Package manifests (declared ranges): `@google/genai@1.52.0`, `minimatch@10.2.5`, `vitest@4.1.5`, `vite@8.0.10`, `@earendil-works/pi-ai@0.84.3/0.84.4`, `@earendil-works/pi-coding-agent@0.84.3/0.84.4` via the npm registry
