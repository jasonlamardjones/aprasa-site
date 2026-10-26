# P05-E2P v0.1-R1 · N2 synthetic contract harness

**Status:** Non-public, synthetic-only technical demonstration. **Not a production adapter, not publication authorization.**

## Authority and isolation

- Governing controlled Project 05 contract: [P05-E2P v0.1-R1](https://docs.google.com/document/d/1OnfGn6MQ3Y22_SYTCVlFb_OEJQtaDogRCv0g9qhVv9Y/edit).
- Project 03's five-record pilot direction is **non-public only**; Project 09 Portuguese strings remain pending. This harness contains **invented IDs, invented provider names, and `.example.invalid` test URLs**. It reads no Project 05 workbook rows.
- The trusted, frozen *synthetic-only* claim/value oracle is code-owned in `scripts/p05-e2p/nonpublic-adapter.mjs`; editable `synthetic-fixtures.json` cannot authorize its own title, summary, action URL, source URL or provider relationships.
- These exact four files are not imported or invoked by `scripts/build-all.mjs`, the site, the current training generator, CI, or any publication workflow. No runtime code writes files or makes network calls.
- Intended repository branch, **once a genuine local checkout from verified main is available:** `test/p05-e2p-n2-nonpublic-contract-harness`. Do not fake `main` or create a remote branch under an editing-only authorization.

## Four-file set

1. `automation/p05-e2p/nonpublic/README.md` — these boundaries.
2. `automation/p05-e2p/nonpublic/synthetic-fixtures.json` — eight invented scenarios (five positive, two held, one suppressed).
3. `scripts/p05-e2p/nonpublic-adapter.mjs` — synchronous, in-memory contract screening; whitelist and independent value binding.
4. `scripts/p05-e2p/test-nonpublic-adapter.mjs` — Node built-in test harness with hostile mutation regressions.

## Run in a local checkout

From the repository root:

```sh
node --test scripts/p05-e2p/test-nonpublic-adapter.mjs
```

No install or dependency change is necessary. Tests read fixtures, do not write to disk, and do not contact a service. The exported `screenSyntheticBatch()` function returns an object in memory; it does not generate a public JSON file.

## Contract coverage and gaps

Covered at **synthetic unit-test level**: stable ID preservation; independent provider resolution; claim/value binding; strict action URL equality; positive and negative outcome selection; privacy-field fail-closed behavior; optional-field omission; explicit synthetic relationship evidence; duplicate IDs; deterministic sorting; unexpected diff detection; conservative currentness; no PT approval claim; no production route output.

**Not covered or authorized:** real Project 05 evidence extraction, authenticity of actual submitted provider evidence, live claim freshness, real EN/PT parity, production data projection, protected build integration, hosted preview/production QA, true RBAC, signed policy, repository CI execution, merge/deployment/rollback. `fingerprint()` is a SHA-256 **diff guard only**, not a signature, identity proof, authority decision or tamper-proof log. The frozen synthetic oracle is *not* an approved production assertion mechanism. Exact real value/evidence binding still requires a separately approved Project 05 transport design.

`Revalidation Due` returns a conservative HOLD in N2; this does not supersede Project 03/05's nuanced real public handling. Any later migration/production work requires explicit approvals and real source review.

## Local checkout prerequisite

The originating executor had GitHub API read access but **no functioning `git clone` network path** and no mounted authoritative checkout. This four-file packet was therefore built/tested as a **local staging package**, not placed on a real Git branch. A follow-up Git/Claude Code executor must first verify clean working tree and fresh remote main, checkout a local branch at that exact SHA, and only then copy these four files, inspect the diff, retest, and STOP prior to commit/push/PR/merge/deploy.
